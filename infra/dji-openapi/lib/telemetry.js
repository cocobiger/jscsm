'use strict'
/**
 * 遥测入库（2026-08-27 OSD 实装版）
 * 来源：司空 OpenAPI WebSocket OSD 实时遥测（机场/无人机）
 * GPS / 云台 / 姿态 → 内存 ring buffer（后续可落 sqlite）
 * 自动定位：若遥测含 机体GPS(heading) + 云台(yaw/pitch) + 测距(range)
 *           → 用 target-locator 计算焚烧目标经纬度，附加到 entry.target
 * 用途：告警定位（阶段 2 地图打点数据源）
 */
const { locateTarget } = require('./target-locator')

module.exports = () => {
  const MAX = 500
  const ring = []

  /** 宽松取字段：支持嵌套与扁平两种 OSD 格式 */
  function pick(data, nestedPath, flatKeys) {
    let v
    for (const k of nestedPath) {
      if (data[k] != null) { v = data[k]; break }
    }
    if (v == null) {
      for (const k of flatKeys) {
        if (data[k] != null) { v = data[k]; break }
      }
    }
    return v
  }

  /** 从一条遥测提取定位所需字段并计算目标位置；返回 target 或 null */
  function resolveTarget(data) {
    const uavLat = pick(data, ['position', 'location'], ['latitude', 'lat'])
    const uavLon = pick(data, ['position', 'location'], ['longitude', 'lon', 'lng'])
    const heading = pick(data, ['attitude'], ['yaw', 'heading'])
    const gimYaw = pick(data, ['gimbal'], ['gimbal_yaw', 'gimbalYaw'])
    const gimPitch = pick(data, ['gimbal'], ['gimbal_pitch', 'gimbalPitch'])
    const range = pick(data, ['laser'], ['measure_distance', 'measureDistance', 'range', 'distance'])
    if (uavLat == null || uavLon == null || heading == null || gimYaw == null || gimPitch == null || range == null) {
      return null
    }
    try {
      const t = locateTarget(
        { lat: Number(uavLat), lon: Number(uavLon), heading: Number(heading) },
        { yaw: Number(gimYaw), pitch: Number(gimPitch) },
        Number(range)
      )
      return { ...t, range: Number(range), uavLat: Number(uavLat), uavLon: Number(uavLon), gimYaw: Number(gimYaw), gimPitch: Number(gimPitch), heading: Number(heading) }
    } catch (e) {
      return null
    }
  }

  return {
    /** 记录一条遥测（自动附带目标定位） */
    record(deviceSn, data) {
      const target = resolveTarget(data)
      const entry = { deviceSn, ts: new Date().toISOString(), ...data, target }
      ring.push(entry)
      if (ring.length > MAX) ring.splice(0, ring.length - MAX)
      return entry
    },

    /** 最近 N 条 */
    recent(limit = 100) {
      return ring.slice(-limit).reverse()
    },

    /** 某设备最新一条 */
    latest(deviceSn) {
      for (let i = ring.length - 1; i >= 0; i--) {
        if (ring[i].deviceSn === deviceSn) return ring[i]
      }
      return null
    },

    /** 某设备最近一次成功定位（target 非空） */
    latestTarget(deviceSn) {
      for (let i = ring.length - 1; i >= 0; i--) {
        if (ring[i].deviceSn === deviceSn && ring[i].target) return ring[i]
      }
      return null
    },

    /** 所有设备最新遥测（供面板展示） */
    allLatest() {
      const map = new Map()
      for (const e of ring) map.set(e.deviceSn, e)
      return Array.from(map.values())
    },
  }
}
