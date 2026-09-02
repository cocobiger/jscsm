import { useEffect, useRef, useState } from 'react'
import { SinglePlayer } from '../VideoPlayerModal'
import {
  DRONE_AUTO_HIDE_MS, DRONE_FALLBACK_FOLD_MS,
  type LiveEntry,
} from './dronePopupModel'

/**
 * v2 无人机回传弹窗 —— 单个窗口（≤2 路之一，React key 由 host 以 w-<key>-<openSeq> 控制重挂载）
 *
 * 行为（决策 D6 + 既有验收口径）：
 *   - 画面首次进入 playing 才启动 30s 自动收起倒计时（超时调 onFold → 入队非销毁）
 *   - 始终未能播放（镜像一直未接入）→ DRONE_FALLBACK_FOLD_MS(120s) 兜底折叠，避免窗口常驻
 *   - 单 ✕ 按钮收起（入队）
 */

const CYAN = '#00aaff'
const RED = '#ff4444'
const AMBER = '#ffd740'

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60
  const mm = String(m).padStart(2, '0')
  return h > 0
    ? `${h}:${mm}:${String(ss).padStart(2, '0')}`
    : `${mm}:${String(ss).padStart(2, '0')}`
}

/** 每秒 tick 的 now（各卡片独立计时，避免整树重渲染） */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

export function DronePopupWindow({
  entry, onFold, onRetry,
}: {
  entry: LiveEntry
  onFold: (key: string) => void
  onRetry: (key: string) => void
}) {
  const now = useNow(1000)
  const [playStatus, setPlayStatus] = useState<string>('')
  const [leftMs, setLeftMs] = useState<number | null>(null)
  const startedRef = useRef(false)          // 30s 倒计时是否已启动（防重入）
  const tickerRef = useRef<number | null>(null)

  const stopTicker = () => {
    if (tickerRef.current) { clearInterval(tickerRef.current); tickerRef.current = null }
  }
  useEffect(() => stopTicker, [])

  /** 决策 D6：视频首次播放 → 启动 30s 自动收起倒计时（超时 → 收起入队） */
  const startAutoHide = () => {
    if (startedRef.current) return
    startedRef.current = true
    const deadline = Date.now() + DRONE_AUTO_HIDE_MS
    const tick = () => {
      const left = deadline - Date.now()
      if (left <= 0) { stopTicker(); onFold(entry.key); return }
      setLeftMs(left)
    }
    tick()
    tickerRef.current = window.setInterval(tick, 500)
  }
  const handleStatus = (s: string) => {
    setPlayStatus(s)
    if (s === 'playing') startAutoHide()
  }

  // 兜底：始终未能播放（镜像一直未接入）时 120s 后也收起，避免窗口常驻阻塞画面
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (!startedRef.current) onFold(entry.key)
    }, DRONE_FALLBACK_FOLD_MS)
    return () => clearTimeout(t)
  }, [entry.key, onFold])

  const live = playStatus === 'playing'
  const leftSec = leftMs == null ? null : Math.ceil(leftMs / 1000)

  return (
    <div
      style={{
        width: 400, background: 'rgba(4,14,30,0.96)', border: live ? '1px solid rgba(0,229,255,0.45)' : '1px solid rgba(0,150,220,0.3)',
        borderRadius: 6, boxShadow: '0 6px 28px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,0,0,0.4)', overflow: 'hidden',
        pointerEvents: 'auto', flexShrink: 0,
      }}
    >
      {/* 头部 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', background: 'linear-gradient(90deg, rgba(0,120,200,0.18), transparent)', borderBottom: '1px solid rgba(0,80,150,0.25)' }}>
        <div style={{ width: 6, height: 6, borderRadius: '50%', background: live ? RED : AMBER, boxShadow: live ? `0 0 6px ${RED}` : 'none', flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: '#e3f2ff', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {entry.title || '无人机'}
            <span style={{ color: '#5a8aaa', fontWeight: 400, marginLeft: 6, fontSize: 10 }}>{entry.sub}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 9, color: '#5a8aaa', fontFamily: "'JetBrains Mono',monospace" }}>
            <span>起飞 {fmtDur(now - entry.startedAt)}</span>
            {leftSec != null && (
              <span style={{ color: AMBER, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <span style={{ width: 40, height: 2, background: 'rgba(255,215,64,0.18)', borderRadius: 1, overflow: 'hidden', display: 'inline-block', verticalAlign: 'middle' }}>
                  <span style={{ display: 'block', height: '100%', width: `${(leftSec / (DRONE_AUTO_HIDE_MS / 1000)) * 100}%`, background: AMBER, transition: 'width 0.5s linear' }} />
                </span>
                {leftSec}s 收起
              </span>
            )}
          </div>
        </div>
        <button
          onClick={() => onFold(entry.key)} title="收起至队列（播放后 30s 自动收起；点队列缩略图可拉回）"
          style={{ width: 22, height: 22, borderRadius: 3, border: '1px solid rgba(0,150,220,0.3)', background: 'rgba(0,80,150,0.18)', color: '#7fc9ff', cursor: 'pointer', fontSize: 11, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
        >✕</button>
      </div>

      {/* 画面区 16:9 */}
      <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9', background: '#000' }}>
        {entry.url ? (
          <SinglePlayer url={entry.url} protocol="hls" primary={false} onStatus={handleStatus} />
        ) : entry.phase === 'timeout' ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, background: 'rgba(0,0,0,0.85)' }}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={AMBER} strokeWidth="1.5"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
            <span style={{ color: AMBER, fontSize: 11 }}>视频流接入超时</span>
            <button onClick={() => onRetry(entry.key)} style={{ padding: '3px 14px', fontSize: 11, borderRadius: 3, border: `1px solid ${CYAN}50`, background: `${CYAN}18`, color: CYAN, cursor: 'pointer' }}>重新尝试</button>
          </div>
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, background: 'radial-gradient(ellipse at 50% 40%, rgba(0,60,120,0.25), rgba(0,10,25,0.95))' }}>
            <div style={{ width: 26, height: 26, border: `2px solid ${CYAN}25`, borderTop: `2px solid ${CYAN}`, borderRadius: '50%', animation: 'dpl-spin 1s linear infinite' }} />
            <div style={{ color: '#5a8aaa', fontSize: 11 }}>等待视频流接入…</div>
            <div style={{ color: '#2a4a60', fontSize: 9, fontFamily: "'JetBrains Mono',monospace" }}>
              {entry.streamId} · {fmtDur(now - entry.startedAt)}
            </div>
          </div>
        )}
        {/* 顶部叠加 LIVE/状态角标 */}
        <div style={{ position: 'absolute', top: 5, right: 6, display: 'flex', alignItems: 'center', gap: 4, background: 'rgba(0,0,0,0.55)', borderRadius: 2, padding: '1px 5px' }}>
          <span style={{ color: live ? RED : '#5a8aaa', fontSize: 9, fontFamily: "'JetBrains Mono',monospace", fontWeight: 700 }}>{live ? '● LIVE' : entry.url ? '连接中' : '待接入'}</span>
        </div>
      </div>
    </div>
  )
}
