import { useCallback, useEffect, useRef, useState } from 'react'
import { authFetch } from '../../lib/apiFetch'
import { Camera, Image as ImageIcon, BarChart3 } from 'lucide-react'

// ── 检测结果统一视图（三合一：全量检测 + 推送状态 + 复检状态 + 内嵌复检工作台）──
// 数据源：/api/straw/results（主表 straw_detections；推送状态按 warning_id 精确关联，老数据时间窗回退）
// 第 2 批：内嵌快捷复检（真烟/误报/稍后/撤销/画框补标），reviewer 由后端从登录 token 绑定
// 第 3 批：复检↔推送联动——gate=pre 低置信度 held（⏸ 待复核后推送，复检通过即释放）；
//          误报且已推送 → 追发更正推送（✓ 已推送·已更正）；顶部 gate 开关可配置 off/post/pre + 阈值

const CYAN = '#00aaff'
const GREEN = '#4ade80'
const RED = '#ff4444'
const AMBER = '#ffb74d'
const ORANGE = '#ff7043'
const PURPLE = '#b388ff'

const card: React.CSSProperties = {
  background: 'rgba(4,14,35,0.7)',
  border: '1px solid rgba(0,80,150,0.25)',
  borderRadius: 8,
  padding: '14px 16px',
}

const th: React.CSSProperties = {
  textAlign: 'left', padding: '8px 10px', fontSize: 12, color: '#5a8aaa', fontWeight: 600,
  borderBottom: '1px solid rgba(0,120,220,0.2)', whiteSpace: 'nowrap',
}

const td: React.CSSProperties = {
  padding: '8px 10px', fontSize: 12, color: '#c8e6ff',
  borderBottom: '1px solid rgba(0,60,120,0.15)',
}

const mono = { fontFamily: "'JetBrains Mono', 'Consolas', monospace" } as const

const tinyBtn = (bg: string, color: string, border: string): React.CSSProperties => ({
  padding: '2px 8px', fontSize: 11, borderRadius: 3, cursor: 'pointer', background: bg, color,
  border: `1px solid ${border}`, whiteSpace: 'nowrap',
})

interface Box { cls: number; conf: number; x1: number; y1: number; x2: number; y2: number }

interface PushInfo {
  status: 'none' | 'pending' | 'failed' | 'pushed' | 'held'
  warning_id?: string
  pushed?: boolean
  held?: boolean
  reason?: string
  cardUrl?: string
  town?: string
  unit?: string
  review?: string
  reviewReason?: string
  reviewedBy?: string
  correctedAt?: string
  correctionNote?: string
  correctedBy?: string
}

interface Row {
  id: number
  stream_id?: string
  ts?: string
  frame_path?: string
  boxes?: Box[]
  label?: string
  source?: string
  max_conf?: number
  review_status?: string
  reviewer?: string
  reviewed_at?: string
  note?: string
  lat?: number
  lng?: number
  push?: PushInfo
}

// 类别颜色/名：0=smoke 青 / 1=fire 红 / 2=house 黄（对齐 ServerReviewPage）
const clsColor = (c: number) => (c === 1 ? RED : c === 2 ? AMBER : CYAN)
const clsName = (c: number) => (c === 1 ? 'fire' : c === 2 ? 'house' : 'smoke')

// 图片地址兼容：/api/evidence/xxx 直连（已验证）；evidence/xxx 走 review/image 代理 + 缩略图
const srcOf = (p?: string, w?: number) => {
  if (!p) return ''
  if (p.startsWith('/api/evidence/')) {
    if (!w) return p
    return `/api/review/image?path=${encodeURIComponent(p.replace(/^\/api\/evidence\//, 'evidence/'))}&w=${w}`
  }
  return `/api/review/image?path=${encodeURIComponent(p)}${w ? `&w=${w}` : ''}`
}

// 推送状态徽标（held=gate=pre 低置信度待复核后推送；correctedAt=误报已追发更正）
function pushBadge(p?: PushInfo) {
  const s = p?.status
  if (s === 'held') return { text: '⏸ 待复核后推送', color: PURPLE, bg: 'rgba(179,136,255,0.12)' }
  if (s === 'pushed' && p?.correctedAt) return { text: '✓ 已推送·已更正', color: RED, bg: 'rgba(255,68,68,0.10)' }
  if (s === 'pushed') return { text: '✓ 已推送', color: GREEN, bg: 'rgba(74,222,128,0.12)' }
  if (s === 'failed') return { text: '✗ 推送失败', color: RED, bg: 'rgba(255,68,68,0.12)' }
  if (s === 'pending') return { text: '⏳ 处理中', color: AMBER, bg: 'rgba(255,183,77,0.12)' }
  return { text: '— 未推送', color: '#5a8aaa', bg: 'rgba(90,138,170,0.08)' }
}

// 复检状态徽标（straw_detections.review_status）
function reviewBadge(s?: string) {
  if (s === 'true') return { text: '真烟', color: GREEN, bg: 'rgba(74,222,128,0.12)' }
  if (s === 'false') return { text: '误报', color: RED, bg: 'rgba(255,68,68,0.12)' }
  if (s === 'uncertain') return { text: '稍后处理', color: AMBER, bg: 'rgba(255,183,77,0.12)' }
  return { text: '待复检', color: '#5a8aaa', bg: 'rgba(90,138,170,0.08)' }
}

