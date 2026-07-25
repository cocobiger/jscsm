'use strict'
/*
 * 模拟城运中心 (Mock City-Ops Center)
 * 零依赖纯 Node http 服务。用于真实模拟「智治推送」向城运中心推送事件的闭环。
 *
 * 依据《全景影像视频平台接口规范 V1.0》实现城运中心侧第三方接收接口：
 *   POST /client/handle_event        —— 摄像头识别事件推送
 *   POST /client/handle_event_other  —— 事件短视频推送
 * 响应固定: { code:200, message:"请求已成功", data:{} }
 *
 * 同时提供：事件查看 UI + 主动回执(processing/closed) 发回 JSC 的 /api/smart-push/callback。
 */

const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const PORT = parseInt(process.env.PORT || '8088', 10)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data')
const PUBLIC_DIR = path.join(__dirname, 'public')
fs.mkdirSync(DATA_DIR, { recursive: true })

const EVENTS_FILE = path.join(DATA_DIR, 'events.json')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')

// ── eventType 码 -> 中文标签（来自《全景影像视频平台接口规范 V1.0》）──
const EVENT_TYPES = {
  1: '工程车作业', 2: '工程车数量', 3: '烟尘', 4: '工地裸露地未覆盖',
  5: '生物质燃烧', 6: '烟囱烟雾', 7: '扬尘', 8: '人员入侵', 9: '卡车脏车',
  10: '脏车', 12: '建渣未覆盖', 16: '车辆冒装', 17: '工业烟羽',
}
const DEFAULT_CONFIG = {
  jscCallbackBase: 'http://127.0.0.1:7170', // JSC 回调基础地址（回执走到这里 + /api/smart-push/callback）。直连后端 loopback 最稳（:81 不代理 /api 到 JSC）。
  chengyunToken: '',                      // 若 JSC 设了 CHENGYUN_CALLBACK_TOKEN，这里填同样的值
  autoReply: 'off',                       // off | processing | closed
  autoClosedDelayMs: 5000,
}

// ── 持久化 ──
function loadEvents() {
  try { return JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8')) } catch { return [] }
}
function saveEvents() { fs.writeFileSync(EVENTS_FILE, JSON.stringify(events, null, 2)) }
function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    return Object.assign({}, DEFAULT_CONFIG, c)
  } catch { return Object.assign({}, DEFAULT_CONFIG) }
}
function saveConfig() { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)) }

let events = loadEvents()
let config = loadConfig()

function nowShanghai() {
  return new Date().toLocaleString('sv', { timeZone: 'Asia/Shanghai' }).replace('T', ' ')
}
function log(...a) { console.log(`[chengyun-mock ${nowShanghai()}]`, ...a) }

// ── HTTP 工具 ──
function send(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj)
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Push-Id,X-Callback-Token,X-Callback-Url',
  }, extraHeaders || {}))
  res.end(body)
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = ''; req.on('data', c => d += c); req.on('end', () => resolve(d))
  })
}
function parseBody(raw) {
  let b = raw
  if (typeof b === 'string') { try { b = JSON.parse(b) } catch { b = {} } }
  return (b && typeof b === 'object') ? b : {}
}
function httpPostJson(urlStr, bodyObj, headers) {
  return new Promise((resolve) => {
    let u
    try { u = new URL(urlStr) } catch (e) { return resolve({ error: 'bad url: ' + urlStr }) }
    const lib = u.protocol === 'https:' ? https : http
    const data = JSON.stringify(bodyObj)
    const opts = {
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: (u.pathname || '/') + (u.search || ''),
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers || {}),
    }
    const req = lib.request(opts, (resp) => {
      let d = ''; resp.on('data', c => d += c)
      resp.on('end', () => { let j; try { j = JSON.parse(d) } catch { j = d } resolve({ httpStatus: resp.statusCode, json: j }) })
    })
    req.on('error', e => resolve({ error: e.message }))
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')) })
    req.write(data); req.end()
  })
}

