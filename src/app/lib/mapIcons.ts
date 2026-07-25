// 地图标注 SVG 图标库
// 每个图标提供 24x24 viewBox 的 path，渲染时注入颜色和尺寸。
// 用于地图点位/视频流分组的可自定义图标。

export interface MapIcon {
  key: string
  label: string
  /** 分类：video 视频监控 / air 大气 / water 水质 / alert 告警 / device 设备 / general 通用 */
  cat: 'video' | 'air' | 'water' | 'alert' | 'device' | 'general'
  /** 24x24 viewBox 下的 SVG 内部内容（path 等），用 currentColor 由外部上色 */
  svg: string
}

// 分类元数据（用于选择器分组显示）
export const ICON_CATEGORIES: { key: MapIcon['cat']; label: string }[] = [
  { key: 'video', label: '视频监控' },
  { key: 'air', label: '大气环境' },
  { key: 'water', label: '水环境' },
  { key: 'alert', label: '告警预警' },
  { key: 'device', label: '设备设施' },
  { key: 'general', label: '通用' },
]

// 说明：path 用 fill="currentColor"，由 renderMarkerIcon 注入实际颜色
export const MAP_ICONS: MapIcon[] = [
  { key: 'camera', label: '摄像头', cat: 'video', svg: '<path fill="currentColor" d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/>' },
  { key: 'cctv', label: '监控球机', cat: 'video', svg: '<path fill="currentColor" d="M3 3h12a2 2 0 0 1 2 2v3l4-1.5v9L17 14v3a2 2 0 0 1-2 2H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm4 8a2 2 0 1 0 4 0 2 2 0 0 0-4 0z"/>' },
  { key: 'drone', label: '无人机', cat: 'video', svg: '<path fill="currentColor" d="M4 4h3v3a3 3 0 0 1-3-3zm13 0a3 3 0 0 1-3 3V4h3zM9 8h6l1.5 3h2.5v2h-3l-2 5h-2l-2-5H4v-2h2.5L8 8h1zm1.5 3h3l-.6-1h-1.8l-.6 1z"/>' },
  { key: 'plane', label: '飞机/机场', cat: 'video', svg: '<path fill="currentColor" d="M21 16v-2l-8-5V3.5A1.5 1.5 0 0 0 11.5 2 1.5 1.5 0 0 0 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>' },
  { key: 'home', label: '监测站/房', cat: 'air', svg: '<path fill="currentColor" d="M12 3 2 12h3v8h6v-6h2v6h6v-8h3L12 3z"/>' },
  { key: 'factory', label: '工厂', cat: 'air', svg: '<path fill="currentColor" d="M2 22V10l6 4V10l6 4V4h2v18H2zm16-6h4v6h-4v-6z"/>' },
  { key: 'chimney', label: '烟囱/排放', cat: 'air', svg: '<path fill="currentColor" d="M8 22V8l3-5h2l3 5v14H8zm2-12h4V8h-4v2zM5 14c0-2 2-2 2-4H5c0 2-2 2-2 4h2zm14 0c0-2 2-2 2-4h-2c0 2-2 2-2 4h2z"/>' },
  { key: 'alert', label: '预警/警告', cat: 'alert', svg: '<path fill="currentColor" d="M12 2 1 21h22L12 2zm0 6 6.5 11h-13L12 8zm-1 4v3h2v-3h-2zm0 4v2h2v-2h-2z"/>' },
  { key: 'bell', label: '告警铃', cat: 'alert', svg: '<path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 3.5-1.5 5-2 6h18c-.5-1-2-2.5-2-6a7 7 0 0 0-7-7zM9 20a3 3 0 0 0 6 0H9z"/>' },
  { key: 'water', label: '水滴/水质', cat: 'water', svg: '<path fill="currentColor" d="M12 2s7 8 7 13a7 7 0 0 1-14 0c0-5 7-13 7-13zm0 16a4 4 0 0 0 4-4h-2a2 2 0 0 1-2 2v2z"/>' },
  { key: 'wave', label: '水体/河流', cat: 'water', svg: '<path fill="currentColor" d="M3 8c2 0 2 2 4.5 2S10 8 12 8s2 2 4.5 2S19 8 21 8v2c-2 0-2 2-4.5 2S14 10 12 10s-2 2-4.5 2S5 10 3 10V8zm0 6c2 0 2 2 4.5 2S10 14 12 14s2 2 4.5 2S19 14 21 14v2c-2 0-2 2-4.5 2S14 16 12 16s-2 2-4.5 2S5 16 3 16v-2z"/>' },
  { key: 'sensor', label: '传感器', cat: 'device', svg: '<path fill="currentColor" d="M12 8a4 4 0 0 0-4 4 4 4 0 0 0 4 4 4 4 0 0 0 4-4 4 4 0 0 0-4-4zm0 2a2 2 0 0 1 2 2 2 2 0 0 1-2 2 2 2 0 0 1-2-2 2 2 0 0 1 2-2zM5.6 5.6 7 7a7 7 0 0 0 0 10l-1.4 1.4a9 9 0 0 1 0-12.8zM18.4 5.6a9 9 0 0 1 0 12.8L17 17a7 7 0 0 0 0-10l1.4-1.4z"/>' },
  { key: 'gauge', label: '仪表/监测', cat: 'air', svg: '<path fill="currentColor" d="M12 4a9 9 0 0 0-9 9 9 9 0 0 0 1.5 5h15A9 9 0 0 0 21 13a9 9 0 0 0-9-9zm0 3a1 1 0 0 1 1 1v4l3 2-.8 1.4L11 13V8a1 1 0 0 1 1-1z"/>' },
  { key: 'radar', label: '雷达', cat: 'device', svg: '<path fill="currentColor" d="M12 2a10 10 0 1 0 10 10h-2a8 8 0 1 1-8-8V2zm0 4a6 6 0 1 0 6 6h-2a4 4 0 1 1-4-4V6zm0 4a2 2 0 1 0 2 2h-2v-2z"/>' },
  { key: 'ship', label: '船舶/港口', cat: 'device', svg: '<path fill="currentColor" d="M4 10V5h6V3h4v2h6v5l2 1-2 7H4l-2-7 2-1zm2-1 6-2 6 2V7H6v2z"/>' },
  { key: 'crane', label: '起重机/堆场', cat: 'device', svg: '<path fill="currentColor" d="M3 21V4h2v3h13L5 9v2l13-2v10H3zm14-1h4v1h-4v-1zm0-3h4v2h-4v-2z"/>' },
  { key: 'truck', label: '车辆/渣土车', cat: 'device', svg: '<path fill="currentColor" d="M3 6h11v9H3V6zm12 3h4l2 3v3h-6V9zM6.5 16a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm11 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/>' },
  { key: 'dust', label: '扬尘', cat: 'air', svg: '<path fill="currentColor" d="M6 14a4 4 0 0 1 .5-8 5 5 0 0 1 9.5 1 3.5 3.5 0 0 1 0 7H6zm-1 3h4v2H5v-2zm6 0h4v2h-4v-2zm6 0h2v2h-2v-2z"/>' },
  { key: 'leaf', label: '生态/环境', cat: 'general', svg: '<path fill="currentColor" d="M6 21c-1-5 1-13 14-15 1 9-3 15-11 15 .5-3 2-6 6-8-5 1-7 4-9 8z"/>' },
  { key: 'building', label: '楼宇/企业', cat: 'device', svg: '<path fill="currentColor" d="M4 22V3h10v6h6v13H4zm3-4h2v2H7v-2zm0-4h2v2H7v-2zm0-4h2v2H7V10zm0-4h2v2H7V6zm9 8h2v2h-2v-2zm0 4h2v2h-2v-2z"/>' },
  { key: 'pin', label: '通用定位', cat: 'general', svg: '<path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/>' },
  { key: 'dot', label: '圆点', cat: 'general', svg: '<circle cx="12" cy="12" r="6" fill="currentColor"/>' },
  // ── 细分环保设备 ──
  { key: 'incinerator', label: '垃圾焚烧', cat: 'air', svg: '<path fill="currentColor" d="M7 22V11h10v11H7zm2-13a3 3 0 0 1 1-5c-.5 2 1 2.5 1.5 4 .8-1 .5-2.5 0-3.5 2 1 3 3 2.5 5H9zm-4 4H3v-3h2v3zm16 0h-2v-3h2v3z"/>' },
  { key: 'dustcar', label: '扬尘车/雾炮车', cat: 'air', svg: '<path fill="currentColor" d="M2 8h9v7H2V8zm10 2h4l3 3v2h-7v-5zM5.5 16a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm10 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM19 7c1 0 2 .5 2.5 1.5-1 0-1.5.3-2 .8.2-.8-.2-1.6-.5-2.3zm1.5 3c1 .3 1.8 1 2 2-.9-.3-1.5-.1-2.1.2.3-.8.3-1.5.1-2.2z"/>' },
  { key: 'fogcannon', label: '雾炮', cat: 'air', svg: '<path fill="currentColor" d="M3 14V9l8-3v11l-8-3zm9-7 3-1v9l-3-1V7zm5 1.5c1.5 0 2.5 1 3 2-1-.3-1.8-.1-2.5.3.2-.9-.1-1.7-.5-2.3zm.5 3.5c1.3.4 2 1.2 2.2 2.3-.9-.4-1.6-.2-2.3.2.3-.9.3-1.7.1-2.5z"/>' },
  { key: 'hydrology', label: '水文站', cat: 'water', svg: '<path fill="currentColor" d="M4 4h2v14h15v2H4V4zm5 11 3-4 3 3 4-6v5l-4 4-3-3-3 3v-2z"/>' },
  { key: 'pump', label: '泵站/排口', cat: 'water', svg: '<path fill="currentColor" d="M11 2h2v4h4v2h-4v3h6v2h-2v8h-2v-8h-4v8H9v-8H7v-2h6V8H9V6h2V2z"/>' },
  { key: 'noise', label: '噪声监测', cat: 'device', svg: '<path fill="currentColor" d="M3 9h4l5-4v14l-5-4H3V9zm12.5-1.5a5 5 0 0 1 0 9l-1-1.7a3 3 0 0 0 0-5.6l1-1.7zM18 4a9 9 0 0 1 0 16l-1-1.7a7 7 0 0 0 0-12.6L18 4z"/>' },
  { key: 'solar', label: '太阳能/电源', cat: 'device', svg: '<path fill="currentColor" d="M11 2h2v3h-2V2zm6.7 2.9 1.4 1.4-2.1 2.1-1.4-1.4 2.1-2.1zM19 11h3v2h-3v-2zM4.9 4.9 7 7 5.6 8.4 3.5 6.3 4.9 4.9zM2 11h3v2H2v-2zm10 1a4 4 0 0 1 4 4H8a4 4 0 0 1 4-4zm-6 6h12v2H6v-2z"/>' },
  { key: 'fire', label: '秸秆焚烧/火点', cat: 'alert', svg: '<path fill="currentColor" d="M12 2c1 3-1 4-1 6 0 1 .5 2 1.5 2.5C12 9 13 8 13 7c2 2 3 4 3 7a4 4 0 0 1-8 0c0-2 1-3 2-4 .3 1.5 1 2 2 2-.5-1.5 0-3 0-3-2 1-4 3-4 5a4 4 0 0 0 8 0c0-4-3-6-4-9z"/>' },
  { key: 'gaspipe', label: '气体管网', cat: 'device', svg: '<path fill="currentColor" d="M3 7h10v3h4V7h4v3h-2v4h2v3h-4v-3h-4v3H9v-3H3v-3h4V7H3zm6 3v4h2v-4H9z"/>' },
]

