'use strict'
// 内部端点共享密钥（供 straw-engine 读取无人机 OSD；文件优先，便于轮换）
const SECRET_INTERNAL = (() => {
  try { return require('fs').readFileSync('/opt/jsc/backend/.internal-secret', 'utf8').trim() } catch (e) { return '' }
})()
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

  // ── ④b 弹窗链路自检（诊断面板数据源，T4）──
  // 四段状态：SSE 连接数 / 最近事件源 / 拉流状态 / 司空链路。供后台诊断面板展示。
  app.get('/api/drone-events/diag', async (req, res) => {
    try {
      // 段1 SSE 连接（活跃客户端数）
      const sseClients = clients.size
      // 段2 最近事件（取最近 10 条，含事件源判断）
      const recent = db.prepare('SELECT device_sn, dock_sn, status, change_reason, event_time, whitelisted, zlm_online, created_at FROM drone_live_events ORDER BY id DESC LIMIT 10').all()
      const recentWithSource = recent.map(r => ({
        ...r,
        source: /OSD_/.test(r.change_reason || '') ? 'OSD兜底' : /SIM/.test(r.event_id || '') ? '模拟' : 'webhook',
      }))
      // 段3 拉流状态（我方 ZLM sikong_ 流在线数）
      let zlmSikongOnline = 0
      try {
        const zlm = require('./zlm.js')
        const list = await zlm.getMediaList()
        zlmSikongOnline = list.filter(m => m.app === 'jsc' && String(m.stream || '').startsWith('sikong_')).length
      } catch (e) { /* ZLM 不可达时 0 */ }
      // 段4 司空链路（dji-openapi health）
      let sikongHealth = null
      try {
        const r = await fetch('http://127.0.0.1:17810/health', { signal: AbortSignal.timeout(3000) })
        sikongHealth = r.ok ? await r.json() : null
      } catch (e) { sikongHealth = null }
      res.json({
        ok: true,
        ts: Date.now(),
        sse: { clients: sseClients },
        recent: recentWithSource,
        zlm: { sikongOnline: zlmSikongOnline },
        sikong: sikongHealth ? { up: true, wsOsd: sikongHealth.wsOsd ?? null, devices: sikongHealth.devices?.length ?? 0 } : { up: false },
      })
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message })
    }
  })

  // ── ④d 内部端点：无人机高度/垂直速度（供 straw-engine 降落判定，2026-09-11）──
  // 安全：共享密钥（/opt/jsc/backend/.internal-secret 或 env JSC_INTERNAL_SECRET），
  // 无密钥/密钥不符一律 403；路径列入 PUBLIC_PATHS 但数据仍需密钥，公网无法直接取用。
  app.get('/api/internal/drone-osd', async (req, res) => {
    try {
      const want = process.env.JSC_INTERNAL_SECRET || SECRET_INTERNAL
      const got = String(req.headers['x-internal-secret'] || req.query.secret || '')
      if (!want || got !== want) return res.status(403).json({ ok: false, error: 'forbidden' })
      const sn = String(req.query.deviceSn || '')
      if (!sn) return res.status(400).json({ ok: false, error: '缺 deviceSn' })
      const raw = await redisGet(`system:osd_dock_drone:${sn}`)
      if (!raw) return res.json({ ok: true, deviceSn: sn, online: false, height: null, verticalSpeed: null })
      let d = null
      try { d = JSON.parse(raw) } catch (e) { d = null }
      if (!d) return res.json({ ok: true, deviceSn: sn, online: false, height: null, verticalSpeed: null })
      res.json({
        ok: true, deviceSn: sn, online: true,
        height: d.height ?? null,
        verticalSpeed: d.verticalSpeed ?? null,
        horizontalSpeed: d.horizontalSpeed ?? null,
        latitude: d.latitude ?? null,
        longitude: d.longitude ?? null,
        ts: Date.now(),
      })
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message })
    }
  })

  // ── ④c 实时检测框 bbox 转发（T5 实时标框：原流 + bbox 叠加）──
  // 数据源：straw-engine /debug/snapshot 的 streams[sikong_<deviceSn>].boxes
  // 前端弹窗在原流画面上轮询（2s，与检测抽帧节奏一致）拉本接口，canvas 叠加检测框。
  app.get('/api/drone-events/bbox', async (req, res) => {
    try {
      const deviceSn = String(req.query.deviceSn || '')
      if (!deviceSn) return res.status(400).json({ ok: false, error: '缺 deviceSn' })
      const sid = `sikong_${deviceSn}`
      const r = await fetch('http://127.0.0.1:7200/debug/snapshot', { signal: AbortSignal.timeout(4000) })
      if (!r.ok) return res.status(502).json({ ok: false, error: 'straw-engine 不可达' })
      const j = await r.json()
      const streams = (j && j.streams) || {}
      const st = streams[sid] || null
      // boxes: [{cls, conf, box:[x1,y1,x2,y2]}]，顺带带回流分辨率（前端按比例缩放叠加框）
      res.json({
        ok: true,
        deviceSn,
        streamId: sid,
        streamOk: st ? !!st.stream_ok : false,
        detects: st ? st.detects || 0 : 0,
        boxes: st && Array.isArray(st.boxes) ? st.boxes : [],
        ts: Date.now(),
      })
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message })
    }
  })

  // ── ④d 机场网络流量监控（上行带宽占用 + 拥堵预警）──
  // 数据源：司空 ZLM getMediaList 的 bytesSpeed（源流码率，字节/秒）。
  // 直播流码率 = 该 dock 相关的 live 流（dock 监控流 + 无人机流）bytesSpeed 之和；
  // dock_media 录像上传 = 估算（在飞时按定档，q=3 HD1080P→2MB/s，q=4 UHD→4MB/s）。
  // 上行阈值 3MB/s（用户给定）；拥堵等级 safe(<60%)/warn(60-90%)/danger(>90%)。
  const SK_ZLM = process.env.SIKONG_ZLM_HTTP || 'http://172.28.0.90:9080'
  const SK_ZLM_SECRET = process.env.SIKONG_ZLM_SECRET || 'ibxX0tCpM0GUF9qJKaLRnnNc0LEm7YKT'
  app.get('/api/drone-events/network-status', async (req, res) => {
    try {
      const dockSn = String(req.query.dockSn || '')
      const deviceSn = String(req.query.deviceSn || '')
      if (!dockSn && !deviceSn) return res.status(400).json({ ok: false, error: '缺 dockSn/deviceSn' })

      // 1. 从司空设备目录解析 childSn（若只给了 dockSn）
      let childSn = deviceSn
      let dockName = ''
      if (!childSn || !dockName) {
        try {
          const sikong = require('./sikong.js')
          const dev = await sikong.fetchMergedDevices()
          const items = (dev && dev.items) || []
          for (const d of items) {
            if (dockSn && String(d.deviceSn) === dockSn) {
              dockName = dockName || String(d.deviceName || '')
              if (!childSn && d.drone && d.drone.droneSn) childSn = String(d.drone.droneSn)
            }
            if (!dockName && childSn && d.drone && String(d.drone.droneSn) === childSn) dockName = String(d.deviceName || '')
          }
        } catch (e) { /* 设备目录不可达时降级 */ }
      }

      // 2. 调司空 ZLM getMediaList，汇总该 dock 相关 live 流的 bytesSpeed
      const zlmUrl = `${SK_ZLM}/index/api/getMediaList?secret=${SK_ZLM_SECRET}`
      let liveBytesSpeed = 0
      let droneBytesSpeed = 0   // 无人机源流码率（判断"真在飞"的依据）
      const flowDetail = []
      try {
        const r = await fetch(zlmUrl, { signal: AbortSignal.timeout(5000) })
        const j = await r.json()
        const list = (j && j.data) || []
        const sns = new Set([dockSn, childSn].filter(Boolean))
        for (const m of list) {
          if (m.schema === 'rtmp' && m.app === 'live' && sns.has(m.stream)) {
            const bs = Number(m.bytesSpeed) || 0
            liveBytesSpeed += bs
            if (childSn && m.stream === childSn) droneBytesSpeed = bs
            flowDetail.push({ stream: m.stream, bytesSpeed: bs, aliveSecond: m.aliveSecond })
          }
        }
      } catch (e) { /* 司空 ZLM 不可达时 liveBytesSpeed=0 */ }

      // 3. dock_media 录像上传说明（修正 2026-09-08 流量虚高问题）
      // 原逻辑把"dock_media 录像上传"估算为 2~4MB/s 加进总上行，导致显示虚高（直播0.8+估算2=2.8MB/s 误报拥堵）。
      // 实际：① dock_media 录像上传不是飞行中实时占机场上行（遥控器录像滞后 6~9min 归档）；② 它走"机场→大疆云→MinIO"，
      // 不是"机场→我方服务器"的实时上行；③ 大疆厂方实测"机场上传不到 1MB"=直播流码率（司空 bytesSpeed ≈0.8MB/s），完全吻合。
      // 因此总上行只算直播流（司空 bytesSpeed 之和），不再加录像估算。
      let recordMBps = 0   // 不再估算录像上传（保留字段兼容前端，恒 0）
      let quality = null
      const flying = droneBytesSpeed > 0   // 无人机源流有码率=真在飞（dock 监控流常驻不算）

      // 4. 汇总计算（totalMBps 只算直播流，不加录像估算）
      const liveMBps = liveBytesSpeed / 1024 / 1024
      const totalMBps = liveMBps
      const uplinkMBps = 3.0
      const usagePct = Math.round((totalMBps / uplinkMBps) * 100)
      const level = usagePct >= 90 ? 'danger' : usagePct >= 60 ? 'warn' : 'safe'
      const liveKbps = Math.round(liveBytesSpeed * 8 / 1000)

      res.json({
        ok: true,
        dockSn, deviceSn: childSn, dockName,
        flying,
        liveKbps,                       // 直播流码率 kbps
        liveMBps: Math.round(liveMBps * 100) / 100,   // 直播流 MB/s
        recording: recordMBps > 0,
        recordMBps,                     // 录像上传估算 MB/s
        quality,                        // 当前定档
        totalMBps: Math.round(totalMBps * 100) / 100, // 总上行占用 MB/s
        uplinkMBps,                     // 上行阈值
        usagePct,                       // 占用百分比
        level,                          // safe/warn/danger
        flowDetail,                     // 各流明细
        ts: Date.now(),
      })
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message })
    }
  })

  // ── ④e 无人机实时 OSD（画中画小地图数据源）──
  // 数据源：司空 Redis system:osd_dock_drone:<deviceSn>（dji-openapi ws-osd 实时推送）。
  // 后端无 redis 包且生产环境不宜装第三方包，故用 node 内置 net 手写 RESP GET 客户端（只读，不重启服务）。
  const { redisGet } = require('./redis-get.js')

  app.get('/api/drone-events/osd', async (req, res) => {
    try {
      const deviceSn = String(req.query.deviceSn || '')
      if (!deviceSn) return res.status(400).json({ ok: false, error: '缺 deviceSn' })
      const raw = await redisGet(`system:osd_dock_drone:${deviceSn}`)
      if (!raw) return res.json({ ok: true, deviceSn, online: false, osd: null })
      let d = null
      try { d = JSON.parse(raw) } catch (e) { d = null }
      if (!d) return res.json({ ok: true, deviceSn, online: false, osd: null })
      // 提取小地图所需的关键字段（经纬度/高度/朝向/速度/电量/目标点）
      const payload0 = Array.isArray(d.payload) && d.payload[0] ? d.payload[0] : {}
      const battery = d.battery || {}
      const posState = d.positionState || {}
      res.json({
        ok: true,
        deviceSn,
        online: true,
        osd: {
          latitude: d.latitude ?? null,
          longitude: d.longitude ?? null,
          height: d.height ?? null,
          elevation: d.elevation ?? null,
          attitudeHead: d.attitudeHead ?? null,   // 机头朝向（画中画朝向箭头）
          attitudePitch: d.attitudePitch ?? null,
          gimbalPitch: payload0.gimbalPitch ?? null,  // 云台俯仰角
          gimbalYaw: payload0.gimbalYaw ?? null,      // 云台朝向
          horizontalSpeed: d.horizontalSpeed ?? null,
          verticalSpeed: d.verticalSpeed ?? null,
          batteryPercent: battery.capacityPercent ?? null,
          remainFlightTime: battery.remainFlightTime ?? null,
          gpsNumber: posState.gpsNumber ?? null,
          rtkNumber: posState.rtkNumber ?? null,
          windSpeed: d.windSpeed ?? null,
          measureTargetLatitude: payload0.measureTargetLatitude ?? null,   // 云台目标点（事件位置）
          measureTargetLongitude: payload0.measureTargetLongitude ?? null,
          modeCode: d.modeCode ?? null,
          ts: Date.now(),
        },
      })
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message })
    }
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
      const bboxStreamId = `straw_bbox_${deviceSn}` // straw-engine 带框流（实时标框，优先播放）
      const zlm = require('./zlm.js')
      const [online, bboxOnline, resolution, dev] = await Promise.all([
        zlm.isStreamOnline(streamId).catch(() => false),
        zlm.isStreamOnline(bboxStreamId).catch(() => false),
        zlm.getStreamResolution(streamId).catch(() => null),
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
      const hls = online ? `/jsc/${streamId}/hls.m3u8` : ''  // 相对路径：走 nginx ^~ /jsc/sikong_ 反代（6080 公网未开放，绝对地址会超时）
      const bboxHls = bboxOnline ? `/jsc/${bboxStreamId}/hls.m3u8` : ''
      // 2026-09-11：ZLM 的 HLS/TS 转发曾整体挂起（HTTP 请求超时），而 HTTP-FLV 正常。
      // 前端优先播 FLV（延迟也更低），HLS 仅作回退。
      const flv = online ? `/jsc/${streamId}.live.flv` : ''
      const bboxFlv = bboxOnline ? `/jsc/${bboxStreamId}.live.flv` : ''
      res.json({ ok: true, deviceSn, dockSn, streamId, online, hls, bboxHls, flv, bboxFlv,
                 dockName, width: resolution?.width ?? null, height: resolution?.height ?? null })
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

  // ── ⑦ OSD 轮询兜底（LIVE webhook 缺失时的可靠性兜底）──
  // 背景：弹窗依赖司空 LIVE_STATUS_CHANGE webhook，但司空有时不推该事件（如无人机仅开机未起飞、
  // 或 webhook 通道异常），导致"无人机起飞了但没弹窗"。兜底：每 10s 轮询司空 OSD 的
  // droneInDock（1=在仓 0=飞行），检测 1→0（起飞）/ 0→1（降落）变化，用 childSn 作为 deviceSn
  // 走 ingestEvent 触发弹窗（与真实 webhook 同一链路，幂等 + 白名单 + SSE 广播）。
  const OSD_POLL_MS = 10000
  const osdDockState = new Map() // dockSn -> { droneInDock:number, childSn:string }
  const droneTrail = new Map() // deviceSn -> [{lat,lon,ts},...] 飞行轨迹（保留最近 120 点，供大地图轨迹线）
  const TRAIL_MAX = 120
  const { redisGet: redisGetTrail } = require('./redis-get.js')
  async function appendTrail(deviceSn) {
    if (!deviceSn) return
    try {
      const raw = await redisGetTrail(`system:osd_dock_drone:${deviceSn}`)
      if (!raw) return
      const d = JSON.parse(raw)
      const lat = d.latitude ?? d.lat
      const lon = d.longitude ?? d.lon ?? d.lng
      if (lat == null || lon == null) return
      const arr = droneTrail.get(deviceSn) || []
      // 与上一点距离过近（<2m）则跳过，避免悬停时点堆积
      const last = arr[arr.length - 1]
      if (last) {
        const dx = (Number(lat) - last.lat) * 111320
        const dy = (Number(lon) - last.lon) * 111320 * Math.cos(last.lat * Math.PI / 180)
        if (Math.hypot(dx, dy) < 2) return
      }
      arr.push({ lat: Number(lat), lon: Number(lon), ts: Date.now() })
      if (arr.length > TRAIL_MAX) arr.splice(0, arr.length - TRAIL_MAX)
      droneTrail.set(deviceSn, arr)
    } catch (e) { /* 遥测不可达时静默 */ }
  }
  const OSD_URL = 'http://127.0.0.1:17810/api/telemetry/latest'

  async function osdPollOnce() {
    try {
      const resp = await fetch(OSD_URL, { signal: AbortSignal.timeout(5000) })
      if (!resp.ok) return
      const j = await resp.json()
      const devs = Array.isArray(j && j.devices) ? j.devices : []
      for (const d of devs) {
        const dockSn = String(d.dockSn || d.deviceSn || '')
        const childSn = String(d.childSn || '')
        if (!dockSn) continue
        const curInDock = d.droneInDock === 1 || d.droneInDock === '1' ? 1 : 0
        // 在飞无人机：累积飞行轨迹（经纬度，供大地图轨迹线）
        if (curInDock === 0 && childSn) appendTrail(childSn)
        const prev = osdDockState.get(dockSn)
        if (!prev) {
          osdDockState.set(dockSn, { droneInDock: curInDock, childSn })
          continue
        }
        // 状态变化检测
        if (prev.droneInDock !== curInDock) {
          const nowMs = Date.now()
          const deviceSn = childSn || prev.childSn || ''
          const status = curInDock === 0 ? 'LIVE_ON' : 'LIVE_OFF'
          const changeReason = curInDock === 0 ? 'OSD_TAKEOFF_FALLBACK' : 'OSD_LANDING_FALLBACK'
          if (deviceSn) {
            const body = {
              eventId: `OSD_${dockSn}_${nowMs}`,
              deviceSn, dockSn, status, changeReason, eventTime: nowMs,
              data: { deviceSn, dockSn, status, changeReason, timestamp: nowMs, osdFallback: true },
            }
            const out = await ingestEvent(body)
            if (out && out.ok && !out.duplicated) {
              log.info(`[drone-events][OSD兜底] ${dockSn} droneInDock ${prev.droneInDock}→${curInDock} → ${status} ${deviceSn} (broadcast=${out.broadcast ? 'Y' : 'N'})`)
            }
          }
          osdDockState.set(dockSn, { droneInDock: curInDock, childSn: childSn || prev.childSn })
        }
      }
    } catch (e) {
      // 司空链路不可达时静默（下次重试）
    }
  }

  // 启动 OSD 兜底轮询（10s 间隔，永不主动停止，随进程生命周期）
  setInterval(osdPollOnce, OSD_POLL_MS)
  osdPollOnce()
  log.info('[drone-events] OSD 兜底轮询已启动（10s，droneInDock 变化触发弹窗）')

  // ── ⑦ 飞行轨迹查询（大地图轨迹线数据源）──
  // 数据源：OSD 兜底轮询里对在飞无人机累积的 droneTrail（内存，保留最近 120 点）。
  app.get('/api/drone-events/trail', (req, res) => {
    const deviceSn = String(req.query.deviceSn || '')
    if (!deviceSn) return res.status(400).json({ ok: false, error: '缺 deviceSn' })
    const pts = droneTrail.get(deviceSn) || []
    res.json({ ok: true, deviceSn, count: pts.length, points: pts })
  })

  // ── ⑦b 全部在飞无人机轨迹（大地图一次拿全部）──
  app.get('/api/drone-events/trails', (req, res) => {
    const out = {}
    for (const [sn, pts] of droneTrail) { if (pts.length) out[sn] = pts }
    res.json({ ok: true, count: Object.keys(out).length, trails: out, ts: Date.now() })
  })
}
