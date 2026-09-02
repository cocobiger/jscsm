/**
 * 无人机回传弹窗 v2 —— 纯函数调度状态机（无 React / 无副作用，可单测）
 *
 * 背景：T2 首版（DroneLivePopup.tsx）的「promote 晋升计数 + 强制重挂载」调度被整体弃用。
 * v2 改为由本模型统一表达弹窗/队列转移，调度常量集中在此为唯一来源。
 *
 * ── 用户拍板后的调度语义（决策逐项落点）──
 *   D1 容量        ：同屏 2 窗口 + 队列 3（DRONE_WINDOW_MAX / DRONE_QUEUE_MAX）
 *   D2 满窗新事件  ：LIVE_ON 时窗口已满 → 折叠「最新打开窗口」（windows 数组末）入队腾位，新事件上窗
 *   D3 队列点击    ：窗口未满补位；满窗 → 折叠「最新打开窗口」并打开所点项（不再用 promote 语义）
 *   D4 队满溢出    ：窗口满且队列满 → 折叠「最旧窗口」(windows[0]) 并把最旧队列项 (queue[0]) 挤出销毁
 *   D5 LIVE_OFF    ：全局移除销毁（窗口/队列均删，不留痕）
 *   D6 ✕ / 超时收起：foldWindow 入队非销毁，且「不自动补位」（沿用已验收 T2 口径）
 *   D7 同机去重    ：同 deviceSn 已在窗口/队列时重复 LIVE_ON → no-op（原引用）
 *   D8 进窗代数    ：openSeq 由全局 seq 分配器单调分配（每次上窗=新代数），供 React key 强制重挂载
 *
 * 窗口数组约定：windows[0]=最旧打开，windows[末尾]=最新打开。
 * 队列数组约定：queue[0]=最旧排队，fold/溢出时优先被挤出。
 */
import type { DroneLiveEvt } from '../../lib/droneLive'

// ── 调度常量（唯一来源，v2 排期参数化决策 P2 的落点）──
export const DRONE_WINDOW_MAX = 2          // 决策 D1：同屏窗口上限
export const DRONE_QUEUE_MAX = 3           // 决策 D1：队列上限
export const DRONE_AUTO_HIDE_MS = 30_000   // 决策 D6：播放后 30s 自动收起（入队非销毁）
export const DRONE_RESOLVE_WAIT_MS = 60_000 // 等待 mirror 接入的最长解析时间
export const DRONE_RESOLVE_RETRY_MS = 4_000 // 解析重试间隔（zlm-watcher 15s 轮询拉 mirror，留余量）
export const DRONE_FALLBACK_FOLD_MS = 120_000 // 兜底：始终未能播放也折叠，避免窗口常驻

// ── 条目 ──
export interface LiveEntry {
  key: string           // deviceSn（唯一标识）
  deviceSn: string
  dockSn: string
  streamId: string      // sikong_<deviceSn>（我方 ZLM mirror）
  title: string         // 机场名（dock 设备名或兜底 `机场 <shortSn>`）
  sub: string           // 无人机 SN 标签
  startedAt: number     // 起飞（广播）时间 ms
  url: string           // 相对 HLS 播放地址（''=尚未解析到）
  phase: 'resolving' | 'ready' | 'timeout'
  waitingUntil: number  // 解析超时时刻（host 手动重试会重设）
  zlmOnline: boolean
  openSeq: number       // 进窗代数：每次上窗分配新值，React key 用 w-<key>-<openSeq>
}

export interface PopupState {
  windows: LiveEntry[]
  queue: LiveEntry[]
  seq: number           // openSeq 分配器（单调递增，永不复用）
}

// ── 操作结果 ──
export type LiveOnPlace = 'window' | 'dup' | 'invalid'

export interface LiveOnResult {
  state: PopupState
  placed: LiveOnPlace
  key: string
  openSeq: number
  foldedKey?: string    // 为腾位被折叠入队的窗口 key（D2 折叠最新 / D4 折叠最旧）
  evictedKey?: string   // D4：被挤出的最旧队列项 key（销毁）
}

