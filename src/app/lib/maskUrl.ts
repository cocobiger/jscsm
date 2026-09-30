/**
 * 视频流 URL 脱敏（2026-09-16）
 *
 * 为什么必须有：
 *   `/api/streams` 的 url 实测 **22/27 路**形如 `rtsp://berfenrir:5358996w@172.16.8.50:554/…`——
 *   含明文摄像机账号口令。统计条下钻弹窗是「给人看」的界面（投屏/截图/汇报都会出现），
 *   一旦把 url 原样渲染，等于把摄像机口令展示出去。
 *
 * 铁律：任何面向界面的展示 / 导出 / 日志，都必须经过本函数；禁止直出 `stream.url`。
 */
export function maskStreamUrl(url: string | null | undefined): string {
  const s = String(url || '')
  if (!s) return '—'
  // 仅脱敏 authority 段里的 `user:pass@`
  return s.replace(/\/\/[^/@\s]+@/g, '//***:***@')
}

/** 相对时间（供"最后检测"列用）；无法解析返回 '—' */
export function relTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (isNaN(t)) return '—'
  const d = Math.max(0, now - t)
  if (d < 60_000) return `${Math.floor(d / 1000)} 秒前`
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`
  return `${Math.floor(d / 86_400_000)} 天前`
}
