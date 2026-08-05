// 空气质量指数（AQI）分级工具 —— 纯函数，供地图时间轴/标记着色复用
// 分级与配色对齐生态环境部 HJ633-2012（AQI 0-500 六级）

export interface AqiLevel {
  /** 等级名：优/良/轻度/中度/重度/严重 */
  label: string
  /** 主题色（标记主色、时间轴圆点色） */
  color: string
  /** 等级序号 0-5（越高越差） */
  index: number
}

const LEVELS: AqiLevel[] = [
  { label: '优', color: '#00c853', index: 0 },
  { label: '良', color: '#ffd740', index: 1 },
  { label: '轻度污染', color: '#ff9800', index: 2 },
  { label: '中度污染', color: '#ff5252', index: 3 },
  { label: '重度污染', color: '#ab47bc', index: 4 },
  { label: '严重污染', color: '#d32f2f', index: 5 },
]

/** 按 AQI 值返回等级信息（默认 优） */
export function aqiLevel(aqi: number | null | undefined): AqiLevel {
  const v = Number(aqi)
  if (!isFinite(v) || v < 0) return LEVELS[0]
  if (v <= 50) return LEVELS[0]
  if (v <= 100) return LEVELS[1]
  if (v <= 150) return LEVELS[2]
  if (v <= 200) return LEVELS[3]
  if (v <= 300) return LEVELS[4]
  return LEVELS[5]
}

/** 按 AQI 值返回主题色 */
export function aqiColor(aqi: number | null | undefined): string {
  return aqiLevel(aqi).color
}
