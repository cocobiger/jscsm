'use strict'
/**
 * 无人机直播事件链路（弹窗需求 T1 · 决策4 dockSn 白名单）
 *
 * 数据链：
 *   司空 webhook LIVE_STATUS_CHANGE（dji-openapi:17810 收到）
 *     → POST /api/drone-events/ingest      [header: x-drone-bridge-key 内网桥接密钥]
 *     → drone_live_events 表落库（event_id 幂等）
 *     → dockSn 白名单过滤（kv_config 'drone_dock_whitelist'，精确/前缀匹配，空数组=全部放行兜底）
 *     → SSE 广播  /api/drone-events/stream?token=<会话>（仅白名单命中的事件广播，ON/OFF 均广播）
 *
 * 配套 API：
 *   GET /api/drone-events                最近事件（任意登录）
 *   GET /api/drone-events/whitelist      白名单查询（任意登录）
 *   PUT /api/drone-events/whitelist      白名单更新（默认 admin，走角色矩阵）
 *
 * 广播载荷（SSE data）：
 *   { type:'drone-live', on, eventId, deviceSn, dockSn, streamId, status,
 *     changeReason, eventTime, ts, zlm_online, whitelisted }
 */
const BRIDGE_KEY = process.env.DRONE_BRIDGE_KEY || 'jsc-drone-bridge-2026'
const WL_KEY = 'drone_dock_whitelist'
const KEEPALIVE_MS = 25000

module.exports = { registerDroneEventsRoutes, BRIDGE_KEY }

