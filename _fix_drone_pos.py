#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""修复 sikong.js fetchMergedDevices：drone.lat/lon 从 Redis osd_dock_drone 回填
根因：原逻辑从 /api/telemetry/latest 筛 deviceType=1（无人机），但该接口只返回 deviceType=0（dock），
      droneOsdMap 永远空 → drone.lat/lon 恒 None → 大地图无人机图标不渲染。
修复：改用 redis-get.js 的 redisGet 读 Redis system:osd_dock_drone:<droneSn> 回填经纬度/高度/朝向。
"""
p = 'E:/CC work/CC jsc/server/sikong.js'
s = open(p, encoding='utf-8').read()

# 1. 顶部引入 redisGet（在 jget 定义后）
old_require = "const SK_BASE = process.env.SIKONG_API_BASE || 'http://127.0.0.1:17810'"
new_require = ("const SK_BASE = process.env.SIKONG_API_BASE || 'http://127.0.0.1:17810'\n"
               "const { redisGet } = require('./redis-get.js')")
assert old_require in s, '未找到 SK_BASE 行'
s = s.replace(old_require, new_require, 1)

# 2. 替换 drone 回填逻辑：从 droneOsdMap（空）改为 Redis osd_dock_drone
old_drone = """  const items = docks.map(d => {
    const droneSn = d.drone && d.drone.droneSn ? d.drone.droneSn : null
    // 无人机实时坐标（飞行时 deviceType=1 帧，含 latitude/longitude/height）
    const dOsd = droneSn ? droneOsdMap.get(droneSn) : null
    const drone = d.drone ? { ...d.drone } : null
    if (drone && dOsd) {
      const lat = dOsd.latitude ?? dOsd.lat ?? null
      const lon = dOsd.longitude ?? dOsd.lon ?? dOsd.lng ?? null
      const height = dOsd.height ?? dOsd.altitude ?? null
      if (lat != null && lon != null) {
        drone.latitude = Number(lat)
        drone.longitude = Number(lon)
        if (height != null) drone.height = Number(height)
        drone.osdTs = dOsd.ts || null
      }
    }"""

new_drone = """  // 并行读所有无人机的实时遥测（Redis system:osd_dock_drone:<droneSn>，经纬度/高度/朝向）
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
    }"""

assert old_drone in s, '未找到 drone 回填逻辑'
s = s.replace(old_drone, new_drone, 1)

open(p, 'w', encoding='utf-8').write(s)
print('sikong.js drone.lat/lon 已改为从 Redis osd_dock_drone 回填')
