/**
 * v2 弹窗纯状态机单测（决策 D1-D8 全覆盖）
 * 覆盖：liveOn 空窗/重复/缺SN/满窗折叠最新/队满挤最旧、liveOff 各分支、
 *       foldWindow 收起入队非销毁/队满挤出/已在队/不存在、clickQueue 补位/满窗折叠/缺失、
 *       patchEntry 回写与字段保留、容量与唯一性上限、openSeq 单调。
 *
 * 注意 addMany 的推进语义（D2 折叠「最新打开」）：n 台依次 LIVE_ON 后
 *   窗 = [最老A, 最新第n台]，队 = [第2台, 第3台, …, 第n-1台]（队满 3 时再挤最老）。
 * 例如 5 台 → 窗 [A,E] / 队 [B,C,D]；6 台（满窗+满队）→ 折叠最老 A → 窗 [E,F] / 队 [C,D,A]（挤 B）。
 */
import { describe, it, expect } from 'vitest'
import {
  emptyState, liveOn, liveOff, foldWindow, clickQueue, patchEntry,
  findEntry, allEntries,
  DRONE_WINDOW_MAX, DRONE_QUEUE_MAX,
  type PopupState,
} from './dronePopupModel'
import type { DroneLiveEvt } from '../../lib/droneLive'

/** 构造一个 LIVE_ON 载荷 */
function evt(deviceSn: string, dockSn = 'DOCK1', over: Partial<DroneLiveEvt> = {}): Pick<DroneLiveEvt, 'deviceSn' | 'dockSn' | 'streamId' | 'ts' | 'zlm_online'> {
  return {
    deviceSn, dockSn,
    streamId: `sikong_${deviceSn}`,
    ts: 1_700_000_000_000,
    zlm_online: 1,
    ...over,
  }
}

const now0 = 1_750_000_000_000

/** 依次 liveOn 若干台（每台不重复） */
function addMany(state: PopupState, sns: string[]): PopupState {
  let s = state
  for (const sn of sns) s = liveOn(s, evt(sn), now0).state
  return s
}

/** 便捷断言：窗口/队列的 deviceSn 顺序 */
function shape(s: PopupState) {
  return { win: s.windows.map(w => w.deviceSn), que: s.queue.map(q => q.deviceSn) }
}

describe('liveOn 上窗', () => {
  it('空窗时直接上窗（placed=window，openSeq=0）', () => {
    const r = liveOn(emptyState(), evt('A'), now0)
    expect(r.placed).toBe('window')
    expect(shape(r.state)).toEqual({ win: ['A'], que: [] })
    expect(r.openSeq).toBe(0)
    expect(r.state.windows[0].phase).toBe('resolving')
    expect(r.state.windows[0].streamId).toBe('sikong_A')
  })

  it('同 deviceSn 已在窗口 → dup no-op（原引用）', () => {
    const s0 = liveOn(emptyState(), evt('A'), now0).state
    const r = liveOn(s0, evt('A'), now0)
    expect(r.placed).toBe('dup')
    expect(r.state).toBe(s0)
    expect(r.state.windows).toHaveLength(1)
  })

  it('缺 deviceSn → invalid no-op', () => {
    const s0 = liveOn(emptyState(), evt('A'), now0).state
    const r = liveOn(s0, { deviceSn: '', dockSn: 'D', streamId: '', ts: 1, zlm_online: 0 }, now0)
    expect(r.placed).toBe('invalid')
    expect(r.state).toBe(s0)
  })

  it('决策 D2：满窗队未满 → 折叠「最新打开窗口」入队，新事件上窗', () => {
    const s0 = addMany(emptyState(), ['A', 'B'])       // 窗满 [A,B]
    const r = liveOn(s0, evt('C'), now0)
    expect(r.placed).toBe('window')
    expect(r.foldedKey).toBe('B')                      // B 最新打开被折叠
    expect(shape(r.state)).toEqual({ win: ['A', 'C'], que: ['B'] })
  })

  it('第 4 台：满窗队 1 → 仍折叠最新打开，队列追加', () => {
    const s1 = addMany(emptyState(), ['A', 'B', 'C'])  // 窗 [A,C] / 队 [B]
    const r = liveOn(s1, evt('D'), now0)
    expect(r.placed).toBe('window')
    expect(r.foldedKey).toBe('C')                      // 最新打开 C 被折叠
    expect(shape(r.state)).toEqual({ win: ['A', 'D'], que: ['B', 'C'] })
  })

  it('决策 D4：满窗 + 队满 → 折叠最旧窗口(windows[0])，挤出最旧队列项(queue[0])', () => {
    const s0 = addMany(emptyState(), ['A', 'B', 'C', 'D', 'E'])  // 窗 [A,E] / 队 [B,C,D] 满
    expect(shape(s0)).toEqual({ win: ['A', 'E'], que: ['B', 'C', 'D'] })
    const r = liveOn(s0, evt('F'), now0)
    expect(r.placed).toBe('window')
    expect(r.foldedKey).toBe('A')                      // 最旧窗口 A 被折叠
    expect(r.evictedKey).toBe('B')                     // 最旧队列项 B 被挤出销毁
    expect(shape(r.state)).toEqual({ win: ['E', 'F'], que: ['C', 'D', 'A'] })
    expect(findEntry(r.state, 'B')).toBeUndefined()    // B 完全消失
  })

  it('决策 D6：窗口有空位时新 LIVE_ON 正常补窗（不排队等待）', () => {
    const s0 = addMany(emptyState(), ['A', 'B'])       // 窗 [A,B]
    const s1 = foldWindow(s0, 'A').state               // A 收起：窗 [B] / 队 [A]
    const r = liveOn(s1, evt('C'), now0)
    expect(r.placed).toBe('window')
    expect(shape(r.state)).toEqual({ win: ['B', 'C'], que: ['A'] })
  })
})

