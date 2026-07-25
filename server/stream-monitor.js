'use strict'
/**
 * 视频流在线状态探测器
 * - 定期探测启用视频流地址可达性，自动更新在线/离线
 * - HTTP-FLV / HLS / 其他 http(s) 地址：fetch 探测（先 HEAD，不支持则 GET 少量字节）
 * - RTSP：可选 ffprobe 探测（需系统装 ffmpeg），无 ffprobe 时标记 unknown
 * - 探测结果写入内存 statusMap，并回写 stream 的 autoOffline + lastCheckedAt
 * - 手动 offline 优先：用户手动下线的流不被探测覆盖为在线
 */
const { spawn } = require('child_process')

let timer = null
let log = { info(){}, warn(){}, error(){}, debug(){} }

// id -> { reachable, lastCheckedAt, latencyMs, detail }
const statusMap = new Map()

function getStatusMap() {
  const obj = {}
  for (const [k, v] of statusMap) obj[k] = v
  return obj
}

function isHttp(url) { return /^https?:\/\//i.test(url) }
function isRtsp(url) { return /^rtsp:\/\//i.test(url) }

// HTTP/FLV/HLS 探测：可连通即视为在线
async function probeHttp(url, timeoutMs) {
  if (typeof fetch !== 'function') return { reachable: null, detail: 'Node 不支持 fetch' }
  const ctrl = new AbortController()
  const tid = setTimeout(() => ctrl.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    // 直播流不能完整下载，用 GET + 立即 abort 的方式只验证能否建立连接拿到响应头
    const resp = await fetch(url, { method: 'GET', signal: ctrl.signal })
    clearTimeout(tid)
    const latencyMs = Date.now() - t0
    // 主动断开，避免持续拉流
    try { resp.body?.cancel?.() } catch {}
    // 2xx/3xx 视为可达；部分流媒体返回 200 持续流
    const reachable = resp.status >= 200 && resp.status < 400
    return { reachable, latencyMs, detail: `HTTP ${resp.status}` }
  } catch (e) {
    clearTimeout(tid)
    return { reachable: false, detail: e.name === 'AbortError' ? '超时' : (e.message || '连接失败') }
  }
}

// RTSP 探测：用 ffprobe（若存在）
function probeRtsp(url, timeoutMs) {
  return new Promise(resolve => {
    const t0 = Date.now()
    const args = ['-v', 'quiet', '-rtsp_transport', 'tcp', '-show_streams', '-of', 'json', url]
    let proc
    try { proc = spawn('ffprobe', args, { stdio: ['ignore', 'ignore', 'ignore'] }) }
    catch { return resolve({ reachable: null, detail: '未安装 ffprobe' }) }
    const killer = setTimeout(() => { try { proc.kill() } catch {} }, timeoutMs)
    proc.on('error', () => { clearTimeout(killer); resolve({ reachable: null, detail: '未安装 ffprobe' }) })
    proc.on('close', code => {
      clearTimeout(killer)
      resolve({ reachable: code === 0, latencyMs: Date.now() - t0, detail: code === 0 ? 'ffprobe ok' : `ffprobe exit ${code}` })
    })
  })
}

async function probeOne(stream, timeoutMs) {
  const { url } = stream
  if (!url) return { reachable: false, detail: '无地址' }
  if (isHttp(url)) return probeHttp(url, timeoutMs)
  if (isRtsp(url)) return probeRtsp(url, timeoutMs)
  return { reachable: null, detail: '不支持探测的协议' }
}

/**
 * 执行一轮探测
 * @param {Function} loadStreams 读取流列表
 * @param {Function} updateStreamStatus 按 id 更新单条状态：(id, {autoOffline,lastCheckedAt}) => void
 * @param {number} timeoutMs 单流探测超时
 */
async function runOnce(loadStreams, updateStreamStatus, timeoutMs = 8000) {
  const streams = loadStreams()
  for (const s of streams) {
    const result = await probeOne(s, timeoutMs)
    const now = new Date().toISOString()
    statusMap.set(s.id, { reachable: result.reachable, lastCheckedAt: now, latencyMs: result.latencyMs ?? null, detail: result.detail })
    // 按 id 精准更新单条，绝不整表回写——彻底避免与 CRUD 的读-改-写竞态。
    // reachable=null（无法探测，如RTSP无ffprobe）时不改 autoOffline，仅更新探测时间。
    let patch = null
    if (result.reachable === true && s.autoOffline !== false) patch = { autoOffline: false, lastCheckedAt: now }
    else if (result.reachable === false && s.autoOffline !== true) patch = { autoOffline: true, lastCheckedAt: now }
    else patch = { lastCheckedAt: now }
    try { updateStreamStatus(s.id, patch) } catch (e) { log.error('回写流状态失败[' + s.id + ']: ' + e.message) }
  }
  return statusMap
}

function start({ loadStreams, updateStreamStatus, logger, intervalMs = 60000, timeoutMs = 8000 }) {
  if (logger) log = logger
  if (timer) clearInterval(timer)
  // 启动后延迟 5 秒首探，避免和启动种子争抢
  setTimeout(() => runOnce(loadStreams, updateStreamStatus, timeoutMs).catch(e => log.error('探测异常: ' + e.message)), 5000)
  timer = setInterval(() => runOnce(loadStreams, updateStreamStatus, timeoutMs).catch(e => log.error('探测异常: ' + e.message)), intervalMs)
  log.info(`视频流探测器已启动（每 ${Math.round(intervalMs/1000)} 秒探测一次，按 id 精准更新）`)
}

function stop() { if (timer) { clearInterval(timer); timer = null } }

module.exports = { start, stop, runOnce, probeOne, getStatusMap, statusMap }
