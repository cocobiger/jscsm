import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useOsdPolling } from './useOsdPolling'

/**
 * 画中画小地图（放大视频左下角）
 * 实时显示无人机位置 + 朝向箭头，地图中心跟随无人机。
 * 数据：useOsdPolling（/api/drone-events/osd，模块级单例 2s 轮询，与 LiveTextOverlay 共享）
 * 引擎：Leaflet + 天地图瓦片（与主地图一致，vec_w 底图 + cva_w 注记）
 */

const TIANDITU_KEY = (import.meta.env.VITE_TIANDITU_KEY as string) || ''
const WMTS = (layer: string) =>
  `https://t{s}.tianditu.gov.cn/${layer}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=${TIANDITU_KEY}`
const TILE_VEC_URL = (import.meta.env.VITE_TILE_VEC_URL as string) || WMTS('vec')
const TILE_CVA_URL = (import.meta.env.VITE_TILE_CVA_URL as string) || WMTS('cva')

const CYAN = '#00e5ff'
const MONO = "'JetBrains Mono','Courier New',monospace"

/** 无人机位置标记（脉动圆点 + 朝向箭头，按 attitudeHead 旋转） */
function droneIcon(headDeg: number): L.DivIcon {
  const rot = ((headDeg ?? 0) + 360) % 360
  return L.divIcon({
    className: 'jsc-div-icon',
    html: `
      <div style="position:relative;width:40px;height:40px;transform:translate(-50%,-50%);">
        <div style="position:absolute;left:50%;top:50%;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:50%;background:${CYAN};box-shadow:0 0 8px ${CYAN};animation:mini-drone-pulse 1.6s ease-out infinite;"></div>
        <div style="position:absolute;left:50%;top:50%;width:0;height:0;margin:-20px 0 0 -6px;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:16px solid ${CYAN};transform-origin:50% 20px;transform:rotate(${rot}deg);filter:drop-shadow(0 0 3px ${CYAN});"></div>
      </div>`,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  })
}

const MINI_CSS = `
  @keyframes mini-drone-pulse {
    0% { box-shadow: 0 0 0 0 rgba(0,229,255,0.6); }
    100% { box-shadow: 0 0 0 14px rgba(0,229,255,0); }
  }
  .mini-drone-map .leaflet-control-zoom { display: none; }
  .mini-drone-map .leaflet-control-attribution { font-size: 8px !important; background: rgba(5,15,35,0.5) !important; color: #3a5a70 !important; }
  .mini-drone-map .leaflet-control-attribution a { color: #4a7a9a !important; }
  .mini-drone-map .jsc-tile-dark { filter: invert(1) hue-rotate(180deg) brightness(0.95) contrast(0.92) saturate(0.85); }
  .mini-drone-map .jsc-tile-cva { filter: invert(1) hue-rotate(180deg) brightness(0.95); }
`