describe('liveOff 移除（决策 D5）', () => {
  it('窗口中的 LIVE_OFF → 移除（不入队）', () => {
    const s0 = addMany(emptyState(), ['A', 'B'])       // 窗 [A,B]
    const s1 = liveOff(s0, 'A')
    expect(shape(s1)).toEqual({ win: ['B'], que: [] })
    expect(findEntry(s1, 'A')).toBeUndefined()
  })

  it('队列中的 LIVE_OFF → 从队列移除', () => {
    const s0 = addMany(emptyState(), ['A', 'B', 'C', 'D', 'E'])  // 窗 [A,E] / 队 [B,C,D]
    const s1 = liveOff(s0, 'D')
    expect(shape(s1)).toEqual({ win: ['A', 'E'], que: ['B', 'C'] })
  })

  it('A 降落移除窗口项后，队列项不自动补位（留白）', () => {
    const s0 = addMany(emptyState(), ['A', 'B', 'C', 'D', 'E'])  // 窗 [A,E] / 队 [B,C,D]
    const s1 = liveOff(s0, 'A')
    expect(shape(s1)).toEqual({ win: ['E'], que: ['B', 'C', 'D'] })
    expect(s1.windows.length).toBe(1)                  // 空位留白
  })

  it('不存在的 LIVE_OFF → 原引用', () => {
    const s0 = addMany(emptyState(), ['A'])
    const s1 = liveOff(s0, 'NOPE')
    expect(s1).toBe(s0)
  })
})

describe('foldWindow 收起（决策 D6）', () => {
  it('窗口条目收起 → 入队非销毁', () => {
    const s0 = addMany(emptyState(), ['A', 'B'])       // 窗 [A,B]
    const r = foldWindow(s0, 'A')
    expect(r.ok).toBe(true)
    expect(r.from).toBe('window')
    expect(shape(r.state)).toEqual({ win: ['B'], que: ['A'] })
    expect(findEntry(r.state, 'A')).toBeTruthy()       // 仍在系统内
  })

  it('收起时队列已满 → 挤最旧队列项，保留刚收起条目', () => {
    const s0 = addMany(emptyState(), ['A', 'B', 'C', 'D', 'E'])  // 窗 [A,E] / 队 [B,C,D] 满
    const r = foldWindow(s0, 'A')                                 // A 收起 → 队 4 → 挤 B
    expect(r.ok).toBe(true)
    expect(r.evictedKey).toBe('B')
    expect(shape(r.state)).toEqual({ win: ['E'], que: ['C', 'D', 'A'] })
    expect(findEntry(r.state, 'A')).toBeTruthy()
    expect(findEntry(r.state, 'B')).toBeUndefined()
  })

  it('已在队列的 key 再次收起 → no-op（不重复入队）', () => {
    const s0 = addMany(emptyState(), ['A', 'B', 'C', 'D'])  // 窗 [A,D] / 队 [B,C]
    const r = foldWindow(s0, 'C')
    expect(r.ok).toBe(false)
    expect(r.from).toBe('queue')
    expect(r.state).toBe(s0)
  })

  it('不存在的 key 收起 → no-op（原引用）', () => {
    const s0 = addMany(emptyState(), ['A'])
    const r = foldWindow(s0, 'NOPE')
    expect(r.ok).toBe(false)
    expect(r.from).toBe('missing')
    expect(r.state).toBe(s0)
  })
})

