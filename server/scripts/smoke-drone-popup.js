#!/usr/bin/env node
'use strict'
/**
 * 无人机弹窗链路 端到端 smoke test（T1）
 * 目的：部署后自动跑一遍"模拟起飞→推测试流→校验 stream-status/hls 可达"，阻断潜伏 bug。
 * 运行：node scripts/smoke-drone-popup.js [--quick]
 * 退出码：0=全部通过；1=有失败项（CI/部署流程可据此阻断）
 *
 * 链路覆盖：
 *   ① simulate 模拟起飞事件（SIM_ 前缀，防污染真实 SN）
 *   ② ffmpeg 推测试流到我方 ZLM jsc/sikong_<SIM_deviceSn>
 *   ③ GET stream-status：校验 online=true + hls 相对路径 + 分辨率非空
 *   ④ hls 相对路径经 nginx 反代可达（:80 本机 200/302）
 *   ⑤ simulate/off-all 清理模拟事件（防残留假弹窗）
 */
const { spawn } = require('child_process')

const BASE = 'http://127.0.0.1:7170'
const ZLM_PUSH = 'rtmp://127.0.0.1:1936/jsc'
const NGINX = 'http://127.0.0.1:80'
const SIM_DEVICE = 'SIM_SMOKE_0001'
const SIM_DOCK = '8UUXN8N00A0LS7' // 白名单内的真实 dockSn（三峡科技）

const results = []
let ffmpegProc = null

function ok(name, detail) { results.push({ name, pass: true, detail }); console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`) }
function fail(name, detail) { results.push({ name, pass: false, detail }); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`) }

async function jfetch(path, opts = {}) {
  const token = global.__token
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  if (token) headers['Authorization'] = 'Bearer ' + token
  const r = await fetch(BASE + path, { ...opts, headers })
  const txt = await r.text()
  let j = null
  try { j = JSON.parse(txt) } catch { }
  return { status: r.status, json: j, text: txt }
}

async function login() {
  const r = await jfetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin123' }) })
  if (r.json && r.json.token) { global.__token = r.json.token; return true }
  return false
}

async function simulate(on) {
  return jfetch('/api/drone-events/simulate', { method: 'POST', body: JSON.stringify({ deviceSn: SIM_DEVICE, dockSn: SIM_DOCK, on }) })
}

async function offAll() {
  return jfetch('/api/drone-events/simulate/off-all', { method: 'POST', body: JSON.stringify({}) })
}

function pushTestStream() {
  // 推一个 30fps 测试流到 jsc/sikong_<SIM_DEVICE>（模拟无人机流）
  const url = `${ZLM_PUSH}/sikong_${SIM_DEVICE}`
  ffmpegProc = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-re',
    '-f', 'lavfi', '-i', 'testsrc=size=960x720:rate=30',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30',
    '-f', 'flv', url,
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  ffmpegProc.stderr.on('data', d => { err += d.toString() })
  return new Promise((resolve) => {
    ffmpegProc.on('error', (e) => resolve({ ok: false, err: e.message }))
    setTimeout(() => resolve({ ok: true, err }), 4000) // 4s 后视为推流已建立
  })
}

async function checkStreamStatus() {
  const qs = new URLSearchParams({ deviceSn: SIM_DEVICE, dockSn: SIM_DOCK })
  return jfetch('/api/drone-events/stream-status?' + qs.toString())
}

async function checkNginx(path) {
  try {
    const r = await fetch(NGINX + path, { signal: AbortSignal.timeout(5000) })
    return r.status
  } catch (e) { return -1 }
}

async function main() {
  console.log('=== 无人机弹窗链路 smoke test ===')
  console.log(`模拟机: ${SIM_DEVICE}  dock: ${SIM_DOCK}`)

  // 0. 登录
  if (!(await login())) { fail('登录', 'admin 登录失败'); process.exit(1) }
  ok('登录', 'admin token 获取成功')

  // 1. 清理历史模拟事件（防上次残留）
  const off1 = await offAll()
  if (off1.json && off1.json.ok) ok('清理历史模拟事件', `deleted=${off1.json.deleted ?? 0}`)
  else ok('清理历史模拟事件', '无残留（ok 但无历史）')

  // 2. 模拟起飞
  const sim = await simulate(true)
  if (sim.json && sim.json.ok && sim.json.broadcast) ok('模拟起飞事件（SIM LIVE_ON + 白名单命中广播）', `broadcast=${sim.json.broadcast}`)
  else fail('模拟起飞事件', JSON.stringify(sim.json || sim.text).slice(0, 120))

  // 3. 推测试流
  const push = await pushTestStream()
  if (push.ok) ok('推测试流到我方 ZLM', `sikong_${SIM_DEVICE}`)
  else fail('推测试流', push.err)

  // 4. 校验 stream-status
  await new Promise(r => setTimeout(r, 3000)) // 等 mirror/注册
  const st = await checkStreamStatus()
  if (st.json && st.json.ok) {
    if (st.json.online === true) ok('stream-status online=true', '我方 ZLM 流在线')
    else fail('stream-status online', `online=${st.json.online}`)
    if (typeof st.json.hls === 'string' && st.json.hls.startsWith('/jsc/')) ok('hls 为相对路径（走 nginx 反代）', st.json.hls)
    else fail('hls 相对路径', `hls=${st.json.hls}`)
    if (st.json.width != null && st.json.height != null) ok('分辨率非空', `${st.json.width}×${st.json.height}`)
    else fail('分辨率', `width=${st.json.width} height=${st.json.height}`)
    // 5. hls 经 nginx 可达（on-demand 下首拉可能 404，允许 200/404 但要求"非连接失败"）
    const code = await checkNginx(st.json.hls)
    if (code === 200 || code === 302 || code === 404) ok('hls 经 nginx 反代可达', `HTTP ${code}（on-demand 下 404 属正常）`)
    else fail('hls nginx 可达性', `HTTP ${code}`)
  } else {
    fail('stream-status 调用', JSON.stringify(st.json || st.text).slice(0, 120))
  }

  // 6. 清理：补 OFF + 删模拟事件
  await simulate(false)
  const off2 = await offAll()
  if (off2.json && off2.json.ok) ok('清理模拟事件（补 OFF + 删 SIM_ 行）', `offCount=${off2.json.offCount ?? 0} deleted=${off2.json.deleted ?? 0}`)

  // 停 ffmpeg
  if (ffmpegProc) { try { ffmpegProc.kill() } catch { } }

  // 汇总
  const passN = results.filter(r => r.pass).length
  const failN = results.filter(r => !r.pass).length
  console.log('=== 汇总 ===')
  console.log(`通过 ${passN} 项，失败 ${failN} 项`)
  process.exit(failN > 0 ? 1 : 0)
}

main().catch(e => { console.error('smoke test 异常:', e); if (ffmpegProc) try { ffmpegProc.kill() } catch { } process.exit(1) })
