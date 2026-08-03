/**
 * 驾驶舱统一调色板（P0 视觉基线）
 * 与 src/styles/theme.css 中 --cockpit-* CSS 变量一一对应；
 * 组件内联样式统一从这里取色，避免散落硬编码。
 */
export const CK = {
  // 主色系
  cyan: '#00d4ff',
  cyanSoft: '#00aaff',
  blue: '#2979ff',
  amber: '#ffd740',
  green: '#00e676',
  orange: '#ff7043',
  red: '#ff4444',
  purple: '#ab47bc',
  teal: '#00bcd4',
  // 文本层级
  textMain: '#c8e6ff',
  textSub: '#7ab8e0',
  textDim: '#5a8aaa',
  textFaint: '#3a5a70',
  // 容器/背景
  panelBg: 'rgba(7, 18, 42, 0.72)',
  cardBg: 'rgba(10, 26, 56, 0.55)',
  glassBg: 'rgba(8, 20, 45, 0.55)',
  border: 'rgba(0, 180, 255, 0.22)',
  borderSoft: 'rgba(0, 150, 220, 0.12)',
} as const

export type CockpitColor = keyof typeof CK

/** 给十六进制色追加透明度（如 hexA('#00d4ff', 0.2)），与 mapIcons.hexA 同款但独立，避免跨层依赖 */
export function alpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r},${g},${b},${a})`
}
