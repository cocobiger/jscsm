import { useState, useEffect, useCallback } from 'react'
import { authFetch } from '../../lib/apiFetch'
import { Satellite, Zap, FolderArchive } from 'lucide-react'

// ── 司空2 设备面板（数据贯通可视化：机场 OSD 状态 + 司空事件 + 媒体归档）──

const CYAN = '#00aaff'
const GREEN = '#4ade80'
const RED = '#ff4444'
const AMBER = '#ffb74d'
const PURPLE = '#ab47bc'
const GRAY = '#5a6b7a'

const card: React.CSSProperties = {
  background: 'rgba(4,14,35,0.7)',
  border: '1px solid rgba(0,80,150,0.25)',
  borderRadius: 8,
  padding: '14px 16px',
}

interface Dock {
  id: string
  deviceSn: string
  deviceName: string
  latitude: number
  longitude: number
  drone?: { droneSn?: string; droneName?: string } | null
  osd?: Record<string, any> | null
}

interface SkEvent {
  ts: string
  type: string | null
  classified: string
  deviceSn: string
  detail: string
  source?: string
}

interface MediaItem {
  kind: string
  name: string
  size: number
  parts: number
  mtime: string
  sn: string
  archived?: string
}

function fmtTs(ts?: string | null) {
  if (!ts) return '—'
  try { return new Date(ts).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(5, 19) } catch { return ts }
}

function healthLight(ok: boolean | null | undefined, label: string, detail: string) {
  const color = ok == null ? GRAY : ok ? GREEN : RED
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'rgba(4,14,35,0.6)', border: '1px solid rgba(0,80,150,0.2)', borderRadius: 6 }}>
      <span style={{ width: 9, height: 9, borderRadius: '50%', background: color, boxShadow: `0 0 6px ${color}`, flexShrink: 0 }} />
      <div>
        <div style={{ color: '#c8e6ff', fontSize: 12, fontWeight: 600 }}>{label}</div>
        <div style={{ color: '#5a8aaa', fontSize: 10, marginTop: 2 }}>{detail}</div>
      </div>
    </div>
  )
}

