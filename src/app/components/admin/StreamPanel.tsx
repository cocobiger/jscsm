import { useState, useEffect } from 'react'
import { authFetch, getToken } from '../../lib/apiFetch'

// ── 司空视频流面板：只展示司空 OpenAPI 通道的视频流（机场/无人机 → 司空 ZLM → 我方 ZLM mirror）──

const CYAN = '#00aaff'
const GREEN = '#4ade80'
const RED = '#ff4444'
const AMBER = '#ffb74d'
const PURPLE = '#b388ff'
const DIM = '#5a8aaa'

const mono = { fontFamily: "'JetBrains Mono', monospace" } as const

const card: React.CSSProperties = {
  background: 'rgba(4,14,35,0.7)',
  border: '1px solid rgba(0,80,150,0.25)',
  borderRadius: 8,
  padding: '12px 14px',
}

interface SikongStream {
  id: string            // mirror 流名 sikong_<SN>
  sikongSn: string      // 司空 SN
  role: 'dock' | 'drone'
  deviceName: string
  droneSn: string | null
  lat: number | null
  lon: number | null
  sikongLive: boolean   // 司空 ZLM 上正在直播
  zlm_online: boolean   // 我方 ZLM mirror 在线
  readers: number
  osd: any | null
  play: any | null
  snapUrl: string
}