describe('clickQueue 队列点击拉起（决策 D3）', () => {
  it('窗口未满 → 直接补位上窗（分配新 openSeq）', () => {
    const s0 = addMany(emptyState(), ['A', 'B', 'C'])  // 窗 [A,C] / 队 [B]
    const s1 = foldWindow(s0, 'A').state               // A 收起：窗 [C] / 队 [B,A]
    expect(shape(s1)).toEqual({ win: ['C'], que: ['B', 'A'] })
    const r = clickQueue(s1, 'A')
    expect(r.ok).toBe(true)
    expect(r.opened?.key).toBe('A')
    expect(shape(r.state)).toEqual({ win: ['C', 'A'], que: ['B'] })
  })

  it('满窗 → 折叠「最新打开窗口」并打开所点项', () => {
    const s0 = addMany(emptyState(), ['A', 'B', 'C', 'D', 'E'])  // 窗 [A,E] / 队 [B,C,D]
    const r = clickQueue(s0, 'D')
    expect(r.ok).toBe(true)
    expect(r.folded?.key).toBe('E')                    // E 最新打开被折叠
    expect(shape(r.state)).toEqual({ win: ['A', 'D'], que: ['B', 'C', 'E'] })
  })

  it('满窗 + 队满 → 折叠最新打开并打开点击项（队列不超上限）', () => {
    const s0 = addMany(emptyState(), ['A', 'B', 'C', 'D', 'E'])  // 窗 [A,E] / 队 [B,C,D] 满
    const r = clickQueue(s0, 'B')
    expect(r.ok).toBe(true)
    expect(r.folded?.key).toBe('E')
    expect(shape(r.state)).toEqual({ win: ['A', 'B'], que: ['C', 'D', 'E'] })
  })

  it('不在队列（在窗口）→ no-op（原引用）', () => {
    const s0 = addMany(emptyState(), ['A', 'B'])       // 窗 [A,B]
    const r = clickQueue(s0, 'A')
    expect(r.ok).toBe(false)
    expect(r.from).toBe('window')
    expect(r.state).toBe(s0)
  })

  it('缺失 key → no-op（原引用）', () => {
    const s0 = addMany(emptyState(), ['A'])
    const r = clickQueue(s0, 'NOPE')
    expect(r.ok).toBe(false)
    expect(r.from).toBe('missing')
    expect(r.state).toBe(s0)
  })
})

describe('patchEntry 解析回写', () => {
  it('解析成功回写 url/phase/title，保留其余字段', () => {
    const s0 = addMany(emptyState(), ['A'])
    const s1 = patchEntry(s0, 'A', {
      url: '/jsc/sikong_A/hls.m3u8',
      phase: 'ready',
      zlmOnline: true,
      title: '环保局机场',
    })
    const e = findEntry(s1, 'A')!
    expect(e.url).toBe('/jsc/sikong_A/hls.m3u8')
    expect(e.phase).toBe('ready')
    expect(e.title).toBe('环保局机场')
    expect(e.zlmOnline).toBe(true)
    expect(e.startedAt).toBe(1_700_000_000_000)        // 未 patch 字段保留
    expect(e.openSeq).toBe(0)
  })

  it('patch 设置 phase=timeout 后手动重试可复位 resolving', () => {
    const s0 = addMany(emptyState(), ['A'])
    const s1 = patchEntry(s0, 'A', { phase: 'timeout' })
    const s2 = patchEntry(s1, 'A', { phase: 'resolving', url: '', waitingUntil: now0 + 60_000 })
    const e = findEntry(s2, 'A')!
    expect(e.phase).toBe('resolving')
    expect(e.waitingUntil).toBe(now0 + 60_000)
  })

  it('不存在 key → 原引用', () => {
    const s0 = addMany(emptyState(), ['A'])
    const s1 = patchEntry(s0, 'NOPE', { url: 'x' })
    expect(s1).toBe(s0)
  })
})

describe('容量与唯一性（决策 D1）', () => {
  it('30 台轮流 LIVE_ON 后 windows/queue 恒不超上限', () => {
    let s = emptyState()
    for (let i = 0; i < 30; i++) s = liveOn(s, evt(`SN${i}`), now0).state
    expect(s.windows.length).toBeLessThanOrEqual(DRONE_WINDOW_MAX)
    expect(s.queue.length).toBeLessThanOrEqual(DRONE_QUEUE_MAX)
    expect(allEntries(s).length).toBeLessThanOrEqual(DRONE_WINDOW_MAX + DRONE_QUEUE_MAX)
    expect(s.seq).toBe(30)
  })

  it('deviceSn 全局唯一（窗口/队列无重复 key）', () => {
    let s = emptyState()
    for (let i = 0; i < 30; i++) {
      s = liveOn(s, evt(`SN${i}`), now0).state
      const keys = allEntries(s).map(e => e.key)
      expect(new Set(keys).size).toBe(keys.length)
    }
  })

  it('openSeq 单调递增（每次上窗新代数 = 重挂载信号）', () => {
    let s = emptyState()
    const seen: number[] = []
    for (let i = 0; i < 6; i++) {
      const r = liveOn(s, evt(`SN${i}`), now0)
      seen.push(r.openSeq)
      s = r.state
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5])
    // 队列点击拉起分配新 seq
    const s1 = addMany(emptyState(), ['A', 'B', 'C', 'D'])  // 窗 [A,D] / 队 [B,C]，seq=4
    const r = clickQueue(s1, 'C')
    expect(r.opened?.openSeq).toBe(4)
    expect(r.state.seq).toBe(5)
  })
})
