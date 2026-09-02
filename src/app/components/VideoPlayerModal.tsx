import { useEffect, useRef, useState, useCallback } from 'react'
import { getApiKey } from '../lib/apiFetch'
import mpegtsRaw from 'mpegts.js'
import HlsRaw from 'hls.js'
const mpegts = ((mpegtsRaw as any).default ?? mpegtsRaw) as typeof mpegtsRaw
const Hls = ((HlsRaw as any).default ?? HlsRaw) as typeof HlsRaw

import type { DJIWebRTCConfig } from '../context/DashboardContext'

// 判断是否需经后端转换（浏览器无法直接播 RTSP / DJI WebRTC）
function needsTranscode(url: string, protocol: string) {
  // RTSP 源始终需要后端转换，不管 protocol 标签是什么
  if (/^rtsp:\/\//i.test(url)) return true
  return protocol === 'rtsp' || protocol === 'onvif' || protocol === 'gb28281' || protocol === 'dji_webrtc'
}
// 由 url 派生稳定 streamId
function deriveStreamId(url: string) {
  let h = 0
  for (let i = 0; i < url.length; i++) { h = ((h << 5) - h + url.charCodeAt(i)) | 0 }
  return 's' + Math.abs(h).toString(36)
}

const CYAN = '#00aaff'
const GREEN = '#00e676'
const RED = '#ff4444'
const AMBER = '#ffd740'

interface Props {
  name: string
  location: string
  url: string
  protocol: string
  djiConfig?: DJIWebRTCConfig
  onClose: () => void
}

type PlayStatus = 'loading' | 'playing' | 'error' | 'no-url' | 'reconnecting'
type LayoutMode = '1' | '4' | '9'

function isFLV(url: string) { return url.includes('.flv') }
function isWebRTC(url: string) { return url.startsWith('webrtc://') || url.startsWith('whep://') }

const PROTOCOL_COLOR: Record<string, string> = {
  rtsp: '#3a5a70', hls: GREEN, webrtc: CYAN, onvif: AMBER, gb28281: AMBER, dji_webrtc: AMBER, flv: '#ab47bc',
}

function GridIcon({ n }: { n: number }) {
  const cols = n === 1 ? 1 : n === 4 ? 2 : 3
  return (
    <svg width="14" height="14" viewBox="0 0 12 12">
      {Array.from({ length: n }).map((_, i) => {
        const col = i % cols, row = Math.floor(i / cols)
        const size = 12 / cols - 1
        return <rect key={i} x={col * (size + 1)} y={row * (size + 1)} width={size} height={size} rx="0.5" fill="currentColor" />
      })}
    </svg>
  )
}

function SinglePlayer({
  url, protocol, primary, djiConfig, onSnapshot, onStatus,
}: { url: string; protocol: string; primary: boolean; djiConfig?: DJIWebRTCConfig; onSnapshot?: (dataUri: string) => void; onStatus?: (s: PlayStatus) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const playerRef = useRef<ReturnType<typeof mpegts.createPlayer> | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const hlsRef = useRef<InstanceType<typeof Hls> | null>(null)
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const snapshotRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const snapshotDoneRef = useRef(false)
  const [status, setStatus] = useState<PlayStatus>('loading')
  // 供外部（如无人机弹窗）感知播放状态：playing 时启动 30s 自动收起计时
  const updateStatus = useCallback((s: PlayStatus) => { setStatus(s); onStatus?.(s) }, [onStatus])
  const [errMsg, setErrMsg] = useState('')
  const [retryNum, setRetryNum] = useState(0)
  const retryNumRef = useRef(0)
  // 重连预算拉长到 ~89s：DJI 司空 WebRTC 推流需先加载 FlightHub 页面+推流，
  // 后端已改为立即返回播放地址（避免云网关 60s 超时 504），前端需扛过这段空窗。
  const DELAYS = [2000, 4000, 8000, 15000, 30000, 30000]

  const destroy = useCallback(() => {
    if (retryRef.current) { clearTimeout(retryRef.current); retryRef.current = null }
    if (snapshotRef.current) { clearTimeout(snapshotRef.current); snapshotRef.current = null }
    if (playerRef.current) {
      try { playerRef.current.unload(); playerRef.current.detachMediaElement(); playerRef.current.destroy() } catch {}
      playerRef.current = null
    }
    if (hlsRef.current) {
      try { hlsRef.current.destroy() } catch {}
      hlsRef.current = null
    }
    if (pcRef.current) { try { pcRef.current.close() } catch {}; pcRef.current = null }
  }, [])

  const scheduleRetry = useCallback((streamUrl: string) => {
    const n = retryNumRef.current
    if (n >= DELAYS.length) { updateStatus('error'); setErrMsg('已重试多次仍无法连接，请检查视频源或稍后重试'); return }
    retryNumRef.current = n + 1
    setRetryNum(n + 1)
    updateStatus('reconnecting')
    retryRef.current = setTimeout(() => play(streamUrl), DELAYS[n])
  }, [])

  const play = useCallback((streamUrl: string) => {
    if (!streamUrl) { updateStatus('no-url'); return }
    const el = videoRef.current
    if (!el) return
    destroy()
    updateStatus('loading')
    setErrMsg('')

    if (isWebRTC(streamUrl)) {
      // WHEP-based WebRTC playback
      const whepUrl = streamUrl.replace('webrtc://', 'http://').replace('whep://', 'https://')
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
      pcRef.current = pc
      pc.addTransceiver('video', { direction: 'recvonly' })
      pc.addTransceiver('audio', { direction: 'recvonly' })
      pc.ontrack = (ev) => { el.srcObject = ev.streams[0]; el.play().catch(() => {}) }
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'connected') updateStatus('playing')
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') scheduleRetry(streamUrl)
      }
      pc.createOffer().then(offer => {
        pc.setLocalDescription(offer)
        return fetch(whepUrl, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: offer.sdp })
      }).then(r => r.text()).then(sdp => {
        pc.setRemoteDescription({ type: 'answer', sdp })
      }).catch(() => scheduleRetry(streamUrl))
      return
    }

    if (isFLV(streamUrl) || protocol === 'hls' && streamUrl.endsWith('.flv')) {
      if (!mpegts.isSupported()) { updateStatus('error'); setErrMsg('浏览器不支持 HTTP-FLV'); return }
      const p = mpegts.createPlayer(
        { type: 'flv', url: streamUrl, isLive: true, cors: true, hasAudio: false, hasVideo: true },
        { enableWorker: false, lazyLoadMaxDuration: 180, seekType: 'range' }
      )
      playerRef.current = p
      p.attachMediaElement(el)
      p.load(); p.play()?.catch(() => {})
      p.on(mpegts.Events.ERROR, (_: unknown, ed: { type?: string; details?: string } | undefined) => {
        updateStatus('error')
        setErrMsg(`${ed?.type ?? '流错误'}：${ed?.details ?? '无法连接，请检查地址与网络'}`)
        scheduleRetry(streamUrl)
      })
      el.onplaying = () => updateStatus('playing')
      return
    }

    // HLS m3u8：Chrome/Edge/Firefox 需 hls.js，Safari/iOS 原生支持
    if (streamUrl.includes('.m3u8') && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true, lowLatencyMode: true, liveDurationInfinity: true })
      hlsRef.current = hls
      hls.loadSource(streamUrl)
      hls.attachMedia(el)
      hls.on(Hls.Events.MANIFEST_PARSED, () => { el.play().catch(() => {}) })
      hls.on(Hls.Events.ERROR, (_e: unknown, data: { fatal?: boolean; details?: string }) => {
        if (data.fatal) {
          updateStatus('error')
          setErrMsg(data.details ? `HLS错误：${data.details}` : 'HLS流连接失败')
          scheduleRetry(streamUrl)
        }
      })
      el.onplaying = () => updateStatus('playing')
      el.onwaiting = () => updateStatus('loading')
      return
    }
    // Native (Safari/iOS 原生 HLS, mp4 等)
    el.src = streamUrl
    el.onplaying = () => updateStatus('playing')
    el.onwaiting = () => updateStatus('loading')
    el.onerror = () => { updateStatus('error'); setErrMsg('无法播放，请检查流格式'); scheduleRetry(streamUrl) }
    el.play().catch(() => {})
  }, [destroy, scheduleRetry, protocol])

  const scheduleSnapshot = useCallback(() => {
    if (!onSnapshot || snapshotDoneRef.current) return
    if (snapshotRef.current) clearTimeout(snapshotRef.current)
    snapshotRef.current = setTimeout(() => {
      const el = videoRef.current
      if (!el || el.readyState < 2) return
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 255
        canvas.height = 125
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        const vw = el.videoWidth || 16
        const vh = el.videoHeight || 9
        const scale = Math.min(255 / vw, 125 / vh)
        const dw = vw * scale
        const dh = vh * scale
        const dx = (255 - dw) / 2
        const dy = (125 - dh) / 2
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, 255, 125)
        ctx.drawImage(el, dx, dy, dw, dh)
        const dataUri = canvas.toDataURL('image/jpeg', 0.7)
        if (dataUri && dataUri.length > 100) {
          snapshotDoneRef.current = true
          onSnapshot(dataUri)
        }
      } catch {
        // canvas 被跨域污染时 toDataURL 抛 SecurityError，静默跳过
      }
    }, 3000)
  }, [onSnapshot])

  useEffect(() => {
    if (status === 'playing') {
      scheduleSnapshot()
    }
  }, [status, scheduleSnapshot])

  useEffect(() => {
    retryNumRef.current = 0
    setRetryNum(0)
    snapshotDoneRef.current = false
    if (!url && protocol !== 'dji_webrtc') { updateStatus('no-url'); return }
    if (needsTranscode(url, protocol)) {
      // RTSP/ONVIF/GB28181/DJI WebRTC：先请求后端转换为可播放地址
      updateStatus('loading')
      const sid = protocol === 'dji_webrtc' && djiConfig
        ? deriveStreamId(
            djiConfig.parentName
              ? `${djiConfig.shareUrl}#${djiConfig.parentName}|${djiConfig.airportName}`
              : `${djiConfig.shareUrl}#${djiConfig.airportName}`
          )
        : deriveStreamId(url)
      const key = getApiKey()
      const body: Record<string, unknown> = { id: sid, url }
      if (protocol === 'dji_webrtc') {
        body.protocol = 'dji_webrtc'
        body.djiConfig = djiConfig
      }
      fetch('/api/stream/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
        body: JSON.stringify(body),
      })
        .then(r => r.json())
        .then((res: any) => {
          if (res && res.ok && res.hls) {
            // 优先用 HLS（支持 H.264 + H.265/HEVC）
            // 绝对地址转相对路径，避免跨域（nginx 已配 /jsc/ 和 /jsc_h264/ 反代）
            let hlsUrl = res.hls
            const m = hlsUrl.match(/\/jsc(?:_h264)?\/.+\/hls\.m3u8/)
            if (m) hlsUrl = m[0]
            play(hlsUrl)
          } else if (res && res.ok && res.flvUrl) {
            // FLV 仅作为降级（不支持 H.265）
            let flvUrl = res.flvUrl
            const m = flvUrl.match(/\/jsc(?:_h264)?\/.+\.live\.flv/)
            if (m) flvUrl = m[0]
            play(flvUrl)
          } else {
            updateStatus('error')
            setErrMsg(res?.error || res?.note || '后端转换失败，请确认已配置 ZLMediaKit')
          }
        })
        .catch(() => { updateStatus('error'); setErrMsg('无法连接后端转换服务') })
    } else {
      play(url)
    }
    return destroy
  }, [url])

  const badge = isFLV(url) ? 'HTTP-FLV' : isWebRTC(url) ? 'WebRTC' : protocol === 'dji_webrtc' ? 'DJI WebRTC' : protocol.toUpperCase()
  const badgeColor = PROTOCOL_COLOR[badge.toLowerCase()] ?? '#3a5a70'

  return (
    <div style={{ position: 'relative', background: '#000', width: '100%', height: '100%' }}>
      <video ref={videoRef} style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} controls={primary} muted playsInline />

      {primary && (
        <div style={{ position: 'absolute', top: 6, left: 6, display: 'flex', gap: 4 }}>
          <span style={{ padding: '1px 6px', fontSize: 10, fontFamily: "'JetBrains Mono',monospace", borderRadius: 2, background: `${badgeColor}22`, border: `1px solid ${badgeColor}50`, color: badgeColor }}>
            {badge}
          </span>
        </div>
      )}

      {status === 'loading' && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, background: 'rgba(0,0,0,0.7)', pointerEvents: 'none' }}>
          <div style={{ width: 24, height: 24, border: `2px solid ${CYAN}30`, borderTop: `2px solid ${CYAN}`, borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
          <span style={{ color: '#5a8aaa', fontSize: 11 }}>连接中…</span>
        </div>
      )}
      {status === 'reconnecting' && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, background: 'rgba(0,0,0,0.8)', pointerEvents: 'none' }}>
          <div style={{ width: 24, height: 24, border: `2px solid ${AMBER}30`, borderTop: `2px solid ${AMBER}`, borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
          <span style={{ color: AMBER, fontSize: 11 }}>重连中 {retryNum}/{DELAYS.length}…</span>
        </div>
      )}
      {status === 'error' && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, background: 'rgba(0,0,0,0.85)' }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={RED} strokeWidth="1.5"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
          <span style={{ color: RED, fontSize: 12, fontWeight: 600 }}>连接失败</span>
          <span style={{ color: '#5a8aaa', fontSize: 10, textAlign: 'center', maxWidth: 200, lineHeight: 1.5 }}>{errMsg}</span>
          <button onClick={() => { retryNumRef.current = 0; setRetryNum(0); play(url) }} style={{ padding: '4px 12px', fontSize: 11, borderRadius: 2, border: `1px solid ${CYAN}40`, background: `${CYAN}15`, color: CYAN, cursor: 'pointer', marginTop: 4 }}>重试</button>
        </div>
      )}
      {status === 'no-url' && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.8)' }}>
          <span style={{ color: '#3a5a70', fontSize: 12 }}>未配置流地址</span>
        </div>
      )}
      {status === 'playing' && (
        <div style={{ position: 'absolute', top: 6, right: 6, display: 'flex', alignItems: 'center', gap: 3 }}>
          <div style={{ width: 5, height: 5, borderRadius: '50%', background: RED, boxShadow: `0 0 4px ${RED}`, animation: 'live-blink 1.5s infinite' }} />
          <span style={{ color: RED, fontSize: 9, fontFamily: "'JetBrains Mono',monospace", fontWeight: 700 }}>LIVE</span>
        </div>
      )}
    </div>
  )
}

