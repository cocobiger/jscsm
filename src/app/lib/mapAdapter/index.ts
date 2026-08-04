/**
 * 地图适配层 —— 统一驾驶舱对地图引擎的访问
 *
 * 目的：把 MapView.tsx 对具体引擎（高德 AMap / 天地图 Leaflet）的直接依赖收敛到
 * 这一层，业务代码只依赖 MapHandle 接口，引擎可切换、可回退。
 *
 * 引擎注册：
 *   - 'amap'   高德 JS API 2.0（在线，现状默认）
 *   - 'leaflet' 计划中（Leaflet + 天地图瓦片，离线目标，见 outputs/电子地图离线部署方案-天地图.md）
 */
import { loadAmapScript, createAmapMap } from './amap'

export type MapEngine = 'amap' | 'leaflet'

/** 统一事件对象：业务代码用 stopPropagation() 阻断冒泡，不再接触引擎原生事件结构 */
export interface MapEvent {
  stopPropagation(): void
}

export interface MapMarkerEvents {
  mouseover?: (e: MapEvent) => void
  mouseout?: (e: MapEvent) => void
  click?: (e: MapEvent) => void
  dblclick?: (e: MapEvent) => void
}

export interface MapMarkerOptions {
  lon: number
  lat: number
  /** 自定义 HTML 标记（由 renderMarkerIcon 生成，可含动画） */
  html: string
  zIndex?: number
  anchor?: 'center'
  events?: MapMarkerEvents
}

export interface MapViewOptions {
  /** [lng, lat] */
  center: [number, number]
  zoom: number
  /** 引擎深色样式名（各引擎自行映射，未知样式回退默认） */
  style?: 'darkblue' | 'black' | 'indigo'
  doubleClickZoom?: boolean
}

export interface MapHandle {
  /** 添加一个自定义 HTML 标记 */
  addMarker(opts: MapMarkerOptions): void
  /** 移除全部标记（重绘前调用） */
  clearMarkers(): void
  /** 打开信息窗（等价引擎的 setContent + open） */
  openInfoWindow(html: string, lon: number, lat: number): void
  closeInfoWindow(): void
  panTo(lon: number, lat: number): void
  setZoom(zoom: number, animated?: boolean): void
  /** 自适应视野，让所有标记可见（padding 为 [top,right,bottom,left] 像素） */
  fitView(padding?: [number, number, number, number]): void
  getCenter(): { lng: number; lat: number }
  getZoom(): number
  setZoomAndCenter(zoom: number, center: [number, number]): void
  /** 地图级事件（关闭信息窗联动等） */
  on(event: 'click' | 'dragstart' | 'movestart' | 'zoomstart', cb: () => void): void
  destroy(): void
}

/**
 * 初始化地图（异步：先确保引擎 SDK 已加载，再创建实例）
 * @throws 引擎加载失败 / 未知引擎
 */
export async function initMap(el: HTMLElement, engine: MapEngine, options: MapViewOptions): Promise<MapHandle> {
  if (engine === 'amap') {
    await loadAmapScript()
    return createAmapMap(el, options)
  }
  if (engine === 'leaflet') {
    // 阶段 2 接入：Leaflet + 天地图瓦片（完全离线目标）
    throw new Error('map engine "leaflet" not implemented yet (planned for phase 2)')
  }
  throw new Error(`unknown map engine: ${String(engine)}`)
}

export type { MapHandle as MapHandleType }
