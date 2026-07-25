import { authFetch } from '../../lib/apiFetch'
import { useState, useEffect } from 'react'
import { useDashboard, VIDEO_GROUPS, GROUP_COLORS, STREAM_CATEGORIES } from '../../context/DashboardContext'
import type { VideoStream, VideoGroup, GB28181Config, DJIWebRTCConfig } from '../../context/DashboardContext'

// 表单中的分类三态：'' = 未分类（全域态势可见）；'气环境' / '水环境' = 对应驾驶舱
const CATEGORIES = ['', ...STREAM_CATEGORIES] as const
const CATEGORY_LABELS: Record<string, string> = { '': '未分类', '气环境': '气环境', '水环境': '水环境' }
const CATEGORY_COLORS: Record<string, string> = { '': '#5a8aaa', '气环境': '#4fc3f7', '水环境': '#26c6da' }

const CYAN = '#00aaff'
const GREEN = '#00e676'
const AMBER = '#ffd740'
const RED = '#ff4444'

const PROTOCOLS = ['rtsp', 'hls', 'webrtc', 'onvif', 'gb28281', 'dji_webrtc'] as const
const PROTOCOL_LABELS: Record<string, string> = {
  rtsp: 'RTSP', hls: 'HLS', webrtc: 'WebRTC', onvif: 'ONVIF', gb28281: 'GB28281', dji_webrtc: '大疆司空WebRTC',
}

const EMPTY_GB28181: GB28181Config = {
  sipServer: '', sipPort: 5060, sipServerId: '', sipDomain: '',
  deviceId: '', channelId: '', username: '', password: '', transport: 'UDP',
}

const EMPTY_DJI_WEBRTC: DJIWebRTCConfig = {
  shareUrl: '', airportName: '', parentName: undefined, airportIndex: undefined, autoFullscreen: true, keepAlive: true,
  width: 1280, height: 720, bitrate: 2000,
}

// 表单使用三态分类：'' = 未分类；'气环境' / '水环境' = 对应驾驶舱。保存时 '' 转为 undefined
type StreamForm = Omit<VideoStream, 'id' | 'category'> & { category: '' | '气环境' | '水环境' }

const EMPTY: StreamForm = {
  name: '', location: '', lat: '', lon: '', url: '', group: '道路监控', offline: false,
  protocol: 'rtsp', category: '', thumbnail: '', gb28181Config: undefined, djiWebRTCConfig: undefined,
}

// ── shared input primitives ──────────────────────────────────

function Input({ label, value, onChange, placeholder, mono, type = 'text', hint }: {
  label: string; value: string | number; onChange: (v: string) => void
  placeholder?: string; mono?: boolean; type?: string; hint?: string
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 4 }}>{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: '100%', padding: '7px 10px',
          background: 'rgba(0,20,60,0.6)',
          border: '1px solid rgba(0,150,220,0.25)',
          borderRadius: 3, color: '#c8e6ff', fontSize: 13,
          fontFamily: mono ? "'JetBrains Mono', monospace" : 'inherit',
          outline: 'none',
        }}
      />
      {hint && <div style={{ color: '#3a5a70', fontSize: 10, marginTop: 3 }}>{hint}</div>}
    </div>
  )
}

function Select<T extends string>({ label, value, options, labels, onChange }: {
  label: string; value: T; options: readonly T[]; labels?: Record<string, string>; onChange: (v: T) => void
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 4 }}>{label}</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value as T)}
        style={{
          width: '100%', padding: '7px 10px',
          background: 'rgba(0,20,60,0.8)',
          border: '1px solid rgba(0,150,220,0.25)',
          borderRadius: 3, color: '#c8e6ff', fontSize: 13,
          outline: 'none',
        }}
      >
        {options.map(o => <option key={o} value={o}>{labels ? labels[o] : o}</option>)}
      </select>
    </div>
  )
}

// ── GB28181 form section ─────────────────────────────────────

