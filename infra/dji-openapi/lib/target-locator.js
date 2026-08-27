/**
 * 目标定位模块：机体 GPS + 云台朝向 + 激光测距 → 焚烧目标经纬度
 *
 * 原理（无人机云台测距定位）：
 *   目标方位角 = 机身航向 heading + 云台相对偏航 gimbal.yaw（右正）
 *   水平距离   = 测距 range × cos(gimbal.pitch)
 *   垂直高差   = 测距 range × sin(gimbal.pitch)
 *   目标经纬度 = 机体坐标沿方位角偏移水平距离（等距投影近似，10km 内精度足够）
 *
 * 角度约定：
 *   heading / yaw：0°=正北，顺时针增大（右转正值），司空 osd 与云台数据均为该约定
 *   gimbal.pitch：水平 0°，向下为正（即向下看 45° → +45°），范围通常 -90~0（司空可能给负值，统一取绝对值向下）
 *
 * 使用：
 *   const { locateTarget } = require('./target-locator')
 *   const t = locateTarget(
 *     { lat: 30.8077, lon: 108.4076, heading: 90 },   // 机体朝正东
 *     { yaw: 0, pitch: -30 },                          // 云台正前方下俯 30°
 *     200                                              // 激光测距 200m
 *   )
 *   // → { lat, lon, hdist, voffset, bearing, altOffset }
 */

const R_EARTH = 6371000.0          // 地球平均半径（米）
const METER_PER_DEG_LAT = 111320.0 // 纬度 1° ≈ 111.32 km

function deg2rad(d) { return d * Math.PI / 180 }
function rad2deg(r) { return r * 180 / Math.PI }

/**
 * 定位目标
 * @param {Object} uav    { lat, lon, heading } lat/lon 十进制°；heading 机身航向°(0北顺时针)
 * @param {Object} gimbal { yaw, pitch }        yaw 云台相对机身偏航°(右正)；pitch 云台俯仰°(0水平，向下取正)
 * @param {number} range 激光测距距离（米）
 * @returns {{lat:number, lon:number, hdist:number, voffset:number, bearing:number, altOffset:number}}
 */
function locateTarget(uav, gimbal, range) {
  if (!uav || !gimbal || typeof range !== 'number' || !isFinite(range) || range <= 0) {
    throw new Error('locateTarget: 参数非法（需 uav{lat,lon,heading} + gimbal{yaw,pitch} + range>0）')
  }
  const { lat, lon, heading } = uav
  const { yaw, pitch } = gimbal
  if (![lat, lon, heading, yaw, pitch].every(v => typeof v === 'number' && isFinite(v))) {
    throw new Error('locateTarget: 坐标/角度必须为有限数值')
  }

  // 云台俯仰统一为"向下为正"（兼容司空可能给 0~-90 或 0~90）
  const pitchDown = Math.abs(pitch)
  if (pitchDown > 89) throw new Error('locateTarget: pitch 超出合理范围(>89°)')

  // 目标方位角（从正北顺时针）
  const bearing = (heading + yaw + 360) % 360
  const br = deg2rad(bearing)

  // 水平距离 / 垂直高差
  const hdist = range * Math.cos(deg2rad(pitchDown))
  const voffset = range * Math.sin(deg2rad(pitchDown))

  // 等距投影：沿方位角偏移
  const dLat = hdist * Math.cos(br) / METER_PER_DEG_LAT
  const dLon = hdist * Math.sin(br) / (METER_PER_DEG_LAT * Math.cos(deg2rad(lat)))
  const tLat = lat + dLat
  const tLon = lon + dLon

  return {
    lat: Number(tLat.toFixed(6)),
    lon: Number(tLon.toFixed(6)),
    hdist: Math.round(hdist),
    voffset: Math.round(voffset),
    bearing: Number(bearing.toFixed(1)),
    altOffset: Math.round(voffset), // 目标相对机体的高度偏移（米，正=低于机体）
  }
}

/** 球面距离（Haversine，米）——用于验证/回溯 */
function haversineM(aLat, aLon, bLat, bLon) {
  const dLat = deg2rad(bLat - aLat)
  const dLon = deg2rad(bLon - aLon)
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(deg2rad(aLat)) * Math.cos(deg2rad(bLat)) * Math.sin(dLon / 2) ** 2
  return 2 * R_EARTH * Math.asin(Math.sqrt(s))
}

module.exports = { locateTarget, haversineM, METER_PER_DEG_LAT }

// ---------- 自测（node lib/target-locator.js 直接运行） ----------
if (require.main === module) {
  const assert = require('assert')
  // 场景1：正东 90°、云台水平、测距 111.32m → 目标应在正东约 0.001°
  let t = locateTarget({ lat: 30.8077, lon: 108.4076, heading: 90 }, { yaw: 0, pitch: 0 }, 111.32)
  // 经度偏移 = 111.32m / (111320 × cos(30.8077°)) ≈ 0.0011645°
  assert(Math.abs(t.lon - 108.408765) < 1e-4, '场景1 lon 偏移错误')
  assert(Math.abs(t.lat - 30.8077) < 1e-6, '场景1 lat 不变')
  // 场景2：正北 0°、测距 222.64m → lat +0.002°
  t = locateTarget({ lat: 30.8077, lon: 108.4076, heading: 0 }, { yaw: 0, pitch: 0 }, 222.64)
  assert(Math.abs(t.lat - 30.8097) < 1e-4, '场景2 lat 偏移错误')
  // 场景3：正东 + 云台右偏 45° → 目标在东南方向
  t = locateTarget({ lat: 30.8077, lon: 108.4076, heading: 90 }, { yaw: 45, pitch: 0 }, 200)
  assert(t.bearing === 135, '场景3 bearing 应为135')
  assert(t.lat < 30.8077 && t.lon > 108.4076, '场景3 东南方向应 lat 减小、lon 增大')
  // 场景4：俯仰 60° 测距 200m → 水平距离 100m 垂直 173m
  t = locateTarget({ lat: 30.8077, lon: 108.4076, heading: 90 }, { yaw: 0, pitch: -60 }, 200)
  assert(Math.abs(t.hdist - 100) < 1, '场景4 水平距离应为100m')
  assert(Math.abs(t.voffset - 173) < 1, '场景4 垂直高差应为173m')
  // 场景5：Haversine 回溯一致性（水平距离 ≈ 球面距离）
  t = locateTarget({ lat: 30.8077, lon: 108.4076, heading: 33 }, { yaw: 0, pitch: 0 }, 500)
  const dist = haversineM(30.8077, 108.4076, t.lat, t.lon)
  assert(Math.abs(dist - 500) < 3, `场景5 距离回溯 ${dist} 应≈500`)
  // 场景6：非法参数
  assert.throws(() => locateTarget({ lat: 30.8077, lon: 108.4076, heading: 0 }, { yaw: 0, pitch: 0 }, -1), '场景6 应抛异常')
  console.log('✅ target-locator 全部 6 个自测通过')
  console.log('  示例:', JSON.stringify(locateTarget({ lat: 30.8077, lon: 108.4076, heading: 90 }, { yaw: 30, pitch: -30 }, 300)))
}