const nowLocal = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function StrawResultsView() {
  const PAGE_SIZE = 50
  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [stats, setStats] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [fStatus, setFStatus] = useState('')
  const [fPush, setFPush] = useState('')
  const [fLabel, setFLabel] = useState('')
  const [fSource, setFSource] = useState('')
  const [fMinConf, setFMinConf] = useState('')
  const [focus, setFocus] = useState<Row | null>(null)
  const [imgSizes, setImgSizes] = useState<Record<number, { w: number; h: number }>>({})
  const [me, setMe] = useState<{ username?: string; role?: string } | null>(null)
  const [msg, setMsg] = useState('')
  // 复检把关开关（gate=off/post/pre + 低置信阈值 conf）
  const [gate, setGate] = useState('off')
  const [gateConf, setGateConf] = useState(0.5)
  const [gateSaving, setGateSaving] = useState(false)
  // 第 4 批：数据资产报表弹层开关
  const [showStats, setShowStats] = useState(false)

  // 当前登录用户（复核人绑定；后端优先从 token 解析，此值仅用于界面展示）
  useEffect(() => {
    authFetch('/api/auth/me').then(r => r.json()).then(d => { if (d.ok) setMe(d.user || null) }).catch(() => {})
  }, [])

  // 复检把关开关状态（第 3 批）
  useEffect(() => {
    authFetch('/api/straw/review-gate').then(r => r.json()).then(d => {
      if (d.gate) { setGate(d.gate); setGateConf(typeof d.conf === 'number' ? d.conf : 0.5) }
    }).catch(() => {})
  }, [])

  const saveGate = async () => {
    setGateSaving(true)
    try {
      const r = await authFetch('/api/straw/review-gate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gate, conf: Number(gateConf) || 0.5 }),
      })
      const d = await r.json()
      if (d.ok) { flash(`复检把关已切换为 ${gate === 'off' ? '先推后检（无把关）' : gate === 'post' ? '先推后检·可更正' : '低置信度先复核后推送'}`); load(page) }
      else flash(d.error || '保存失败')
    } catch { flash('保存失败') }
    setGateSaving(false)
  }

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000) }

  const load = useCallback(async (targetPage = 1) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((targetPage - 1) * PAGE_SIZE) })
      if (fStatus) params.set('status', fStatus)
      if (fPush) params.set('push', fPush)
      if (fLabel) params.set('label', fLabel)
      if (fSource) params.set('source', fSource)
      if (fMinConf) params.set('min_conf', fMinConf)
      const r = await authFetch(`/api/straw/results?${params}`)
      const d = await r.json()
      if (d.ok) { setRows(d.rows || []); setTotal(d.total || 0); setStats(d.stats || null) }
    } catch {}
    setLoading(false)
  }, [fStatus, fPush, fLabel, fSource, fMinConf])

  useEffect(() => { setPage(1); load(1) }, [load])

  // ── 复检操作（行内 + 弹层共用）──
  // 本地同步单行状态 + stats 计数（避免整页刷新闪烁）
  const syncRow = (id: number, patch: Partial<Row>) => {
    setRows(prev => prev.map(r => (r.id === id ? { ...r, ...patch } : r)))
  }
  const bumpStats = (from?: string, to?: string) => {
    setStats((s: any) => {
      if (!s) return s
      const ns = { ...s, push: { ...(s.push || {}) } }
      if (from === 'pending') ns.pending = Math.max(0, (ns.pending || 0) - 1)
      if (from === 'true') ns.trueCount = Math.max(0, (ns.trueCount || 0) - 1)
      if (from === 'false') ns.falseCount = Math.max(0, (ns.falseCount || 0) - 1)
      if (to === 'true') ns.trueCount = (ns.trueCount || 0) + 1
      if (to === 'false') ns.falseCount = (ns.falseCount || 0) + 1
      return ns
    })
  }

  const applyReview = async (id: number, status: string, note = '') => {
    try {
      const r = await authFetch('/api/review/submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, review_status: status, note }),
      })
      const d = await r.json()
      if (!d.ok) { flash(d.error || '提交失败'); return }
      const prev = rows.find(x => x.id === id)
      syncRow(id, { review_status: status, reviewer: me?.username || prev?.reviewer || '', reviewed_at: nowLocal(), note: note || prev?.note || '' })
      bumpStats(prev?.review_status, status)
      flash(`#${id} → ${status === 'true' ? '真烟' : status === 'false' ? '误报' : '稍后处理'}`)
      // 第 3 批联动：该帧关联告警（held 待复核 / 已推送）时，判定后异步联动推送 → 延迟刷新取最新推送状态
      if (prev?.push && (prev.push.status === 'held' || prev.push.status === 'pushed' || prev.push.warning_id)) {
        setTimeout(() => load(page), 1800)
      }
    } catch { flash('提交失败') }
  }

  const undoReview = async (id: number) => {
    try {
      const r = await authFetch('/api/review/undo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
      })
      const d = await r.json()
      if (!d.ok) { flash(d.error || '撤销失败'); return }
      const prev = rows.find(x => x.id === id)
      syncRow(id, { review_status: 'pending', reviewer: '', reviewed_at: undefined, note: '' })
      bumpStats(prev?.review_status, 'pending')
      flash(`#${id} 已撤销 → 待复检`)
    } catch { flash('撤销失败') }
  }

  const saveBoxes = async (id: number, boxes: any[]) => {
    try {
      // 记录级 label 按框类别优先级：smoke（烟为主）> fire > house（房屋排除）
      const hasSmoke = boxes.some((b: any) => b.cls === 0)
      const hasFire = boxes.some((b: any) => b.cls === 1)
      const hasHouse = boxes.some((b: any) => b.cls === 2)
      const label = hasSmoke ? 'smoke' : hasFire ? 'fire' : hasHouse ? 'house' : 'fire'
      const r = await authFetch('/api/review/box', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, boxes, label }),
      })
      const d = await r.json()
      if (!d.ok) { flash(d.error || '保存失败'); return }
      const prev = rows.find(x => x.id === id)
      const maxConf = boxes.length ? Math.max(...boxes.map((b: any) => b.conf || 0)) : prev?.max_conf
      syncRow(id, { boxes, label, max_conf: maxConf, review_status: 'true', reviewer: me?.username || prev?.reviewer || '', reviewed_at: nowLocal() })
      bumpStats(prev?.review_status, 'true')
      flash(`#${id} 画框已保存（${boxes.length} 框）→ 真烟`)
    } catch { flash('保存失败') }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const pushDist = stats?.push || {}

  const selectStyle: React.CSSProperties = {
    background: 'rgba(0,20,60,0.6)', color: '#c8e6ff', border: '1px solid rgba(0,150,220,0.3)',
    padding: '5px 8px', borderRadius: 4, fontSize: 12,
  }
  const navBtn: React.CSSProperties = {
    padding: '5px 14px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
    border: '1px solid rgba(0,150,220,0.3)', background: 'rgba(0,80,180,0.12)', color: '#7ab8e0',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 提示条：当前复核人 + 复检把关开关 + 操作反馈 */}
      <div style={{ ...card, padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, color: '#7ab8e0', flexWrap: 'wrap' }}>
        {me?.username && (
          <span>
            <Camera size={11} strokeWidth={1.75} style={{ verticalAlign: -2, marginRight: 4 }} />
            当前复核人 <b style={{ color: GREEN, fontFamily: 'monospace' }}>{me.username}</b>（判定将记入 reviewer）
          </span>
        )}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 8 }}>
          <span style={{ color: '#5a8aaa' }}>复检把关</span>
          <select value={gate} onChange={e => setGate(e.target.value)} style={selectStyle} title="off=现状先推后检 / post=先推后检·误报可更正 / pre=低置信度先复核后推送">
            <option value="off">off · 先推后检（无把关）</option>
            <option value="post">post · 先推后检 · 可更正</option>
            <option value="pre">pre · 低置信度先复核后推送</option>
          </select>
          {gate === 'pre' && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: '#5a8aaa' }}>阈值</span>
              <input
                type="number" min={0.1} max={0.9} step={0.05}
                value={gateConf} onChange={e => setGateConf(Number(e.target.value))}
                style={{ ...selectStyle, width: 62, fontFamily: 'monospace' }}
              />
            </span>
          )}
          <button onClick={saveGate} disabled={gateSaving}
            style={{ ...tinyBtn('rgba(179,136,255,0.14)', gateSaving ? '#6b5a9a' : PURPLE, 'rgba(179,136,255,0.4)') }}>
            {gateSaving ? '保存中...' : '应用'}
          </button>
        </span>
        {/* 第 4 批：数据资产报表入口 */}
        <button onClick={() => setShowStats(true)}
          style={{ ...tinyBtn('rgba(0,170,255,0.14)', CYAN, 'rgba(0,170,255,0.4)'), marginLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <BarChart3 size={12} strokeWidth={2} /> 数据报表
        </button>
        {msg && <span style={{ color: ORANGE, marginLeft: 8 }}>{msg}</span>}
      </div>

      {/* 统计卡 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
        {([
          ['检测帧总数', stats?.total ?? '—', '#c8e6ff'],
          ['待复检', stats?.pending ?? '—', AMBER],
          ['确认真烟', stats?.trueCount ?? '—', GREEN],
          ['确认误报', stats?.falseCount ?? '—', RED],
          ['已推送告警', pushDist.pushed ?? '—', CYAN],
          ['待复核后推', pushDist.held ?? '—', PURPLE],
          ['推送失败', pushDist.failed ?? '—', ORANGE],
        ] as const).map(([label, v, color]) => (
          <div key={label} style={{ ...card, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 11, color: '#5a8aaa' }}>{label}</div>
            <div style={{ color, fontSize: 20, fontWeight: 700, fontFamily: 'monospace' }}>{v}</div>
          </div>
        ))}
      </div>

      {/* 筛选栏 */}
      <div style={{ ...card, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', padding: '10px 14px' }}>
        <span style={{ fontSize: 11, color: '#5a8aaa' }}>筛选:</span>
        <select value={fStatus} onChange={e => setFStatus(e.target.value)} style={selectStyle}>
          <option value="">全部复检状态</option>
          <option value="pending">待复检</option>
          <option value="true">真烟</option>
          <option value="false">误报</option>
          <option value="uncertain">稍后处理</option>
        </select>
        <select value={fPush} onChange={e => setFPush(e.target.value)} style={selectStyle}>
          <option value="">全部推送状态</option>
          <option value="pushed">已推送</option>
          <option value="held">待复核后推送</option>
          <option value="failed">推送失败</option>
          <option value="pending">处理中</option>
          <option value="none">未推送</option>
        </select>
        <select value={fLabel} onChange={e => setFLabel(e.target.value)} style={selectStyle}>
          <option value="">全部类别</option>
          <option value="smoke">smoke 烟</option>
          <option value="fire">fire 火</option>
          <option value="house">house 房</option>
        </select>
        <select value={fSource} onChange={e => setFSource(e.target.value)} style={selectStyle}>
          <option value="">全部来源</option>
          <option value="alert">alert 告警</option>
          <option value="picall">picall 截图</option>
          <option value="picall_random">picall 无检出</option>
          <option value="low">low 低分</option>
          <option value="random">random 随机</option>
        </select>
        <select value={fMinConf} onChange={e => setFMinConf(e.target.value)} style={selectStyle}>
          <option value="">全部置信度</option>
          <option value="0.5">≥ 0.50</option>
          <option value="0.4">≥ 0.40</option>
          <option value="0.3">≥ 0.30</option>
          <option value="0.25">≥ 0.25</option>
        </select>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#5a8aaa' }}>
          共 <b style={{ color: CYAN, fontFamily: 'monospace' }}>{total}</b> 条 · 第 {page} / {totalPages} 页
        </span>
      </div>

      {/* 表格 */}
      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 30, textAlign: 'center', color: '#5a8aaa', fontSize: 12 }}>加载中...</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#3a5a70', fontSize: 12 }}>暂无检测记录</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['时间', '流', '类别', '置信度', '框', '推送状态', '复检状态', '坐标', '快捷复检'].map(h => (
                    <th key={h} style={th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const pb = pushBadge(r.push)
                  const rb = reviewBadge(r.review_status)
                  const hasFire = (r.boxes || []).some(b => b.cls === 1)
                  const hasSmoke = (r.boxes || []).some(b => b.cls === 0)
                  const clsCol = hasFire ? RED : hasSmoke ? CYAN : AMBER
                  const done = r.review_status === 'true' || r.review_status === 'false' || r.review_status === 'uncertain'
                  return (
                    <tr key={r.id} style={{ opacity: done && fStatus === '' ? 0.62 : 1 }}>
                      <td style={{ ...td, ...mono, fontSize: 11, whiteSpace: 'nowrap' }}>
                        {r.ts ? r.ts.slice(5, 19) : '-'}
                      </td>
                      <td style={{ ...td, ...mono, fontSize: 10, maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#7ab8e0' }}>
                        {r.stream_id || '-'}
                      </td>
                      <td style={{ ...td }}>
                        <span style={{ color: clsCol, fontWeight: 700, fontSize: 11 }}>
                          {r.label || '-'}
                        </span>
                        {(r.boxes || []).length > 0 && (
                          <span style={{ fontSize: 10, color: '#5a8aaa', marginLeft: 4 }}>
                            {(r.boxes || []).map(b => clsName(b.cls)).join('/')}
                          </span>
                        )}
                      </td>
                      <td style={{ ...td, ...mono, fontSize: 11 }}>
                        <span style={{ color: (r.max_conf || 0) >= 0.5 ? GREEN : (r.max_conf || 0) >= 0.3 ? AMBER : '#5a8aaa' }}>
                          {r.max_conf ? ((r.max_conf) * 100).toFixed(1) + '%' : '-'}
                        </span>
                      </td>
                      <td style={{ ...td, ...mono, fontSize: 11, color: '#5a8aaa' }}>{(r.boxes || []).length}</td>
                      <td style={td}>
                        <span style={{
                          display: 'inline-block', padding: '2px 8px', borderRadius: 3, fontSize: 11, fontWeight: 600,
                          color: pb.color, background: pb.bg,
                          ...(r.push?.status === 'failed' && r.push?.reason ? { cursor: 'help' } : {}),
                        }} title={r.push?.status === 'failed' ? (r.push.reason || '') : r.push?.status === 'held' ? (r.push.reason || '低置信度待复核') : r.push?.status === 'pushed' ? `告警 ${r.push.warning_id || ''} · ${r.push.town || ''} ${r.push.unit || ''}${r.push.correctedAt ? ' · 已更正' : ''}` : ''}>
                          {pb.text}
                        </span>
                      </td>
                      <td style={td}>
                        <span style={{
                          display: 'inline-block', padding: '2px 8px', borderRadius: 3, fontSize: 11, fontWeight: 600,
                          color: rb.color, background: rb.bg,
                        }}>
                          {rb.text}
                          {r.push?.review && r.review_status !== r.push.review && (
                            <span style={{ marginLeft: 4, fontSize: 10, color: ORANGE }} title={`告警复核: ${r.push.review === 'true' ? '真警' : r.push.review === 'false' ? '误报' : r.push.review === 'miss' ? '漏报' : r.push.review}${r.push.reviewReason ? ' · ' + r.push.reviewReason : ''}`}>
                              *{r.push.review === 'true' ? '真警' : r.push.review === 'false' ? '误报' : r.push.review === 'miss' ? '漏报' : r.push.review}
                            </span>
                          )}
                        </span>
                        {r.reviewer && (
                          <div style={{ fontSize: 10, color: '#3a6a8a', marginTop: 2 }}>by {r.reviewer}</div>
                        )}
                      </td>
                      <td style={{ ...td, ...mono, fontSize: 10, color: '#5a8aaa', whiteSpace: 'nowrap' }}>
                        {typeof r.lat === 'number' && typeof r.lng === 'number' ? `${r.lat.toFixed(3)}, ${r.lng.toFixed(3)}` : '-'}
                      </td>
                      <td style={td}>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'nowrap' }}>
                          <button onClick={() => setFocus(r)} style={tinyBtn('rgba(0,80,180,0.15)', '#7ab8e0', 'rgba(0,150,220,0.4)')}>查看</button>
                          <button onClick={() => applyReview(r.id, 'true')} disabled={r.review_status === 'true'}
                            style={{ ...tinyBtn('rgba(74,222,128,0.12)', r.review_status === 'true' ? '#2e6b45' : GREEN, 'rgba(74,222,128,0.35)'), opacity: r.review_status === 'true' ? 0.45 : 1 }}>真烟</button>
                          <button onClick={() => applyReview(r.id, 'false')} disabled={r.review_status === 'false'}
                            style={{ ...tinyBtn('rgba(255,68,68,0.12)', r.review_status === 'false' ? '#6b2e2e' : RED, 'rgba(255,68,68,0.35)'), opacity: r.review_status === 'false' ? 0.45 : 1 }}>误报</button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 分页 */}
      {!loading && total > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={() => { const p = page - 1; setPage(p); load(p) }} disabled={page <= 1} style={{ ...navBtn, opacity: page <= 1 ? 0.4 : 1 }}>← 上一页</button>
          <button onClick={() => { const p = page + 1; setPage(p); load(p) }} disabled={page >= totalPages} style={{ ...navBtn, opacity: page >= totalPages ? 0.4 : 1 }}>下一页 →</button>
          <span style={{ fontSize: 11, color: '#5a8aaa' }}>{page} / {totalPages} 页 · 每页 {PAGE_SIZE} 条</span>
        </div>
      )}

      {/* 详情弹层（内嵌复检工作台） */}
      {focus && (
        <DetailModal
          row={rows.find(x => x.id === focus.id) ?? focus}
          onClose={() => setFocus(null)}
          imgSizes={imgSizes} setImgSizes={setImgSizes}
          onApply={applyReview} onUndo={undoReview} onSaveBoxes={saveBoxes}
          reviewer={me?.username || ''}
        />
      )}

      {/* 第 4 批：复检数据资产报表弹层 */}
      {showStats && <StatsOverlay onClose={() => setShowStats(false)} />}
    </div>
  )
}