function GB28181Form({ cfg, onChange }: {
  cfg: GB28181Config
  onChange: (patch: Partial<GB28181Config>) => void
}) {
  const set = (patch: Partial<GB28181Config>) => onChange(patch)
  return (
    <div style={{ background: 'rgba(0,60,120,0.08)', border: '1px solid rgba(0,150,220,0.2)', borderRadius: 4, padding: '14px', marginBottom: 12 }}>
      <div style={{ color: '#7ab8e0', fontSize: 12, fontWeight: 600, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ padding: '1px 7px', background: 'rgba(255,215,64,0.12)', border: '1px solid rgba(255,215,64,0.3)', borderRadius: 2, color: AMBER, fontSize: 11 }}>GB28181</span>
        国标接入参数
      </div>

      {/* SIP 服务器 */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ color: '#5a8aaa', fontSize: 11, marginBottom: 6 }}>SIP 服务器</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: 8 }}>
          <Input label="服务器地址" value={cfg.sipServer} onChange={v => set({ sipServer: v })} placeholder="192.168.1.100" mono />
          <Input label="端口" value={cfg.sipPort} onChange={v => set({ sipPort: Number(v) || 5060 })} placeholder="5060" mono type="number" />
        </div>
        <Input label="服务器国标编码（20位）" value={cfg.sipServerId} onChange={v => set({ sipServerId: v })} placeholder="34020000002000000001" mono hint="由平台方分配，格式：行政区划码+业务码+编号" />
        <Input label="SIP 域" value={cfg.sipDomain} onChange={v => set({ sipDomain: v })} placeholder="3402000000（或与服务器IP相同）" mono hint="填服务器国标ID前10位或IP地址" />
      </div>

      {/* 设备 */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ color: '#5a8aaa', fontSize: 11, marginBottom: 6 }}>设备信息</div>
        <Input label="设备国标编码（20位）" value={cfg.deviceId} onChange={v => set({ deviceId: v })} placeholder="34020000001310000001" mono hint="摄像头设备的唯一国标编码" />
        <Input label="通道国标编码（20位）" value={cfg.channelId} onChange={v => set({ channelId: v })} placeholder="34020000001310000001" mono hint="视频通道编码，通常与设备编码相同或末位不同" />
      </div>

      {/* 认证 */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ color: '#5a8aaa', fontSize: 11, marginBottom: 6 }}>认证信息</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Input label="用户名" value={cfg.username} onChange={v => set({ username: v })} placeholder="admin" />
          <Input label="密码" value={cfg.password} onChange={v => set({ password: v })} type="password" placeholder="••••••••" />
        </div>
      </div>

      {/* 传输协议 */}
      <div style={{ marginBottom: 4 }}>
        <div style={{ color: '#5a8aaa', fontSize: 11, marginBottom: 6 }}>传输协议</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {(['UDP', 'TCP'] as const).map(t => (
            <button key={t} onClick={() => set({ transport: t })} style={{
              padding: '5px 18px', fontSize: 12, borderRadius: 3,
              border: `1px solid ${cfg.transport === t ? CYAN : 'rgba(0,150,220,0.2)'}`,
              background: cfg.transport === t ? `${CYAN}18` : 'transparent',
              color: cfg.transport === t ? CYAN : '#5a8aaa',
              cursor: 'pointer',
            }}>{t}</button>
          ))}
          <span style={{ color: '#3a5a70', fontSize: 11, alignSelf: 'center', marginLeft: 4 }}>
            UDP 延迟低；TCP 丢包重传更可靠
          </span>
        </div>
      </div>
    </div>
  )
}

// ── DJI 司空 WebRTC form section ─────────────────────────────

// 本地 streamId 派生（与 VideoPlayerModal / 后端一致）
function djiDeriveStreamId(url: string) {
  let h = 0
  for (let i = 0; i < url.length; i++) { h = ((h << 5) - h + url.charCodeAt(i)) | 0 }
  return 's' + Math.abs(h).toString(36)
}
function djiPreviewSid(cfg: DJIWebRTCConfig) {
  if (!cfg.shareUrl || !cfg.airportName) return ''
  const key = cfg.parentName
    ? `${cfg.shareUrl}#${cfg.parentName}|${cfg.airportName}`
    : `${cfg.shareUrl}#${cfg.airportName}`
  return djiDeriveStreamId(key)
}

