'use strict'
/**
 * dji-openapi 接入服务（2026-08-27 数据贯通版）
 * 四通道：
 *  ① 主动 REST（司空 OpenAPI /v1/*，login-user 内部头）—— 设备/组织/任务/直播
 *  ② 实时 OSD WebSocket（/apisocket/osd?token=）—— 机场/无人机实时遥测 → target-locator 定位
 *  ③ 被动 Webhook（POST /webhook/sync，X-Event-Type + X-Signature）—— 直播/任务/文件事件
 *  ④ RTMP 直推（无人机/机场直推我方 ZLM 1936，不经司空转发）
 * 与司空2 本地化部署零冲突（隔离红线见 config.json.isolation）
 */
const http = require('http')
const path = require('path')

const config = require(path.join(__dirname, 'config.json'))
const openapi = require(path.join(__dirname, 'lib', 'openapi-client.js'))(config)
const live = require(path.join(__dirname, 'lib', 'live-manager.js'))(config)
const telemetry = require(path.join(__dirname, 'lib', 'telemetry.js'))()
const strawSync = require(path.join(__dirname, 'lib', 'straw-sync.js'))(config)
const webhook = require(path.join(__dirname, 'lib', 'webhook-handler.js'))(config)
const wsOsd = require(path.join(__dirname, 'lib', 'ws-osd-client.js'))(config, telemetry)

const state = {
  startedAt: new Date().toISOString(),
  openapi: openapi.status(),
  devices: [],
  devicesSyncedAt: null,
  isolation: config.isolation,
  webhook: webhook.status(),
  wsOsd: wsOsd.status(),
  events: [],
}

const PORT = config.port || 17810

/** 事件 ring（最近 200 条，供 /api/events） */
function pushEvent(ev) {
  state.events.push(ev)
  if (state.events.length > 200) state.events.shift()
}

function send(res, code, data) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(data, null, 2))
}

async function readBody(req) {
  let body = ''
  for await (const c of req) body += c
  return body
}

/** 设备同步（启动 + 每 60s 刷新） */
async function syncDevices() {
  const r = await openapi.syncDevices()
  if (r.ok) {
    state.devices = r.devices
    state.devicesSyncedAt = new Date().toISOString()
  } else {
    console.warn('[dji-openapi] 设备同步失败:', r.error)
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  try {
    // ③ 司空 webhook 推送接收（真实事件：POST + X-Event-Type/X-Signature）
    if ((req.method === 'POST' || req.method === 'GET') && url.pathname === '/webhook/sync') {
      const raw = req.method === 'GET' ? url.searchParams.toString() : await readBody(req)
      const result = webhook.handle(req.headers, raw)
      // 事件联动：LIVE_STATUS_CHANGE → 记录并尝试提取设备/状态（自动建流骨架，真实事件体到校准字段）
      try {
        const cls = result.classified || {}
        let body = null
        try { body = JSON.parse(String(raw)) } catch (e) {}
        const d = body && (body.data || body)
        const sn = d?.droneSn || d?.deviceSn || d?.dockSn || d?.sn || ''
        pushEvent({
          ts: new Date().toISOString(),
          type: cls.eventType || null,
          classified: cls.type || 'unknown',
          deviceSn: sn,
          detail: cls.detail || '',
          signatureOk: !!(result.signature && result.signature.ok),
        })
        if (cls.type === 'live') {
          console.log(`[webhook] 直播状态变更 sn=${sn} detail=${cls.detail}`)
        } else if (cls.type === 'task' || cls.type === 'media') {
          console.log(`[webhook] ${cls.eventType} sn=${sn} detail=${cls.detail}`)
        }
      } catch (e) { console.warn('[webhook] 事件联动处理失败:', e.message) }
      // 始终返回 200 确认，避免司空重试风暴；处理结果记录在日志/存储
      return send(res, 200, { code: 0, message: 'ok', detail: result.classified })
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      state.openapi = openapi.status()
      state.wsOsd = wsOsd.status()
      state.webhook = webhook.status()
      return send(res, 200, { ok: true, service: 'dji-openapi', ...state })
    }

    // ① 司空设备（机场+无人机，含经纬度）
    if (req.method === 'GET' && url.pathname === '/api/devices') {
      return send(res, 200, { ok: true, syncedAt: state.devicesSyncedAt, count: state.devices.length, devices: state.devices })
    }

    // ② 实时遥测（OSD）与目标定位
    if (req.method === 'GET' && url.pathname === '/api/telemetry') {
      return send(res, 200, { ok: true, telemetry: telemetry.recent() })
    }
    if (req.method === 'GET' && url.pathname === '/api/telemetry/latest') {
      return send(res, 200, { ok: true, devices: telemetry.allLatest() })
    }

    if (req.method === 'GET' && url.pathname === '/api/streams') {
      return send(res, 200, { ok: true, streams: live.list() })
    }

    // 司空事件记录（webhook 收到的事件，最近 200 条）
    if (req.method === 'GET' && url.pathname === '/api/events') {
      return send(res, 200, { ok: true, count: state.events.length, events: state.events.slice(-100).reverse() })
    }
    if (req.method === 'POST' && url.pathname === '/api/streams') {
      const { streamId, pushUrl } = JSON.parse(await readBody(req) || '{}')
      if (!streamId || !pushUrl) return send(res, 400, { ok: false, error: '需 streamId + pushUrl' })
      return send(res, 200, { ok: true, ...live.addStream(streamId, pushUrl) })
    }
    if (req.method === 'POST' && url.pathname === '/api/sync-engine') {
      const { streamId } = JSON.parse(await readBody(req) || '{}')
      const s = streamId ? live.list().find((x) => x.streamId === streamId) : live.list()[0]
      if (!s) return send(res, 400, { ok: false, error: '无直播流可同步' })
      const flvUrl = `${config.zlm.http}/${s.streamId}.live.flv`
      const add = strawSync.addStreamToEngine(s.streamId, flvUrl)
      const restart = await strawSync.restartEngine()
      return send(res, 200, { ok: true, add, restart, flvUrl })
    }

    // ① 直接代理司空 OpenAPI（透传 login-user，方便联调）
    if (req.method === 'POST' && url.pathname.startsWith('/proxy/')) {
      const apiPath = url.pathname.slice('/proxy/'.length)
      const rawBody = await readBody(req)
      const j = await openapi.proxy(apiPath, rawBody ? JSON.parse(rawBody) : {})
      return send(res, 200, j)
    }

    send(res, 404, { ok: false, error: 'not found' })
  } catch (e) {
    send(res, 500, { ok: false, error: e.message })
  }
})

// 启动：设备同步 + OSD 实时遥测
syncDevices()
setInterval(syncDevices, 60000)
wsOsd.start()

server.listen(PORT, () => {
  console.log(`[dji-openapi] 接入服务已启动 :${PORT}`)
  console.log(`[dji-openapi] ① REST: ${config.openapi.baseUrl}/v1/*（login-user 内部头）`)
  console.log(`[dji-openapi] ② OSD WebSocket: ${config.openapi.wsUrl}`)
  console.log(`[dji-openapi] ③ webhook 接收: POST /webhook/sync（X-Event-Type + X-Signature）`)
  console.log(`[dji-openapi] ④ RTMP 直推: ${config.zlm.rtmp}（我方 ZLM）`)
  console.log(`[dji-openapi] 隔离红线: 端口 ${config.isolation.forbiddenPorts.join('/')} 不占用 · systemd 非 docker`)
})
