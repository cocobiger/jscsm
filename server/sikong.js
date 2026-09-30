'use strict'
/**
 * 司空2 设备/遥测聚合代理（驾驶舱地图标注层）
 * 数据链：司空2 OpenAPI（dji-openapi:17810 四通道服务）→ 本模块聚合 → 驾驶舱前端
 *   /api/sikong/devices    5 台机场（经纬度）+ 每机 OSD 实时状态（电量/风速/温度/GPS数）
 *   /api/sikong/telemetry  全部机场最新遥测（透传 dji-openapi）
 *   /api/sikong/health     司空链路健康（openapi/wsOsd/webhook 状态，透传）
 * 隔离：只调 dji-openapi 的聚合 API，不直连司空容器。
 */
const SK_BASE = process.env.SIKONG_API_BASE || 'http://127.0.0.1:17810'
const { redisGet } = require('./redis-get.js')

async function jget(url, timeoutMs = 6000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) throw new Error(`司空链路 ${r.status}`)
  return r.json()
}

/** 机场设备 + 最新 OSD 合并（驾驶舱地图标注数据源） */
async function fetchMergedDevices() {
  const [dev, tel, remain, recentFiles] = await Promise.all([
    jget(`${SK_BASE}/api/devices`).catch(() => null),
    jget(`${SK_BASE}/api/telemetry/latest`).catch(() => null),
    jget(`${SK_BASE}/api/dock-remain-upload`).catch(() => null),
    jget(`${SK_BASE}/api/dock-recent-files?limit=3`).catch(() => null),
  ])
  const docks = (dev && dev.devices) || []
  // 上游可达性（2026-09-16）：jget 用 .catch(()=>null) 吞掉异常，若不显式上报，
  //   dji-openapi 挂掉时会返回「ok:true 且全为 0」→ 前端把"链路断"误读成"司空没有无人机"。
  //   故单独暴露 upstreamOk/degraded，供前端走「—」降级态而不是显示 0。
  const upstreamOk = !!(dev && Array.isArray(dev.devices))
  const telList = (tel && tel.devices) || []
  const remainMap = (remain && remain.remainUpload) || {}
  const recentMap = (recentFiles && recentFiles.files) || {}
  // 机场 OSD（deviceType=0，key=dockSn）+ 无人机 OSD（deviceType=1，key=childSn）
  const dockOsdMap = new Map()
  const droneOsdMap = new Map()
  for (const t of telList) {
    if (t._deviceType === 1) {
      const sn = t.childSn || t.deviceSn
      if (sn) droneOsdMap.set(sn, t)
    } else {
      const sn = t.dockSn || t.deviceSn
      if (sn) dockOsdMap.set(sn, t)
    }
  }
  // 并行读所有无人机的实时遥测（Redis system:osd_dock_drone:<droneSn>，经纬度/高度/朝向）
  // 根因修复：原从 /api/telemetry/latest 筛 deviceType=1，但该接口只返回 dock（deviceType=0），
  // droneOsdMap 永远空 → drone.lat/lon 恒 None → 大地图无人机图标不渲染。改从 Redis osd_dock_drone 读。
  const droneSnList = docks.map(d => (d.drone && d.drone.droneSn) || null)
  const droneOsdRaws = await Promise.all(droneSnList.map(sn => (sn ? redisGet(`system:osd_dock_drone:${sn}`).catch(() => null) : Promise.resolve(null))))
  const droneOsdBySn = new Map()
  droneSnList.forEach((sn, i) => {
    if (!sn) return
    const raw = droneOsdRaws[i]
    if (!raw) return
    try { droneOsdBySn.set(sn, JSON.parse(raw)) } catch (e) { }
  })

  const items = docks.map(d => {
    const droneSn = d.drone && d.drone.droneSn ? d.drone.droneSn : null
    // 无人机实时坐标（Redis osd_dock_drone 帧，含 latitude/longitude/height/attitudeHead）
    const dOsd = droneSn ? droneOsdBySn.get(droneSn) : null
    const drone = d.drone ? { ...d.drone } : null
    if (drone && dOsd) {
      const lat = dOsd.latitude ?? dOsd.lat ?? null
      const lon = dOsd.longitude ?? dOsd.lon ?? dOsd.lng ?? null
      const height = dOsd.height ?? dOsd.altitude ?? null
      if (lat != null && lon != null) {
        drone.latitude = Number(lat)
        drone.longitude = Number(lon)
        if (height != null) drone.height = Number(height)
        if (dOsd.attitudeHead != null) drone.attitudeHead = Number(dOsd.attitudeHead)
        drone.osdTs = dOsd.ts || null
      }
    }
    // 待上传文件数（remainUpload，从司空 Redis 透传）+ 最近上传文件名（MySQL system_fly_record_file）
    const osd = dockOsdMap.get(d.deviceSn) || null
    const remainVal = remainMap[d.deviceSn]
    const recent = recentMap[d.deviceSn] || []
    const osdWithRemain = osd
      ? { ...osd, remainUpload: typeof remainVal === 'number' ? remainVal : null, recentFiles: recent }
      : null
    return {
      id: d.id,
      deviceSn: d.deviceSn,
      deviceName: d.deviceName,
      latitude: Number(d.latitude),
      longitude: Number(d.longitude),
      height: d.height != null ? Number(d.height) : null,
      drone,
      osd: osdWithRemain,
    }
  })
  // 口径唯一出处（2026-09-16）：驾驶舱 KPI 的「无人机 N 架」取 droneCount、「机场 N 座」取 dockCount。
  // 为什么放后端算：项目文件 api-types.ts 约定「口径只在一处定义」，前端不再各自 filter 统计；
  //   历史坑：CenterPanel 的 uavCount 曾取 mapPoints(type='uav') 人工点位 → 恒 0，与司空台账无关。
  // 说明：司空登记里无人机与机场 1:1 配对，故 droneCount 通常等于 dockCount；
  //   droneUnpaired（有机场无无人机）正常恒为 0，非 0 说明司空侧配对异常，可作告警依据。
  const dockCount = items.length
  const droneCount = items.filter(i => i.drone && i.drone.droneSn).length
  // 「在飞 / 待命」副指标（2026-09-16）：口径必须与前端 lib/sikongStatus.ts 的 droneDockState() 一致。
  //   droneInDock: 0=不在仓(飞行中) / 1=在仓待命 / 其它或缺失=遥测未推送（**不得当成待命**）
  //   这里用 Number() 容错，避免 0/'0' 两种表示造成统计漂移。
  const dockStateOf = (i) => {
    const v = i.osd ? i.osd.droneInDock : undefined
    if (v === null || v === undefined || v === '') return 'unknown'
    const n = Number(v)
    return n === 0 ? 'flying' : n === 1 ? 'docked' : 'unknown'
  }
  const flyingCount = items.filter(i => dockStateOf(i) === 'flying').length
  const dockedCount = items.filter(i => dockStateOf(i) === 'docked').length
  const osdMissingCount = dockCount - flyingCount - dockedCount
  return {
    ok: true,
    upstreamOk,
    degraded: !upstreamOk,
    syncedAt: dev?.syncedAt || null,
    count: items.length,
    dockCount,
    droneCount,
    droneUnpaired: dockCount - droneCount,
    flyingCount,
    dockedCount,
    osdMissingCount,
    items,
  }
}

