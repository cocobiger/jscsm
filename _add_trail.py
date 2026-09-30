#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""后端轨迹累积 + /api/drone-events/trail 接口
1. osdPollOnce 里：对在飞无人机（droneInDock=0）用 redisGet 读 osd_dock_drone，累积位置到内存 droneTrail（保留最近 120 点）
2. 加 /api/drone-events/trail?deviceSn= 接口返回轨迹点列表
"""
p = 'E:/CC work/CC jsc/server/drone-events.js'
s = open(p, encoding='utf-8').read()

# 1. 在 osdDockState 声明后加 droneTrail Map
old_state = "  const osdDockState = new Map() // dockSn -> { droneInDock:number, childSn:string }"
new_state = ("  const osdDockState = new Map() // dockSn -> { droneInDock:number, childSn:string }\n"
             "  const droneTrail = new Map() // deviceSn -> [{lat,lon,ts},...] 飞行轨迹（保留最近 120 点，供大地图轨迹线）\n"
             "  const TRAIL_MAX = 120\n"
             "  const { redisGet: redisGetTrail } = require('./redis-get.js')\n"
             "  async function appendTrail(deviceSn) {\n"
             "    if (!deviceSn) return\n"
             "    try {\n"
             "      const raw = await redisGetTrail(`system:osd_dock_drone:${deviceSn}`)\n"
             "      if (!raw) return\n"
             "      const d = JSON.parse(raw)\n"
             "      const lat = d.latitude ?? d.lat\n"
             "      const lon = d.longitude ?? d.lon ?? d.lng\n"
             "      if (lat == null || lon == null) return\n"
             "      const arr = droneTrail.get(deviceSn) || []\n"
             "      // 与上一点距离过近（<2m）则跳过，避免悬停时点堆积\n"
             "      const last = arr[arr.length - 1]\n"
             "      if (last) {\n"
             "        const dx = (Number(lat) - last.lat) * 111320\n"
             "        const dy = (Number(lon) - last.lon) * 111320 * Math.cos(last.lat * Math.PI / 180)\n"
             "        if (Math.hypot(dx, dy) < 2) return\n"
             "      }\n"
             "      arr.push({ lat: Number(lat), lon: Number(lon), ts: Date.now() })\n"
             "      if (arr.length > TRAIL_MAX) arr.splice(0, arr.length - TRAIL_MAX)\n"
             "      droneTrail.set(deviceSn, arr)\n"
             "    } catch (e) { /* 遥测不可达时静默 */ }\n"
             "  }")
assert old_state in s, '未找到 osdDockState 行'
s = s.replace(old_state, new_state, 1)

# 2. 在 osdPollOnce 的循环里，对在飞无人机累积轨迹（curInDock===0 时 appendTrail）
old_loop = """        const prev = osdDockState.get(dockSn)
        if (!prev) {
          osdDockState.set(dockSn, { droneInDock: curInDock, childSn })
          continue
        }"""
new_loop = """        // 在飞无人机：累积飞行轨迹（经纬度，供大地图轨迹线）
        if (curInDock === 0 && childSn) appendTrail(childSn)
        const prev = osdDockState.get(dockSn)
        if (!prev) {
          osdDockState.set(dockSn, { droneInDock: curInDock, childSn })
          continue
        }"""
assert old_loop in s, '未找到 osdPollOnce 循环'
s = s.replace(old_loop, new_loop, 1)

# 3. 在 OSD 兜底轮询启动后加 /api/drone-events/trail 接口（在 setInterval(osdPollOnce) 之后）
old_start = """  // 启动 OSD 兜底轮询（10s 间隔，永不主动停止，随进程生命周期）
  setInterval(osdPollOnce, OSD_POLL_MS)
  osdPollOnce()
  log.info('[drone-events] OSD 兜底轮询已启动（10s，droneInDock 变化触发弹窗）')
}"""
new_start = """  // 启动 OSD 兜底轮询（10s 间隔，永不主动停止，随进程生命周期）
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
}"""
assert old_start in s, '未找到 OSD 兜底启动行'
s = s.replace(old_start, new_start, 1)

open(p, 'w', encoding='utf-8').write(s)
print('drone-events.js 已加轨迹累积 + /trail + /trails 接口')
