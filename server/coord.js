// WGS-84 <-> GCJ-02（火星坐标）转换
// 背景：底图已切换为天地图（WGS-84 瓦片），而历史点位（监测站/摄像头/告警）为
// 高德时代录入的 GCJ-02 加密坐标，直接显示会整体偏移数百米。本模块提供双向转换。
//
// 说明：GCJ-02 是国测局加密坐标（高德/腾讯/谷歌中国通用），WGS-84 为原始 GPS/天地图坐标。
// 转换算法为标准开源实现，gcj2wgs 用一阶反算近似，地图展示精度 1~2m 足够。

const PI = Math.PI
const A = 6378245.0
const EE = 0.00669342162296594323

/** 是否在中国境外（境外无偏移，直接返回原值） */
function outOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0
  ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0
  ret += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0
  return ret
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0
  ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0
  ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0
  return ret
}

/** GCJ-02 相对 WGS-84 的偏移量 */
function delta(lat, lng) {
  const dLat = transformLat(lng - 105.0, lat - 35.0)
  const dLng = transformLng(lng - 105.0, lat - 35.0)
  const radLat = (lat / 180.0) * PI
  let magic = Math.sin(radLat)
  magic = 1 - EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  return {
    lat: (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI),
    lng: (dLng * 180.0) / (A / sqrtMagic * Math.cos(radLat) * PI),
  }
}

/** WGS-84 -> GCJ-02 */
function wgs2gcj(lat, lng) {
  if (outOfChina(lat, lng)) return { lat, lon: lng }
  const d = delta(lat, lng)
  return { lat: lat + d.lat, lon: lng + d.lng }
}

/** GCJ-02 -> WGS-84（一阶反算近似） */
function gcj2wgs(lat, lng) {
  if (outOfChina(lat, lng)) return { lat, lon: lng }
  const d = delta(lat, lng)
  return { lat: lat - d.lat, lon: lng - d.lng }
}

/**
 * 按点位源坐标系转换为 WGS-84（底图坐标系）
 * @param {number} lat
 * @param {number} lng
 * @param {'gcj02'|'wgs84'} source 点位数据录入时的坐标系
 */
function toWgs84(lat, lng, source) {
  if (source === 'gcj02') return gcj2wgs(lat, lng)
  return { lat, lon: lng }
}

module.exports = { wgs2gcj, gcj2wgs, toWgs84, outOfChina }