/** 告警定位解析（dji-openapi /api/target）：OSD 精确定位 → 机场坐标 → null */
async function fetchAlertTarget(streamId, timeoutMs = 2500) {
  try {
    const j = await jget(`${SK_BASE}/api/target?streamId=${encodeURIComponent(streamId)}`, timeoutMs)
    if (j && j.ok && j.target && typeof j.target.lat === 'number' && typeof j.target.lon === 'number') {
      return { lat: j.target.lat, lon: j.target.lon, source: j.source, rangeSource: j.target.rangeSource || null, deviceSn: j.deviceSn || null, droneSn: j.droneSn || null }
    }
  } catch (e) { /* 司空链路不可达时静默降级 */ }
  return null
}

function registerSikongRoutes(app) {
  app.get('/api/sikong/devices', async (req, res) => {
    try {
      res.json(await fetchMergedDevices())
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message, hint: '司空链路(dji-openapi:17810)不可达' })
    }
  })

  app.get('/api/sikong/telemetry', async (req, res) => {
    try {
      res.json(await jget(`${SK_BASE}/api/telemetry/latest`))
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message })
    }
  })

  app.get('/api/sikong/health', async (req, res) => {
    try {
      const h = await jget(`${SK_BASE}/health`)
      res.json({
        ok: true,
        openapi: h.openapi || null,
        wsOsd: h.wsOsd || null,
        webhook: h.webhook || null,
        deviceCount: Array.isArray(h.devices) ? h.devices.length : 0,
        devicesSyncedAt: h.devicesSyncedAt || null,
      })
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message })
    }
  })

  // 司空事件（直播/媒体/任务事件时间线）
  app.get('/api/sikong/events', async (req, res) => {
    try {
      res.json(await jget(`${SK_BASE}/api/events`))
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message })
    }
  })

  // 司空媒体归档（任务照片/视频/录制/OSD 记录）
  app.get('/api/sikong/media', async (req, res) => {
    try {
      const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
      res.json(await jget(`${SK_BASE}/api/media${qs}`))
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message })
    }
  })

  // 司空媒体在线播放：签发短期签名 URL（经 dji-openapi 签名，浏览器 <video> 直接播放）
  // 该端点位于 /api 全局鉴权之下（PUBLIC_PATHS 外），只有登录用户能取到可播 URL
  app.get('/api/sikong/media-sign', async (req, res) => {
    try {
      const p = String(req.query.path || '')
      if (!p) return res.status(400).json({ ok: false, error: 'missing path' })
      const j = await jget(`${SK_BASE}/api/media/sign?path=${encodeURIComponent(p)}`)
      res.json(j)
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message })
    }
  })

  // 司空 ZLM 直播流监视状态
  app.get('/api/sikong/zlm-watch', async (req, res) => {
    try {
      res.json(await jget(`${SK_BASE}/api/zlm-watch`))
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message })
    }
  })

  // 司空视频流面板数据源：5 机场/无人机 + 司空直播状态 + 我方 ZLM mirror 状态/播放地址
  app.get('/api/sikong/live-streams', async (req, res) => {
    try {
      const zlm = require('./zlm.js')
      const [dev, watch, mediaList] = await Promise.all([
        fetchMergedDevices(),
        jget(`${SK_BASE}/api/zlm-watch`).catch(() => ({ watching: [] })),
        zlm.getMediaList().catch(() => []),
      ])
      const watching = new Set(((watch && watch.watching) || []).map(w => w.stream))
      // 我方 ZLM 上的 mirror 流（app=jsc, stream=sikong_<SN>）
      const mirrorMap = new Map()
      for (const m of mediaList) {
        if (typeof m.stream === 'string' && m.stream.startsWith('sikong_')) {
          mirrorMap.set(m.stream.slice(7), m) // key = 司空 SN
        }
      }
      const items = []
      for (const d of dev.items || []) {
        const droneSn = d.drone && d.drone.droneSn ? d.drone.droneSn : null
        for (const [sn, role] of [[d.deviceSn, 'dock'], [droneSn, 'drone']]) {
          if (!sn) continue
          const mirror = mirrorMap.get(sn)
          const mirrorStream = `sikong_${sn}`
          const online = !!mirror
          items.push({
            id: mirrorStream,
            sikongSn: sn,
            role, // dock=机场 drone=无人机
            deviceName: d.deviceName,
            droneSn,
            lat: d.latitude, lon: d.longitude,
            sikongLive: watching.has(sn),          // 司空 ZLM 上正在直播
            zlm_online: online,                     // 我方 ZLM mirror 在线
            readers: mirror ? (mirror.readerCount || 0) : 0,
            osd: role === 'dock' ? (d.osd || null) : null,
            play: online && zlm.playUrls ? zlm.playUrls('jsc', mirrorStream) : null,
            snapUrl: `/api/streams/live/snap?id=${encodeURIComponent(mirrorStream)}`,
          })
        }
      }
      res.json({ ok: true, count: items.length, sikongLiveCount: items.filter(i => i.sikongLive).length, mirrorOnlineCount: items.filter(i => i.zlm_online).length, items })
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message })
    }
  })
}

module.exports = { registerSikongRoutes, fetchMergedDevices, fetchAlertTarget }
