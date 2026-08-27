'use strict'
/**
 * ZLMediaKit REST API 封装
 * 文档：https://github.com/ZLMediaKit/ZLMediaKit/wiki/MediaServer支持的HTTP-API
 *
 * 核心能力：
 * - addStreamProxy：拉取 RTSP/RTMP 流并代理为 FLV/HLS/WebRTC
 * - delStreamProxy：停止代理
 * - getMediaList：查询当前活跃流
 * 配置（zlmHost/zlmPort/zlmSecret）存于 data/config.json，可热更新。
 */
const fs = require('fs')
const path = require('path')

// 完整流媒体服务器配置。zlmHost/zlmPort/zlmSecret 为核心，其余用于拼播放地址与展示。
let cfg = {
  name: 'media',            // 配置名称
  zlmHost: '127.0.0.1',     // 服务器IP
  domain: '',               // 服务器域名（填了则播放地址优先用域名）
  zlmSecret: '',            // 流媒体密钥
  scheme: 'http',           // 播放协议 http/https
  zlmPort: 6080,            // Http端口（也是 API 端口）——我方裸部署 ZLM 端口，与司空 8080 系错开
  httpsPort: 4443,          // Https端口
  rtspPort: 5540,           // Rtsp端口
  rtmpPort: 1936,           // Rtmp端口
  hookUrl: '',              // Hook 回调地址（ZLM 服务端事件回调）
  recordPort: 0,            // 录像管理端口（0=不启用）
  rtpMode: 'single',        // 收流模式 single/multi
  rtpPortRange: '',         // 多端口收流范围，如 50000-50300
  rtpPort: 0,               // 单端口收流端口
  autoConfig: true,         // 自动配置开关
}
let configFile = null
let log = { info(){}, warn(){}, error(){}, debug(){} }

// 所有可持久化字段
const CFG_KEYS = ['name', 'zlmHost', 'domain', 'zlmSecret', 'scheme', 'zlmPort', 'httpsPort',
  'rtspPort', 'rtmpPort', 'hookUrl', 'recordPort', 'rtpMode', 'rtpPortRange', 'rtpPort', 'autoConfig']
const NUM_KEYS = ['zlmPort', 'httpsPort', 'rtspPort', 'rtmpPort', 'recordPort', 'rtpPort']

function init(dataDir, logger) {
  if (logger) log = logger
  configFile = path.join(dataDir, 'config.json')
  try {
    const c = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    // 兼容旧结构：顶层 zlmHost/zlmPort/zlmSecret
    for (const k of CFG_KEYS) if (c[k] !== undefined) cfg[k] = c[k]
    // 新结构：嵌套在 zlm 字段下（优先）
    if (c.zlm && typeof c.zlm === 'object') {
      for (const k of CFG_KEYS) if (c.zlm[k] !== undefined) cfg[k] = c.zlm[k]
    }
  } catch {}
  return getConfig()
}

// 对外配置（隐藏 secret 明文，仅返回是否已配置）
function getConfig() {
  const out = { configured: !!cfg.zlmSecret }
  for (const k of CFG_KEYS) if (k !== 'zlmSecret') out[k] = cfg[k]
  return out
}

// 更新配置并持久化到 config.json 的 zlm 字段（保留 apiKey/sms 等其它字段）
function setConfig(patch = {}) {
  let full = {}
  try { full = JSON.parse(fs.readFileSync(configFile, 'utf8')) } catch {}
  if (!full.zlm || typeof full.zlm !== 'object') full.zlm = {}
  for (const k of CFG_KEYS) {
    if (patch[k] === undefined) continue
    // secret 为空串视为不修改，避免误清空
    if (k === 'zlmSecret' && (patch[k] === '' || patch[k] == null)) continue
    let v = patch[k]
    if (NUM_KEYS.includes(k)) v = Number(v) || 0
    if (k === 'autoConfig') v = !!v
    cfg[k] = v
    full.zlm[k] = v
  }
  // 清理旧的顶层字段，统一收敛到 zlm 下
  for (const k of ['zlmHost', 'zlmPort', 'zlmSecret']) delete full[k]
  try {
    const tmp = configFile + '.tmp.' + process.pid
    fs.writeFileSync(tmp, JSON.stringify(full, null, 2))
    fs.renameSync(tmp, configFile)
  } catch (e) { log.error('保存 ZLM 配置失败: ' + e.message) }
  return getConfig()
}

// API 调用始终走 http + IP（ZLM 的 HTTP-API 端口）
function base() { return `http://${cfg.zlmHost}:${cfg.zlmPort}/index/api` }

// 播放用主机名：有域名优先用域名，否则用 IP
function playHost() { return cfg.domain || cfg.zlmHost }
// 播放用 http(s) 端口
function playHttpPort() { return cfg.scheme === 'https' ? cfg.httpsPort : cfg.zlmPort }