export interface FoldResult {
  state: PopupState
  ok: boolean           // 是否发生转移
  from: 'window' | 'queue' | 'missing'
  folded?: LiveEntry    // 被折叠的窗口条目（入队后引用）
  opened?: LiveEntry    // clickQueue 上窗条目（含新 openSeq）
  evictedKey?: string   // 队满挤出项 key
}

/** SN 缩短显示（纯函数自实现，避免模型引入 DOM 依赖） */
export function shortSn(sn: string): string {
  const s = String(sn || '')
  return s.length > 10 ? `${s.slice(0, 8)}…` : s
}

export function emptyState(): PopupState {
  return { windows: [], queue: [], seq: 0 }
}

export function findEntry(state: PopupState, key: string): LiveEntry | undefined {
  const k = String(key)
  return state.windows.find(e => e.key === k) || state.queue.find(e => e.key === k)
}

export function allEntries(state: PopupState): LiveEntry[] {
  return [...state.windows, ...state.queue]
}

function makeEntry(
  evt: Pick<DroneLiveEvt, 'deviceSn' | 'dockSn' | 'streamId' | 'ts' | 'zlm_online'>,
  now: number, openSeq: number,
): LiveEntry {
  const deviceSn = String(evt.deviceSn)
  const dockSn = String(evt.dockSn || '')
  return {
    key: deviceSn,
    deviceSn,
    dockSn,
    streamId: evt.streamId || `sikong_${deviceSn}`,
    title: dockSn ? `机场 ${shortSn(dockSn)}` : `无人机 ${shortSn(deviceSn)}`,
    sub: `无人机 ${shortSn(deviceSn)}`,
    startedAt: Number(evt.ts) || now,
    url: '',
    phase: 'resolving',
    waitingUntil: now + DRONE_RESOLVE_WAIT_MS,
    zlmOnline: !!Number(evt.zlm_online),
    openSeq,
  }
}

/** 入队尾并裁剪（队满挤最旧 queue[0]），返回新队列与可能被挤出的 key */
function pushQueue(queue: LiveEntry[], entry: LiveEntry): { queue: LiveEntry[]; evictedKey?: string } {
  const next = [...queue, entry]
  if (next.length > DRONE_QUEUE_MAX) {
    const evictedKey = next[0].key
    return { queue: next.slice(next.length - DRONE_QUEUE_MAX), evictedKey }
  }
  return { queue: next }
}

/**
 * 决策 D1/D2/D4/D7：LIVE_ON 事件入调度。
 *  - 缺 SN → invalid（原引用）
 *  - 已在窗口/队列 → dup（原引用，不消耗 seq）
 *  - 窗口未满 → 直接上窗
 *  - 窗口满 + 队列未满 → 折叠「最新打开窗口」入队（D2），新事件上窗
 *  - 窗口满 + 队列满 → 折叠「最旧窗口」入队（D4），挤出最旧队列项，新事件上窗
 */
export function liveOn(
  state: PopupState,
  evt: Pick<DroneLiveEvt, 'deviceSn' | 'dockSn' | 'streamId' | 'ts' | 'zlm_online'>,
  now: number = Date.now(),
): LiveOnResult {
  const deviceSn = String(evt?.deviceSn || '')
  if (!deviceSn) return { state, placed: 'invalid', key: '', openSeq: 0 }

  const dup = findEntry(state, deviceSn)
  if (dup) return { state, placed: 'dup', key: deviceSn, openSeq: dup.openSeq }

  const entry = makeEntry(evt, now, state.seq)
  let next: PopupState
  let foldedKey: string | undefined
  let evictedKey: string | undefined

  if (state.windows.length < DRONE_WINDOW_MAX) {
    // 空位补窗
    next = { ...state, windows: [...state.windows, entry], seq: state.seq + 1 }
  } else if (state.queue.length < DRONE_QUEUE_MAX) {
    // D2：满窗队未满 → 折叠最新打开窗口（数组末）腾位
    const newest = state.windows[state.windows.length - 1]
    const windows = state.windows.slice(0, -1)
    const { queue, evictedKey: ek } = pushQueue(state.queue, newest)
    next = { ...state, windows: [...windows, entry], queue, seq: state.seq + 1 }
    foldedKey = newest.key
    evictedKey = ek
  } else {
    // D4：满窗队满 → 折叠最旧窗口(windows[0])入队并挤出最旧队列项(queue[0])
    const oldest = state.windows[0]
    const windows = state.windows.slice(1)
    const { queue, evictedKey: ek } = pushQueue(state.queue, oldest)
    next = { ...state, windows: [...windows, entry], queue, seq: state.seq + 1 }
    foldedKey = oldest.key
    evictedKey = ek
  }
  return { state: next, placed: 'window', key: deviceSn, openSeq: entry.openSeq, foldedKey, evictedKey }
}