export const ICON_MAP: Record<string, MapIcon> = Object.fromEntries(MAP_ICONS.map(i => [i.key, i]))

/**
 * 生成地图标注的 HTML 字符串（带方框背景 + 名称标签）
 * @param iconKey 图标 key（不存在则回退 pin）
 * @param color   主色（边框/图标）
 * @param name    下方标签文字（空则不显示）
 * @param opts    size 图标尺寸；pulse 是否脉冲动画；alert 是否告警联动（染红+红色脉冲）
 */
export function renderMarkerIcon(iconKey: string, color: string, name = '', opts: { size?: number; pulse?: boolean; alert?: boolean } = {}): string {
  const alert = !!opts.alert
  // 告警联动：图标与边框强制染红，并叠加红色脉冲动画
  const useColor = alert ? '#ff3b3b' : color
  const anim = alert
    ? 'animation:amap-alert-pulse-red 1.1s ease-in-out infinite'
    : opts.pulse ? 'animation:amap-water-pulse 2s ease-in-out infinite' : ''
  const icon = ICON_MAP[iconKey] || ICON_MAP['pin']
  const size = opts.size || 26
  const inner = Math.round(size * 0.62)
  const box = `width:${size}px;height:${size}px;background:rgba(5,15,35,0.78);border:1.5px solid ${useColor};border-radius:6px;display:flex;align-items:center;justify-content:center;box-shadow:0 0 12px ${hexA(useColor, 0.55)}${anim ? ';' + anim : ''}`
  const svg = `<svg width="${inner}" height="${inner}" viewBox="0 0 24 24" style="color:${useColor}">${icon.svg}</svg>`
  const label = name
    ? `<div style="position:absolute;top:${size + 2}px;left:50%;transform:translateX(-50%);color:${useColor};font-size:10px;white-space:nowrap;text-shadow:0 0 8px rgba(0,0,40,0.9);font-family:'Noto Sans SC',sans-serif;font-weight:600">${name}</div>`
    : ''
  return `<div style="position:relative;display:inline-block;cursor:pointer"><div style="${box}">${svg}</div>${label}</div>`
}

// 16进制颜色 + alpha → rgba()
function hexA(hex: string, a: number): string {
  const h = hex.replace('#', '')
  if (h.length !== 6) return hex
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${a})`
}

// 预设可选颜色
export const ICON_COLORS = [
  { value: '#00b84a', label: '绿' },
  { value: '#1a7fff', label: '蓝' },
  { value: '#00e5ff', label: '青' },
  { value: '#ab47bc', label: '紫' },
  { value: '#ffb300', label: '琥珀' },
  { value: '#ff7043', label: '橙' },
  { value: '#ff4444', label: '红' },
  { value: '#9e9e9e', label: '灰' },
]
