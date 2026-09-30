import { useEffect, useRef, useState } from 'react'
import { SinglePlayer } from '../VideoPlayerModal'
import { BboxOverlay } from './BboxOverlay'
import { NetworkStatusBar } from './NetworkStatusBar'
import { MiniDroneMap } from './MiniDroneMap'
import { LiveTextOverlay } from './LiveTextOverlay'
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
  const [zoomed, setZoomed] = useState(false)  // 直播画面放大（全屏查看）
  const [playUrl, setPlayUrl] = useState<string>(entry.url)  // 当前实际播放地址（失败可回退 fallbackUrl）
  const startedRef = useRef(false)          // 30s 倒计时是否已启动（防重入）
  const tickerRef = useRef<number | null>(null)

  // entry.url 变化时同步 playUrl
  useEffect(() => { setPlayUrl(entry.url) }, [entry.url])

  const stopTicker = () => {
    if (tickerRef.current) { clearInterval(tickerRef.current); tickerRef.current = null }
  }
  useEffect(() => stopTicker, [])

  /** 决策 D6：视频首次播放 → 启动自动收起倒计时（超时 → 收起入队）
   *  DRONE_AUTO_HIDE_MS=0 表示禁用自动收起，画面跟随 LIVE_OFF（降落）由 host 统一销毁 */
  const startAutoHide = () => {
    if (startedRef.current) return
    startedRef.current = true
    if (DRONE_AUTO_HIDE_MS <= 0) return   // 禁用自动收起（但已标记 started，避免 120s 兜底误折叠）
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
    // 播放失败且有备用地址（带框流回退原流场景）→ 切回备用地址
    if (s === 'error' && entry.fallbackUrl && playUrl !== entry.fallbackUrl) {
      setPlayUrl(entry.fallbackUrl)
    }
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

  /**
   * 视频真实宽高比（2026-09-11）：画面区/放大层原来固定 16:9，而直播源常见 4:3（1440×1080/960×720）
   * → 视频按 contain 显示时左右留黑边，检测框贴边时视觉上像"跑到画面外"。
   * 这里轮询读取 <video> 的 videoWidth/Height（1s，值变化才 setState）让容器比例跟随视频，消除黑边。
   */
  const [aspect, setAspect] = useState<number | null>(null)
  useEffect(() => {
    if (!playUrl) { setAspect(null); return }
    const tick = () => {
      const v = document.querySelector('video') as HTMLVideoElement | null
      if (v && v.videoWidth > 0 && v.videoHeight > 0) {
        const a = v.videoWidth / v.videoHeight
        setAspect(prev => (prev != null && Math.abs(prev - a) < 0.01) ? prev : a)
      }
    }
    tick()
    const iv = window.setInterval(tick, 1000)
    return () => window.clearInterval(iv)
  }, [playUrl])
  const boxAspect = aspect ?? ((entry.width && entry.height) ? entry.width / entry.height : 16 / 9)
  // 播放协议按地址推断（FLV 优先，HLS 回退；SinglePlayer 内部分别用 mpegts.js / hls.js）
  const protocol = playUrl.includes('.flv') ? 'flv' : 'hls'
  // 放大层宽度上限：同时受 视口宽/1600px/高度不超过 88vh 约束（避免 4:3 视频撑出屏幕）
  const zoomWidth = aspect
    ? `min(94vw, 1600px, ${(88 * aspect).toFixed(1)}vh)`
    : 'min(94vw, 1600px)'

  // 事件来源诊断：webhook / OSD 兜底 / 模拟 / 回灌
  const cr = entry.changeReason || ''
  const sourceLabel = cr.includes('OSD_') ? 'OSD兜底' : cr.includes('SIM') ? '模拟' : cr ? 'webhook' : '—'
  const sourceColor = cr.includes('OSD_') ? AMBER : cr.includes('SIM') ? '#ab47bc' : CYAN

  // T3 接入进度估算：mirror 建立平均 9~15s，进度按 15s 封顶 95%（避免长时间卡 100% 假象）
  const elapsed = now - entry.startedAt
  const EST_MS = 15000
  const progress = Math.min(elapsed / EST_MS, 0.95)
  const estLeft = Math.max(0, Math.ceil((EST_MS - elapsed) / 1000))

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
            {entry.width != null && entry.height != null && (
              <span style={{ color: CYAN, fontWeight: 700 }}>{entry.width}×{entry.height}</span>
            )}
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

      {/* 画面区：比例跟随视频（默认 16:9） */}
      <div style={{ position: 'relative', width: '100%', aspectRatio: String(boxAspect), background: '#000' }}>
        {playUrl ? (
          <>
            <SinglePlayer key={playUrl} url={playUrl} protocol={protocol} primary={false} onStatus={handleStatus} />
            {/* T5 实时标框：原流画面上 canvas 叠加 straw-engine 检测框 */}
            <BboxOverlay deviceSn={entry.deviceSn} videoWidth={entry.width} videoHeight={entry.height} enabled={live} />
            {/* 文字播报层：坐标/镇街/时间 常显（独立于检测，漏检时截图即可传达位置） */}
            <LiveTextOverlay deviceSn={entry.deviceSn} deviceLabel={entry.title} enabled={!!playUrl} size="sm" />
          </>
        ) : entry.phase === 'timeout' ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, background: 'rgba(0,0,0,0.85)' }}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={AMBER} strokeWidth="1.5"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
            <span style={{ color: AMBER, fontSize: 11 }}>视频流接入超时</span>
            <button onClick={() => onRetry(entry.key)} style={{ padding: '3px 14px', fontSize: 11, borderRadius: 3, border: `1px solid ${CYAN}50`, background: `${CYAN}18`, color: CYAN, cursor: 'pointer' }}>重新尝试</button>
          </div>
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, background: 'radial-gradient(ellipse at 50% 40%, rgba(0,60,120,0.25), rgba(0,10,25,0.95))' }}>
            <div style={{ width: 26, height: 26, border: `2px solid ${CYAN}25`, borderTop: `2px solid ${CYAN}`, borderRadius: '50%', animation: 'dpl-spin 1s linear infinite' }} />
            <div style={{ color: '#9ad6f0', fontSize: 12, fontWeight: 600 }}>已检测到起飞</div>
            <div style={{ color: '#5a8aaa', fontSize: 11 }}>正在接入视频流（镜像建立需约 9~15 秒）…</div>
            {/* T3 接入进度条 */}
            <div style={{ width: '70%', maxWidth: 240, height: 4, background: 'rgba(0,150,220,0.15)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${(progress * 100).toFixed(0)}%`, background: `linear-gradient(90deg, ${CYAN}, #00e5ff)`, transition: 'width 0.5s linear', borderRadius: 2 }} />
            </div>
            <div style={{ color: CYAN, fontSize: 10, fontFamily: "'JetBrains Mono',monospace" }}>
              {estLeft > 0 ? `预计还需 ~${estLeft}s` : '即将接入…'} · 已等待 {fmtDur(elapsed)}
            </div>
            <div style={{ color: '#2a4a60', fontSize: 9, fontFamily: "'JetBrains Mono',monospace" }}>
              {entry.streamId}
            </div>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 9, fontFamily: "'JetBrains Mono',monospace" }}>
              <span style={{ color: '#5a8aaa' }}>事件源</span>
              <span style={{ padding: '0 6px', borderRadius: 3, background: `${sourceColor}18`, border: `1px solid ${sourceColor}40`, color: sourceColor }}>{sourceLabel}</span>
            </div>
          </div>
        )}
        {/* 顶部叠加 LIVE/状态角标 */}
        <div style={{ position: 'absolute', top: 5, right: 6, display: 'flex', alignItems: 'center', gap: 4, background: 'rgba(0,0,0,0.55)', borderRadius: 2, padding: '1px 5px' }}>
          <span style={{ color: live ? RED : '#5a8aaa', fontSize: 9, fontFamily: "'JetBrains Mono',monospace", fontWeight: 700 }}>{live ? '● LIVE' : playUrl ? '连接中' : '待接入'}</span>
        </div>
        {/* 右下角放大按钮（有流且播放中才显示） */}
        {playUrl && live && (
          <button
            onClick={() => setZoomed(true)}
            title="放大直播画面（全屏查看）"
            style={{
              position: 'absolute', right: 6, bottom: 6, width: 26, height: 26,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: 4, border: '1px solid rgba(0,170,255,0.5)', background: 'rgba(0,40,80,0.7)',
              color: CYAN, cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0,
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="M21 3l-7 7" /><path d="M3 21l7-7" />
            </svg>
          </button>
        )}
      </div>

      {/* 机场网络流量监控条（上行带宽占用 + 拥堵预警） */}
      <NetworkStatusBar dockSn={entry.dockSn} deviceSn={entry.deviceSn} enabled={!!playUrl} />

      {/* 全屏放大层 */}
      {zoomed && playUrl && (
        <div
          onClick={() => setZoomed(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 4000, background: 'rgba(0,0,0,0.92)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12,
          }}
        >
          <div style={{ position: 'relative', width: zoomWidth, aspectRatio: String(boxAspect), background: '#000', borderRadius: 6, overflow: 'hidden', border: '1px solid rgba(0,170,255,0.3)' }}>
            <SinglePlayer key={playUrl} url={playUrl} protocol={protocol} primary={false} onStatus={() => {}} />
            {/* 放大层同样叠加实时检测框 */}
            <BboxOverlay deviceSn={entry.deviceSn} videoWidth={entry.width} videoHeight={entry.height} enabled={live} />
            {/* 文字播报层（大字号）：全屏查看时坐标/镇街/时间同样常显 */}
            <LiveTextOverlay deviceSn={entry.deviceSn} deviceLabel={entry.title} enabled={!!playUrl} size="lg" />
            {/* 画中画小地图：左下角显示无人机实时位置/朝向 */}
            <MiniDroneMap deviceSn={entry.deviceSn} enabled={live} />
            {/* 关闭按钮 */}
            <button
              onClick={(e) => { e.stopPropagation(); setZoomed(false) }}
              title="关闭放大"
              style={{
                position: 'absolute', top: 10, right: 10, width: 32, height: 32,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: 6, border: '1px solid rgba(255,255,255,0.35)', background: 'rgba(0,0,0,0.6)',
                color: '#fff', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0,
              }}
            >✕</button>
          </div>
          <div style={{ color: '#9fc3dd', fontSize: 13, textAlign: 'center', padding: '0 20px' }}>
            {entry.title || '无人机'}
            {entry.width != null && entry.height != null && (
              <span style={{ color: CYAN, fontWeight: 700, marginLeft: 10, fontFamily: "'JetBrains Mono',monospace" }}>{entry.width}×{entry.height}</span>
            )}
          </div>
          <div style={{ color: '#5a8aaa', fontSize: 11 }}>点击任意处或 ✕ 关闭放大</div>
        </div>
      )}
    </div>
  )
}
