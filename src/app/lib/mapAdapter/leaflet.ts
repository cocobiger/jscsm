/**
 * Leaflet 引擎实现（mapAdapter 的 'leaflet' 后端）—— 离线目标（Leaflet + 天地图瓦片）
 *
 * 职责：
 *   1. 创建 Leaflet 地图实例，承载天地图瓦片双层（底图 vec_w + 注记 cva_w）
 *   2. L.divIcon 直接承载 renderMarkerIcon 的 HTML —— 脉冲/红闪动画 100% 保真
 *   3. 信息窗用 L.Popup + 透明容器，让深色玻璃卡片完全接管样式
 *   4. 瓦片 URL 模板支持 .env 覆盖：生产内网无外网时指向自托管离线瓦片
 *
 * 瓦片来源优先级：
 *   VITE_TILE_VEC_URL / VITE_TILE_CVA_URL 已配置 → 用之（如 /tiles/vec_w/{z}/{x}/{y}.png 内网离线）
 *   否则 → 回退天地图公网 WMTS（带 VITE_TIANDITU_KEY 的 tk），用于外网联调/验证
 */
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { MapHandle, MapMarkerOptions, MapEvent, MapViewOptions } from './index'

const TIANDITU_KEY = (import.meta.env.VITE_TIANDITU_KEY as string) || ''

/** 天地图公网 WMTS 模板（EPSG:3857 / WGS-84，与高德坐标一致） */
const WMTS = (layer: string) =>
  `https://t{s}.tianditu.gov.cn/${layer}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=${TIANDITU_KEY}`

/** 底图（深色滤镜）与注记瓦片模板；未配置时走公网 */
const TILE_VEC_URL = (import.meta.env.VITE_TILE_VEC_URL as string) || WMTS('vec')
const TILE_CVA_URL = (import.meta.env.VITE_TILE_CVA_URL as string) || WMTS('cva')

const ENGINE_CSS = `
  .leaflet-container { background: #040d1e; font-family: inherit; }
  .leaflet-control-attribution { background: rgba(5,15,35,0.55) !important; color: #3a5a70 !important; font-size: 9px !important; }
  .leaflet-control-attribution a { color: #4a7a9a !important; }
  /* 标记容器透明化（divIcon 默认样式可能带背景） */
  .jsc-div-icon { background: transparent !important; border: none !important; }
  /* 信息窗：容器透明，深色卡片 HTML 完全接管 */
  .jsc-info-popup .leaflet-popup-content-wrapper, .jsc-info-popup .leaflet-popup-tip {
    background: transparent !important; box-shadow: none !important; border: none !important;
  }
  .jsc-info-popup .leaflet-popup-content { margin: 0 !important; line-height: normal; max-width: none !important; }
  .jsc-info-popup a.leaflet-popup-close-button { display: none !important; }
  /* 底图深色滤镜（天地图浅色 → 驾驶舱深色风） */
  .jsc-tile-dark { filter: invert(1) hue-rotate(180deg) brightness(0.95) contrast(0.92) saturate(0.85); }
  .jsc-tile-cva { filter: invert(1) hue-rotate(180deg) brightness(0.95); }
`

function injectEngineCss(): void {
  if (document.getElementById('leaflet-engine-styles')) return
  const s = document.createElement('style')
  s.id = 'leaflet-engine-styles'
  s.textContent = ENGINE_CSS
  document.head.appendChild(s)
}

/** 从 renderMarkerIcon 的 HTML 提取图标盒宽度（用于 divIcon 尺寸/锚点） */
function parseIconWidth(html: string): number {
  const m = html.match(/width:(\d+(?:\.\d+)?)px/)
  return m ? Math.round(parseFloat(m[1])) : 26
}

