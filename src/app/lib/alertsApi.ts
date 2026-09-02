/**
 * 告警接口辅助（轻量拉取）
 *
 * fetchUnhandledCount()
 *   - 仅返数字（未处理告警数 = 聚合组 + 平铺未处理 去重），用于 AlertPanel 入口角标
 *   - 复用已有 /api/warnings?aggregate=1 与 /api/warnings?status=pending 接口
 *   - 算法与 AlertHistoryModal.displayList 一致（聚合组按 1 条目计，成员不双计）
 *   - 失败静默返回 0（角标消失但不影响驾驶舱主功能）
 */

import { apiFetch } from './apiFetch'

interface AggregateResp {
  warnings?: Array<{
    ruleId?: string
    channelSipId?: string | null
    aiType?: string
    memberIds?: string[]
  }>
}
interface FlatResp {
  warnings?: Array<{ id: string; status?: string }>
}

/** 获取后端未处理告警总数（聚合组 + 平铺未处理 去重） */
export async function fetchUnhandledCount(): Promise<number> {
  try {
    const [aggRes, flatRes] = await Promise.all([
      apiFetch<AggregateResp | unknown[]>('/api/warnings?aggregate=1'),
      apiFetch<FlatResp | unknown[]>('/api/warnings?status=pending&limit=500'),
    ])
    // 后端 /api/warnings 直接返数组（非 { warnings: [...] } 包装），兼容两种格式
    const aggList: any[] = Array.isArray(aggRes) ? aggRes : ((aggRes as any)?.warnings || [])
    const flatList: any[] = Array.isArray(flatRes) ? flatRes : ((flatRes as any)?.warnings || [])
    // 聚合组内的成员不应再加（已折叠进组里）
    const aggMemberIds = new Set<string>()
    for (const a of aggList) {
      if (Array.isArray(a.memberIds)) for (const id of a.memberIds) aggMemberIds.add(id)
    }
    return aggList.length + flatList.filter((w: any) => !aggMemberIds.has(w.id)).length
  } catch {
    return 0
  }
}