// 调用 ZLM API（GET，参数走 query）
async function call(api, params = {}, timeout = 8000) {
  if (typeof fetch !== 'function') throw new Error('Node 不支持 fetch，请用 Node 18+')
  if (!cfg.zlmSecret) throw new Error('ZLMediaKit secret 未配置，请先在系统设置中填写')
  const qs = new URLSearchParams({ secret: cfg.zlmSecret, ...params }).toString()
  const url = `${base()}/${api}?${qs}`
  const ctrl = new AbortController()
  const tid = setTimeout(() => ctrl.abort(), timeout)
  try {
    const resp = await fetch(url, { signal: ctrl.signal })
    clearTimeout(tid)
    if (!resp.ok) throw new Error(`ZLM HTTP ${resp.status}`)
    const json = await resp.json()
    // ZLM 约定 code=0 为成功
    if (json.code !== 0) throw new Error(json.msg || `ZLM code=${json.code}`)
    return json
  } catch (e) {
    clearTimeout(tid)
    throw new Error(e.name === 'AbortError' ? 'ZLM 请求超时' : (e.message || String(e)))
  }
}

/**
 * 拉流代理：把 RTSP/RTMP 源拉进 ZLM，输出 FLV/HLS/WebRTC
 * 幂等：若该流已在线，直接返回播放地址，不重复 addStreamProxy
 * （ZLM 对已存在的流会报错，重复调用会导致上层误判失败而降级）
 * @returns 各协议播放地址
 */
async function addStreamProxy(streamId, sourceUrl, opts = {}) {
  const app = opts.app || 'jsc'
  // 已在线 → 直接返回播放地址
  try {
    if (await isStreamOnline(streamId, app)) return playUrls(app, streamId)
  } catch {}
  const params = {
    vhost: '__defaultVhost__',
    app,
    stream: streamId,
    url: sourceUrl,
    enable_hls: 1,
    enable_mp4: 0,
    rtp_type: opts.rtpType ?? 0,  // 0:tcp 1:udp
  }
  try {
    await call('addStreamProxy', params)
  } catch (e) {
    // 容错：若因"已存在"等原因失败，但流其实已在线，则视为成功
    if (await isStreamOnline(streamId, app)) return playUrls(app, streamId)
    throw e
  }
  return playUrls(app, streamId)
}

// 查询某路流是否已在 ZLM 在线
async function isStreamOnline(streamId, app = 'jsc') {
  const list = await getMediaList()
  return list.some(m => m.app === app && m.stream === streamId)
}

async function delStreamProxy(streamId, app = 'jsc') {
  // ZLM 用 key 删除，key 格式: __defaultVhost__/app/stream
  const key = `__defaultVhost__/${app}/${streamId}`
  return call('delStreamProxy', { key })
}

async function getMediaList() {
  const r = await call('getMediaList')
  return r.data || []
}

// 生成各协议播放地址（按配置的协议/域名/端口）
function playUrls(app, streamId) {
  const h = playHost()
  const hp = playHttpPort()
  const scheme = cfg.scheme === 'https' ? 'https' : 'http'
  const ws = scheme === 'https' ? 'wss' : 'ws'
  // http(s) 默认端口（80/443）时省略端口段，地址更干净
  const portSeg = (scheme === 'https' && hp === 443) || (scheme === 'http' && hp === 80) ? '' : `:${hp}`
  return {
    flv: `${scheme}://${h}${portSeg}/${app}/${streamId}.live.flv`,
    hls: `${scheme}://${h}${portSeg}/${app}/${streamId}/hls.m3u8`,
    ws_flv: `${ws}://${h}${portSeg}/${app}/${streamId}.live.flv`,
    webrtc: `${scheme}://${h}${portSeg}/index/api/webrtc?app=${app}&stream=${streamId}&type=play`,
    rtmp: `rtmp://${h}:${cfg.rtmpPort || 1935}/${app}/${streamId}`,
    rtsp: `rtsp://${h}:${cfg.rtspPort || 554}/${app}/${streamId}`,
  }
}

/** getSnap 二进制截图（内部用 cfg.zlmSecret，返回 Buffer 或 null） */
async function snapJpeg(streamId, app = 'jsc', timeoutMs = 6000) {
  if (!cfg.zlmSecret) return null
  const playUrl = `rtmp://127.0.0.1:${cfg.rtmpPort || 1936}/${app}/${streamId}`
  const qs = new URLSearchParams({ secret: cfg.zlmSecret, url: playUrl, timeout_sec: '5', expire_sec: '5' }).toString()
  try {
    const resp = await fetch(`${base()}/getSnap?${qs}`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!resp.ok) return null
    const buf = Buffer.from(await resp.arrayBuffer())
    if (buf.length < 500 || buf[0] === 0x7b) return null // JSON 错误响应
    return buf
  } catch { return null }
}

module.exports = { init, getConfig, setConfig, addStreamProxy, delStreamProxy, getMediaList, isStreamOnline, playUrls, call, snapJpeg }