export function createLeafletMap(el: HTMLElement, options: MapViewOptions): MapHandle {
  injectEngineCss()

  const map = L.map(el, {
    center: [options.center[1], options.center[0]], // [lat, lng]
    zoom: options.zoom,
    zoomControl: false, // 驾驶舱右上角有自定义帮助按钮，不显示默认控件
    doubleClickZoom: options.doubleClickZoom ?? false,
    attributionControl: true,
    maxZoom: 16,
  })

  // 底图 + 注记双层
  L.tileLayer(TILE_VEC_URL, { subdomains: '01234567', maxZoom: 16, className: 'jsc-tile-dark', attribution: '&copy; 天地图' }).addTo(map)
  L.tileLayer(TILE_CVA_URL, { subdomains: '01234567', maxZoom: 16, className: 'jsc-tile-cva', attribution: '' }).addTo(map)

  // 比例尺（对应高德 Scale LB）
  L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map)

  const markers: L.Marker[] = []
  /** 标记坐标 [lat, lng] 集合，供 fitView 计算范围 */
  const markerLatLngs: [number, number][] = []
  let popup: L.Popup | null = null

  const wrapEvent = (e: L.LeafletMouseEvent, cb?: (ev: MapEvent) => void) =>
    cb?.({ stopPropagation: () => e.originalEvent?.stopPropagation() })

  const handle: MapHandle = {
    addMarker(opts: MapMarkerOptions) {
      const w = parseIconWidth(opts.html)
      // 有名称标签时图标下方还有 label 高度（≈18px），锚点仍取图标中心，视觉与高德 anchor:center 一致
      const h = w + (opts.html.includes('position:absolute;top:') ? 18 : 0)
      const icon = L.divIcon({
        html: opts.html,
        className: 'jsc-div-icon',
        iconSize: [w, h],
        iconAnchor: [w / 2, h / 2],
      })
      const m = L.marker([opts.lat, opts.lon], {
        icon,
        zIndexOffset: ((opts.zIndex ?? 10) - 10) * 100,
        interactive: true,
      })
      m.on('mouseover', (e) => wrapEvent(e, opts.events?.mouseover))
      m.on('mouseout', (e) => wrapEvent(e, opts.events?.mouseout))
      m.on('click', (e) => wrapEvent(e, opts.events?.click))
      m.on('dblclick', (e) => wrapEvent(e, opts.events?.dblclick))
      m.addTo(map)
      markers.push(m)
      markerLatLngs.push([opts.lat, opts.lon])
    },

    clearMarkers() {
      markers.forEach(m => m.remove())
      markers.length = 0
      markerLatLngs.length = 0
    },

    openInfoWindow(html, lon, lat) {
      if (!popup) {
        popup = L.popup({
          className: 'jsc-info-popup',
          closeButton: false,
          autoPan: false,
          closeOnClick: false,
          closeOnEscapeKey: false,
          offset: [0, -6],
        })
      }
      popup.setContent(html).setLatLng([lat, lon])
      if (!popup.isOpen()) popup.openOn(map)
      else popup.update()
    },

    closeInfoWindow() {
      map.closePopup()
    },

    panTo(lon, lat) {
      map.panTo([lat, lon])
    },

    setZoom(zoom, animated) {
      map.setZoom(zoom, { animate: animated ?? true })
    },

    fitView(padding) {
      if (markerLatLngs.length === 0) return
      const bounds = L.latLngBounds(markerLatLngs)
      const p = padding ?? [40, 40, 40, 40] // [top, right, bottom, left]
      map.fitBounds(bounds, {
        paddingTopLeft: [p[3], p[0]], // [left, top]
        paddingBottomRight: [p[1], p[2]], // [right, bottom]
      })
    },

    getCenter() {
      const c = map.getCenter()
      return { lng: c.lng, lat: c.lat }
    },

    getZoom() {
      return map.getZoom()
    },

    setZoomAndCenter(zoom, center) {
      map.setView([center[1], center[0]], zoom)
    },

    on(event, cb) {
      map.on(event, cb)
    },

    destroy() {
      map.remove()
    },
  }

  return handle
}
