/**
 * 无人机直播事件（弹窗 T2 → v2 重写）工具库
 *
 * 数据链（与后端 drone-events.js 对齐）：
 *   dji-openapi webhook LIVE_STATUS_CHANGE → 后端 /api/drone-events/ingest（dockSn 白名单过滤）
 *     → SSE /api/drone-events/stream?token=<会话> 广播 { type:'drone-live', on, deviceSn, dockSn, ... }
 *
 * 本模块提供：
 *   - DroneLiveEvt 类型（SSE 载荷）
 *   - fetchDroneStreamStatus  按 deviceSn 直查 ZLM mirror 在线/播放地址 + 机场名
 *                             （与 /satellite/camera role 列表解耦，弹窗拥有自有数据源）
 *   - toRelativeMediaUrl  绝对播放地址 → 同源相对路径（nginx /jsc/... 反代 ZLM）
 *   - playAlertChime / unlockAudioOnGesture / loadSoundPref / saveSoundPref  提示音与偏好
 *
 * 调度常量与纯状态机见 components/drvPopup/dronePopupModel.ts（唯一来源）。
 */
import { apiFetch } from './apiFetch'

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

// ── 单机镜像状态/播放地址（与相机 role 列表解耦）──
export interface DroneStreamStatus {
  ok: boolean
  deviceSn: string
  dockSn: string
  streamId: string
  online: boolean       // ZLM mirror（sikong_<SN>）是否在线
  hls: string           // 相对 HLS 播放地址（''=尚未接入）
  dockName: string      // 机场设备名（设备目录按 dockSn/deviceSn 匹配，无 role 概念）
  error?: string
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
 * 单机取流解析（v2 弹窗专用）：GET /api/drone-events/stream-status?deviceSn=&dockSn=
 * 后端直连 zlm.isStreamOnline(sikong_<SN>) + 设备目录取名，无 dock/drone role 概念。
 * 失败返回 null（后端不可达等），调用方用兜底名 + 稍后重试。
 */
export async function fetchDroneStreamStatus(deviceSn: string, dockSn = ''): Promise<DroneStreamStatus | null> {
  try {
    const qs = new URLSearchParams({ deviceSn: String(deviceSn) })
    if (dockSn) qs.set('dockSn', String(dockSn))
    return await apiFetch<DroneStreamStatus>(`/api/drone-events/stream-status?${qs.toString()}`)
  } catch {
    return null
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
