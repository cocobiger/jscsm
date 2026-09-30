#!/usr/bin/env node
/**
 * 真实页面验收探针（CDP 驱动 Edge headless，零第三方依赖 · Node 22 自带 WebSocket）
 *
 * 背景：本地无法直连生产（仅 ssh 可达）→ 先用 SSH 隧道把生产 nginx 映射到本机：
 *   ssh -N -L 18080:127.0.0.1:80 root@111.10.220.226
 * 然后：
 *   node scripts/ui-probe.mjs http://127.0.0.1:18080/jsc/ --probe "秸秆焚烧监控|tmp/shot1.png|tmp/txt1.txt"
 *
 * 流程：登录（admin）→ 写入 localStorage['jsc:token'] → 刷新 → 依次点击指定菜单 → 截图 + 导出页面文本
 * 输出：每个 probe 一张 png + 一份 txt（供人工/程序核对数值）
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9333

const argv = process.argv.slice(2)
const cfgIdx = argv.indexOf('--config')
let cfg = null
if (cfgIdx >= 0 && argv[cfgIdx + 1]) {
  cfg = JSON.parse(fs.readFileSync(argv[cfgIdx + 1], 'utf8'))   // 中文菜单名从 UTF-8 JSON 读，避免命令行编码破坏
}
const baseUrl = cfg?.url || argv[0]
const preSteps = cfg?.pre || []          // 进入目标页前需要先点的菜单（如「管理后台」）
const probes = cfg?.probes || []
if (!cfg) {
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--probe' && argv[i + 1]) {
      const [menu, png, txt] = argv[++i].split('|')
      probes.push({ menu, png, txt })
    }
  }
}
if (!baseUrl) {
  console.error('用法: node scripts/ui-probe.mjs --config <utf8.json>')
  process.exit(2)
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const userDataDir = path.join(os.tmpdir(), 'jsc-ui-probe-' + Date.now())

// ── CDP 客户端 ──
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map() }
  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('WS 连接失败: ' + (e?.message || ''))) })
    const c = new CDP(ws)
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.id && c.pending.has(msg.id)) {
        const { res, rej } = c.pending.get(msg.id); c.pending.delete(msg.id)
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result)
      }
    }
    return c
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时: ' + method)) } }, 30000)
    })
  }
  async eval(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
    if (r.exceptionDetails) throw new Error('页面执行异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result?.value
  }
}

async function waitHttp(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true } catch {}
    await sleep(500)
  }
  return false
}

async function waitReady(cdp, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { if (await cdp.eval("document.readyState === 'complete'", false)) return true } catch {}
    await sleep(500)
  }
  return false
}

// 文本匹配点击：精确优先 → 退化为 includes（按钮文本会演化）；取文本最短的候选，避免点到外层大容器
const clickByText = (label) => `(() => {
  const L = ${JSON.stringify(label)}
  const all = [...document.querySelectorAll('button,a,li,div,span,td')]
    .map(e => ({ e, t: (e.textContent || '').trim() }))
    .filter(o => o.t)
  let hits = all.filter(o => o.t === L)
  if (!hits.length) hits = all.filter(o => o.t.includes(L))
  if (!hits.length) return 'notfound'
  hits.sort((a, b) => a.t.length - b.t.length)
  const el = hits[0].e
  const target = el.closest('button') || el.closest('a') || el
  target.click()
  return 'clicked(' + hits.length + '候选): ' + (target.textContent || '').trim().slice(0, 24)
})()`

function cleanup(proc) {
  try { proc?.kill() } catch {}
  try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
}

const edgeProc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--window-size=1600,2000',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`, 'about:blank',
], { stdio: 'ignore' })

let cdp = null
const report = []
try {
  if (!await waitHttp(`http://127.0.0.1:${PORT}/json/version`)) throw new Error('Edge 调试端口未就绪')
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const target = list.find(t => t.type === 'page')
  if (!target) throw new Error('未找到页面 target')
  cdp = await CDP.attach(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  // 1) 打开首页 + 登录，写入会话 token
  await cdp.send('Page.navigate', { url: baseUrl })
  await waitReady(cdp)
  const login = await cdp.eval(`(async () => {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }) })
    const d = await r.json()
    if (!d.token) return 'LOGIN_FAIL: ' + JSON.stringify(d).slice(0, 120)
    localStorage.setItem('jsc:token', d.token)
    return 'LOGIN_OK'
  })()`)
  report.push('login: ' + login)
  if (!String(login).startsWith('LOGIN_OK')) throw new Error(String(login))

  // 2) 刷新进入已登录态
  await cdp.send('Page.navigate', { url: baseUrl })
  await waitReady(cdp)
  await sleep(2500)

  // 3) 前置菜单（如「管理后台」）
  for (const label of preSteps) {
    const r = await cdp.eval(clickByText(label), false)
    report.push(`pre[${label}]: ${r}`)
    await sleep(2500)
  }

  // 4) 逐个菜单探查
  for (const p of probes) {
    if (p.eval) {
      // 自定义表达式探针：在页面上下文执行，把返回值（序列化）写进 txt（诊断用）
      try {
        const v = await cdp.eval(`(async () => { return (${p.eval}) })()`)
        report.push(`eval: ${String(v).slice(0, 200)}`)
        if (p.txt) { fs.mkdirSync(path.dirname(p.txt), { recursive: true }); fs.writeFileSync(p.txt, typeof v === 'string' ? v : JSON.stringify(v, null, 2)) }
      } catch (e) { report.push(`eval ERROR: ${e?.message || e}`) }
      continue
    }
    if (p.menu && p.menu !== '-') {
      const clicked = await cdp.eval(clickByText(p.menu), false)
      report.push(`click[${p.menu}]: ${clicked}`)
      await sleep(4500)   // 页面内轮询/请求返回时间
    }
    const text = await cdp.eval('document.body.innerText', false)
    if (p.txt) { fs.mkdirSync(path.dirname(p.txt), { recursive: true }); fs.writeFileSync(p.txt, text || '') }
    if (p.png) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
      fs.mkdirSync(path.dirname(p.png), { recursive: true })
      fs.writeFileSync(p.png, Buffer.from(shot.data, 'base64'))
      report.push(`shot: ${p.png} (${Math.round(fs.statSync(p.png).size / 1024)}KB) text: ${(text || '').length} 字 → ${p.txt}`)
    }
  }
  report.push('RESULT: PASS')
} catch (e) {
  report.push('RESULT: FAIL - ' + (e?.message || e))
} finally {
  if (cdp) { try { await cdp.send('Page.close') } catch {} }
  cleanup(edgeProc)
}
console.log(report.join('\n'))
