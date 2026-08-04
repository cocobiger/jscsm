/**
 * 高德地图引擎实现（mapAdapter 的 'amap' 后端）
 *
 * 职责：
 *   1. 动态加载高德 JS API 2.0 脚本（含 key / 安全密钥注入）
 *   2. 创建 AMap.Map 实例并包装成统一 MapHandle
 *   3. 注入高德引擎专属样式（.amap-info-* 等），卸载/隔离业务样式
 *
 * 说明：key 优先读环境变量（VITE_AMAP_KEY / VITE_AMAP_SECURITY），
 * 未配置时回退内置默认值保证开箱即用；生产建议用 .env 配置。
 */
import type { MapHandle, MapMarkerOptions, MapEvent, MapViewOptions } from './index'

declare global {
  interface Window {
    AMap: any
    _AMapSecurityConfig: { securityJsCode: string }
  }
}

const AMAP_KEY = (import.meta.env.VITE_AMAP_KEY as string) || '72b6dd5eb838c3b4fd1f9c466f48a5e2'
const AMAP_SECURITY = (import.meta.env.VITE_AMAP_SECURITY as string) || '08e88a8e76d867ec63378b39419c89f4'

/** 高德引擎专属样式（信息窗透明化、压暗 logo/版权） */
const ENGINE_CSS = `
  .amap-info-outer, .amap-info-content { padding: 0 !important; background: transparent !important; border: none !important; box-shadow: none !important; }
  .amap-info-close { display: none !important; }
  .amap-copyright, .amap-logo { opacity: 0.5 !important; filter: brightness(0.4) !important; }
`

function injectEngineCss(): void {
  if (document.getElementById('amap-engine-styles')) return
  const s = document.createElement('style')
  s.id = 'amap-engine-styles'
  s.textContent = ENGINE_CSS
  document.head.appendChild(s)
}

/** 加载高德 SDK（幂等：已加载 / 已注入均直接返回） */
export function loadAmapScript(): Promise<void> {
  if (window.AMap) return Promise.resolve()

  // 脚本已注入但 SDK 未就绪 → 轮询等待
  if (document.querySelector('script[src*="webapi.amap.com"]')) {
    return new Promise(resolve => {
      const poll = setInterval(() => {
        if (window.AMap) {
          clearInterval(poll)
          resolve()
        }
      }, 150)
    })
  }

  window._AMapSecurityConfig = { securityJsCode: AMAP_SECURITY }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${AMAP_KEY}&plugin=AMap.Scale,AMap.ToolBar`
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('高德地图 SDK 加载失败（网络不可达？）'))
    document.head.appendChild(script)
  })
}

/** 创建高德地图实例并包装为统一 MapHandle */
export function createAmapMap(el: HTMLElement, options: MapViewOptions): MapHandle {
  const AMap = window.AMap
  injectEngineCss()

  const map = new AMap.Map(el, {
    center: options.center,
    zoom: options.zoom,
    mapStyle: 'amap://styles/darkblue',
    viewMode: '2D',
    resizeEnable: true,
    doubleClickZoom: options.doubleClickZoom ?? false,
  })

  try {
    map.addControl(new AMap.Scale({ position: 'LB' }))
  } catch (_) {}

  const infoWindow = new AMap.InfoWindow({ isCustom: true, autoMove: false, offset: new AMap.Pixel(0, -10) })

  /** 收集当前标记，供 clearMarkers 统一移除 */
  const markers: any[] = []

  const wrapEvent = (e: any, cb?: (ev: MapEvent) => void) =>
    cb?.({ stopPropagation: () => e.originEvent?.stopPropagation() })

  const handle: MapHandle = {
    addMarker(opts: MapMarkerOptions) {
      const m = new AMap.Marker({
        position: [opts.lon, opts.lat],
        content: opts.html,
        anchor: opts.anchor || 'center',
        zIndex: opts.zIndex ?? 10,
      })
      m.on('mouseover', (e: any) => wrapEvent(e, opts.events?.mouseover))
      m.on('mouseout', (e: any) => wrapEvent(e, opts.events?.mouseout))
      m.on('click', (e: any) => wrapEvent(e, opts.events?.click))
      m.on('dblclick', (e: any) => wrapEvent(e, opts.events?.dblclick))
      map.add(m)
      markers.push(m)
    },

    clearMarkers() {
      if (markers.length > 0) {
        map.remove(markers)
        markers.length = 0
      }
    },

    openInfoWindow(html, lon, lat) {
      infoWindow.setContent(html)
      infoWindow.open(map, [lon, lat])
    },

    closeInfoWindow() {
      infoWindow.close()
    },

    panTo(lon, lat) {
      map.panTo([lon, lat])
    },

    setZoom(zoom, animated) {
      map.setZoom(zoom, animated)
    },

    fitView(padding) {
      map.setFitView(null, false, padding)
    },

    getCenter() {
      const c = map.getCenter()
      return { lng: c.lng, lat: c.lat }
    },

    getZoom() {
      return map.getZoom()
    },

    setZoomAndCenter(zoom, center) {
      map.setZoomAndCenter(zoom, center)
    },

    on(event, cb) {
      map.on(event, cb)
    },

    destroy() {
      try {
        map.destroy()
      } catch (_) {}
    },
  }

  return handle
}