export function SikongPanel() {
  const [health, setHealth] = useState<any>(null)
  const [docks, setDocks] = useState<Dock[]>([])
  const [events, setEvents] = useState<SkEvent[]>([])
  const [media, setMedia] = useState<MediaItem[]>([])
  const [mediaByKind, setMediaByKind] = useState<Record<string, number>>({})
  const [mediaFilter, setMediaFilter] = useState<string>('')
  const [subTab, setSubTab] = useState<'docks' | 'events' | 'media'>('docks')

  const load = useCallback(() => {
    authFetch('/api/sikong/health').then(r => r.json()).then(d => d && setHealth(d)).catch(() => {})
    authFetch('/api/sikong/devices').then(r => r.json()).then(d => Array.isArray(d?.items) && setDocks(d.items)).catch(() => {})
    authFetch('/api/sikong/events').then(r => r.json()).then(d => Array.isArray(d?.events) && setEvents(d.events)).catch(() => {})
  }, [])

  const loadMedia = useCallback((kind: string) => {
    const q = kind ? `?kind=${kind}&limit=100` : '?limit=100'
    authFetch('/api/sikong/media' + q).then(r => r.json()).then(d => {
      if (d && Array.isArray(d.items)) { setMedia(d.items); setMediaByKind(d.byKind || {}) }
    }).catch(() => {})
  }, [])

  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t) }, [load])
  useEffect(() => { loadMedia(mediaFilter) }, [mediaFilter, loadMedia])

  const osdOf = (dk: Dock) => dk.osd || {}

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 链路健康（四通道） */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        {healthLight(health?.openapi?.connected, 'REST OpenAPI', health?.openapi?.connected ? `已打通 ${health?.openapi?.baseUrl || ''}` : '未连接')}
        {healthLight(health?.wsOsd?.connected, 'OSD 实时遥测', health?.wsOsd?.connected ? `在线 · 帧 ${health?.wsOsd?.framesReceived || 0}` : '断开')}
        {healthLight(health ? true : null, 'Webhook 事件', `已配置 · 收到 ${health?.webhook?.received || 0} 条`)}
        {healthLight(health?.deviceCount > 0, '设备同步', `${health?.deviceCount || 0} 台机场 · ${fmtTs(health?.devicesSyncedAt)}`)}
      </div>

      {/* 子 Tab */}
      <div style={{ display: 'flex', gap: 6 }}>
        {([
          ['docks', `机场状态 (${docks.length})`, Satellite],
          ['events', `司空事件 (${events.length})`, Zap],
          ['media', `媒体归档 (${Object.values(mediaByKind).reduce((a, b) => a + b, 0)})`, FolderArchive],
        ] as const).map(([key, label, Icon]) => (
          <button key={key} onClick={() => setSubTab(key)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '4px 14px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
            border: `1px solid ${subTab === key ? PURPLE : 'rgba(171,71,188,0.25)'}`,
            background: subTab === key ? 'rgba(171,71,188,0.15)' : 'transparent',
            color: subTab === key ? PURPLE : '#5a8aaa',
          }}>{Icon && <Icon size={13} strokeWidth={1.75} />}{label}</button>
        ))}
      </div>

      {/* 机场状态网格 */}
      {subTab === 'docks' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 10 }}>
          {docks.map(dk => {
            const o = osdOf(dk)
            const inDock = o.droneInDock === 1
            return (
              <div key={dk.deviceSn} style={{ ...card, borderColor: 'rgba(171,71,188,0.3)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ color: PURPLE, fontSize: 14, fontWeight: 700 }}>{dk.deviceName}</span>
                  <span style={{ fontSize: 11, color: inDock ? GREEN : AMBER }}>
                    {inDock ? '● 机场内待命' : o.droneInDock === 0 ? '▲ 飞行中' : '○ 遥测待接入'}
                  </span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}>
                  <span style={{ color: '#5a8aaa' }}>机场 SN</span><span style={{ color: '#9ad6f0' }}>{dk.deviceSn}</span>
                  <span style={{ color: '#5a8aaa' }}>无人机</span><span style={{ color: '#9ad6f0' }}>{dk.drone?.droneName || '—'}</span>
                  <span style={{ color: '#5a8aaa' }}>无人机电量</span><span style={{ color: (o.droneCapacityPercent ?? 0) > 50 ? GREEN : (o.droneCapacityPercent != null ? AMBER : GRAY) }}>{o.droneCapacityPercent ?? '—'}%</span>
                  <span style={{ color: '#5a8aaa' }}>风速 / 温度</span><span style={{ color: '#9ad6f0' }}>{o.windspeed ?? '—'} m/s · {o.temperature ?? '—'}℃</span>
                  <span style={{ color: '#5a8aaa' }}>环境温 / 湿度</span><span style={{ color: '#9ad6f0' }}>{o.envTemperature ?? '—'}℃ · {o.humidity ?? '—'}%</span>
                  <span style={{ color: '#5a8aaa' }}>GPS / 供电</span><span style={{ color: '#9ad6f0' }}>{o.gpsNumber ?? '—'} 颗 · {o.electricSupplyVoltage ?? '—'}V</span>
                  <span style={{ color: '#5a8aaa' }}>坐标</span><span style={{ color: '#9ad6f0' }}>{dk.latitude.toFixed(4)}, {dk.longitude.toFixed(4)}</span>
                </div>
              </div>
            )
          })}
          {docks.length === 0 && <div style={{ ...card, color: GRAY }}>司空设备同步中…</div>}
        </div>
      )}

      {/* 司空事件时间线 */}
      {subTab === 'events' && (
        <div style={{ ...card, maxHeight: 480, overflowY: 'auto' }}>
          {events.length === 0 && <div style={{ color: GRAY, fontSize: 12 }}>暂无司空事件（直播/任务/媒体发生时自动记录）</div>}
          {events.map((e, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, padding: '6px 0', borderBottom: '1px solid rgba(0,80,150,0.12)', fontSize: 12 }}>
              <span style={{ color: GRAY, fontFamily: 'JetBrains Mono, monospace', flexShrink: 0, width: 105 }}>{fmtTs(e.ts)}</span>
              <span style={{
                flexShrink: 0, fontSize: 10, padding: '1px 7px', borderRadius: 8, height: 'fit-content', marginTop: 1,
                background: e.classified === 'live' ? 'rgba(0,170,255,0.15)' : e.classified === 'media' ? 'rgba(171,71,188,0.15)' : 'rgba(255,183,77,0.15)',
                color: e.classified === 'live' ? CYAN : e.classified === 'media' ? PURPLE : AMBER,
              }}>{e.type || e.classified}</span>
              <span style={{ color: '#9ad6f0' }}>{e.detail}</span>
            </div>
          ))}
        </div>
      )}

      {/* 媒体归档 */}
      {subTab === 'media' && (
        <>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {['', 'photo', 'video', 'record', 'osd-json', 'fly-record'].map(k => (
              <button key={k || 'all'} onClick={() => setMediaFilter(k)} style={{
                padding: '3px 12px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
                border: `1px solid ${mediaFilter === k ? CYAN : 'rgba(0,170,255,0.25)'}`,
                background: mediaFilter === k ? 'rgba(0,170,255,0.12)' : 'transparent',
                color: mediaFilter === k ? CYAN : '#5a8aaa',
              }}>
                {k === '' ? '全部' : k === 'photo' ? '照片' : k === 'video' ? '任务视频' : k === 'record' ? '直播录制' : k === 'osd-json' ? '飞行OSD' : '飞行记录'}
                {mediaByKind[k] != null ? ` (${mediaByKind[k]})` : ''}
              </button>
            ))}
          </div>
          <div style={{ ...card, maxHeight: 420, overflowY: 'auto' }}>
            {media.length === 0 && <div style={{ color: GRAY, fontSize: 12 }}>暂无媒体归档</div>}
            {media.map((m, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, padding: '5px 0', borderBottom: '1px solid rgba(0,80,150,0.1)', fontSize: 12, fontFamily: 'JetBrains Mono, monospace' }}>
                <span style={{ color: GRAY, flexShrink: 0, width: 105 }}>{fmtTs(m.mtime)}</span>
                <span style={{
                  flexShrink: 0, fontSize: 10, padding: '1px 7px', borderRadius: 8, height: 'fit-content', marginTop: 1,
                  background: m.kind === 'photo' ? 'rgba(74,222,128,0.12)' : m.kind === 'video' ? 'rgba(255,112,67,0.12)' : 'rgba(0,170,255,0.1)',
                  color: m.kind === 'photo' ? GREEN : m.kind === 'video' ? '#ff7043' : CYAN,
                }}>{m.kind}</span>
                <span style={{ color: '#9ad6f0', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</span>
                <span style={{ color: '#5a8aaa', flexShrink: 0 }}>{m.size > 1048576 ? (m.size / 1048576).toFixed(1) + 'MB' : (m.size / 1024).toFixed(0) + 'KB'}</span>
                {m.archived && <span style={{ color: GREEN, flexShrink: 0, fontSize: 10 }}>已回流</span>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