// ── 回执：把 processing / closed 发回 JSC 的 /api/smart-push/callback ──
async function sendCallback(rec, status, opts) {
  opts = opts || {}
  if (!rec.pushId) return { ok: false, error: '该事件没有 push_id（非真实智治推送，无法关联 JSC 历史）' }
  const base = (config.jscCallbackBase || 'http://127.0.0.1:81').replace(/\/+$/, '')
  const url = base + '/api/smart-push/callback'
  const body = {
    push_id: rec.pushId,
    disposal_status: status, // JSC 取 disposal_status || status
    disposal_result: opts.result || '',
    disposal_operator: opts.operator || '模拟城运中心',
    disposal_time: opts.time || nowShanghai(),
  }
  const headers = { 'X-Push-Id': String(rec.pushId) }
  if (config.chengyunToken) headers['X-Callback-Token'] = config.chengyunToken
  const r = await httpPostJson(url, body, headers)
  const entry = {
    time: nowShanghai(), status,
    result: opts.result || '', operator: opts.operator || '模拟城运中心',
    response: r,
  }
  rec.callbackHistory = rec.callbackHistory || []
  rec.callbackHistory.push(entry)
  if (!r.error && r.httpStatus && r.httpStatus < 400) {
    rec.callbackStatus = status
    rec.callbackTime = nowShanghai()
    rec.callbackResponse = r.json || { httpStatus: r.httpStatus }
  } else {
    rec.callbackResponse = r
  }
  saveEvents()
  log(`回执 ${status} pushId=${rec.pushId} ->`, JSON.stringify(r).slice(0, 200))
  return r
}
function maybeAutoReply(rec) {
  if (config.autoReply === 'processing' || config.autoReply === 'closed') {
    setTimeout(() => {
      sendCallback(rec, 'processing', {}).then(() => {
        if (config.autoReply === 'closed') {
          setTimeout(() => sendCallback(rec, 'closed', {}), parseInt(config.autoClosedDelayMs) || 5000)
        }
      })
    }, 800)
  }
}

// ── 样例事件（用于无 JSC 时也演示 UI 与回执流程）──
function buildSample() {
  const evId = 'sjzl-mock-' + Date.now()
  const pushId = 'mock-' + crypto.randomUUID().slice(0, 8)
  const svg = (label) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#1f2a44"/><text x="160" y="95" fill="#ffd166" font-size="22" text-anchor="middle" font-family="sans-serif">${label}</text><text x="160" y="125" fill="#cbd5e1" font-size="13" text-anchor="middle" font-family="sans-serif">样例图（非真实抓拍）</text></svg>`)
  return {
    eventId: evId,
    eventTime: nowShanghai(),
    cameraId: 'CAM-MOCK-001',
    eventType: 7,
    subType: 7,
    elevation: 12, azimuth: 145, absoluteZoom: 8, distance: 36,
    latitude: 108.412, longitude: 30.805,
    address: '万州区龙都街道某工地（样例）',
    eventImgSmall: svg('扬尘样例'),
    eventImgBig: svg('扬尘样例-大图'),
    watermarkImage: svg('水印'),
    count: '3', total: '5',
    presetPosNum: 'P02', presetPosName: '工地东南角',
    processEventId: '', processEventStatus: 1,
    confirm: 0,
    districtId: 500101000, districtName: '万州区',
    townId: 500101005, townName: '龙都街道',
    push_id: pushId,
    callback_url: (config.jscCallbackBase || 'http://127.0.0.1:81') + '/api/smart-push/callback',
  }
}

