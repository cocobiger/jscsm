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

async function jget(url, timeoutMs = 6000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) throw new Error(`司空链路 ${r.status}`)
  return r.json()
}

/** 机场设备 + 最新 OSD 合并（驾驶舱地图标注数据源） */
async function fetchMergedDevices() {
  const [dev, tel] = await Promise.all([
    jget(`${SK_BASE}/api/devices`).catch(() => null),
    jget(`${SK_BASE}/api/telemetry/latest`).catch(() => null),
  ])
  const docks = (dev && dev.devices) || []
  const telMap = new Map(((tel && tel.devices) || []).map(t => [t.deviceSn, t]))
  const items = docks.map(d => ({
    id: d.id,
    deviceSn: d.deviceSn,
    deviceName: d.deviceName,
    latitude: Number(d.latitude),
    longitude: Number(d.longitude),
    height: d.height != null ? Number(d.height) : null,
    drone: d.drone || null,
    osd: telMap.get(d.deviceSn) || null,
  }))
  return { ok: true, syncedAt: dev?.syncedAt || null, count: items.length, items }
}

/** 告警定位解析（dji-openapi /api/target）：OSD 精确定位 → 机场坐标 → null */
async function fetchAlertTarget(streamId, timeoutMs = 2500) {
  try {
    const j = await jget(`${SK_BASE}/api/target?streamId=${encodeURIComponent(streamId)}`, timeoutMs)
    if (j && j.ok && j.target && typeof j.target.lat === 'number' && typeof j.target.lon === 'number') {
      return { lat: j.target.lat, lon: j.target.lon, source: j.source, deviceSn: j.deviceSn || null, droneSn: j.droneSn || null }
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
}

module.exports = { registerSikongRoutes, fetchMergedDevices, fetchAlertTarget }