export function MiniDroneMap({ deviceSn, enabled }: { deviceSn: string; enabled: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markerRef = useRef<L.Marker | null>(null)
  const osd = useOsdPolling(deviceSn, enabled)   // 共用单例轮询（批1-1）
  const [ready, setReady] = useState(false)

  // 注入小地图 CSS（一次性）
  useEffect(() => {
    if (!document.getElementById('mini-drone-map-styles')) {
      const s = document.createElement('style')
      s.id = 'mini-drone-map-styles'
      s.textContent = MINI_CSS
      document.head.appendChild(s)
    }
  }, [])

  // 初始化小地图
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return
    const map = L.map(containerRef.current, {
      center: [30.8077, 108.4076],
      zoom: 13,
      zoomControl: false,   // 自绘 +/- 按钮（贴合 UI 风格）
      minZoom: 12,          // 220px 小图防缩到全国
      attributionControl: true,
      dragging: false,                                  // A1 范围：不做拖拽平移，中心始终跟随无人机
      scrollWheelZoom: true,                            // 滚轮缩放（用户缩放等级由 setView(latlng, map.getZoom()) 天然保留）
      doubleClickZoom: true,
      boxZoom: false,
      keyboard: false,
      touchZoom: true,
    })
    L.tileLayer(TILE_VEC_URL, { subdomains: '01234567', maxZoom: 16, className: 'jsc-tile-dark', attribution: '&copy; 天地图' }).addTo(map)
    L.tileLayer(TILE_CVA_URL, { subdomains: '01234567', maxZoom: 16, className: 'jsc-tile-cva', attribution: '' }).addTo(map)
    mapRef.current = map
    setReady(true)
    return () => {
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null }
      markerRef.current = null
    }
  }, [])

  // 渲染无人机位置 + 朝向 + 跟随
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map || !osd || !osd.online || !osd.osd) return
    const { latitude, longitude, attitudeHead } = osd.osd
    if (latitude == null || longitude == null) return
    const latlng: L.LatLngExpression = [latitude, longitude]
    if (!markerRef.current) {
      markerRef.current = L.marker(latlng, { icon: droneIcon(attitudeHead ?? 0) }).addTo(map)
    } else {
      markerRef.current.setLatLng(latlng)
      markerRef.current.setIcon(droneIcon(attitudeHead ?? 0))
    }
    // 地图中心跟随（保持无人机在视野中心）
    map.setView(latlng, map.getZoom(), { animate: false })
  }, [ready, osd])

  const h = osd?.osd?.height
  const spd = osd?.osd?.horizontalSpeed
  const bat = osd?.osd?.batteryPercent
  const [hovered, setHovered] = useState(false)

  /** 阻断冒泡：地图上的滚轮/点击/双击不得触发全屏层关闭（外层 onClick=关闭） */
  const swallow = (e: React.SyntheticEvent) => e.stopPropagation()

  return (
    <div style={{ position: 'absolute', left: 10, bottom: 10, zIndex: 20, pointerEvents: 'none' }}>
      <div
        className="mini-drone-map"
        ref={containerRef}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={swallow} onWheel={swallow} onDoubleClick={swallow} onMouseDown={swallow}
        style={{
          width: 220, height: 160, borderRadius: 6, overflow: 'hidden',
          border: hovered ? '1px solid #00e5ff' : '1px solid rgba(0,170,255,0.4)',
          boxShadow: hovered ? '0 4px 18px rgba(0,0,0,0.6)' : '0 4px 16px rgba(0,0,0,0.5)',
          background: '#040d1e',
          pointerEvents: 'auto',   // B1 常开：hover 即可滚轮缩放（角标区仍 pointerEvents:none 不挡）
          cursor: hovered ? 'crosshair' : 'default',
          transition: 'border-color 0.15s, box-shadow 0.15s',
        }}
      />
      {/* 自绘缩放按钮（+/-，右下角；触屏/无滚轮备用） */}
      <div style={{ position: 'absolute', right: 4, top: 4, display: 'flex', flexDirection: 'column', gap: 3, pointerEvents: 'auto' }}
        onClick={swallow} onWheel={swallow}>
        {(['+', '−'] as const).map(sym => (
          <button
            key={sym}
            onClick={(e) => { e.stopPropagation(); const m = mapRef.current; if (!m) return; sym === '+' ? m.zoomIn() : m.zoomOut() }}
            title={sym === '+' ? '放大地图' : '缩小地图'}
            style={{
              width: 20, height: 20, borderRadius: 3, border: '1px solid rgba(0,170,255,0.5)',
              background: 'rgba(4,14,30,0.8)', color: CYAN, cursor: 'pointer',
              fontSize: 13, lineHeight: 1, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: MONO,
            }}
          >{sym}</button>
        ))}
      </div>
      {/* 信息角标（高度/速度/电量） */}
      <div style={{
        position: 'absolute', left: 4, bottom: 4, display: 'flex', gap: 6,
        fontSize: 9, fontFamily: "'JetBrains Mono',monospace", color: CYAN,
        background: 'rgba(4,14,30,0.75)', padding: '1px 6px', borderRadius: 3,
      }}>
        {h != null && <span>H {h.toFixed(0)}m</span>}
        {spd != null && <span>V {spd.toFixed(1)}m/s</span>}
        {bat != null && <span>⚡{bat}%</span>}
      </div>
    </div>
  )
}
