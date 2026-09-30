import { useEffect, useState } from 'react'
import { SinglePlayer } from './VideoPlayerModal'
import { BboxOverlay } from './drvPopup/BboxOverlay'
import { MiniDroneMap } from './drvPopup/MiniDroneMap'
import { LiveTextOverlay } from './drvPopup/LiveTextOverlay'
import { fetchDroneStreamStatus } from '../lib/droneLive'

/**
 * 秸秆告警「带框直播」弹窗（P2 · 2026-09-14）
 *
 * 复用 DronePopupWindow 的播放链路，把 straw 告警的 streamId 直连到实时带框画面：
 *   - 播放策略（与 DronePopupHost 一致）：优先播**原流 FLV**（低延迟），
 *     BboxOverlay 用 canvas 实时叠加 straw-engine 检测框；bboxFlv/bboxHls 仅作 fallback
 *     （带框流 2s 抽帧 + 长 GOP，优先播会卡住弹窗 —— 2026-09-08 真飞暴露）
 *   - 叠加：BboxOverlay（检测框）+ LiveTextOverlay（坐标/镇街文字播报）+ MiniDroneMap（画中画位置）
 *   - 断流（无人机已降落 / 历史告警）：显示提示层，不报错
 *
 * 入口：告警卡「📺 带框流」按钮 / 研判依据弹窗「📺 带框直播」按钮（见 AlertPanel / AlertEvidenceModal）
 */

interface Props {
  deviceSn: string        // 无人机 SN（由 straw 告警的 streamId 去掉 sikong_ 前缀得到）
  title?: string          // 标题（机场名等）
  sub?: string            // 副标题（如 aiType）
  onClose: () => void
}

export function StrawLiveModal({ deviceSn, title, sub, onClose }: Props) {
  const [playUrl, setPlayUrl] = useState('')
  const [fallbackUrl, setFallbackUrl] = useState<string | undefined>(undefined)
  const [width, setWidth] = useState<number | null>(null)
  const [height, setHeight] = useState<number | null>(null)
  const [dockName, setDockName] = useState('')
  const [status, setStatus] = useState<'loading' | 'ready' | 'offline'>('loading')
  const [playStatus, setPlayStatus] = useState('')
  const [aspect, setAspect] = useState<number | null>(null)

  // 解析播放地址（FLV 原流优先，带框流 fallback）
  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    fetchDroneStreamStatus(deviceSn).then(info => {
      if (cancelled) return
      if (!info) { setStatus('offline'); return }
      const play = info.flv || info.hls || info.bboxFlv || info.bboxHls || ''
      setPlayUrl(play)
      setFallbackUrl(info.bboxFlv || info.bboxHls || undefined)
      setWidth(info.width ?? null)
      setHeight(info.height ?? null)
      setDockName(info.dockName || '')
      setStatus(play ? 'ready' : 'offline')
    })
    return () => { cancelled = true }
  }, [deviceSn])

  // 播放失败且有 fallback（带框流）→ 切回备用地址（同 DronePopupWindow）
  const handleStatus = (s: string) => {
    setPlayStatus(s)
    if (s === 'error' && fallbackUrl && playUrl !== fallbackUrl) setPlayUrl(fallbackUrl)
  }

  // 容器宽高比跟随视频真实分辨率（消除 4:3 塞进 16:9 的黑边，框映射才不偏移）
  useEffect(() => {
    if (!playUrl) { setAspect(null); return }
    const t = setInterval(() => {
      const v = document.querySelector('video') as HTMLVideoElement | null
      if (v && v.videoWidth > 0 && v.videoHeight > 0) {
        const a = v.videoWidth / v.videoHeight
        setAspect(prev => (prev != null && Math.abs(prev - a) < 0.01) ? prev : a)
      }
    }, 1000)
    return () => clearInterval(t)
  }, [playUrl])

  const protocol = playUrl.includes('.flv') ? 'flv' : 'hls'
  const live = playStatus === 'playing'
  const boxAspect = aspect ?? ((width && height) ? width / height : 16 / 9)
  const headerTitle = title || dockName || deviceSn

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 2400, background: 'rgba(0,0,0,0.78)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ width: 'min(92vw, 1200px)', background: 'linear-gradient(180deg, #0a1929, #0d2137)', border: '1px solid rgba(0,170,255,0.3)', borderRadius: 8, overflow: 'hidden', boxShadow: '0 8px 40px rgba(0,0,0,0.7)' }}
      >
        {/* 头部 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid rgba(0,150,220,0.2)', background: 'rgba(0,80,150,0.15)' }}>
          <span style={{ color: '#ff6b6b', fontSize: 13, fontWeight: 700 }}>📺 带框直播</span>
          <span style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 600 }}>{headerTitle}</span>
          {sub && <span style={{ color: '#7ab8e0', fontSize: 11 }}>{sub}</span>}
          <span style={{ marginLeft: 'auto', color: live ? '#ff4444' : '#5a8aaa', fontSize: 10, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace" }}>
            {live ? '● LIVE' : status === 'offline' ? '流未接入' : status === 'loading' ? '解析中…' : '连接中…'}
          </span>
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', color: '#5a8aaa', fontSize: 20, cursor: 'pointer', lineHeight: 1, padding: '0 2px' }}>✕</button>
        </div>

        {/* 画面区 */}
        <div style={{ position: 'relative', width: '100%', aspectRatio: String(boxAspect), background: '#000', maxHeight: '72vh' }}>
          {status === 'offline' ? (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#3a5a70" strokeWidth="1.5"><rect x="2" y="5" width="15" height="14" rx="2" /><path d="M17 9l5-3v12l-5-3" /></svg>
              <span style={{ color: '#9ad6f0', fontSize: 13 }}>视频流暂未接入或已断开</span>
              <span style={{ color: '#3a5a70', fontSize: 11 }}>无人机可能已降落；历史告警请以「研判依据 / 取证图」为准</span>
            </div>
          ) : playUrl ? (
            <>
              <SinglePlayer key={playUrl} url={playUrl} protocol={protocol} primary={false} onStatus={handleStatus} />
              {/* 实时标框：原流画面上 canvas 叠加 straw-engine 检测框 */}
              <BboxOverlay deviceSn={deviceSn} videoWidth={width} videoHeight={height} enabled={live} />
              {/* 文字播报：坐标/镇街/时间常显 */}
              <LiveTextOverlay deviceSn={deviceSn} deviceLabel={headerTitle} enabled={!!playUrl} size="sm" />
              {/* 画中画小地图：左下角实时位置/朝向 */}
              <MiniDroneMap deviceSn={deviceSn} enabled={live} />
            </>
          ) : (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#9ad6f0', fontSize: 12 }}>
              <div style={{ width: 24, height: 24, border: '2px solid rgba(0,170,255,0.25)', borderTop: '2px solid #00aaff', borderRadius: '50%', animation: 'dpl-spin 1s linear infinite' }} />
              正在解析播放地址…
            </div>
          )}
        </div>

        {/* 底部说明 */}
        <div style={{ padding: '8px 16px', borderTop: '1px solid rgba(0,80,150,0.15)', color: '#3a5a70', fontSize: 11 }}>
          实时带框画面：原流 + straw-engine 检测框（青=烟 / 红=火 / 黄=房）。点击任意处或 ✕ 关闭。
        </div>
      </div>
      <style>{`@keyframes dpl-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
