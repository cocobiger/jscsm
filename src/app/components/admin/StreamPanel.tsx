import { useState, useEffect } from 'react'
import { authFetch } from '../../lib/apiFetch'

// ── 视频流实时面板：每路流实时画面 + 在线状态 + 来源标识 + 播放地址 ──

const CYAN = '#00aaff'
const GREEN = '#4ade80'
const RED = '#ff4444'
const AMBER = '#ffb74d'
const ORANGE = '#ff7043'
const DIM = '#5a8aaa'

const mono = { fontFamily: "'JetBrains Mono', monospace" } as const

const card: React.CSSProperties = {
  background: 'rgba(4,14,35,0.7)',
  border: '1px solid rgba(0,80,150,0.25)',
  borderRadius: 8,
  padding: '12px 14px',
}

interface LiveStream {
  id: string; name: string; group?: string; location?: string
  lat?: number; lon?: number; url?: string; protocol?: string; offline?: boolean
  source: string; zlm_online: boolean; readers: number
  reachable: boolean | null; latencyMs: number | null; lastCheckedAt?: string | null
  dji: any | null; play: any | null; snapUrl: string
}

export function StreamPanel() {
  const [data, setData] = useState<any>(null)
  const [q, setQ] = useState('')
  const [onlyOnline, setOnlyOnline] = useState(false)
  const [focus, setFocus] = useState<LiveStream | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await authFetch('/api/streams/live')
        if (!r.ok) {
          if (alive) setErr(r.status === 401 ? '登录已过期，请重新登录' : `流状态接口 HTTP ${r.status}`)
          return
        }
        const data = await r.json()
        if (alive) { setData(data); setErr('') }
      } catch (e: any) { if (alive) setErr('流状态不可用：' + (e?.message || '')) }
    }
    load()
    const t = setInterval(load, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const all: LiveStream[] = data?.streams || []
  const onlineCount = all.filter(s => s.zlm_online || s.dji).length
  const djiCount = all.filter(s => s.dji).length
  const streams = all.filter(s =>
    (!onlyOnline || s.zlm_online || s.dji) &&
    (!q || (s.name || '').includes(q) || (s.id || '').toLowerCase().includes(q.toLowerCase()))
  )

  const snapSrc = (s: LiveStream) => s.snapUrl + (s.zlm_online || s.dji ? `&t=${Date.now()}` : '')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 顶部：统计 + 过滤 */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {[
          ['全部流', `${all.length}`, CYAN],
          ['ZLM 在线', `${all.filter(s => s.zlm_online).length}`, GREEN],
          ['抓屏会话', `${djiCount}`, ORANGE],
        ].map(([k, v, c]) => (
          <div key={k as string} style={{ ...card, padding: '6px 16px', display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 18, fontWeight: 700, color: c as string, ...mono }}>{v as string}</span>
            <span style={{ fontSize: 11, color: DIM }}>{k as string}</span>
          </div>
        ))}
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索流名 / ID…"
          style={{ background: 'rgba(0,20,50,0.6)', border: '1px solid rgba(0,80,150,0.4)', borderRadius: 4, color: '#dbe6f5', padding: '6px 10px', fontSize: 12, outline: 'none', width: 180 }} />
        <button onClick={() => setOnlyOnline(v => !v)} style={{
          padding: '6px 14px', fontSize: 12, borderRadius: 4, cursor: 'pointer', fontWeight: 600,
          border: `1px solid ${onlyOnline ? GREEN : 'rgba(0,80,150,0.4)'}`,
          background: onlyOnline ? 'rgba(74,222,128,0.12)' : 'transparent', color: onlyOnline ? GREEN : DIM,
        }}>仅在线</button>
        <span style={{ fontSize: 11, color: DIM }}>5s 自动刷新 {err && <span style={{ color: RED }}>· {err}</span>}</span>
      </div>

      {streams.length === 0 && <div style={{ ...card, color: DIM, fontSize: 13 }}>无匹配流</div>}

      {/* 流卡片网格 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
        {streams.map(s => {
          const online = s.zlm_online || !!s.dji
          return (
            <div key={s.id} onClick={() => setFocus(s)} style={{ ...card, cursor: 'pointer', transition: 'border-color 0.2s' }} onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(0,170,255,0.5)')} onMouseLeave={e => (e.currentTarget.style.borderColor = 'rgba(0,80,150,0.25)')}>
              {/* 画面 */}
              <div style={{ position: 'relative', background: 'rgba(0,0,0,0.5)', borderRadius: 6, overflow: 'hidden', minHeight: 130, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {online ? (
                  <img src={snapSrc(s)} alt="" style={{ width: '100%', display: 'block' }} onError={e => ((e.target as HTMLImageElement).style.opacity = '0')} />
                ) : (
                  <span style={{ fontSize: 12, color: DIM, padding: 24 }}>📹 离线 / 无信号</span>
                )}
                {/* 状态角标 */}
                <span style={{ position: 'absolute', top: 6, left: 6, fontSize: 10, padding: '2px 8px', borderRadius: 4, fontWeight: 600, background: online ? 'rgba(74,222,128,0.2)' : 'rgba(255,68,68,0.18)', color: online ? GREEN : RED, ...mono }}>
                  {s.dji ? '抓屏中' : s.zlm_online ? '在线' : '离线'}
                </span>
                <span style={{ position: 'absolute', top: 6, right: 6, fontSize: 10, padding: '2px 8px', borderRadius: 4, background: 'rgba(0,0,0,0.55)', color: '#9ab4d0' }}>
                  {s.source}
                </span>
              </div>
              {/* 信息 */}
              <div style={{ marginTop: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#dbe6f5' }}>{s.name || s.id}</span>
                  {s.group && <span style={{ fontSize: 10, color: DIM }}>{s.group}</span>}
                </div>
                <div style={{ fontSize: 11, color: DIM, ...mono, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.id.slice(0, 18)}…
                </div>
                <div style={{ display: 'flex', gap: 10, fontSize: 11, color: '#9ab4d0', marginTop: 6, flexWrap: 'wrap' }}>
                  {s.zlm_online && <span>👁 <b style={{ color: CYAN, ...mono }}>{s.readers}</b> 观看</span>}
                  {s.latencyMs != null && <span>延迟 <b style={{ ...mono }}>{s.latencyMs}ms</b></span>}
                  {s.lat != null && s.lon != null && Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lon)) && <span>📍 {Number(s.lat).toFixed(4)}, {Number(s.lon).toFixed(4)}</span>}
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
              <span style={{ fontSize: 15, fontWeight: 700, color: '#dbe6f5' }}>{focus.name} <span style={{ fontSize: 12, color: DIM, ...mono }}>#{focus.id.slice(0, 12)}</span></span>
              <button onClick={() => setFocus(null)} style={{ padding: '5px 12px', fontSize: 12, borderRadius: 4, cursor: 'pointer', background: 'rgba(0,20,50,0.4)', border: '1px solid rgba(0,80,150,0.4)', color: DIM }}>✕ 关闭</button>
            </div>
            <img src={focus.snapUrl + `&t=${Date.now()}`} alt="" style={{ width: '100%', maxHeight: '60vh', objectFit: 'contain', background: '#000', borderRadius: 6 }} />
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12, fontSize: 12, color: '#9ab4d0' }}>
              <span style={{ ...mono }}>状态：{focus.dji ? '抓屏中' : focus.zlm_online ? 'ZLM 在线' : '离线'}</span>
              {focus.readers > 0 && <span style={{ ...mono }}>观看 {focus.readers}</span>}
              {focus.location && <span>📍 {focus.location}</span>}
              {focus.lat != null && focus.lon != null && (
                <a href={`https://map.qq.com/?pt=${focus.lat},${focus.lon}`} target="_blank" rel="noreferrer" style={{ color: CYAN }}>腾讯地图</a>
              )}
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