// ── 详情弹层：大图 + 检测框 + 推送状态 + 复检状态 + 快捷复检操作 ──
function DetailModal({ row, onClose, imgSizes, setImgSizes, onApply, onUndo, onSaveBoxes, reviewer }: {
  row: Row
  onClose: () => void
  imgSizes: Record<number, { w: number; h: number }>
  setImgSizes: React.Dispatch<React.SetStateAction<Record<number, { w: number; h: number }>>>
  onApply: (id: number, status: string, note?: string) => void
  onUndo: (id: number) => void
  onSaveBoxes: (id: number, boxes: any[]) => void
  reviewer: string
}) {
  const [drawing, setDrawing] = useState(false)
  const [note, setNote] = useState(row.note || '')
  const sz = imgSizes[row.id]
  const iw = sz?.w || 2942, ih = sz?.h || 1732
  const pb = pushBadge(row.push)
  const rb = reviewBadge(row.review_status)
  const done = row.review_status === 'true' || row.review_status === 'false' || row.review_status === 'uncertain'

  const labelLine = (k: string, v: React.ReactNode, color?: string) => (
    <div style={{ display: 'flex', gap: 10, fontSize: 12, lineHeight: 1.9 }}>
      <span style={{ color: '#5a8aaa', minWidth: 84, flexShrink: 0 }}>{k}</span>
      <span style={{ color: color || '#c8e6ff', wordBreak: 'break-all' }}>{v}</span>
    </div>
  )

  // 键盘快捷键（输入框聚焦时不触发）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if (e.key === '1') { onApply(row.id, 'true', note) }
      else if (e.key === '2') { onApply(row.id, 'false', note) }
      else if (e.key === '3') { onApply(row.id, 'uncertain', note) }
      else if (e.key === '4' || (e.ctrlKey && e.key.toLowerCase() === 'z')) { e.preventDefault(); onUndo(row.id) }
      else if (e.key === '5') { setDrawing(true) }
      else if (e.key === 'Escape') { onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [row.id, note, onApply, onUndo, onClose])

  const opBtn = (bg: string, color: string, border: string): React.CSSProperties => ({
    padding: '6px 14px', fontSize: 12, borderRadius: 4, cursor: 'pointer', background: bg, color,
    border: `1px solid ${border}`, fontWeight: 600,
  })

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: '#040e25', border: '1px solid rgba(0,150,220,0.4)', borderRadius: 10,
        padding: 18, width: 880, maxWidth: '94vw', maxHeight: '92vh', overflowY: 'auto',
      }}>
        {/* 头 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <div style={{ width: 3, height: 18, background: CYAN }} />
          <span style={{ color: '#c8e6ff', fontSize: 15, fontWeight: 700 }}>检测详情 · 复检工作台</span>
          <span style={{ ...mono, fontSize: 11, color: '#5a8aaa' }}>#{row.id} · {row.stream_id}</span>
          {reviewer && <span style={{ fontSize: 11, color: GREEN }}>复核人 {reviewer}</span>}
          <button onClick={onClose} style={{
            marginLeft: 'auto', padding: '3px 10px', fontSize: 11, cursor: 'pointer',
            border: '1px solid rgba(150,150,180,0.3)', background: 'transparent', color: '#7ab8e0', borderRadius: 3,
          }}>关闭 ✕</button>
        </div>

        {/* 大图 + 检测框 */}
        {row.frame_path && (
          <div style={{ position: 'relative', marginBottom: 12, background: '#000', borderRadius: 6, overflow: 'hidden' }}>
            <img src={srcOf(row.frame_path)}
              onLoad={e => {
                const nw = (e.target as HTMLImageElement).naturalWidth, nh = (e.target as HTMLImageElement).naturalHeight
                if (nw && nh) setImgSizes(prev => (prev[row.id] ? prev : { ...prev, [row.id]: { w: nw, h: nh } }))
              }}
              alt="" style={{ width: '100%', display: 'block', borderRadius: 6 }} />
            {(row.boxes || []).map((b, i) => (
              <div key={i} style={{
                position: 'absolute',
                left: `${(b.x1 / iw) * 100}%`, top: `${(b.y1 / ih) * 100}%`,
                width: `${((b.x2 - b.x1) / iw) * 100}%`, height: `${((b.y2 - b.y1) / ih) * 100}%`,
                border: `2px solid ${clsColor(b.cls)}`, boxSizing: 'border-box',
              }}>
                <span style={{
                  position: 'absolute', top: -17, left: 0, background: clsColor(b.cls), color: '#000',
                  fontSize: 10, padding: '0 4px', borderRadius: 2, fontWeight: 600, lineHeight: '15px', ...mono,
                }}>
                  {clsName(b.cls)} {(b.conf || 0).toFixed(2)}
                </span>
              </div>
            ))}
            <span style={{
              position: 'absolute', top: 8, right: 8, background: 'rgba(0,10,25,0.75)', color: '#7ab8e0',
              fontSize: 11, padding: '2px 8px', borderRadius: 3, ...mono,
            }}>
              {row.label} · {(row.max_conf || 0).toFixed(3)}
            </span>
          </div>
        )}

        {/* 基本信息 */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ color: '#7ab8e0', fontSize: 12, fontWeight: 700, marginBottom: 4 }}>检测信息</div>
          {labelLine('时间', row.ts || '-')}
          {labelLine('来源', row.source || '-')}
          {labelLine('坐标', (typeof row.lat === 'number' && typeof row.lng === 'number') ? `${row.lat.toFixed(5)}, ${row.lng.toFixed(5)}` : '-')}
        </div>

        {/* 推送状态 */}
        <div style={{ borderTop: '1px solid rgba(0,150,220,0.2)', paddingTop: 10, marginBottom: 12 }}>
          <div style={{ color: '#7ab8e0', fontSize: 12, fontWeight: 700, marginBottom: 4 }}>推送状态</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{
              display: 'inline-block', padding: '2px 10px', borderRadius: 3, fontSize: 12, fontWeight: 700,
              color: pb.color, background: pb.bg,
            }}>{pb.text}</span>
            {row.push?.warning_id && (
              <span style={{ ...mono, fontSize: 10, color: '#5a8aaa' }}>告警 {row.push.warning_id}</span>
            )}
          </div>
          {row.push?.status === 'failed' && row.push?.reason && labelLine('失败原因', row.push.reason, RED)}
          {row.push?.status === 'held' && row.push?.reason && labelLine('挂起原因', row.push.reason, PURPLE)}
          {row.push?.status === 'held' && (
            <div style={{ marginTop: 4, fontSize: 11, color: PURPLE, lineHeight: 1.7 }}>
              ⏸ gate=pre 低置信度挂起：人工判定「真烟」后自动向责任单位推送；判定「误报」则静默取消。
            </div>
          )}
          {row.push?.correctedAt && (
            <>
              <div style={{ marginTop: 6, color: RED, fontSize: 11, fontWeight: 700 }}>⚠ 已追发更正推送（误报撤销）</div>
              {labelLine('更正时间', String(row.push.correctedAt).slice(5, 19).replace('T', ' '), RED)}
              {row.push.correctionNote && labelLine('更正说明', row.push.correctionNote, RED)}
              {row.push.correctedBy && labelLine('更正复核人', row.push.correctedBy, RED)}
            </>
          )}
          {(row.push?.town || row.push?.unit) && (
            <>
              {labelLine('行政区', row.push.town || '-')}
              {labelLine('责任单位', row.push.unit || '-')}
            </>
          )}
          {row.push?.cardUrl && (
            <div style={{ marginTop: 6 }}>
              <div style={{ fontSize: 11, color: '#5a8aaa', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
                <ImageIcon size={12} strokeWidth={1.75} />告警卡片（微信推送图）
              </div>
              <img src={row.push.cardUrl} alt="card" style={{ width: '100%', maxWidth: 480, borderRadius: 6, border: '1px solid rgba(0,150,220,0.2)' }} />
            </div>
          )}
        </div>

        {/* 复检操作区（第 2 批内嵌工作台） */}
        <div style={{ borderTop: '1px solid rgba(0,150,220,0.2)', paddingTop: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ color: '#7ab8e0', fontSize: 12, fontWeight: 700 }}>复检操作</span>
            <span style={{
              display: 'inline-block', padding: '2px 10px', borderRadius: 3, fontSize: 12, fontWeight: 700,
              color: rb.color, background: rb.bg,
            }}>{rb.text}</span>
            {row.reviewer && <span style={{ fontSize: 11, color: '#5a8aaa' }}>复核人 {row.reviewer} · {row.reviewed_at || ''}</span>}
          </div>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            <button onClick={() => onApply(row.id, 'true', note)} style={opBtn('rgba(74,222,128,0.15)', GREEN, 'rgba(74,222,128,0.4)')}>✓ 真烟 (1)</button>
            <button onClick={() => onApply(row.id, 'false', note)} style={opBtn('rgba(255,68,68,0.15)', RED, 'rgba(255,68,68,0.4)')}>✗ 误报 (2)</button>
            <button onClick={() => onApply(row.id, 'uncertain', note)} style={opBtn('rgba(255,183,77,0.15)', AMBER, 'rgba(255,183,77,0.4)')}>⏸ 稍后 (3)</button>
            <button onClick={() => onUndo(row.id)} disabled={!done} style={{ ...opBtn('rgba(90,138,170,0.12)', '#7ab8e0', 'rgba(90,138,170,0.35)'), opacity: done ? 1 : 0.4 }}>↩ 撤销 (4)</button>
            <button onClick={() => setDrawing(true)} style={opBtn('rgba(0,170,255,0.15)', CYAN, 'rgba(0,170,255,0.4)')}>✏ 画框补标 (5)</button>
          </div>

          {/* 备注 */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="备注（随判定一并保存）"
              style={{
                flex: 1, background: 'rgba(0,20,60,0.6)', color: '#c8e6ff', border: '1px solid rgba(0,150,220,0.3)',
                padding: '6px 10px', borderRadius: 4, fontSize: 12,
              }} />
            <button onClick={() => onApply(row.id, row.review_status === 'pending' ? 'uncertain' : row.review_status || 'uncertain', note)}
              style={opBtn('rgba(0,80,180,0.15)', '#7ab8e0', 'rgba(0,150,220,0.4)')}>保存备注</button>
          </div>

          {row.note && labelLine('历史备注', row.note, '#7ab8e0')}

          <div style={{ marginTop: 6, fontSize: 11, color: '#3a5a70', lineHeight: 1.7 }}>
            <Camera size={11} strokeWidth={1.75} style={{ verticalAlign: -2 }} />
            快捷键：1=真烟 2=误报 3=稍后 4/Ctrl+Z=撤销 5=画框 Esc=关闭（输入框聚焦时自动停用）· 判定将记入「AI 检测复检」页并用于后续重训
          </div>
        </div>
      </div>

      {/* 画框补标全屏弹层 */}
      {drawing && (
        <BoxDrawerOverlay
          src={srcOf(row.frame_path) || ''}
          initialBoxes={row.boxes || []}
          onSave={(boxes) => { onSaveBoxes(row.id, boxes); setDrawing(false) }}
          onCancel={() => setDrawing(false)}
        />
      )}
    </div>
  )
}

// ── 画框补标（全屏 canvas，精确定位）──
function BoxDrawerOverlay({ src, initialBoxes, onSave, onCancel }: {
  src: string
  initialBoxes?: any[]
  onSave: (boxes: any[]) => void
  onCancel: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const [boxes, setBoxes] = useState<any[]>(initialBoxes || [])
  const [drawing, setDrawing] = useState<any>(null)
  const [cls, setCls] = useState(0)

  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      if (imgRef.current) {
        imgRef.current.src = src
        const canvas = canvasRef.current
        if (canvas) {
          canvas.width = img.naturalWidth
          canvas.height = img.naturalHeight
          redraw()
        }
      }
    }
    img.src = src
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src])

  const redraw = () => {
    const canvas = canvasRef.current
    const img = imgRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !img || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    for (const b of boxes) {
      ctx.strokeStyle = clsColor(b.cls)
      ctx.lineWidth = 3
      ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1)
      ctx.fillStyle = clsColor(b.cls)
      ctx.font = 'bold 28px sans-serif'
      ctx.fillText(clsName(b.cls), b.x1, b.y1 - 8)
      // 右上角 × 删除标记
      const sx = b.x2 - 22, sy = b.y1 + 2
      ctx.fillStyle = 'rgba(0,0,0,0.65)'
      ctx.fillRect(sx, sy, 20, 20)
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5
      ctx.strokeRect(sx + 0.5, sy + 0.5, 19, 19)
      ctx.fillStyle = '#fff'; ctx.font = 'bold 18px sans-serif'
      ctx.fillText('×', sx + 5, sy + 16)
    }
    if (drawing) {
      ctx.strokeStyle = clsColor(cls)
      ctx.lineWidth = 2
      ctx.strokeRect(drawing.x1, drawing.y1, drawing.x2 - drawing.x1, drawing.y2 - drawing.y1)
    }
  }

  const pos = (e: React.MouseEvent) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(canvas.width, (e.clientX - rect.left) * (canvas.width / rect.width))),
      y: Math.max(0, Math.min(canvas.height, (e.clientY - rect.top) * (canvas.height / rect.height))),
    }
  }

  const cBtn = (c: number, name: string, color: string) => (
    <button onClick={() => setCls(c)} style={{
      padding: '6px 14px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
      background: cls === c ? color + '33' : 'rgba(0,20,50,0.5)', color: cls === c ? color : '#7ab8e0',
      border: `1px solid ${cls === c ? color : 'rgba(90,138,170,0.35)'}`, fontWeight: 600,
    }}>{name}</button>
  )

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 3100, background: 'rgba(2,8,20,0.92)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }} onClick={onCancel}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 'min(1180px, 96vw)', maxHeight: '96vh', display: 'flex', flexDirection: 'column',
        background: '#040e25', border: '1px solid rgba(0,150,220,0.4)', borderRadius: 10, overflow: 'hidden',
      }}>
        {/* 顶栏 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid rgba(0,80,150,0.3)' }}>
          <span style={{ color: CYAN, fontSize: 14, fontWeight: 700 }}>✏ 画框补标（漏报补标 · 保存即真烟）</span>
          <span style={{ fontSize: 11, color: '#5a8aaa', marginLeft: 'auto' }}>在图上拖拽画框 · 点框右上角 × 删除 · {boxes.length} 框</span>
          <button onClick={onCancel} style={tinyBtn('rgba(90,138,170,0.12)', '#7ab8e0', 'rgba(90,138,170,0.35)')}>取消 ✕</button>
        </div>
        {/* 类别栏 */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 14px', borderBottom: '1px solid rgba(0,80,150,0.3)' }}>
          <span style={{ fontSize: 11, color: '#5a8aaa' }}>画框类别:</span>
          {cBtn(0, '烟 smoke', CYAN)}
          {cBtn(1, '火 fire', RED)}
          {cBtn(2, '房 house', AMBER)}
          <button onClick={() => setBoxes(prev => prev.slice(0, -1))} disabled={!boxes.length}
            style={{ ...tinyBtn('rgba(90,138,170,0.12)', '#7ab8e0', 'rgba(90,138,170,0.35)'), opacity: boxes.length ? 1 : 0.4 }}>撤销上一框</button>
        </div>
        {/* 图 + 画布 */}
        <div style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'auto', background: '#000' }}>
          <img ref={imgRef} src={src} alt="" style={{ width: '100%', display: 'block' }} />
          <canvas ref={canvasRef} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', cursor: 'crosshair' }}
            onMouseDown={e => { const p = pos(e); setDrawing({ x1: p.x, y1: p.y, x2: p.x, y2: p.y }) }}
            onMouseMove={e => { if (drawing) { const p = pos(e); setDrawing({ ...drawing, x2: p.x, y2: p.y }); redraw() } }}
            onMouseUp={e => {
              const p = pos(e)
              const hitIdx = boxes.findIndex(b => p.x >= b.x2 - 22 && p.x <= b.x2 + 2 && p.y >= b.y1 + 2 && p.y <= b.y1 + 22)
              if (hitIdx >= 0) { setBoxes(boxes.filter((_, i) => i !== hitIdx)); setDrawing(null); redraw(); return }
              if (drawing) {
                const b = { x1: Math.min(drawing.x1, drawing.x2), y1: Math.min(drawing.y1, drawing.y2), x2: Math.max(drawing.x1, drawing.x2), y2: Math.max(drawing.y1, drawing.y2), cls, conf: 1.0 }
                if (b.x2 - b.x1 > 5 && b.y2 - b.y1 > 5) { setBoxes([...boxes, b]); setDrawing(null); redraw() }
                else setDrawing(null)
              }
            }}
          />
        </div>
        {/* 底栏 */}
        <div style={{ display: 'flex', gap: 8, padding: '10px 14px', borderTop: '1px solid rgba(0,80,150,0.3)' }}>
          <button onClick={() => onSave(boxes)} style={{ flex: 1, padding: '8px 0', fontSize: 13, borderRadius: 4, cursor: 'pointer', fontWeight: 700,
            background: 'rgba(0,170,255,0.2)', color: CYAN, border: '1px solid rgba(0,170,255,0.5)' }}>
            保存画框（{boxes.length} 框 → 真烟）
          </button>
          <button onClick={onCancel} style={{ padding: '8px 24px', fontSize: 13, borderRadius: 4, cursor: 'pointer',
            background: 'rgba(90,138,170,0.12)', color: '#7ab8e0', border: '1px solid rgba(90,138,170,0.35)' }}>取消</button>
        </div>
      </div>
    </div>
  )
}

