/**
 * 无人机直播事件（弹窗需求 T2）工具库
 *
 * 数据链（与后端 drone-events.js 对齐）：
 *   dji-openapi webhook LIVE_STATUS_CHANGE → 后端 /api/drone-events/ingest（dockSn 白名单过滤）
 *     → SSE /api/drone-events/stream?token=<会话> 广播 { type:'drone-live', on, deviceSn, dockSn, ... }
 *
 * 本模块提供：
 *   - DroneLiveEvt 类型（SSE 载荷）
 *   - fetchDroneInfo  按 deviceSn/dockSn 从 /api/sikong/live-streams 解析名称与播放地址（role=drone 过滤）
 *   - toRelativeMediaUrl  绝对播放地址 → 同源相对路径（nginx /jsc/... 反代 ZLM）
 *   - playAlertChime / unlockAudioOnGesture  弹窗提示音（WebAudio，无音频资源）
 *   - 常量：自动收起 30s、同屏上限 2、队列上限等
 */
import { apiFetch } from './apiFetch'

// ── 产品常量（决策 2/3 落点，集中管理便于后续参数化）──
export const DRONE_AUTO_HIDE_MS = 30_000    // 决策3：弹窗 30s 自动收起（收进队列非销毁）
export const DRONE_MAX_WINDOWS = 2          // 决策2：同屏同时弹出上限 2 路
export const DRONE_MAX_QUEUE = 3            // 队列缩略图上限（超出丢弃最旧）
export const DRONE_RESOLVE_WAIT_MS = 60_000 // 等待 mirror 接入的最长解析时间
export const DRONE_RESOLVE_RETRY_MS = 4_000 // 解析重试间隔（zlm-watcher 15s 轮询拉 mirror，需留余量）

// ── SSE 载荷 ──
export interface DroneLiveEvt {
  type: 'drone-live'
  id: number
  on: number            // 1=LIVE_ON / 0=LIVE_OFF
  eventId: string
  deviceSn: string      // 无人机 SN（回传画面源）
  dockSn: string        // 机场 SN（dock）
  streamId: string      // sikong_<deviceSn>（我方 ZLM mirror）
  status: string        // LIVE_ON / LIVE_OFF
  changeReason?: string
  eventTime: string
  ts: number            // 服务器入库时间戳（ms）
  zlm_online: number    // 我方 ZLM mirror 是否已在线
  whitelisted: number   // 1=白名单命中已广播
}

// ── 解析结果 ──
export interface DroneResolved {
  name: string          // 机场设备名（title）
  airportName: string
  droneLabel: string
  zlmOnline: boolean
  hls: string           // 相对 HLS 播放地址（''=尚无）
}

/** SN 缩短显示 */
export function shortSn(sn: string): string {
  const s = String(sn || '')
  return s.length > 10 ? `${s.slice(0, 8)}…` : s
}

/** 绝对播放地址 → 同源相对路径（nginx /jsc/、/jsc_h264/ 已反代 ZLM） */
export function toRelativeMediaUrl(abs: string): string {
  if (!abs) return ''
  const m = String(abs).match(/\/jsc(?:_h264)?\/[^?#\s]+/)
  return m ? m[0] : String(abs)
}

/**
 * 按 deviceSn/dockSn 解析显示名与播放地址。
 * 来源 /api/sikong/live-streams（聚合 司空设备 + 我方 ZLM mirror 状态/播放地址，实时拉取）。
 * 匹配策略：dock 条目按 sikongSn===dockSn 取名；drone 条目按 droneSn/sikongSn===deviceSn 取流。
 */
export async function fetchDroneInfo(deviceSn: string, dockSn: string): Promise<DroneResolved | null> {
  try {
    const d: any = await apiFetch('/api/sikong/live-streams')
    const items = Array.isArray(d?.items) ? d.items : []
    const dock = items.find((i: any) => i.role === 'dock' && String(i.sikongSn) === String(dockSn))
    const drone = items.find((i: any) =>
      i.role === 'drone' &&
      (String(i.sikongSn) === String(deviceSn) || String(i.droneSn) === String(deviceSn))
    )
    const name = String(dock?.deviceName || drone?.deviceName || '')
    const hls = toRelativeMediaUrl(drone?.play?.hls || '')
    return {
      name: name || `机场 ${shortSn(dockSn)}`,
      airportName: name,
      droneLabel: `无人机 ${shortSn(deviceSn)}`,
      zlmOnline: !!drone?.zlm_online,
      hls,
    }
  } catch {
    return null // 后端不可达等：调用方用兜底名 + 稍后重试
  }
}

// ── 提示音（WebAudio 合成双音，无音频文件；浏览器需一次手势解锁）──
let _actx: AudioContext | null = null
function ensureAudio(): AudioContext | null {
  try {
    if (!_actx) {
      const AC: any = window.AudioContext || (window as any).webkitAudioContext
      if (!AC) return null
      _actx = new AC()
    }
    const actx = _actx
    if (!actx) return null
    if (actx.state === 'suspended') { actx.resume().catch(() => {}) }
    return actx
  } catch { return null }
}

/** 在任何用户手势时解锁 AudioContext（首次弹窗提示音可能被自动播放策略拦截） */
export function unlockAudioOnGesture() {
  const unlock = () => { ensureAudio() }
  window.addEventListener('pointerdown', unlock, { once: true })
  window.addEventListener('keydown', unlock, { once: true })
}

/** 弹窗提示音：880Hz 短音 + 1174Hz 尾音（约 0.5s） */
export function playAlertChime() {
  try {
    const ctx = ensureAudio()
    if (!ctx || ctx.state !== 'running') return
    const t0 = ctx.currentTime
    const tone = (freq: number, at: number, dur: number) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.value = freq
      o.connect(g)
      g.connect(ctx.destination)
      g.gain.setValueAtTime(0.0001, at)
      g.gain.exponentialRampToValueAtTime(0.16, at + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
      o.start(at)
      o.stop(at + dur + 0.03)
    }
    tone(880, t0, 0.15)
    tone(1174, t0 + 0.18, 0.3)
  } catch { /* 音频不可用静默降级 */ }
}

/** 声音开关持久化 */
export function loadSoundPref(): boolean {
  try { return localStorage.getItem('jsc:drone-popup-sound') !== 'off' } catch { return true }
}
export function saveSoundPref(on: boolean) {
  try { localStorage.setItem('jsc:drone-popup-sound', on ? 'on' : 'off') } catch {}
}