// ── 路由 ──
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {})
  const u = new URL(req.url, 'http://localhost')
  const p = u.pathname
  const q = u.searchParams
  try {
    // 接收：摄像头识别事件
    if (req.method === 'POST' && p === '/client/handle_event') {
      const raw = await readBody(req)
      const ev = parseBody(raw)
      if (!ev.eventId) return send(res, 400, { code: 400, message: '缺少 eventId', data: {} })
      const hdrPushId = req.headers['x-push-id']
      const hdrCbUrl = req.headers['x-callback-url']
      const rec = {
        id: crypto.randomUUID(),
        kind: 'event',
        receivedAt: nowShanghai(),
        pushId: hdrPushId || ev.push_id || ev.pushId || ev.event_id || null,
        callbackUrl: hdrCbUrl || ev.callback_url || ev.callbackUrl || null,
        raw: ev,
        eventTypeLabel: EVENT_TYPES[ev.eventType] || ('未知(' + ev.eventType + ')'),
        callbackStatus: null,
        callbackResponse: null,
        callbackTime: null,
        callbackHistory: [],
        videoUrl: null,
      }
      events.unshift(rec); saveEvents()
      log(`收到事件 ${ev.eventId} | type=${rec.eventTypeLabel} | pushId=${rec.pushId} | from=${req.socket.remoteAddress}`)
      maybeAutoReply(rec)
      return send(res, 200, { code: 200, message: '请求已成功', data: {} })
    }
    // 接收：事件短视频
    if (req.method === 'POST' && p === '/client/handle_event_other') {
      const ev = parseBody(await readBody(req))
      const ids = Array.isArray(ev.eventIds)
        ? ev.eventIds.map(String)
        : String(ev.eventIds || '').split(',').map(s => s.trim()).filter(Boolean)
      const url = ev.fileUrl || null
      const rec = {
        id: crypto.randomUUID(), kind: 'video', receivedAt: nowShanghai(),
        raw: ev, linkedEventIds: ids, videoUrl: url,
        callbackStatus: null, callbackHistory: [],
      }
      events.unshift(rec)
      let updated = 0
      for (const e of events) {
        if (e.kind === 'event' && ids.includes(String(e.raw.eventId))) { e.videoUrl = url; updated++ }
      }
      saveEvents()
      log(`收到短视频 ${ids.join(',')} | fileUrl=${url} | 关联事件 ${updated}`)
      return send(res, 200, { code: 200, message: '请求已成功', data: { updated } })
    }
    // 事件列表
    if (req.method === 'GET' && p === '/api/events') {
      let list = events.slice()
      const status = q.get('status'); const kw = (q.get('keyword') || '').trim().toLowerCase()
      const type = q.get('eventType')
      if (status) list = list.filter(e => (e.callbackStatus || 'pending') === status || (status === 'pending' && !e.callbackStatus))
      if (type) list = list.filter(e => String(e.raw && e.raw.eventType) === String(type))
      if (kw) list = list.filter(e => JSON.stringify(e.raw).toLowerCase().includes(kw) || (e.pushId || '').includes(kw))
      return send(res, 200, { total: list.length, items: list })
    }
    // 统计
    if (req.method === 'GET' && p === '/api/stats') {
      const pending = events.filter(e => e.kind === 'event' && !e.callbackStatus).length
      const processing = events.filter(e => e.callbackStatus === 'processing').length
      const closed = events.filter(e => e.callbackStatus === 'closed').length
      const videos = events.filter(e => e.kind === 'video').length
      return send(res, 200, { total: events.length, eventTotal: events.filter(e => e.kind === 'event').length, pending, processing, closed, videos })
    }
    // 清空
    if (req.method === 'DELETE' && p === '/api/events') {
      events = []; saveEvents()
      return send(res, 200, { ok: true })
    }
    // 配置读写
    if (req.method === 'GET' && p === '/api/config') return send(res, 200, config)
    if (req.method === 'POST' && p === '/api/config') {
      const b = parseBody(await readBody(req))
      for (const k of Object.keys(DEFAULT_CONFIG)) {
        if (b[k] !== undefined) {
          if (k === 'autoClosedDelayMs') config[k] = parseInt(b[k]) || DEFAULT_CONFIG[k]
          else config[k] = b[k]
        }
      }
      saveConfig()
      return send(res, 200, config)
    }
    // 样例注入
    if (req.method === 'POST' && p === '/api/sample') {
      const ev = buildSample()
      const rec = {
        id: crypto.randomUUID(), kind: 'event', receivedAt: nowShanghai(),
        pushId: ev.push_id, callbackUrl: ev.callback_url, raw: ev,
        eventTypeLabel: EVENT_TYPES[ev.eventType] || '未知',
        callbackStatus: null, callbackResponse: null, callbackTime: null, callbackHistory: [], videoUrl: null,
      }
      events.unshift(rec); saveEvents()
      log(`注入样例事件 ${ev.eventId} pushId=${ev.push_id}`)
      return send(res, 200, { code: 200, message: '样例已注入', data: { id: rec.id, pushId: rec.pushId } })
    }
    // 单条详情
    if (req.method === 'GET' && p.startsWith('/api/events/')) {
      const id = p.slice('/api/events/'.length)
      const rec = events.find(e => e.id === id)
      if (!rec) return send(res, 404, { error: 'not found' })
      return send(res, 200, rec)
    }
    // 回执
    if (req.method === 'POST' && p.match(/^\/api\/events\/[^/]+\/callback$/)) {
      const id = p.split('/')[3]
      const rec = events.find(e => e.id === id)
      if (!rec) return send(res, 404, { error: 'not found' })
      const b = parseBody(await readBody(req))
      const status = (b.status || 'processing').toLowerCase()
      const r = await sendCallback(rec, status === 'closed' ? 'closed' : 'processing', {
        result: b.disposal_result || b.result || '',
        operator: b.disposal_operator || b.operator || '模拟城运中心',
        time: b.disposal_time || b.time || nowShanghai(),
      })
      return send(res, 200, { ok: !r.error, result: r })
    }
    // 静态 UI
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const fp = path.join(PUBLIC_DIR, 'index.html')
      if (fs.existsSync(fp)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        return res.end(fs.readFileSync(fp))
      }
      return send(res, 404, { error: 'UI not found' })
    }
    return send(res, 404, { error: 'not found', path: p })
  } catch (e) {
    log('处理异常:', e && e.stack)
    return send(res, 500, { error: e.message })
  }
})

server.listen(PORT, () => {
  log(`模拟城运中心已启动 http://localhost:${PORT}  (UI 路径: / )`)
  log(`接收接口: POST /client/handle_event , POST /client/handle_event_other`)
  log(`回执基址: ${config.jscCallbackBase}  自动回执: ${config.autoReply}`)
})