// ── 第 4 批：复检数据资产报表弹层（复检分布/类别/工作量/趋势/导出历史 + 一键导出重训）──
interface StatsData {
  verdict: { total: number; pending: number; trueCount: number; falseCount: number; uncertain: number }
  labels: { label: string; c: number }[]
  boxCls: { smoke: number; fire: number; house: number }
  reviewers: { reviewer: string; true_cnt: number; false_cnt: number; uncertain_cnt: number; total: number }[]
  streams: { stream_id: string; total: number; true_cnt: number; false_cnt: number }[]
  months: { ym: string; total: number; true_cnt: number; false_cnt: number }[]
  confs: { lt03: number; m03_05: number; m05_07: number; m07_09: number; ge09: number }
  exports: { id: number; created_at: string; exporter: string; base_dir: string; exported: number; smoke_boxes: number; fire_boxes: number; house_boxes: number; trigger_type: string }[]
}

function StatsOverlay({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<StatsData | null>(null)
  const [exporting, setExporting] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await authFetch('/api/straw/stats')
      const d = await r.json()
      if (d.ok) setData(d)
    } catch {}
  }, [])

  useEffect(() => { load() }, [load])

  const doExport = async () => {
    setExporting(true)
    try {
      const r = await authFetch('/api/review/export', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      })
      const d = await r.json()
      if (d.ok) { setMsg(`导出完成：${d.exported} 帧 → ${d.dir}（烟 ${d.smokeBoxes} / 火 ${d.fireBoxes} / 房 ${d.houseBoxes} 框）`); load() }
      else setMsg(d.error || '导出失败')
    } catch { setMsg('导出失败') }
    setExporting(false)
  }

  // 横向条形图（纯 CSS，无第三方图表库）
  const bar = (label: string, val: number, max: number, color: string) => (
    <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
      <span style={{ width: 88, color: '#7ab8e0', flexShrink: 0, textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={label}>{label}</span>
      <div style={{ flex: 1, height: 14, background: 'rgba(0,60,120,0.18)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: max > 0 ? `${Math.round((val / max) * 100)}%` : 0, height: '100%', background: color, borderRadius: 3 }} />
      </div>
      <span style={{ width: 44, color: '#c8e6ff', fontFamily: 'monospace', flexShrink: 0 }}>{val}</span>
    </div>
  )

  const d = data
  const verdict = d?.verdict
  const reviewed = verdict ? verdict.trueCount + verdict.falseCount + verdict.uncertain : 0
  const rate = verdict && verdict.total ? Math.round((reviewed / verdict.total) * 100) : 0
  const labelMax = Math.max(1, ...(d?.labels || []).map(x => x.c))
  const boxMax = Math.max(1, ...(d ? [d.boxCls.smoke, d.boxCls.fire, d.boxCls.house] : [1]))
  const confList = d ? [
    ['< 0.30', d.confs.lt03, '#5a8aaa'],
    ['0.30-0.50', d.confs.m03_05, AMBER],
    ['0.50-0.70', d.confs.m05_07, CYAN],
    ['0.70-0.90', d.confs.m07_09, '#7ee0ff'],
    ['≥ 0.90', d.confs.ge09, GREEN],
  ] as const : []
  const confMax = Math.max(1, ...confList.map(x => x[1]))
  const monthMax = Math.max(1, ...(d?.months || []).map(x => x.total))

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 3200, background: 'rgba(2,8,20,0.94)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(1180px, 96vw)', maxHeight: '94vh', display: 'flex', flexDirection: 'column', background: '#040e25', border: '1px solid rgba(0,150,220,0.4)', borderRadius: 10, overflow: 'hidden' }}>
        {/* 顶栏 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid rgba(0,80,150,0.3)' }}>
          <BarChart3 size={14} strokeWidth={2} style={{ color: CYAN }} />
          <span style={{ color: CYAN, fontSize: 14, fontWeight: 700 }}>复检数据资产报表</span>
          <span style={{ fontSize: 11, color: '#5a8aaa' }}>数据源 straw_detections · 支撑运营评估与算法迭代</span>
          <button onClick={onClose} style={{ ...tinyBtn('rgba(90,138,170,0.12)', '#7ab8e0', 'rgba(90,138,170,0.35)'), marginLeft: 'auto' }}>关闭 ✕</button>
        </div>
        {/* 内容（滚动） */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {!d ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#5a8aaa', fontSize: 12 }}>加载中...</div>
          ) : (
            <>
              {/* 总览卡 */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
                {([
                  ['检测帧总数', verdict?.total ?? 0, '#c8e6ff'],
                  ['已复检', reviewed, '#7ee0ff'],
                  ['复检率', rate + '%', PURPLE],
                  ['真烟', verdict?.trueCount ?? 0, GREEN],
                  ['误报', verdict?.falseCount ?? 0, RED],
                  ['稍后处理', verdict?.uncertain ?? 0, AMBER],
                ] as const).map(([label, v, color]) => (
                  <div key={label} style={{ ...card, display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 14px' }}>
                    <div style={{ fontSize: 11, color: '#5a8aaa' }}>{label}</div>
                    <div style={{ color, fontSize: 20, fontWeight: 700, fontFamily: 'monospace' }}>{v}</div>
                  </div>
                ))}
              </div>

              {/* 类别分布 */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div style={card}>
                  <div style={{ fontSize: 12, color: CYAN, fontWeight: 700, marginBottom: 10 }}>检测结果类别分布（记录级）</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {(d.labels || []).length ? d.labels.map(x => bar(x.label || '-', x.c, labelMax, x.label === 'fire' ? RED : x.label === 'smoke' ? CYAN : AMBER)) : <div style={{ fontSize: 11, color: '#3a5a70' }}>暂无</div>}
                  </div>
                </div>
                <div style={card}>
                  <div style={{ fontSize: 12, color: CYAN, fontWeight: 700, marginBottom: 10 }}>真烟框类别分布（框级）</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {bar('烟 smoke', d.boxCls.smoke, boxMax, CYAN)}
                    {bar('火 fire', d.boxCls.fire, boxMax, RED)}
                    {bar('房 house', d.boxCls.house, boxMax, AMBER)}
                  </div>
                </div>
              </div>

              {/* 置信度分桶 */}
              <div style={card}>
                <div style={{ fontSize: 12, color: CYAN, fontWeight: 700, marginBottom: 10 }}>检测置信度分布（帧级 max_conf）</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {confList.map(([label, val, color]) => bar(label, val, confMax, color))}
                </div>
              </div>

              {/* 复检员工作量 + 按流 TOP */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
                  <div style={{ fontSize: 12, color: CYAN, fontWeight: 700, padding: '10px 14px', borderBottom: '1px solid rgba(0,80,150,0.3)' }}>复检员工作量</div>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead><tr>{['复核人', '真烟', '误报', '稍后', '合计'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                      <tbody>
                        {(d.reviewers || []).length ? d.reviewers.map(r => (
                          <tr key={r.reviewer}>
                            <td style={{ ...td, ...mono, fontSize: 11, color: '#7ab8e0' }}>{r.reviewer}</td>
                            <td style={{ ...td, ...mono, color: GREEN }}>{r.true_cnt}</td>
                            <td style={{ ...td, ...mono, color: RED }}>{r.false_cnt}</td>
                            <td style={{ ...td, ...mono, color: AMBER }}>{r.uncertain_cnt}</td>
                            <td style={{ ...td, ...mono }}>{r.total}</td>
                          </tr>
                        )) : <tr><td colSpan={5} style={{ ...td, textAlign: 'center', color: '#3a5a70' }}>暂无复检记录</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
                  <div style={{ fontSize: 12, color: CYAN, fontWeight: 700, padding: '10px 14px', borderBottom: '1px solid rgba(0,80,150,0.3)' }}>按视频流 TOP12</div>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead><tr>{['视频流', '检测', '真烟', '误报'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                      <tbody>
                        {(d.streams || []).map(r => (
                          <tr key={r.stream_id}>
                            <td style={{ ...td, ...mono, fontSize: 10, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#7ab8e0' }} title={r.stream_id}>{r.stream_id || '-'}</td>
                            <td style={{ ...td, ...mono }}>{r.total}</td>
                            <td style={{ ...td, ...mono, color: GREEN }}>{r.true_cnt}</td>
                            <td style={{ ...td, ...mono, color: RED }}>{r.false_cnt}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {/* 按月趋势 */}
              <div style={card}>
                <div style={{ fontSize: 12, color: CYAN, fontWeight: 700, marginBottom: 10 }}>按月趋势（近 12 月 · 检测 / 真烟 / 误报）</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {(d.months || []).slice().reverse().map(m => (
                    <div key={m.ym} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                      <span style={{ width: 52, color: '#5a8aaa', flexShrink: 0, fontFamily: 'monospace' }}>{m.ym}</span>
                      <div style={{ flex: 1, height: 16, background: 'rgba(0,60,120,0.18)', borderRadius: 3, overflow: 'hidden', display: 'flex' }}>
                        <div style={{ width: `${Math.round((m.total / monthMax) * 100)}%`, background: 'rgba(0,170,255,0.55)', height: '100%' }} />
                      </div>
                      <span style={{ width: 30, color: '#c8e6ff', fontFamily: 'monospace', textAlign: 'right' }}>{m.total}</span>
                      <span style={{ width: 24, color: GREEN, fontFamily: 'monospace', textAlign: 'right' }}>{m.true_cnt}</span>
                      <span style={{ width: 24, color: RED, fontFamily: 'monospace', textAlign: 'right' }}>{m.false_cnt}</span>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 14, fontSize: 10, color: '#5a8aaa', marginTop: 6 }}>
                  <span><span style={{ color: CYAN }}>■</span> 检测</span>
                  <span><span style={{ color: GREEN }}>■</span> 真烟</span>
                  <span><span style={{ color: RED }}>■</span> 误报</span>
                </div>
              </div>

              {/* 导出历史 + 一键导出 */}
              <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid rgba(0,80,150,0.3)' }}>
                  <span style={{ fontSize: 12, color: CYAN, fontWeight: 700 }}>YOLO 训练数据导出（数据资产台账）</span>
                  <button onClick={doExport} disabled={exporting}
                    style={{ ...tinyBtn('rgba(0,170,255,0.18)', exporting ? '#6b9abf' : CYAN, 'rgba(0,170,255,0.5)'), padding: '5px 14px', marginLeft: 'auto', fontWeight: 700 }}>
                    {exporting ? '导出中...' : '⚡ 一键导出重训'}
                  </button>
                </div>
                {msg && <div style={{ padding: '6px 14px', fontSize: 11, color: msg.startsWith('导出完成') ? GREEN : ORANGE, borderBottom: '1px solid rgba(0,80,150,0.2)' }}>{msg}</div>}
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr>{['时间', '触发人', '方式', '导出帧', '烟框', '火框', '房框', '目录'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                    <tbody>
                      {(d.exports || []).map(x => (
                        <tr key={x.id}>
                          <td style={{ ...td, ...mono, fontSize: 10, whiteSpace: 'nowrap' }}>{x.created_at}</td>
                          <td style={{ ...td, ...mono, fontSize: 11, color: '#7ab8e0' }}>{x.exporter || '-'}</td>
                          <td style={{ ...td, fontSize: 11 }}>{x.trigger_type === 'manual' ? '一键导出' : 'API'}</td>
                          <td style={{ ...td, ...mono, fontWeight: 700, color: CYAN }}>{x.exported}</td>
                          <td style={{ ...td, ...mono, color: CYAN }}>{x.smoke_boxes}</td>
                          <td style={{ ...td, ...mono, color: RED }}>{x.fire_boxes}</td>
                          <td style={{ ...td, ...mono, color: AMBER }}>{x.house_boxes}</td>
                          <td style={{ ...td, ...mono, fontSize: 10, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#5a8aaa' }} title={x.base_dir}>{x.base_dir}</td>
                        </tr>
                      ))}
                      {!(d.exports || []).length && <tr><td colSpan={8} style={{ ...td, textAlign: 'center', color: '#3a5a70' }}>暂无导出记录 —— 点击右上「一键导出重训」生成首份 YOLO 训练数据集</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