function registerDroneEventsRoutes(app, { store, log }) {
  const db = store.getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS drone_live_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id    TEXT UNIQUE DEFAULT '',
      device_sn   TEXT DEFAULT '',
      dock_sn     TEXT DEFAULT '',
      status      TEXT DEFAULT '',            -- LIVE_ON / LIVE_OFF
      change_reason TEXT DEFAULT '',
      event_time  TEXT DEFAULT '',
      stream_id   TEXT DEFAULT '',            -- sikong_<deviceSn>
      whitelisted INTEGER DEFAULT 0,          -- 0=白名单未命中（仅审计） 1=命中（广播）
      zlm_online  INTEGER DEFAULT 0,
      raw_json    TEXT DEFAULT '',
      created_at  TEXT DEFAULT (datetime('now','localtime'))
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_dle_dock ON drone_live_events(dock_sn, created_at);')
  db.exec('CREATE INDEX IF NOT EXISTS idx_dle_ctime ON drone_live_events(created_at);')

  const clients = new Set() // { res, alive }

  // ── 白名单读写（kv_config）──
  function getWhitelist() {
    const v = store.kvGet(WL_KEY)
    return Array.isArray(v) ? v.filter(Boolean) : []
  }
  function isWhitelisted(dockSn) {
    const wl = getWhitelist()
    if (!wl.length) return true // 空=不过滤（兜底：先跑通链路再收敛）
    const ds = String(dockSn || '')
    return wl.some(w => ds === w || ds.startsWith(w) || String(w).startsWith(ds))
  }

  // ── SSE 广播 ──
  function broadcast(evt) {
    const payload = `data: ${JSON.stringify(evt)}\n\n`
    let ok = 0
    for (const c of clients) {
      try { c.res.write(payload); ok++ } catch (e) { c.alive = false }
    }
    if (ok) log.info(`[drone-events] SSE 广播 ok=${ok} ${evt.deviceSn} ${evt.status}`)
    return ok
  }

  // 我方 ZLM 上 mirror 是否已在线（sikong_<SN>）
  async function zlmOnline(deviceSn) {
    try {
      const zlm = require('./zlm.js')
      return !!(await zlm.isStreamOnline(`sikong_${deviceSn}`))
    } catch (e) { return false }
  }

  // ── 事件落库 + 过滤 + 广播（幂等）──
  async function ingestEvent(raw) {
    const body = raw && typeof raw === 'object' ? raw : {}
    const data = (body.data && typeof body.data === 'object') ? body.data : {}
    const eventId = String(body.eventId || data.eventId || '')
    const deviceSn = String(body.deviceSn || data.deviceSn || '')
    const dockSn = String(body.dockSn || data.dockSn || '')
    const status = String(data.status || body.status || '')
    const changeReason = String(data.changeReason || '')
    const eventTimeMs = Number(body.eventTime || data.eventTime || data.timestamp || 0)
    if (!deviceSn || !dockSn) {
      return { ok: false, error: '缺少 deviceSn/dockSn', body }
    }
    const on = status === 'LIVE_ON' || /STARTED/i.test(changeReason)
    const streamId = `sikong_${deviceSn}`
    const evId = eventId || `${deviceSn}_${eventTimeMs || Date.now()}`

    // 幂等：同 event_id 已入库则忽略（不重复广播）
    const dup = db.prepare('SELECT id, whitelisted FROM drone_live_events WHERE event_id = ?').get(evId)
    if (dup) return { ok: true, duplicated: true, id: dup.id, deviceSn, dockSn, status }

    const wlHit = isWhitelisted(dockSn)
    const online = on ? await zlmOnline(deviceSn) : 0
    const row = {
      event_id: evId, device_sn: deviceSn, dock_sn: dockSn,
      status, change_reason: changeReason,
      event_time: eventTimeMs ? new Date(eventTimeMs).toISOString() : '',
      stream_id: streamId,
      whitelisted: wlHit ? 1 : 0, zlm_online: online ? 1 : 0,
      raw_json: JSON.stringify(body).slice(0, 2000),
    }
    const r = db.prepare(
      'INSERT INTO drone_live_events (event_id, device_sn, dock_sn, status, change_reason, event_time, stream_id, whitelisted, zlm_online, raw_json) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(row.event_id, row.device_sn, row.dock_sn, row.status, row.change_reason, row.event_time, row.stream_id, row.whitelisted, row.zlm_online, row.raw_json)
    const id = Number(r.lastInsertRowid)

    const evt = {
      type: 'drone-live',
      id,
      on: on ? 1 : 0,
      eventId: evId,
      deviceSn, dockSn, streamId,
      status, changeReason,
      eventTime: row.event_time,
      ts: Date.now(),
      zlm_online: online ? 1 : 0,
      whitelisted: wlHit ? 1 : 0,
    }
    const info = `${deviceSn} ${status} dock=${dockSn} whitelisted=${wlHit ? 'Y' : 'N'} zlm=${online ? 'Y' : 'N'}`
    if (wlHit) {
      broadcast(evt)
      log.info(`[drone-events] 事件入库并广播（id=${id}）: ${info}`)
    } else {
      log.info(`[drone-events] 事件入库（白名单外仅审计，不广播; id=${id}）: ${info}`)
    }
    return { ok: true, id, whitelisted: wlHit, deviceSn, dockSn, status, broadcast: wlHit }
  }

  // ── ① 事件接收（dji-openapi 桥接，PUBLIC + 密钥头校验）──
  app.post('/api/drone-events/ingest', async (req, res) => {
    const key = req.headers['x-drone-bridge-key'] || ''
    if (key !== BRIDGE_KEY) {
      return res.status(403).json({ ok: false, error: 'invalid bridge key' })
    }
    try {
      const out = await ingestEvent(req.body || {})
      res.json({ ok: true, ...out })
    } catch (e) {
      log.error(`[drone-events] ingest 失败: ${e.message}`)
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  // ── ② SSE 广播流（EventSource，?token= 会话）──
  app.get('/api/drone-events/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(': connected\n\n')
    const client = { res, alive: true }
    clients.add(client)
    const hb = setInterval(() => {
      if (!client.alive) { clearInterval(hb); return }
      try { res.write(': ping\n\n') } catch (e) { client.alive = false }
    }, KEEPALIVE_MS)
    req.on('close', () => {
      client.alive = false
      clearInterval(hb)
      clients.delete(client)
    })
    log.info(`[drone-events] SSE 客户端接入（当前 ${clients.size}）`)
  })

  // ── ③ 白名单查询 / 更新 ──
  app.get('/api/drone-events/whitelist', (req, res) => {
    res.json({ ok: true, whitelist: getWhitelist() })
  })
  app.put('/api/drone-events/whitelist', (req, res) => {
    const body = req.body || {}
    if (!Array.isArray(body.whitelist)) return res.status(400).json({ ok: false, error: 'whitelist 应为数组' })
    const next = body.whitelist.map(String).filter(Boolean)
    store.kvSet(WL_KEY, next)
    log.info(`[drone-events] dockSn 白名单更新为: ${next.join(', ') || '(空=全部放行)'}`)
    res.json({ ok: true, whitelist: next })
  })

  // ── ④ 事件历史 ──
  app.get('/api/drone-events', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200)
    const rows = db.prepare('SELECT id, event_id, device_sn, dock_sn, status, change_reason, event_time, stream_id, whitelisted, zlm_online, created_at FROM drone_live_events ORDER BY id DESC LIMIT ?').all(limit)
    res.json({ ok: true, count: rows.length, items: rows })
  })
}
