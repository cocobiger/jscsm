/**
 * 跨视图导航（P4 · 2026-09-14）
 *
 * 场景：驾驶舱「实时告警」里的秸秆聚合卡 → 一键跳到管理后台「秸秆焚烧监控 → 告警工作台」
 *   并自动选中该聚合组对应的原始告警记录。
 *
 * 为什么用「事件 + 待处理请求」而不是逐层 props 透传：
 *   跳转跨越 App → AdminPanel → StrawMonitorPage → StrawEnginePage(StrawReviewBoard) 四层，
 *   且驾驶舱态下后三者**尚未挂载**（showAdmin=false），事件监听收不到。
 *   因此：① 写入 __jscPendingNav（带时间戳）② 广播 jsc:nav 让 App 切到管理后台
 *   ③ 各层组件 mount 时用 readStrawNav() 主动领取（带 15s 新鲜度窗口，过期不认）。
 */
export interface StrawNavRequest {
  /** 驾驶舱聚合组的成员告警 id（straw-* 前缀），用于在告警工作台定位 */
  warningIds?: string[]
  aiType?: string
  latestTime?: string
  streamId?: string
  ts: number
}

const NAV_KEY = '__jscPendingNav'
/** 默认新鲜度窗口：超过则视为过期导航意图（用户已手动切页，不应再被劫持） */
const DEFAULT_MAX_AGE_MS = 15000

/** 发起「跳到秸秆告警工作台」导航（驾驶舱侧调用） */
export function requestStrawNav(req: Omit<StrawNavRequest, 'ts'>) {
  const r: StrawNavRequest = { ...req, ts: Date.now() }
  ;(window as unknown as Record<string, unknown>)[NAV_KEY] = r
  window.dispatchEvent(new CustomEvent('jsc:nav', { detail: r }))
}

/** 领取待处理的秸秆导航请求（各层组件 mount/数据就绪时调用）；无或过期返回 null */
export function readStrawNav(maxAgeMs = DEFAULT_MAX_AGE_MS): StrawNavRequest | null {
  const r = (window as unknown as Record<string, unknown>)[NAV_KEY] as StrawNavRequest | undefined
  if (!r || !r.ts) return null
  if (Date.now() - r.ts > maxAgeMs) return null
  return r
}

/** 消费后清除（避免后续手动进入管理后台时被重复定位） */
export function clearStrawNav() {
  delete (window as unknown as Record<string, unknown>)[NAV_KEY]
}