/**
 * 决策 D5：LIVE_OFF 全局移除销毁（窗口/队列均删，清计时由 host 处理）。
 * 不存在 → 原引用。
 */
export function liveOff(state: PopupState, deviceSn: string): PopupState {
  const key = String(deviceSn)
  if (!key || !findEntry(state, key)) return state
  return {
    ...state,
    windows: state.windows.filter(e => e.key !== key),
    queue: state.queue.filter(e => e.key !== key),
  }
}

/**
 * 决策 D6：✕ / 30s 自动收起 / 兜底超时 → 窗口条目入队（非销毁），不自动补位。
 * 队满则挤最旧队列项，保留刚收起条目（沿用已验收 T2 口径 slice(-MAX)）。
 * 已在队列 / 不存在 → no-op（原引用）。
 */
export function foldWindow(state: PopupState, key: string): FoldResult {
  const k = String(key)
  const inWin = state.windows.find(e => e.key === k)
  if (!inWin) {
    if (state.queue.some(e => e.key === k)) return { state, ok: false, from: 'queue' }
    return { state, ok: false, from: 'missing' }
  }
  const windows = state.windows.filter(e => e.key !== k)
  const { queue, evictedKey } = pushQueue(state.queue, inWin)
  return { state: { ...state, windows, queue }, ok: true, from: 'window', folded: inWin, evictedKey }
}

/**
 * 决策 D3：队列缩略图点击拉起。
 *  - 不在队列 → no-op（原引用）
 *  - 窗口未满 → 移出队列上窗（分配新 openSeq，强制重挂载重启 30s 计时）
 *  - 窗口满 → 折叠「最新打开窗口」入队（D3），点击项上窗
 * 折叠入队与点击项移出后队列不会超上限（队 ≤3 时 减1加1 不超）。
 */
export function clickQueue(state: PopupState, key: string, now: number = Date.now()): FoldResult {
  const k = String(key)
  const qIdx = state.queue.findIndex(e => e.key === k)
  if (qIdx < 0) {
    if (state.windows.some(e => e.key === k)) return { state, ok: false, from: 'window' }
    return { state, ok: false, from: 'missing' }
  }
  const target = state.queue[qIdx]
  const rest = state.queue.filter(e => e.key !== k)
  const opened: LiveEntry = { ...target, openSeq: state.seq }

  if (state.windows.length < DRONE_WINDOW_MAX) {
    const next: PopupState = {
      ...state,
      windows: [...state.windows, opened],
      queue: rest,
      seq: state.seq + 1,
    }
    return { state: next, ok: true, from: 'queue', opened }
  }
  // 满窗 → 折叠最新打开窗口腾位
  const newest = state.windows[state.windows.length - 1]
  const windows = state.windows.slice(0, -1)
  const { queue, evictedKey } = pushQueue(rest, newest)
  const next: PopupState = {
    ...state,
    windows: [...windows, opened],
    queue,
    seq: state.seq + 1,
  }
  return { state: next, ok: true, from: 'queue', opened, folded: newest, evictedKey }
}

/**
 * 解析回写：host 解析轮询/手动重试成功后用 patch 更新 url/phase/title/zlmOnline 等。
 * 保留未 patch 的字段（含 timeout 状态供手动重试复位）。不存在 → 原引用。
 */
export function patchEntry(state: PopupState, key: string, patch: Partial<LiveEntry>): PopupState {
  const k = String(key)
  let hit = false
  const mapOne = (e: LiveEntry): LiveEntry => {
    if (e.key !== k) return e
    hit = true
    return { ...e, ...patch }
  }
  const windows = state.windows.map(mapOne)
  const queue = state.queue.map(mapOne)
  if (!hit) return state
  return { ...state, windows, queue }
}