export function VideoPlayerModal({ name, location, url, protocol, djiConfig, onClose }: Props) {
  const [layout, setLayout] = useState<LayoutMode>('1')
  const count = layout === '1' ? 1 : layout === '4' ? 4 : 9

  const gridStyle: React.CSSProperties = layout === '1'
    ? { display: 'block', aspectRatio: '16/9' }
    : layout === '4'
      ? { display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', height: 480 }
      : { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gridTemplateRows: '1fr 1fr 1fr', height: 600 }

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,0.92)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{ width: 'min(92vw, 1100px)', background: '#040e25', border: '1px solid rgba(0,150,220,0.3)', borderRadius: 6, boxShadow: '0 0 60px rgba(0,100,255,0.2)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid rgba(0,80,150,0.25)', flexShrink: 0 }}>
          <div style={{ width: 3, height: 14, background: CYAN, borderRadius: 1 }} />
          <div style={{ flex: 1 }}>
            <div style={{ color: '#c8e6ff', fontSize: 14, fontWeight: 600 }}>{name}</div>
            <div style={{ color: '#5a8aaa', fontSize: 11 }}>{location}</div>
          </div>

          {/* Layout switcher */}
          <div style={{ display: 'flex', gap: 3 }}>
            {(['1', '4', '9'] as LayoutMode[]).map(m => (
              <button key={m} onClick={() => setLayout(m)} title={`${m}宫格`} style={{
                width: 28, height: 28, borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: `1px solid ${layout === m ? CYAN : 'rgba(0,150,220,0.25)'}`,
                background: layout === m ? `${CYAN}18` : 'transparent',
                color: layout === m ? CYAN : '#5a8aaa', cursor: 'pointer',
              }}>
                <GridIcon n={Number(m)} />
              </button>
            ))}
          </div>

          <button onClick={onClose} style={{ width: 26, height: 26, borderRadius: 3, border: '1px solid rgba(0,150,220,0.2)', background: 'rgba(0,80,150,0.15)', color: '#5a8aaa', cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
        </div>

        {/* Video grid */}
        <div style={{ background: '#000', ...gridStyle }}>
          {Array.from({ length: count }).map((_, i) => (
            <div key={i} style={{ position: 'relative', border: i > 0 ? '1px solid rgba(0,100,180,0.2)' : undefined }}>
              <SinglePlayer url={i === 0 ? url : ''} protocol={protocol} djiConfig={djiConfig} primary={i === 0} />
              {i > 0 && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,10,25,0.7)', pointerEvents: 'none' }}>
                  <span style={{ color: '#2a4a60', fontSize: 11 }}>窗口 {i + 1}</span>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Footer */}
        {(url || protocol === 'dji_webrtc') && (
          <div style={{ padding: '6px 14px', borderTop: '1px solid rgba(0,80,150,0.2)', flexShrink: 0 }}>
            <div style={{ color: '#3a5a70', fontSize: 10, fontFamily: "'JetBrains Mono',monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {protocol === 'dji_webrtc' && djiConfig ? `DJI WebRTC · ${djiConfig.airportName} · ${djiConfig.shareUrl}` : url}
            </div>
            {url && isFLV(url) && url.startsWith('http://') && (
              <div style={{ color: AMBER, fontSize: 10, marginTop: 2 }}>⚠ HTTP 地址在 HTTPS 页面下可能被浏览器拦截混合内容</div>
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes live-blink { 0%,100%{opacity:1} 50%{opacity:0.3} }
      `}</style>
    </div>
  )
}

// 供视频墙等复用：单路播放器（与弹窗内同一套 RTSP→FLV/WebRTC 播放逻辑）
export { SinglePlayer }