function DJIWebRTCForm({ cfg, onChange }: {
  cfg: DJIWebRTCConfig
  onChange: (patch: Partial<DJIWebRTCConfig>) => void
}) {
  const set = (patch: Partial<DJIWebRTCConfig>) => onChange(patch)
  const isNested = !!cfg.parentName
  const [showAdvanced, setShowAdvanced] = useState(false)
  const sid = djiPreviewSid(cfg)

  return (
    <div style={{ background: 'rgba(0,60,120,0.08)', border: '1px solid rgba(0,150,220,0.2)', borderRadius: 4, padding: '14px', marginBottom: 12 }}>
      <div style={{ color: '#7ab8e0', fontSize: 12, fontWeight: 600, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ padding: '1px 7px', background: 'rgba(255,215,64,0.12)', border: '1px solid rgba(255,215,64,0.3)', borderRadius: 2, color: AMBER, fontSize: 11 }}>DJI</span>
        大疆司空 WebRTC 接入参数
      </div>

      {/* 接入模式选择 */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 6 }}>接入模式</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => set({ parentName: undefined })}
            style={{
              padding: '6px 14px', fontSize: 12, borderRadius: 3, cursor: 'pointer',
              border: `1px solid ${!isNested ? AMBER : 'rgba(0,150,220,0.2)'}`,
              background: !isNested ? `${AMBER}18` : 'transparent',
              color: !isNested ? AMBER : '#5a8aaa',
            }}>顶层设备</button>
          <button type="button" onClick={() => set({ parentName: cfg.parentName || '' })}
            style={{
              padding: '6px 14px', fontSize: 12, borderRadius: 3, cursor: 'pointer',
              border: `1px solid ${isNested ? AMBER : 'rgba(0,150,220,0.2)'}`,
              background: isNested ? `${AMBER}18` : 'transparent',
              color: isNested ? AMBER : '#5a8aaa',
            }}>嵌套子相机</button>
        </div>
        <div style={{ color: '#3a5a70', fontSize: 10, marginTop: 5 }}>
          {isNested
            ? '父设备（如 "M4TD | 4TD-三峡科技大学"）可展开，内部包含子相机（如 "Matrice 4TD"）'
            : '设备本身即可直接播放，无需展开（如 "Dock 3 | 机场3-三峡科技大学"）'}
        </div>
      </div>

      <Input label="分享页 URL *" value={cfg.shareUrl} onChange={v => set({ shareUrl: v })}
        placeholder="https://fh.dji.com/share/live/xxxxxxxx"
        mono
        hint="大疆司空分享页面完整链接，无需登录即可访问"
      />

      {isNested ? (
        <>
          <Input label="父设备名称 *" value={cfg.parentName || ''} onChange={v => set({ parentName: v })}
            placeholder="如：M4TD | 4TD-三峡科技大学"
            hint="页面左侧可展开的设备组名称（点击后会展开子相机列表）"
          />
          <Input label="子相机名称 *" value={cfg.airportName} onChange={v => set({ airportName: v })}
            placeholder="如：Matrice 4TD、辅助影像"
            hint="展开后显示的子相机名称，点击后开始播放该路视频"
          />
        </>
      ) : (
        <Input label="设备名称 *" value={cfg.airportName} onChange={v => set({ airportName: v })}
          placeholder="如：Dock 3 | 机场3-三峡科技大学"
          hint="页面左侧边栏显示的设备名称，用于自动点击加载该路视频"
        />
      )}

      {/* streamId 预览 */}
      {sid && (
        <div style={{ marginBottom: 12, padding: '6px 10px', background: 'rgba(0,170,255,0.06)', border: '1px solid rgba(0,170,255,0.15)', borderRadius: 3 }}>
          <span style={{ color: '#3a5a70', fontSize: 10 }}>派生 Stream ID：</span>
          <span style={{ color: CYAN, fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>{sid}</span>
          <span style={{ color: '#2a4a60', fontSize: 10, marginLeft: 6 }}>（用于 ZLM 流命名，修改参数会导致地址变化）</span>
        </div>
      )}

      {/* 高级设置折叠区 */}
      <div style={{ marginBottom: 4 }}>
        <button type="button" onClick={() => setShowAdvanced(s => !s)}
          style={{
            padding: '4px 10px', fontSize: 11, borderRadius: 3, cursor: 'pointer',
            border: '1px solid rgba(0,150,220,0.2)', background: 'transparent', color: '#5a8aaa',
          }}>
          {showAdvanced ? '▼ 高级设置' : '▶ 高级设置'}
        </button>
      </div>
      {showAdvanced && (
        <div style={{ padding: '8px 0 4px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Input label="推流码率 (kbps)" value={cfg.bitrate ?? 2000} onChange={v => set({ bitrate: Number(v) || 2000 })}
              type="number" placeholder="2000" mono
              hint="越高画质越好，建议 1500-2500"
            />
            <Input label="机场索引" value={cfg.airportIndex ?? ''} onChange={v => set({ airportIndex: v === '' ? undefined : Number(v) })}
              type="number" placeholder="留空" mono
              hint="仅当名称匹配失败时使用"
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
            <Input label="窗口宽度" value={cfg.width ?? 1280} onChange={v => set({ width: Number(v) || 1280 })}
              type="number" placeholder="1280" mono
            />
            <Input label="窗口高度" value={cfg.height ?? 720} onChange={v => set({ height: Number(v) || 720 })}
              type="number" placeholder="720" mono
            />
          </div>
          <div style={{ marginBottom: 4, marginTop: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={cfg.keepAlive ?? true}
                onChange={e => set({ keepAlive: e.target.checked })}
                style={{ accentColor: AMBER }} />
              <span style={{ color: '#5a8aaa', fontSize: 12 }}>持续保持浏览器推流</span>
            </label>
          </div>
          <div style={{ marginBottom: 4, marginTop: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={cfg.autoFullscreen ?? true}
                onChange={e => set({ autoFullscreen: e.target.checked })}
                style={{ accentColor: AMBER }} />
              <span style={{ color: '#5a8aaa', fontSize: 12 }}>推流后自动全屏画面</span>
            </label>
            <div style={{ color: '#3a5a70', fontSize: 10, marginLeft: 24, marginTop: 2 }}>
              关闭后推流画面将保留左侧设备列表边栏（适合调试）
            </div>
          </div>
        </div>
      )}

      <div style={{ color: '#3a5a70', fontSize: 10, marginTop: 8, lineHeight: 1.6 }}>
        后端将启动浏览器打开分享页，自动点击指定设备{isNested ? '下的子相机' : ''}，WebRTC 视频经 ffmpeg 转推至 ZLMediaKit，生成本系统可直接播放的 HLS/FLV 地址。
      </div>
    </div>
  )
}

// ── main component ───────────────────────────────────────────

export function VideoStreamPage() {
  const { videoStreams, addStream, updateStream, deleteStream } = useDashboard()
  const [form, setForm] = useState<StreamForm>(EMPTY)
  const [editId, setEditId] = useState<string | null>(null)
  const [filterGroup, setFilterGroup] = useState<VideoGroup | 'all'>('all')
  const [showForm, setShowForm] = useState(false)
  const [health, setHealth] = useState<Record<string, { reachable: boolean | null; lastCheckedAt: string; detail: string }>>({})

  // 轮询视频流探测状态（每 30 秒）
  useEffect(() => {
    const load = () => authFetch('/api/streams/health').then(r => r.ok ? r.json() : {}).then(setHealth).catch(() => {})
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [])

  // 相对时间格式化
  const fmtAgo = (iso?: string) => {
    if (!iso) return ''
    const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (sec < 60) return sec + '秒前'
    if (sec < 3600) return Math.floor(sec / 60) + '分钟前'
    return Math.floor(sec / 3600) + '小时前'
  }

  const filtered = filterGroup === 'all' ? videoStreams : videoStreams.filter(s => s.group === filterGroup)
  const isGB = form.protocol === 'gb28281'
  const isDji = form.protocol === 'dji_webrtc'
  const gb = form.gb28181Config ?? EMPTY_GB28181
  const dji = form.djiWebRTCConfig ?? EMPTY_DJI_WEBRTC

  // GB28181 valid when sipServer + sipServerId + deviceId filled
  const gbValid = isGB ? !!(gb.sipServer && gb.sipServerId && gb.deviceId) : true
  // DJI WebRTC 校验：顶层模式需 shareUrl + airportName；嵌套模式（parentName 非空）还需 parentName
  const djiValid = isDji
    ? !!(dji.shareUrl && dji.airportName && (dji.parentName === undefined || dji.parentName.trim() !== ''))
    : true
  const canSave = !!form.name && (isGB ? gbValid : isDji ? djiValid : !!form.url)

  const handleSave = () => {
    if (!canSave) return
    const data: Omit<VideoStream, 'id'> = {
      ...form,
      url: isGB || isDji ? '' : form.url,
      // category: 空字符串视为未分类，存为 undefined（不写入冗余字段）
      category: form.category ? (form.category as '气环境' | '水环境') : undefined,
      gb28181Config: isGB ? gb : undefined,
      djiWebRTCConfig: isDji ? dji : undefined,
    }
    if (editId) {
      updateStream(editId, data)
    } else {
      addStream(data)
    }
    setForm(EMPTY)
    setEditId(null)
    setShowForm(false)
  }

  const handleEdit = (s: VideoStream) => {
    setForm({
      name: s.name, location: s.location, lat: s.lat, lon: s.lon,
      url: s.url, group: s.group, offline: s.offline, protocol: s.protocol,
      category: s.category || '',
      thumbnail: s.thumbnail || '',
      gb28181Config: s.gb28181Config,
      djiWebRTCConfig: s.djiWebRTCConfig,
    })
    setEditId(s.id)
    setShowForm(true)
  }

  const handleCancel = () => {
    setForm(EMPTY); setEditId(null); setShowForm(false)
  }

  const groupCounts = VIDEO_GROUPS.reduce<Record<string, number>>((acc, g) => {
    acc[g] = videoStreams.filter(s => s.group === g).length
    return acc
  }, {})

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Left: list */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Toolbar */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid rgba(0,80,150,0.2)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <h2 style={{ color: '#c8e6ff', fontSize: 16, fontWeight: 600, flex: 1 }}>视频流管理</h2>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['all', ...VIDEO_GROUPS] as const).map(g => (
              <button key={g} onClick={() => setFilterGroup(g)} style={{
                padding: '4px 10px', fontSize: 11, borderRadius: 3,
                border: `1px solid ${filterGroup === g ? CYAN : 'rgba(0,150,220,0.2)'}`,
                background: filterGroup === g ? `${CYAN}18` : 'transparent',
                color: filterGroup === g ? CYAN : '#5a8aaa', cursor: 'pointer',
              }}>
                {g === 'all' ? '全部' : g}
                {g !== 'all' && <span style={{ marginLeft: 4, color: '#3a5a70' }}>({groupCounts[g] ?? 0})</span>}
              </button>
            ))}
          </div>
          <button
            onClick={() => { setForm(EMPTY); setEditId(null); setShowForm(true) }}
            style={{ padding: '6px 16px', fontSize: 12, borderRadius: 3, border: `1px solid ${GREEN}55`, background: `${GREEN}18`, color: GREEN, cursor: 'pointer' }}
          >+ 添加视频流</button>
        </div>

        {/* Summary strip */}
        <div style={{ display: 'flex', gap: 12, padding: '10px 20px', borderBottom: '1px solid rgba(0,60,120,0.2)', flexShrink: 0 }}>
          {VIDEO_GROUPS.map(g => {
            const total = videoStreams.filter(s => s.group === g).length
            const online = videoStreams.filter(s => s.group === g && !s.offline).length
            const color = GROUP_COLORS[g]
            return (
              <div key={g} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
                <span style={{ color: '#5a8aaa', fontSize: 11 }}>{g}</span>
                <span style={{ color, fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>{online}/{total}</span>
              </div>
            )
          })}
        </div>

        {/* Table */}
        <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
              <tr style={{ background: 'rgba(4,14,35,0.98)', borderBottom: '1px solid rgba(0,80,150,0.2)' }}>
                {['状态', '名称', '位置', '坐标', '分组', '分类', '协议', '接入信息', '操作'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: '#5a8aaa', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((s, i) => {
                const color = GROUP_COLORS[s.group]
                const isGbRow = s.protocol === 'gb28281'
                const isDjiRow = s.protocol === 'dji_webrtc'
                const gcfg = s.gb28181Config
                const dcfg = s.djiWebRTCConfig
                return (
                  <tr key={s.id} style={{ borderBottom: '1px solid rgba(0,50,100,0.15)', background: i % 2 === 0 ? 'transparent' : 'rgba(0,20,50,0.2)' }}>
                    <td style={{ padding: '9px 12px' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: s.offline ? RED : GREEN, boxShadow: s.offline ? 'none' : `0 0 5px ${GREEN}`, display: 'inline-block' }} />
                        <span style={{ color: s.offline ? '#ff6060' : GREEN, fontSize: 11 }}>{s.offline ? '离线' : '在线'}</span>
                      </span>
                      {(() => {
                        const h = health[s.id]
                        if (!h) return <div style={{ fontSize: 9, color: '#3a5a70', marginTop: 2 }}>探测中…</div>
                        const c = h.reachable === true ? GREEN : h.reachable === false ? RED : '#5a8aaa'
                        const label = h.reachable === true ? '可达' : h.reachable === false ? '不可达' : '未探测'
                        return <div style={{ fontSize: 9, color: c, marginTop: 2 }} title={h.detail}>● {label} <span style={{ color: '#3a5a70' }}>{fmtAgo(h.lastCheckedAt)}</span></div>
                      })()}
                    </td>
                    <td style={{ padding: '9px 12px', color: '#c8e6ff', fontWeight: 500 }}>{s.name}</td>
                    <td style={{ padding: '9px 12px', color: '#5a8aaa' }}>{s.location}</td>
                    <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>
                      {s.lat !== '' && s.lon !== '' ? (
                        <span style={{ color: '#00aaff', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
                          {Number(s.lat).toFixed(4)}<br />
                          <span style={{ color: '#3a5a70' }}>{Number(s.lon).toFixed(4)}</span>
                        </span>
                      ) : <span style={{ color: '#2a4a60', fontSize: 11 }}>—</span>}
                    </td>
                    <td style={{ padding: '9px 12px' }}>
                      <span style={{ padding: '2px 8px', borderRadius: 2, background: `${color}18`, color, fontSize: 11, border: `1px solid ${color}30` }}>{s.group}</span>
                    </td>
                    <td style={{ padding: '9px 12px' }}>
                      <span style={{ padding: '2px 8px', borderRadius: 2, background: `${CATEGORY_COLORS[s.category || '']}18`, color: CATEGORY_COLORS[s.category || ''], fontSize: 11, border: `1px solid ${CATEGORY_COLORS[s.category || '']}30` }}>{CATEGORY_LABELS[s.category || '']}</span>
                    </td>
                    <td style={{ padding: '9px 12px' }}>
                      <span style={{ color: isGbRow ? '#ffd740' : AMBER, fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
                        {PROTOCOL_LABELS[s.protocol]}
                      </span>
                    </td>
                    <td style={{ padding: '9px 12px', maxWidth: 260 }}>
                      {isGbRow && gcfg ? (
                        <div style={{ fontSize: 11, lineHeight: 1.7 }}>
                          <div style={{ color: '#5a8aaa' }}>
                            <span style={{ color: '#3a5a70' }}>SIP </span>
                            <span style={{ color: CYAN, fontFamily: "'JetBrains Mono', monospace" }}>{gcfg.sipServer}:{gcfg.sipPort}</span>
                            <span style={{ color: '#3a5a70', marginLeft: 6 }}>{gcfg.transport}</span>
                          </div>
                          <div style={{ color: '#3a5a70', fontFamily: "'JetBrains Mono', monospace", fontSize: 10 }}>
                            设备 {gcfg.deviceId || '—'}
                          </div>
                        </div>
                      ) : isDjiRow && dcfg ? (
                        <div style={{ fontSize: 11, lineHeight: 1.7 }}>
                          {dcfg.parentName ? (
                            <div style={{ color: '#5a8aaa' }}>
                              <span style={{ color: '#3a5a70' }}>父设备 </span>
                              <span style={{ color: CYAN, fontFamily: "'JetBrains Mono', monospace" }}>{dcfg.parentName}</span>
                              <span style={{ color: '#3a5a70', marginLeft: 6 }}>子相机 </span>
                              <span style={{ color: AMBER, fontFamily: "'JetBrains Mono', monospace" }}>{dcfg.airportName}</span>
                            </div>
                          ) : (
                            <div style={{ color: '#5a8aaa' }}>
                              <span style={{ color: '#3a5a70' }}>设备 </span>
                              <span style={{ color: CYAN, fontFamily: "'JetBrains Mono', monospace" }}>{dcfg.airportName}</span>
                            </div>
                          )}
                          <div style={{ color: '#3a5a70', fontFamily: "'JetBrains Mono', monospace", fontSize: 10, wordBreak: 'break-all' }}>
                            {dcfg.shareUrl}
                          </div>
                        </div>
                      ) : (
                        <span style={{ color: '#3a5a70', fontFamily: "'JetBrains Mono', monospace", fontSize: 11, wordBreak: 'break-all' }}>{s.url}</span>
                      )}
                    </td>
                    <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>
                      <button onClick={() => updateStream(s.id, { offline: !s.offline })} style={{
                        padding: '3px 8px', fontSize: 11, borderRadius: 2, marginRight: 4,
                        border: `1px solid ${s.offline ? GREEN + '44' : RED + '44'}`,
                        background: s.offline ? `${GREEN}12` : `${RED}12`,
                        color: s.offline ? GREEN : RED, cursor: 'pointer',
                      }}>{s.offline ? '上线' : '下线'}</button>
                      <button onClick={() => handleEdit(s)} style={{
                        padding: '3px 8px', fontSize: 11, borderRadius: 2, marginRight: 4,
                        border: '1px solid rgba(0,150,220,0.3)', background: 'rgba(0,80,180,0.15)',
                        color: CYAN, cursor: 'pointer',
                      }}>编辑</button>
                      <button onClick={() => deleteStream(s.id)} style={{
                        padding: '3px 8px', fontSize: 11, borderRadius: 2,
                        border: `1px solid ${RED}33`, background: `${RED}0d`,
                        color: '#ff7070', cursor: 'pointer',
                      }}>删除</button>
                    </td>
                  </tr>
                )
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={9} style={{ padding: '40px 0', textAlign: 'center', color: '#3a5a70', fontSize: 13 }}>暂无视频流配置</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Right: form drawer */}
      {showForm && (
        <div style={{
          width: 360, flexShrink: 0,
          borderLeft: '1px solid rgba(0,150,220,0.2)',
          background: 'rgba(0,15,40,0.95)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid rgba(0,80,150,0.2)', flexShrink: 0 }}>
            <span style={{ color: '#c8e6ff', fontSize: 14, fontWeight: 600 }}>{editId ? '编辑视频流' : '添加视频流'}</span>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', scrollbarWidth: 'none' }}>
            <Input label="摄像头名称 *" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} placeholder="如：沿江大道东" />
            <Input label="安装位置" value={form.location} onChange={v => setForm(f => ({ ...f, location: v }))} placeholder="如：沿江路段" />

            {/* 经纬度 */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 4 }}>
                安装坐标
                <span style={{ color: '#3a5a70', fontSize: 11, marginLeft: 6 }}>（可选，用于地图标注）</span>
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div>
                  <div style={{ color: '#3a5a70', fontSize: 10, marginBottom: 3 }}>纬度 (Lat)</div>
                  <input type="number" step="0.0001" value={form.lat === '' ? '' : form.lat}
                    onChange={e => setForm(f => ({ ...f, lat: e.target.value === '' ? '' : parseFloat(e.target.value) }))}
                    placeholder="30.8572"
                    style={{ width: '100%', padding: '7px 10px', background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3, color: '#00aaff', fontSize: 12, fontFamily: "'JetBrains Mono', monospace", outline: 'none' }} />
                </div>
                <div>
                  <div style={{ color: '#3a5a70', fontSize: 10, marginBottom: 3 }}>经度 (Lon)</div>
                  <input type="number" step="0.0001" value={form.lon === '' ? '' : form.lon}
                    onChange={e => setForm(f => ({ ...f, lon: e.target.value === '' ? '' : parseFloat(e.target.value) }))}
                    placeholder="108.3801"
                    style={{ width: '100%', padding: '7px 10px', background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3, color: '#00aaff', fontSize: 12, fontFamily: "'JetBrains Mono', monospace", outline: 'none' }} />
                </div>
              </div>
              {form.lat !== '' && form.lon !== '' && (
                <div style={{ marginTop: 6, padding: '5px 8px', background: 'rgba(0,170,255,0.06)', border: '1px solid rgba(0,170,255,0.15)', borderRadius: 3, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#5a8aaa" strokeWidth="2">
                    <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" />
                    <circle cx="12" cy="9" r="2.5" />
                  </svg>
                  <span style={{ color: '#5a8aaa', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
                    {Number(form.lat).toFixed(4)}, {Number(form.lon).toFixed(4)}
                  </span>
                  <a href={`https://uri.amap.com/marker?position=${form.lon},${form.lat}&name=${encodeURIComponent(form.name || '摄像头位置')}`}
                    target="_blank" rel="noreferrer"
                    style={{ color: '#ffd740', fontSize: 10, marginLeft: 'auto', textDecoration: 'none' }}>在地图查看 →</a>
                </div>
              )}
            </div>

            <Select label="分组" value={form.group} options={VIDEO_GROUPS} onChange={v => setForm(f => ({ ...f, group: v }))} />
            <Select label="驾驶舱分类" value={form.category} options={CATEGORIES} labels={CATEGORY_LABELS}
              onChange={v => setForm(f => ({ ...f, category: v as '' | '气环境' | '水环境' }))}
              hint="气环境 / 水环境：分别对应前端「气环境驾驶舱 / 水环境驾驶舱」视图；未分类仅「全域态势」可见"
            />
            <Select label="协议" value={form.protocol} options={PROTOCOLS} labels={PROTOCOL_LABELS}
              onChange={v => setForm(f => ({
                ...f, protocol: v,
                gb28181Config: v === 'gb28281' ? (f.gb28181Config ?? EMPTY_GB28181) : undefined,
                djiWebRTCConfig: v === 'dji_webrtc' ? (f.djiWebRTCConfig ?? EMPTY_DJI_WEBRTC) : undefined,
              }))}
            />

            {/* 协议相关字段 */}
            {isGB ? (
              <GB28181Form
                cfg={gb}
                onChange={patch => setForm(f => ({ ...f, gb28181Config: { ...(f.gb28181Config ?? EMPTY_GB28181), ...patch } }))}
              />
            ) : isDji ? (
              <DJIWebRTCForm
                cfg={dji}
                onChange={patch => setForm(f => ({ ...f, djiWebRTCConfig: { ...(f.djiWebRTCConfig ?? EMPTY_DJI_WEBRTC), ...patch } }))}
              />
            ) : (
              <>
                <Input label="流地址 *" value={form.url} onChange={v => setForm(f => ({ ...f, url: v }))}
                  placeholder={
                    form.protocol === 'hls'
                      ? '支持 rtsp://（自动转HLS）或 http://.../xxx.m3u8'
                      : form.protocol === 'flv'
                        ? 'http://.../xxx.flv 或 rtsp://（自动转FLV）'
                        : 'rtsp://192.168.1.x:554/stream/...'
                  } mono
                  hint={
                    form.protocol === 'hls'
                      ? '可填 RTSP 源地址（系统自动转换为 HLS 播放）或外部 HLS 完整地址'
                      : undefined
                  }
                />
                {form.protocol === 'hls' && form.url.startsWith('rtsp://') && (
                  <div style={{ marginBottom: 12, padding: '8px 10px', background: `${GREEN}10`, border: `1px solid ${GREEN}33`, borderRadius: 3, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ color: GREEN, fontSize: 11 }}>✓</span>
                    <span style={{ color: GREEN, fontSize: 11 }}>检测到 RTSP 源，播放时将自动通过 ZLMediaKit 转为 HLS，无需手动填写流ID</span>
                  </div>
                )}
              </>
            )}

            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={form.offline} onChange={e => setForm(f => ({ ...f, offline: e.target.checked }))} style={{ accentColor: AMBER }} />
                <span style={{ color: '#5a8aaa', fontSize: 12 }}>标记为离线</span>
              </label>
            </div>

            {/* 视频流显示图片：可填 URL，也可上传本地图片（转 base64）。作为前端卡片底图 */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 4 }}>视频流显示图片</label>
              <input
                value={form.thumbnail || ''}
                onChange={e => setForm(f => ({ ...f, thumbnail: e.target.value }))}
                placeholder="图片 URL（如 http://…/cam.jpg），或下方上传本地图片"
                style={{ width: '100%', padding: '7px 10px', background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3, color: '#c8e6ff', fontSize: 12, fontFamily: "'JetBrains Mono', monospace", outline: 'none', boxSizing: 'border-box' }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
                <label style={{ padding: '4px 10px', fontSize: 11, borderRadius: 3, border: `1px solid ${CYAN}44`, background: `${CYAN}12`, color: CYAN, cursor: 'pointer' }}>
                  上传图片
                  <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => {
                    const file = e.target.files?.[0]
                    if (!file) return
                    if (file.size > 2 * 1024 * 1024) { alert('图片建议小于 2MB（会存入数据库）'); return }
                    const reader = new FileReader()
                    reader.onload = () => setForm(f => ({ ...f, thumbnail: String(reader.result || '') }))
                    reader.readAsDataURL(file)
                    e.target.value = ''  // 允许重复选同一文件
                  }} />
                </label>
                {form.thumbnail && (
                  <>
                    <img src={form.thumbnail} alt="预览" style={{ width: 64, height: 36, objectFit: 'cover', borderRadius: 3, border: '1px solid rgba(0,150,220,0.3)' }}
                      onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                    <button type="button" onClick={() => setForm(f => ({ ...f, thumbnail: '' }))}
                      style={{ padding: '3px 8px', fontSize: 11, borderRadius: 3, border: '1px solid rgba(255,70,70,0.4)', background: 'rgba(255,70,70,0.1)', color: '#ff8080', cursor: 'pointer' }}>清除</button>
                  </>
                )}
              </div>
              <div style={{ color: '#3a5a70', fontSize: 10, marginTop: 4 }}>用作前端视频卡片的底图；不填则用默认渐变底色</div>
            </div>

            {/* 协议说明 */}
            <div style={{ background: 'rgba(0,100,200,0.06)', border: '1px solid rgba(0,150,220,0.12)', borderRadius: 4, padding: '10px 12px' }}>
              <div style={{ color: '#3a5a70', fontSize: 11, marginBottom: 4 }}>支持的接入协议</div>
              <div style={{ color: '#5a8aaa', fontSize: 11, lineHeight: 1.8 }}>
                · RTSP — 实时流传输协议（摄像头直连，自动转HLS/FLV播放）<br />
                · HLS — 可填 RTSP 源（自动转HLS）或外部 HLS 地址（http://.../xxx.m3u8）<br />
                · WebRTC — 低延迟 Web 实时通信<br />
                · ONVIF — IP 摄像机发现与控制标准<br />
                · <span style={{ color: AMBER }}>GB28181</span> — 国家公共安全视频联网标准，SIP 信令接入<br />
                · <span style={{ color: AMBER }}>大疆司空 WebRTC</span> — 通过大疆司空分享页，自动抓取机场 WebRTC 视频并转推 ZLMediaKit
              </div>
            </div>
          </div>

          <div style={{ padding: '14px 20px', borderTop: '1px solid rgba(0,80,150,0.2)', display: 'flex', gap: 8, flexShrink: 0 }}>
            <button
              onClick={handleSave}
              disabled={!canSave}
              style={{
                flex: 1, padding: '8px 0', fontSize: 13, borderRadius: 3,
                border: `1px solid ${GREEN}55`, background: `${GREEN}18`,
                color: canSave ? GREEN : '#3a5a70',
                cursor: canSave ? 'pointer' : 'default',
              }}
            >保存</button>
            <button onClick={handleCancel} style={{
              padding: '8px 20px', fontSize: 13, borderRadius: 3,
              border: '1px solid rgba(0,100,180,0.2)', background: 'transparent',
              color: '#5a8aaa', cursor: 'pointer',
            }}>取消</button>
          </div>
        </div>
      )}
    </div>
  )
}
