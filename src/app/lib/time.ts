/**
 * 统一时间格式化 —— 全站唯一出处（2026-09-19 P0-1）
 *
 * 🔴 铁律：一律以「上海时（UTC+8）」为基准，**不依赖设备/浏览器/服务器本地时区**。
 *   实现方式：epoch → `+8h` → 用 `getUTC*` 系列取值。
 *   **禁止**使用 `getHours()` / `toLocaleString()` 等本地时区方法（值班电脑时区一变就错）。
 *
 * 为什么需要它：后端 `created_at` / `createdAt` 存在**两种格式混存**：
 *   ① ISO UTC 串，如 `2026-09-13T11:07:19.514Z`（straw-engine 等路径产生）
 *   ② 上海本地串，如 `2026-09-19 15:37:06`（iotcloud 路径产生，无时区标记）
 *   之前页面用 `str.slice(5)` 直接切字符串 → ① 会显示成 `09-13T11:07:19.514Z`（既不是上海时、又带机器尾巴）。
 */

const pad = (n: number) => String(n).padStart(2, '0')

/** 解析任意后端时间值为 epoch(ms)；无法解析返回 NaN */
export function parseAnyTime(v: unknown): number {
  if (v === null || v === undefined || v === '') return NaN
  // Date 实例：直接取毫秒（否则 String(date) 形如 "Sun Oct 04 2026 … GMT+0800 (China Standard Time)"
  // 既不匹配带时区标记分支、也无空格可换，会被静默当解析失败而**原样返回**）
  if (v instanceof Date) { const t = v.getTime(); return Number.isFinite(t) ? t : NaN }
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v
  const s = String(v).trim()
  if (!s) return NaN
  // 纯数字串时间戳（10 位秒 / 13 位毫秒）
  if (/^\d{10,13}$/.test(s)) {
    const n = Number(s)
    return n < 1e12 ? n * 1000 : n
  }
  // 带时区标记（Z / ±hh:mm）→ 按 ISO 解析；6 位微秒裁到 3 位毫秒（兼容老式 μs 串）
  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const m = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})\.(\d{1,6})(.*)$/.exec(s)
    const iso = m ? `${m[1]}.${m[2].slice(0, 3)}${m[3]}` : s.replace(' ', 'T')
    const t = Date.parse(iso)
    return Number.isFinite(t) ? t : NaN
  }
  // 无时区标记 → **按上海时（UTC+8）**解析（与后端 parseWarningTime 口径一致）
  const t = Date.parse(s.replace(' ', 'T') + '+08:00')
  return Number.isFinite(t) ? t : NaN
}

/**
 * 格式化为上海时字符串。
 * @param v    后端时间值（ISO 串 / 本地串 / 时间戳 / 数字）
 * @param mode 'full' = `YYYY-MM-DD HH:mm:ss`（导出、详情、tooltip）
 *             'short' = `MM-DD HH:mm:ss`（列表紧凑显示）
 * 解析失败时**原样返回**（绝不显示 'Invalid Date'），便于保留现场排错。
 */
export function fmtShanghai(v: unknown, mode: 'full' | 'short' = 'full'): string {
  const ms = parseAnyTime(v)
  if (!Number.isFinite(ms)) return typeof v === 'string' ? v : ''
  const d = new Date(ms + 8 * 3600 * 1000)   // +8h 后用 getUTC* = 上海本地时间
  const ymd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  const hms = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  return mode === 'short' ? `${ymd.slice(5)} ${hms}` : `${ymd} ${hms}`
}

/** 只取日期（上海时）`YYYY-MM-DD`，解析失败返回 '' */
export function fmtShanghaiDate(v: unknown): string {
  const ms = parseAnyTime(v)
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms + 8 * 3600 * 1000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}
