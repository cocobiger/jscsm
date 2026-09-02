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

function registerDroneEventsRoutes(app, { store, log, adminOnly }) {
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
    // 心跳：必须发「数据帧」而非注释行（缺陷②修复 2026-09-03）—— 注释行 `: ping` 到达浏览器
    // 不触发任何事件，前端 45s 看门狗无法喂狗会把健康空闲连接误判半死强重建；
    // 数据帧 `data: {...}` 触发 onmessage（type!=drone-live 被忽略但刷新存活时间），
    // 同时任意字节都刷新 nginx/代理保活窗口，一举两得。
    const hb = setInterval(() => {
      if (!client.alive) { clearInterval(hb); return }
      try { res.write('data: {"type":"ping"}\n\n') } catch (e) { client.alive = false }
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

  // ── ⑤ 单机镜像状态/播放地址/机场名（弹窗取流解析用 · 与相机 role 列表解耦）──
  // 背景：弹窗调度只消费 SSE 事件（自身 drone model），不再依赖 /api/sikong/live-streams 的
  // dock/drone role 匹配。本端点按 deviceSn 直查：我方 ZLM mirror(sikong_<SN>) 实时在线 +
  // 播放地址 + 司空设备目录中的机场名（设备目录仅“机场+挂载无人机”，无 role 概念）。
  // 鉴权：走全局 token 中间件（任意登录用户），与 GET /api/drone-events 同级。
  app.get('/api/drone-events/stream-status', async (req, res) => {
    try {
      const deviceSn = String(req.query.deviceSn || '')
      const dockSn = String(req.query.dockSn || '')
      if (!deviceSn) return res.status(400).json({ ok: false, error: '缺 deviceSn' })
      const streamId = `sikong_${deviceSn}`
      const zlm = require('./zlm.js')
      const [online, dev] = await Promise.all([
        zlm.isStreamOnline(streamId).catch(() => false),
        (async () => {
          try {
            const sikong = require('./sikong.js')
            const j = await sikong.fetchMergedDevices()
            return j && Array.isArray(j.items) ? j.items : []
          } catch (e) { return [] }
        })(),
      ])
      // 机场名：设备目录条目 deviceSn===dockSn；兜底：挂载该无人机的机场
      let dockName = ''
      for (const d of dev) {
        if (!dockName && String(d.deviceSn) === dockSn) dockName = String(d.deviceName || '')
        if (!dockName && d.drone && String(d.drone.droneSn || '') === deviceSn) dockName = String(d.deviceName || '')
      }
      const hls = online ? String((zlm.playUrls('jsc', streamId) || {}).hls || '') : ''
      res.json({ ok: true, deviceSn, dockSn, streamId, online, hls, dockName })
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message })
    }
  })

  // ── ⑥ 模拟起飞测试（T4 回归工具 · adminOnly，绝不入 PUBLIC_PATHS）──
  // 目的：无需真机即可在浏览器复现"一组真机起飞"。事件走与真实 dji-openapi webhook 完全
  // 相同的 ingestEvent() 链路（幂等 / 白名单过滤 / 落库 / SSE 广播），因此弹窗调度、刷新回灌
  // （缺陷①修复后场景：zlm_online 恒 0 → resolving→60s timeout）、SSE 断线重连（缺陷②）全部可测。
  // 防污染约定：模拟 deviceSn 强制 SIM_ 前缀；event_id 统一 SIM_ 前缀 + raw_json 含 sim:true；
  // 剧本强制 ON/OFF 成对；off-all 端点一键补 OFF 广播并删除 SIM_ 历史行。
  app.post('/api/drone-events/simulate', adminOnly, async (req, res) => {
    try {
      const b = (req.body && typeof req.body === 'object') ? req.body : {}
      const deviceSn = String(b.deviceSn || '').trim()
      const dockSn = String(b.dockSn || '').trim()
      if (!deviceSn || !dockSn) return res.status(400).json({ ok: false, error: '缺 deviceSn/dockSn' })
      if (!/^SIM_/.test(deviceSn)) return res.status(400).json({ ok: false, error: '模拟 deviceSn 必须以 SIM_ 开头（防误触真实 SN）' })
      const on = b.on === true || b.on === 1 || b.on === '1' || b.on === 'true'
      const status = on ? 'LIVE_ON' : 'LIVE_OFF'
      const reason = on ? 'SIMULATED_TAKEOFF' : 'SIMULATED_LANDING'
      const nowMs = Date.now()
      const body = {
        eventId: `SIM_${nowMs}_${deviceSn}`,
        deviceSn, dockSn, status, changeReason: reason, eventTime: nowMs,
        data: { deviceSn, dockSn, status, changeReason: reason, timestamp: nowMs, sim: true },
      }
      const out = await ingestEvent(body)
      log.info(`[drone-events][SIM] ${status} ${deviceSn} dock=${dockSn} → ${out.ok ? (out.duplicated ? 'dup(忽略)' : 'broadcast=' + (out.broadcast ? 'Y' : 'N')) : out.error}`)
      res.json({ ok: true, ...out })
    } catch (e) {
      log.error(`[drone-events][SIM] simulate 失败: ${e.message}`)
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  // 一键全部停止：所有"最新事件为 SIM_ LIVE_ON"的模拟机补发 LIVE_OFF（广播收弹窗+落库），
  // 并删除 SIM_ 历史行（防残留 ON 导致下次刷新回灌出假弹窗）。
  app.post('/api/drone-events/simulate/off-all', adminOnly, async (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT e.device_sn AS device_sn, e.dock_sn AS dock_sn
        FROM drone_live_events e
        WHERE e.event_id LIKE 'SIM_%'
          AND e.id = (SELECT MAX(id) FROM drone_live_events x
                      WHERE x.device_sn = e.device_sn AND x.event_id LIKE 'SIM_%')
          AND e.status LIKE 'LIVE_ON%'
      `).all()
      let offCount = 0
      for (const r of rows) {
        const nowMs = Date.now()
        const body = {
          eventId: `SIM_OFFALL_${nowMs}_${r.device_sn}`,
          deviceSn: r.device_sn, dockSn: r.dock_sn, status: 'LIVE_OFF',
          changeReason: 'SIMULATED_LANDING', eventTime: nowMs,
          data: { deviceSn: r.device_sn, dockSn: r.dock_sn, status: 'LIVE_OFF', changeReason: 'SIMULATED_LANDING', timestamp: nowMs, sim: true },
        }
        const out = await ingestEvent(body)
        if (out && out.ok && !out.duplicated) offCount++
      }
      const del = db.prepare("DELETE FROM drone_live_events WHERE event_id LIKE 'SIM_%'").run()
      log.info(`[drone-events][SIM] off-all: 补 OFF ${offCount} 台，清理 SIM_ 历史 ${Number(del.changes)} 行`)
      res.json({ ok: true, offCount, deleted: Number(del.changes) })
    } catch (e) {
      log.error(`[drone-events][SIM] off-all 失败: ${e.message}`)
      res.status(500).json({ ok: false, error: e.message })
    }
  })
}
