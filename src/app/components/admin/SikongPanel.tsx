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
  path?: string
}

function fmtTs(ts?: string | null) {
  if (!ts) return '—'
  try { return new Date(ts).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(5, 19) } catch { return ts }
}

// ── 轻量月历（直播录制按日期浏览：有录制的日期打点高亮，点击筛选/再点取消）──
const CAL_BTN: React.CSSProperties = {
  padding: '2px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12,
  border: '1px solid rgba(0,170,255,0.3)', background: 'rgba(0,170,255,0.08)', color: CYAN,
}
function MonthCalendar({ dates, selected, onPick }: { dates: Record<string, number>; selected: string; onPick: (d: string) => void }) {
  const now = new Date()
  const [ym, setYm] = useState(() => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)
  const [y, m] = ym.split('-').map(Number)
  const startDow = new Date(y, m - 1, 1).getDay()
  const daysInMonth = new Date(y, m, 0).getDate()
  const todayKey = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const cells: (number | null)[] = []
  for (let i = 0; i < startDow; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)
  const monthShift = (delta: number) => setYm(prev => {
    const [yy, mm] = prev.split('-').map(Number)
    const d = new Date(yy, mm - 1 + delta, 1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
  return (
    <div style={{ background: 'rgba(4,14,35,0.7)', border: '1px solid rgba(0,80,150,0.25)', borderRadius: 8, padding: '10px 12px', width: 268, flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <button onClick={() => monthShift(-1)} style={CAL_BTN}>‹</button>
        <span style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 700 }}>{y}年{m}月</span>
        <button onClick={() => monthShift(1)} style={CAL_BTN}>›</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, textAlign: 'center', fontSize: 10, color: '#5a8aaa', marginBottom: 4 }}>
        {['日', '一', '二', '三', '四', '五', '六'].map(w => <span key={w}>{w}</span>)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
        {cells.map((d, i) => d ? (() => {
          const key = `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`
          const has = !!dates[key]
          const sel = key === selected
          return (
            <button key={i} onClick={() => onPick(key)}
              title={has ? `${key.slice(0,4)}-${key.slice(4,6)}-${key.slice(6)} · ${dates[key]} 条` : undefined}
              style={{
                aspectRatio: '1', fontSize: 11, borderRadius: 4, cursor: 'pointer', position: 'relative',
                border: sel ? '1px solid #00aaff' : '1px solid transparent',
                background: sel ? 'rgba(0,170,255,0.22)' : has ? 'rgba(0,170,255,0.1)' : 'transparent',
                color: key === todayKey ? '#7fd0ff' : has ? '#9ad6f0' : '#3a5568',
              }}>
              {d}
              {has && <span style={{ position: 'absolute', bottom: 2, left: '50%', transform: 'translateX(-50%)', width: 4, height: 4, borderRadius: '50%', background: sel ? '#00aaff' : '#4ade80' }} />}
            </button>
          )
        })() : <div key={i} />)}
      </div>
    </div>
  )
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
  const [mediaPage, setMediaPage] = useState(0)
  const [mediaTotal, setMediaTotal] = useState(0)
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({})
  const [mediaDates, setMediaDates] = useState<Record<string, number>>({})
  const [mediaDate, setMediaDate] = useState('')
  const [mediaQuery, setMediaQuery] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [subTab, setSubTab] = useState<'docks' | 'events' | 'media'>('docks')
  const [play, setPlay] = useState<{ url: string; name: string; size: number } | null>(null)
  const [playLoading, setPlayLoading] = useState(false)
  const [playError, setPlayError] = useState('')

  const PAGE_SIZE = 20

  const load = useCallback(() => {
    authFetch('/api/sikong/health').then(r => r.json()).then(d => d && setHealth(d)).catch(() => {})
    authFetch('/api/sikong/devices').then(r => r.json()).then(d => Array.isArray(d?.items) && setDocks(d.items)).catch(() => {})
    authFetch('/api/sikong/events').then(r => r.json()).then(d => Array.isArray(d?.events) && setEvents(d.events)).catch(() => {})
  }, [])

  /** 为视频类媒体批量签发缩略图签名 URL（懒加载：仅当前页） */
  const fetchThumbs = useCallback((items: MediaItem[]) => {
    const vids = items.filter(m => m.path && (m.kind === 'record' || m.kind === 'video' || m.kind === 'photo'))
    if (vids.length === 0) return
    Promise.allSettled(vids.map(async m => {
      const d = await authFetch('/api/sikong/media-sign?path=' + encodeURIComponent(m.path!)).then(r => r.json())
      return [m.path, '/dji-video' + d.url.replace('/api/media/play', '/api/media/thumb')] as [string, string]
    })).then(results => {
      const map: Record<string, string> = {}
      for (const r of results) if (r.status === 'fulfilled' && r.value && r.value[0] && r.value[1]) map[r.value[0]] = r.value[1]
      if (Object.keys(map).length) setThumbUrls(prev => ({ ...prev, ...map }))
    }).catch(() => {})
  }, [])

  /** 照片：新窗口打开原图 */
  const openPhoto = useCallback((m: MediaItem) => {
    if (!m.path) return
    authFetch('/api/sikong/media-sign?path=' + encodeURIComponent(m.path))
      .then(r => r.json())
      .then(d => { if (d && d.ok && d.url) window.open('/dji-video' + d.url, '_blank') })
      .catch(() => {})
  }, [])

  const loadMedia = useCallback((kind: string, offset = 0, date = '', q = '') => {
    const params = new URLSearchParams()
    params.set('limit', String(PAGE_SIZE))
    if (offset) params.set('offset', String(offset))
    if (kind) params.set('kind', kind)
    if (date) params.set('date', date)
    if (q) params.set('q', q)
    authFetch('/api/sikong/media?' + params.toString()).then(r => r.json()).then(d => {
      if (d && Array.isArray(d.items)) {
        setMedia(d.items)
        setMediaByKind(d.byKind || {})
        setMediaTotal(d.total || 0)
        fetchThumbs(d.items)
      }
    }).catch(() => {})
  }, [fetchThumbs])

  /** 当前子栏目的日历日期分布（有录制的日期打点） */
  const loadDates = useCallback((kind: string) => {
    const q = kind ? `?kind=${kind}&dates=1` : '?dates=1'
    authFetch('/api/sikong/media' + q).then(r => r.json()).then(d => {
      if (d && d.dates) setMediaDates(d.dates)
    }).catch(() => {})
  }, [])

  /** 媒体行点击：video/record 弹播放器；osd-json/fly-record 触发下载 */
  const triggerDownload = useCallback((m: MediaItem) => {
    if (!m.path) return
    authFetch('/api/sikong/media-sign?path=' + encodeURIComponent(m.path))
      .then(r => r.json())
      .then(d => {
        if (!d || !d.ok || !d.url) return
        const a = document.createElement('a')
        a.href = '/dji-video' + d.url
        a.download = m.name
        document.body.appendChild(a)
        a.click()
        a.remove()
      })
      .catch(() => {})
  }, [])

  const openPlayer = useCallback((m: MediaItem) => {
    if (!m.path) return
    setPlayError('')
    setPlayLoading(true)
    authFetch('/api/sikong/media-sign?path=' + encodeURIComponent(m.path))
      .then(r => r.json())
      .then(d => {
        if (d && d.ok && d.url) {
          // 签名 URL 是 dji-openapi 内部相对路径（/api/media/play），需经 nginx /dji-video/ 反代到公网
          setPlay({ url: '/dji-video' + d.url, name: m.name, size: m.size })
        } else {
          setPlayError(d?.error || '签名失败')
        }
      })
      .catch(e => setPlayError('播放地址获取失败'))
      .finally(() => setPlayLoading(false))
  }, [])

  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t) }, [load])
  // 切换栏目：清空日历/搜索残留状态，防止污染其他 kind
  useEffect(() => { setMediaDate(''); setMediaQuery(''); setDebouncedQ('') }, [mediaFilter])
  // 搜索防抖 300ms
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(mediaQuery.trim()), 300)
    return () => clearTimeout(t)
  }, [mediaQuery])
  // 子 tab / 日期 / 搜索 变化：重置第 1 页并加载
  useEffect(() => { setMediaPage(0); loadMedia(mediaFilter, 0, mediaDate, debouncedQ) }, [mediaFilter, mediaDate, debouncedQ, loadMedia])
  // 切换子栏目：刷新该栏目日历日期分布（"全部"=空 kind）
  useEffect(() => { loadDates(mediaFilter) }, [mediaFilter, loadDates])

  const goPage = useCallback((p: number) => {
    if (p < 0) return
    const maxPage = Math.max(0, Math.ceil(mediaTotal / PAGE_SIZE) - 1)
    if (p > maxPage) return
    setMediaPage(p)
    loadMedia(mediaFilter, p * PAGE_SIZE, mediaDate, debouncedQ)
  }, [mediaFilter, mediaTotal, mediaDate, debouncedQ, loadMedia])

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
          {/* 日历（按日期浏览）+ 模糊查询：全部子栏目通用 */}
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <MonthCalendar dates={mediaDates} selected={mediaDate} onPick={d => setMediaDate(prev => (prev === d ? '' : d))} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 260 }}>
              <input
                value={mediaQuery}
                onChange={e => setMediaQuery(e.target.value)}
                placeholder="模糊搜索：机场SN / 时间 / 文件名（如 8UUXN7G、02-59、20260827）"
                style={{ padding: '7px 10px', borderRadius: 5, border: '1px solid rgba(0,170,255,0.3)', background: 'rgba(4,14,35,0.7)', color: '#c8e6ff', fontSize: 12, outline: 'none' }}
              />
              <div style={{ fontSize: 11, color: '#5a8aaa', lineHeight: 1.7 }}>
                {mediaDate ? <>已选日期 <b style={{ color: CYAN }}>{mediaDate.slice(0, 4)}-{mediaDate.slice(4, 6)}-{mediaDate.slice(6)}</b> · 共 {mediaTotal} 条 · </> : <>全部日期 · 共 {mediaTotal} 条 · </>}
                {mediaQuery && <>搜索 <b style={{ color: CYAN }}>“{mediaQuery}”</b> · </>}
                {(mediaDate || mediaQuery) && (
                  <a style={{ color: '#ff8a80', cursor: 'pointer', textDecoration: 'underline' }}
                    onClick={() => { setMediaDate(''); setMediaQuery('') }}>清除筛选</a>
                )}
              </div>
            </div>
          </div>
          {mediaFilter === 'record' || mediaFilter === 'video' || mediaFilter === 'photo' ? (
            /* 缩略图卡片网格（直播录制/任务视频/照片） */
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
              {media.length === 0 && <div style={{ color: GRAY, fontSize: 12 }}>暂无媒体归档</div>}
              {media.map(m => {
                const isPhoto = m.kind === 'photo'
                return (
                  <div
                    key={m.path || m.name}
                    onClick={() => (isPhoto ? openPhoto(m) : openPlayer(m))}
                    title={`${m.name} · ${isPhoto ? '点击查看原图' : '点击在线播放'}`}
                    style={{
                      cursor: 'pointer', borderRadius: 8, overflow: 'hidden',
                      background: 'rgba(4,14,35,0.85)', border: '1px solid rgba(0,80,150,0.25)',
                      transition: 'border-color 0.15s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(0,170,255,0.6)' }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(0,80,150,0.25)' }}
                  >
                    <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9', background: '#0a1a2e' }}>
                      {m.path && thumbUrls[m.path] ? (
                        <img src={thumbUrls[m.path]} alt={m.name} loading="lazy"
                          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#5a8aaa', fontSize: 11 }}>缩略图…</div>
                      )}
                      <span style={{
                        position: 'absolute', left: 6, top: 6, fontSize: 10, padding: '1px 8px', borderRadius: 10,
                        background: m.kind === 'video' ? 'rgba(255,112,67,0.85)' : m.kind === 'photo' ? 'rgba(74,222,128,0.85)' : 'rgba(0,170,255,0.85)', color: '#04101f',
                        fontWeight: 700,
                      }}>{m.kind === 'video' ? '任务视频' : m.kind === 'photo' ? '照片' : '录制'}</span>
                      <span style={{
                        position: 'absolute', right: 6, bottom: 6, fontSize: 10, padding: '2px 8px', borderRadius: 10,
                        background: 'rgba(0,8,18,0.7)', color: '#7fd0ff',
                      }}>{isPhoto ? '↗ 查看' : '▶ 播放'}</span>
                    </div>
                    <div style={{ padding: '6px 8px 8px' }}>
                      <div style={{ fontSize: 11, color: '#9ad6f0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</div>
                      <div style={{ fontSize: 10, color: '#5a8aaa', marginTop: 2, fontFamily: 'JetBrains Mono, monospace' }}>
                        {fmtTs(m.mtime)} · {m.size > 1048576 ? (m.size / 1048576).toFixed(1) + 'MB' : (m.size / 1024).toFixed(0) + 'KB'}
                        {m.archived && <span style={{ color: GREEN, marginLeft: 6 }}>已回流</span>}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            /* 文字列表（照片/OSD/飞行记录/全部） */
            <div style={{ ...card, maxHeight: 420, overflowY: 'auto' }}>
              {media.length === 0 && <div style={{ color: GRAY, fontSize: 12 }}>暂无媒体归档</div>}
              {media.map((m, i) => {
                const downloadable = m.kind === 'osd-json' || m.kind === 'fly-record'
                const playable = m.kind === 'video' || m.kind === 'record'
                const actionable = playable || downloadable
                const onClick = playable ? () => openPlayer(m)
                  : downloadable ? () => triggerDownload(m)
                  : undefined
                return (
                  <div
                    key={i}
                    onClick={onClick}
                    title={actionable ? (playable ? '点击在线播放' : '点击下载 JSON/记录') : m.path}
                    style={{
                      display: 'flex', gap: 10, padding: '5px 0', borderBottom: '1px solid rgba(0,80,150,0.1)',
                      fontSize: 12, fontFamily: 'JetBrains Mono, monospace',
                      cursor: actionable ? 'pointer' : 'default',
                    }}
                  >
                    <span style={{ color: GRAY, flexShrink: 0, width: 105 }}>{fmtTs(m.mtime)}</span>
                    <span style={{
                      flexShrink: 0, fontSize: 10, padding: '1px 7px', borderRadius: 8, height: 'fit-content', marginTop: 1,
                      background: m.kind === 'photo' ? 'rgba(74,222,128,0.12)' : m.kind === 'video' ? 'rgba(255,112,67,0.12)' : m.kind === 'fly-record' ? 'rgba(171,71,188,0.12)' : 'rgba(0,170,255,0.1)',
                      color: m.kind === 'photo' ? GREEN : m.kind === 'video' ? '#ff7043' : m.kind === 'fly-record' ? PURPLE : CYAN,
                    }}>{m.kind}</span>
                    <span style={{ color: '#9ad6f0', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {m.name}
                      {playable && <span style={{ color: CYAN, marginLeft: 6, fontSize: 10 }}>▶ 播放</span>}
                      {downloadable && <span style={{ color: PURPLE, marginLeft: 6, fontSize: 10 }}>⬇ 下载</span>}
                    </span>
                    <span style={{ color: '#5a8aaa', flexShrink: 0 }}>{m.size > 1048576 ? (m.size / 1048576).toFixed(1) + 'MB' : (m.size / 1024).toFixed(0) + 'KB'}</span>
                    {m.archived && <span style={{ color: GREEN, flexShrink: 0, fontSize: 10 }}>已回流</span>}
                  </div>
                )
              })}
            </div>
          )}
          {/* 分页控件（按时间倒序，20/页） */}
          {mediaTotal > PAGE_SIZE && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 2, fontSize: 12 }}>
              <button onClick={() => goPage(mediaPage - 1)} disabled={mediaPage === 0}
                style={{ padding: '3px 14px', borderRadius: 5, cursor: 'pointer', border: '1px solid rgba(0,170,255,0.35)', background: mediaPage === 0 ? 'rgba(0,170,255,0.05)' : 'rgba(0,170,255,0.12)', color: mediaPage === 0 ? '#3a5568' : CYAN, fontSize: 12 }}>
                ← 上一页
              </button>
              <span style={{ color: '#9ad6f0', fontFamily: 'JetBrains Mono, monospace' }}>
                第 {mediaPage + 1} / {Math.max(1, Math.ceil(mediaTotal / PAGE_SIZE))} 页 · 共 {mediaTotal} 条
              </span>
              <button onClick={() => goPage(mediaPage + 1)} disabled={mediaPage + 1 >= Math.ceil(mediaTotal / PAGE_SIZE)}
                style={{ padding: '3px 14px', borderRadius: 5, cursor: 'pointer', border: '1px solid rgba(0,170,255,0.35)', background: mediaPage + 1 >= Math.ceil(mediaTotal / PAGE_SIZE) ? 'rgba(0,170,255,0.05)' : 'rgba(0,170,255,0.12)', color: mediaPage + 1 >= Math.ceil(mediaTotal / PAGE_SIZE) ? '#3a5568' : CYAN, fontSize: 12 }}>
                下一页 →
              </button>
            </div>
          )}
        </>
      )}

      {/* 媒体在线播放模态框（训练可用性预审） */}
      {(play || playLoading || playError) && (
        <div onClick={() => { setPlay(null); setPlayError('') }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(2,8,20,0.85)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{
            width: 'min(92vw, 1100px)', background: '#081322', border: '1px solid rgba(0,120,200,0.4)',
            borderRadius: 10, padding: 14, boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {play?.name || '加载中…'}
                <span style={{ color: '#5a8aaa', fontWeight: 400, marginLeft: 8 }}>
                  {play ? `${(play.size / 1048576).toFixed(1)}MB` : ''}
                </span>
              </div>
              <button onClick={() => { setPlay(null); setPlayError('') }}
                style={{ marginLeft: 12, padding: '3px 12px', borderRadius: 5, cursor: 'pointer', border: '1px solid rgba(255,68,68,0.4)', background: 'rgba(255,68,68,0.12)', color: '#ff8a80', fontSize: 12 }}>
                关闭 ✕
              </button>
            </div>
            {playLoading && <div style={{ color: '#5a8aaa', fontSize: 12, padding: '40px 0', textAlign: 'center' }}>正在获取播放地址…</div>}
            {playError && <div style={{ color: '#ff8a80', fontSize: 12, padding: '40px 0', textAlign: 'center' }}>⚠ {playError}</div>}
            {play && (
              <>
                <video key={play.url} src={play.url} controls autoPlay style={{ width: '100%', maxHeight: '72vh', background: '#000', borderRadius: 6 }} />
                <div style={{ marginTop: 8, fontSize: 11, color: '#5a8aaa', lineHeight: 1.6 }}>
                  {play.name.endsWith('_V.mp4') || play.name.endsWith('_S.mp4')
                    ? <>可见光视频，浏览器可直接播放。</>
                    : play.name.endsWith('_T.mp4')
                      ? <>热成像视频（HEVC），若黑屏/无法解码，请下载后使用本地播放器（PotPlayer/VLC）查看。</>
                      : <>录制视频（HEVC），若无法解码请下载后用 PotPlayer/VLC 查看。</>}
                  <span style={{ marginLeft: 8 }}>· 支持拖拽进度（Range）</span>
                </div>
                <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
                  <a href={play.url} download={play.name} target="_blank" rel="noreferrer"
                    style={{ fontSize: 11, padding: '3px 12px', borderRadius: 5, textDecoration: 'none', border: '1px solid rgba(0,170,255,0.4)', background: 'rgba(0,170,255,0.12)', color: '#7fd0ff' }}>
                    下载本视频
                  </a>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