export function StreamPanel() {
  const [data, setData] = useState<any>(null)
  const [focus, setFocus] = useState<SikongStream | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await authFetch('/api/sikong/live-streams')
        if (!r.ok) {
          if (alive) setErr(r.status === 401 ? '登录已过期，请重新登录' : `司空流接口 HTTP ${r.status}`)
          return
        }
        const data = await r.json()
        if (alive) { setData(data); setErr('') }
      } catch (e: any) { if (alive) setErr('司空链路不可用：' + (e?.message || '')) }
    }
    load()
    const t = setInterval(load, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const all: SikongStream[] = data?.items || []
  const docks = all.filter(s => s.role === 'dock')
  const liveCount = data?.sikongLiveCount ?? all.filter(s => s.sikongLive).length
  const mirrorCount = data?.mirrorOnlineCount ?? all.filter(s => s.zlm_online).length

  const snapSrc = (s: SikongStream) => s.snapUrl + `&token=${encodeURIComponent(getToken())}` + (s.zlm_online ? `&t=${Date.now()}` : '')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 顶部：统计 + 说明 */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {[
          ['司空机场', `${docks.length}`, PURPLE],
          ['无人机', `${all.length - docks.length}`, CYAN],
          ['司空直播中', `${liveCount}`, AMBER],
          ['mirror 在线', `${mirrorCount}`, GREEN],
        ].map(([k, v, c]) => (
          <div key={k as string} style={{ ...card, padding: '6px 16px', display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 18, fontWeight: 700, color: c as string, ...mono }}>{v as string}</span>
            <span style={{ fontSize: 11, color: DIM }}>{k as string}</span>
          </div>
        ))}
        <span style={{ fontSize: 11, color: DIM }}>司空 OpenAPI 通道 · 5s 自动刷新 {err && <span style={{ color: RED }}>· {err}</span>}</span>
      </div>

      {all.length === 0 && <div style={{ ...card, color: DIM, fontSize: 13 }}>司空设备同步中…（dji-openapi 60s 周期）</div>}

      {/* 流卡片网格 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
        {all.map(s => {
          const online = s.zlm_online
          return (
            <div key={s.id} onClick={() => setFocus(s)} style={{ ...card, cursor: 'pointer', transition: 'border-color 0.2s' }} onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(0,170,255,0.5)')} onMouseLeave={e => (e.currentTarget.style.borderColor = 'rgba(0,80,150,0.25)')}>
              {/* 画面 */}
              <div style={{ position: 'relative', background: 'rgba(0,0,0,0.5)', borderRadius: 6, overflow: 'hidden', minHeight: 130, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {online ? (
                  <img src={snapSrc(s)} alt="" style={{ width: '100%', display: 'block' }} onError={e => ((e.target as HTMLImageElement).style.opacity = '0')} />
                ) : (
                  <span style={{ fontSize: 12, color: DIM, padding: 24 }}>{s.sikongLive ? '司空直播中 · mirror 建立中' : '📹 待机 / 未开播'}</span>
                )}
                {/* 状态角标 */}
                <span style={{ position: 'absolute', top: 6, left: 6, fontSize: 10, padding: '2px 8px', borderRadius: 4, fontWeight: 600, background: online ? 'rgba(74,222,128,0.2)' : s.sikongLive ? 'rgba(255,183,77,0.18)' : 'rgba(90,138,170,0.15)', color: online ? GREEN : s.sikongLive ? AMBER : DIM, ...mono }}>
                  {online ? 'mirror 在线' : s.sikongLive ? '司空直播中' : '待机'}
                </span>
                <span style={{ position: 'absolute', top: 6, right: 6, fontSize: 10, padding: '2px 8px', borderRadius: 4, background: 'rgba(0,0,0,0.55)', color: s.role === 'dock' ? PURPLE : CYAN }}>
                  {s.role === 'dock' ? '机场' : '无人机'}
                </span>
              </div>
              {/* 信息 */}
              <div style={{ marginTop: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#dbe6f5' }}>{s.deviceName}{s.role === 'drone' ? ' · 机' : ''}</span>
                  <span style={{ fontSize: 10, color: DIM, ...mono }}>{s.sikongSn.slice(-6)}</span>
                </div>
                <div style={{ fontSize: 11, color: DIM, ...mono, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.sikongSn}
                </div>
                <div style={{ display: 'flex', gap: 10, fontSize: 11, color: '#9ab4d0', marginTop: 6, flexWrap: 'wrap' }}>
                  {online && <span>👁 <b style={{ color: CYAN, ...mono }}>{s.readers}</b> 观看</span>}
                  {s.osd?.droneCapacityPercent != null && <span>🔋 <b style={{ ...mono }}>{s.osd.droneCapacityPercent}%</b></span>}
                  {s.osd?.windspeed != null && <span>💨 {s.osd.windspeed}m/s</span>}
                  {s.lat != null && s.lon != null && <span>📍 {Number(s.lat).toFixed(4)}, {Number(s.lon).toFixed(4)}</span>}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* 放大预览 */}
      {focus && (
        <div onClick={() => setFocus(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,5,15,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 24 }}>
          <div onClick={e => e.stopPropagation()} style={{ maxWidth: 'min(1000px, 92vw)', width: '100%', background: 'rgba(4,18,40,0.97)', border: `1px solid ${CYAN}55`, borderRadius: 10, padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: '#dbe6f5' }}>{focus.deviceName} <span style={{ fontSize: 12, color: DIM, ...mono }}>#{focus.sikongSn}</span></span>
              <button onClick={() => setFocus(null)} style={{ padding: '5px 12px', fontSize: 12, borderRadius: 4, cursor: 'pointer', background: 'rgba(0,20,50,0.4)', border: '1px solid rgba(0,80,150,0.4)', color: DIM }}>✕ 关闭</button>
            </div>
            {focus.zlm_online ? (
              <img src={focus.snapUrl + `&token=${encodeURIComponent(getToken())}&t=${Date.now()}`} alt="" style={{ width: '100%', maxHeight: '60vh', objectFit: 'contain', background: '#000', borderRadius: 6 }} />
            ) : (
              <div style={{ padding: 40, textAlign: 'center', color: DIM, fontSize: 13, background: 'rgba(0,0,0,0.4)', borderRadius: 6 }}>
                {focus.sikongLive ? '司空正在直播，mirror 建立中…' : '设备待机中，机场起飞开播后自动上线'}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12, fontSize: 12, color: '#9ab4d0' }}>
              <span style={{ ...mono }}>类型：{focus.role === 'dock' ? '机场' : '无人机'}</span>
              <span style={{ ...mono }}>状态：{focus.zlm_online ? 'mirror 在线' : focus.sikongLive ? '司空直播中' : '待机'}</span>
              {focus.readers > 0 && <span style={{ ...mono }}>观看 {focus.readers}</span>}
              {focus.droneSn && <span style={{ ...mono }}>无人机 {focus.droneSn}</span>}
              {focus.lat != null && focus.lon != null && <span>📍 {Number(focus.lat).toFixed(5)}, {Number(focus.lon).toFixed(5)}</span>}
            </div>
            {/* 播放地址 */}
            {focus.play && (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11 }}>
                {[
                  ['FLV', focus.play.flv], ['HLS', focus.play.hls], ['WebRTC', focus.play.webrtc], ['RTSP', focus.play.rtsp],
                ].filter(([, u]) => u).map(([k, u]) => (
                  <div key={k as string} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ color: AMBER, width: 44 }}>{k}</span>
                    <code style={{ color: DIM, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u as string}</code>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
