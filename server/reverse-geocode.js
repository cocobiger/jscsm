// 万州乡镇边界 Point-in-Polygon 反查（离线，基于 wanzhou_towns.geojson）
// 坐标系：geojson 为 WGS84；调用方需先做 GCJ02→WGS84 归一（或直接传 WGS84）
const fs = require('fs')
const path = require('path')

let _index = null

function _build(features) {
  return (features || []).map((f) => {
    const ring = f.geometry.coordinates[0] || []
    const name = f.properties.name || ''
    const code = f.properties.division_code || ''
    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng
      if (lng > maxLng) maxLng = lng
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
    }
    return { name, code, ring, bbox: [minLng, minLat, maxLng, maxLat] }
  })
}

/**
 * 外部注入边界索引（来自 SQLite area_boundary 表），支持热刷新（不重启后端）。
 * rows: [{ town, division_code, ring(JSON数组) }]
 */
function setIndexFromRows(rows) {
  _index = (rows || []).map((r) => {
    let ring = []
    try { ring = JSON.parse(r.ring) } catch { ring = [] }
    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng
      if (lng > maxLng) maxLng = lng
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
    }
    return { name: r.town, code: r.division_code || '', ring, bbox: [minLng, minLat, maxLng, maxLat] }
  })
  return _index
}

function load() {
  if (_index) return _index
  const fp = process.env.WANZHOU_TOWNS_GEOJSON ||
    path.join(__dirname, 'data', 'wanzhou_towns.geojson')
  const raw = JSON.parse(fs.readFileSync(fp, 'utf8'))
  _index = _build(raw.features)
  return _index
}

function pointInRing(lng, lat, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1]
    const xj = ring[j][0], yj = ring[j][1]
    if ((yi > lat) !== (yj > lat) &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/** 坐标 → 乡镇/街道。返回 { name, divisionCode } 或 null */
function reverseGeocode(lng, lat) {
  const towns = load()
  for (const t of towns) {
    const [minLng, minLat, maxLng, maxLat] = t.bbox
    if (lng < minLng || lng > maxLng || lat < minLat || lat > maxLat) continue
    if (pointInRing(lng, lat, t.ring)) {
      return { name: t.name, divisionCode: t.code }
    }
  }
  return null
}

module.exports = { reverseGeocode, load, setIndexFromRows }
