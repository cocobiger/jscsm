// T18: 误报归因徽标判定 —— 兼容两套 review 语义：
//   1) 新（本批 handle-group 写入）：data_json.review = { verdict:'valid'|'false', note, by, at }
//   2) 旧（秸秆复检系统 updateWarningReview 写入）：data_json.review = 'true' | 'false' | 'miss'（字符串）
export interface WarningReviewRec {
  verdict?: 'valid' | 'false' | 'miss'
  note?: string
  by?: string
  at?: string
}

export interface ReviewBadge {
  kind: 'false' | 'valid' | 'miss'
  text: string
  title: string
}

export function reviewBadgeOf(review: unknown): ReviewBadge | null {
  if (!review) return null
  if (typeof review === 'object') {
    const r = review as WarningReviewRec
    const v = r.verdict
    if (v === 'false') {
      const t = r.note ? `误报·${r.note}` : '误报'
      return { kind: 'false', text: t, title: `归因：${r.note || '误报'}${r.by ? `（${r.by} ${r.at || ''}）` : ''}` }
    }
    if (v === 'valid') return { kind: 'valid', text: '有效', title: `研判有效${r.by ? `（${r.by} ${r.at || ''}）` : ''}` }
    if (v === 'miss') return { kind: 'miss', text: '漏报', title: `复检判定漏报${r.by ? `（${r.by} ${r.at || ''}）` : ''}` }
    return null  // 空对象/无 verdict → 不展示（避免旧兼容误判）
  }
  if (typeof review === 'string') {
    const v = review.toLowerCase()
    if (v === 'false') return { kind: 'false', text: '误报', title: '复检判定误报' }
    if (v === 'true') return { kind: 'valid', text: '有效', title: '复检判定有效' }
    if (v === 'miss') return { kind: 'miss', text: '漏报', title: '复检判定漏报' }
  }
  return null
}

// 徽标配色（深色 UI）
export function reviewBadgeStyle(kind: ReviewBadge['kind']): { border: string; bg: string; color: string } {
  if (kind === 'false') return { border: 'rgba(255,170,60,0.5)', bg: 'rgba(255,170,60,0.14)', color: '#ffb74d' }
  if (kind === 'valid') return { border: 'rgba(0,230,118,0.45)', bg: 'rgba(0,230,118,0.12)', color: '#4ade80' }
  return { border: 'rgba(244,67,54,0.5)', bg: 'rgba(244,67,54,0.14)', color: '#ff8080' }  // miss
}
