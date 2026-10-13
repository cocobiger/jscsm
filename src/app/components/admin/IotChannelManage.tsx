import { useState, useEffect, useCallback, useMemo } from 'react'
import { apiFetch } from '../../lib/apiFetch'
import { roleAtLeast, type CurrentUser } from '../../lib/auth'
import type { RoiConfig } from '../../lib/api-types'
import { AlertCircle, Check, Pencil, X } from 'lucide-react'

const CYAN = '#00aaff'
const GREEN = '#00e676'
const RED = '#ff4444'
const AMBER = '#ffd740'
const DIM = '#3a5a70'
const DIM2 = '#5a8aaa'

/* ────────────────────────────────────────────────────────────────────────────
 * 时间显示：一律上海时（UTC+8）
 * 🔴 本项目该字段**两种格式混存**：17 条是 ISO 串、1 条（龙腾?）是 13 位毫秒时间戳。
 *    旧代码用 `createdAt.slice(0,10)`，于是页面上出现了「接入于 1788425215」这种鬼东西。
 *    这里统一：数字串（10/13 位）按时间戳解析，ISO 串按 Date.parse，再显式 +8h 用 getUTC* 取值。
 * ──────────────────────────────────────────────────────────────────────────── */
const fmtCN = (v?: string | number | null): string => {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'string' && /^\d{10,13}$/.test(v)) v = Number(v)
  let ms: number | null = null
  if (typeof v === 'number' && Number.isFinite(v)) ms = v < 1e12 ? v * 1000 : v
  else if (typeof v === 'string') { const t = Date.parse(v); if (Number.isFinite(t)) ms = t }
  if (ms === null) return String(v)
  const d = new Date(ms + 8 * 3600 * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

interface LocalChannel {
  channelSipId: string
  channelName: string
  deviceSipId: string
  deviceName: string
  streamId: string | null
  enabled: boolean
  remark: string
  aiTypes: string[]
  roi?: RoiConfig
  createdAt: string
  updatedAt: string
}

interface Stream {
  id: string
  name: string
  group?: string
  offline?: boolean
}

const inputStyle: React.CSSProperties = {
  padding: '5px 8px', background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.25)',
  borderRadius: 3, color: '#c8e6ff', fontSize: 12, outline: 'none', maxWidth: 180,
}

/** 规范化名称用于"疑似同一路"的保守匹配：去掉括号后缀/问号/空格 */
const normName = (s: string) => String(s || '')
  .replace(/[（(][^）)]*[）)]/g, '')
  .replace(/[?\s]/g, '')
  .toLowerCase()

interface Props {
  user: CurrentUser
}

type Filter = 'all' | 'mapped' | 'nomap' | 'badname' | 'stopped' | 'free' | 'nochain'

interface HealthRow { name: string; status: string; last30d?: number; lastAt?: string | null }

export function IotChannelManage({ user }: Props) {
  const [local, setLocal] = useState<LocalChannel[]>([])
  const [streams, setStreams] = useState<Stream[]>([])
  const [aiTypes, setAiTypes] = useState<string[]>([])
  const [health, setHealth] = useState<HealthRow[]>([])
  const [toast, setToast] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  // 右栏视图：'channels' = 已登记通道；'streams' = 游离的视频流（点「游离的流」chip 切换）
  const [view, setView] = useState<'channels' | 'streams'>('channels')
  // 手工新增通道（原「远程通道（平台 IoTCloud）」面板已永久移除 —— 平台侧 /sip/channel/list 恒返回 200 + 空清单）
  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState({ channelSipId: '', channelName: '', deviceName: '', streamId: '' })

  const isAdmin = roleAtLeast(user.role, 'admin')
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3500) }

  const loadLocal = useCallback(() => {
    apiFetch<LocalChannel[]>('/api/iot-channels').then(d => setLocal(Array.isArray(d) ? d : [])).catch(() => {})
  }, [])
  const loadStreams = useCallback(() => {
    apiFetch<Stream[]>('/api/streams').then(d => setStreams(Array.isArray(d) ? d : [])).catch(() => {})
  }, [])
  const loadAiTypes = useCallback(() => {
    apiFetch<Array<{ name: string }>>('/api/ai-types').then(d => { if (Array.isArray(d)) setAiTypes(d.map(x => x.name)) }).catch(() => {})
  }, [])
  const loadHealth = useCallback(() => {
    apiFetch<HealthRow[]>('/api/ai-types/health').then(d => { if (Array.isArray(d)) setHealth(d) }).catch(() => {})
  }, [])

  useEffect(() => {
    loadLocal(); loadStreams(); loadAiTypes(); loadHealth()
    const t = setInterval(() => { loadLocal() }, 15000)
    return () => clearInterval(t)
  }, [loadLocal, loadStreams, loadAiTypes, loadHealth])

  /** 🔴 「现网到底有没有算法链在跑」——用算法健康度判定：
   *  status==='active'（近 7 天有数据）或 last30d>0 → 有链；unbound/never → 没有链在跑。
   *  这是页面**唯一**能拿到的"链侧信息"：真正的链配置在各链自己的文件里（堆头 stack_config.json /
   *  TASK 任务 / 边缘链 edge_config.json），不在驾驶舱库里，所以这里只能给"这个算法有没有链"，
   *  不能给"这条通道有没有被链配进去"（见页脚口径说明）。 */
  const algoLive = useMemo(() => {
    const s = new Set<string>()
    for (const h of health) {
      if (h.status === 'active' || (h.last30d || 0) > 0) s.add(h.name)
    }
    return s
  }, [health])

  /** streamId → 占用它的通道名（1:1 冲突提示） */
  const streamOwner = useMemo(() => {
    const m: Record<string, string> = {}
    for (const c of local) if (c.streamId) m[c.streamId] = c.channelName
    return m
  }, [local])

  const streamById = useMemo(() => {
    const m: Record<string, Stream> = {}
    for (const s of streams) m[s.id] = s
    return m
  }, [streams])

  /** 每条通道的"登记体检"结果 —— 页面右栏与筛选都基于它 */
  const rows = useMemo(() => local.map(c => {
    const st = c.streamId ? streamById[c.streamId] : undefined
    const dangling = !!c.streamId && !st                       // 悬空引用：绑了流但流清单里没有
    const roiAlgos = Object.keys(c.roi || {})
    const badName = /[?]/.test(c.channelName) || !String(c.channelName).trim()
    // 「算法链路」：声明的每个算法，现网到底有没有链在跑
    const live = (c.aiTypes || []).filter(a => algoLive.has(a))
    const dead = (c.aiTypes || []).filter(a => !algoLive.has(a))
    return { c, st, dangling, roiAlgos, badName, nomap: !c.streamId, live, dead }
  }), [local, streamById, algoLive])

  /** 未被任何通道使用的流（= 游离的流） */
  const unusedStreams = useMemo(() => {
    const used = new Set(local.map(c => c.streamId).filter(Boolean) as string[])
    return streams.filter(s => !used.has(s.id))
  }, [streams, local])

  /** 每条游离流：找出"疑似同点位的通道"。
   *  🔴 这里用**宽松匹配（双向 includes）**，因为它只用于**给人看的提示**（"这个点位其实已经有通道了"）——
   *     例如通道「大门干道（万源玻璃）」vs 游离流「万源玻璃大门干道」：词序不同，startsWith 抓不到，includes 能抓到。
   *     ⚠ 而"一键补映射"用的是更严的 `suggestStreamFor`（只认同名/前缀），避免宽松匹配把流挂错通道。 */
  const freeStreamRows = useMemo(() => unusedStreams.map(s => {
    const b = normName(s.name)
    const sameName = b ? local.filter(c => {
      const a = normName(c.channelName)
      return a && (a === b || a.includes(b) || b.includes(a))
    }) : []
    const unboundSame = sameName.filter(c => !c.streamId)
    return {
      s,
      sameName,                      // 同名/近名的已登记通道（不管它绑没绑流）
      target: unboundSame.length === 1 ? unboundSame[0] : null,   // 唯一可一键补映射的目标
    }
  }), [unusedStreams, local])

  /** 给"未绑流的通道"找一个同名/近名的流（保守匹配，找不到就不猜） */
  const suggestStreamFor = useCallback((c: LocalChannel): Stream | null => {
    const a = normName(c.channelName)
    if (!a) return null
    const hit = unusedStreams.filter(s => {
      const b = normName(s.name)
      return b && (a === b || a.startsWith(b) || b.startsWith(a))
    })
    return hit.length === 1 ? hit[0] : null
  }, [unusedStreams])

  // ── 统计（体检条） ──
  const stat = useMemo(() => ({
    total: local.length,
    mapped: rows.filter(r => !r.nomap).length,
    nomap: rows.filter(r => r.nomap).length,
    badname: rows.filter(r => r.badName).length,
    stopped: rows.filter(r => !r.c.enabled).length,
    dangling: rows.filter(r => r.dangling).length,
    roiCh: rows.filter(r => r.roiAlgos.length > 0).length,
    unused: unusedStreams.length,
    // 声明了"现网没有链在跑"的算法的通道 → 这些声明永远不会产生任何东西
    nochain: rows.filter(r => (r.c.aiTypes || []).length > 0 && r.live.length === 0).length,
    // 游离流里"同点位其实已有通道、只是通道绑在另一条流上"的重复登记
    dupStream: freeStreamRows.filter(f => f.sameName.length > 0).length,
  }), [local, rows, unusedStreams, freeStreamRows])

  const shown = useMemo(() => rows.filter(r =>
    filter === 'all' ? true
      : filter === 'mapped' ? !r.nomap
        : filter === 'nomap' ? r.nomap
          : filter === 'badname' ? r.badName
            : filter === 'nochain' ? ((r.c.aiTypes || []).length > 0 && r.live.length === 0)
              : !r.c.enabled
  ), [rows, filter])

  /** 可一键补映射的配对（未绑流通道 × 唯一同名未用流） */
  const quickPairs = useMemo(() => rows.filter(r => r.nomap).map(r => ({ c: r.c, s: suggestStreamFor(r.c) })).filter(x => x.s), [rows, suggestStreamFor])

  // ── 写操作（沿用既有接口，未新增任何后端） ──
  const setStream = async (c: LocalChannel, streamId: string | null, quiet = false) => {
    try {
      await apiFetch(`/api/iot-channels/${c.channelSipId}`, { method: 'PUT', body: JSON.stringify({ streamId }) })
      if (!quiet) flash(streamId ? `已映射：${c.channelName} → ${streamById[streamId]?.name || streamId}` : '已取消映射')
      loadLocal()
    } catch (e: any) { flash('更新失败：' + (e?.error || e)) }
  }

  const setChannelAiTypes = async (c: LocalChannel, next: string[]) => {
    try {
      await apiFetch(`/api/iot-channels/${c.channelSipId}/ai-types`, { method: 'PATCH', body: JSON.stringify({ aiTypes: next }) })
      loadLocal()
    } catch (e: any) { flash('AI类型更新失败：' + (e?.error || e)) }
  }

  const renameChannel = async (c: LocalChannel) => {
    const next = window.prompt(`修改通道名称（当前：${c.channelName}）\n注意：只改显示名，不影响通道编号与识别链。`, c.channelName)
    if (next === null) return
    const v = next.trim()
    if (!v || v === c.channelName) return
    try {
      await apiFetch(`/api/iot-channels/${c.channelSipId}`, { method: 'PUT', body: JSON.stringify({ channelName: v }) })
      flash(`已改名：${c.channelName} → ${v}`)
      loadLocal()
    } catch (e: any) { flash('改名失败：' + (e?.error || e)) }
  }

  const toggleEnabled = async (c: LocalChannel) => {
    try {
      await apiFetch(`/api/iot-channels/${c.channelSipId}`, { method: 'PUT', body: JSON.stringify({ enabled: !c.enabled }) })
      loadLocal()
    } catch (e: any) { flash('切换失败：' + (e?.error || e)) }
  }

  const removeChannel = async (c: LocalChannel) => {
    if (!confirm(`确认移除通道「${c.channelName}」？移除后停止轮询与告警（软删除，可重新接入）。`)) return
    setBusyId(c.channelSipId)
    try {
      await apiFetch(`/api/iot-channels/${c.channelSipId}`, { method: 'DELETE' })
      flash('已移除')
      loadLocal()
    } catch (e: any) { flash('移除失败：' + (e?.error || e)) }
    finally { setBusyId(null) }
  }

  /** 手工新增通道：先拦"编号已存在"（后端是 upsert，会**覆盖**既有登记，必须前端先挡） */
  const submitAdd = async () => {
    const spid = addForm.channelSipId.trim()
    const name = addForm.channelName.trim()
    if (!spid || !name) { flash('通道编号与名称都必填'); return }
    const dup = local.find(c => c.channelSipId === spid)
    if (dup) {
      flash(`编号 ${spid} 已登记（${dup.channelName}）—— 请直接在右侧列表里改，避免覆盖`)
      return
    }
    setBusyId('__add__')
    try {
      await apiFetch('/api/iot-channels', {
        method: 'POST', body: JSON.stringify({
          channelSipId: spid, channelName: name,
          deviceName: addForm.deviceName.trim() || 'NVR',
          streamId: addForm.streamId || null, enabled: true,
        }),
      })
      flash(`已新增通道「${name}」${addForm.streamId ? '并映射视频流' : '（未映射，请在右侧补）'}`)
      setAddForm({ channelSipId: '', channelName: '', deviceName: '', streamId: '' })
      setShowAdd(false)
      loadLocal()
    } catch (e: any) { flash('新增失败：' + (e?.error || e)) }
    finally { setBusyId(null) }
  }

  const btn = (color: string, disabled = false): React.CSSProperties => ({
    padding: '4px 10px', fontSize: 12, borderRadius: 3, border: `1px solid ${color}55`,
    background: `${color}15`, color: disabled ? DIM : color, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1,
  })

  // chip：点一下 = 筛右栏；「游离的流」这个 chip 还会把右栏切成"流视图"
  const chip = (label: string, val: number, f: Filter, color: string, title?: string) => (
    <button key={f} title={title}
      onClick={() => { setFilter(filter === f ? 'all' : f); setView(f === 'free' ? 'streams' : 'channels') }}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 12, fontSize: 12,
        cursor: 'pointer', background: filter === f ? `${color}22` : 'transparent',
        border: `1px solid ${filter === f ? color : 'rgba(0,120,200,0.25)'}`, color: filter === f ? color : DIM2,
      }}>
      {label} <b style={{ color: val > 0 ? color : DIM }}>{val}</b>
    </button>
  )

  if (!isAdmin) return <div style={{ color: DIM, padding: 40 }}>权限不足</div>

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {toast && (
        <div style={{ position: 'fixed', top: 80, right: 40, zIndex: 3000, background: 'rgba(0,40,80,0.95)', border: '1px solid rgba(0,150,220,0.3)', borderRadius: 6, padding: '10px 20px', color: CYAN, fontSize: 13 }}>
          {toast}
        </div>
      )}

      {/* ── 登记体检条 ──
          两层维度必须分清：
            · 通道维度（右栏）：已登记的 14 条通道里，哪些没绑流 / 哪些声明的算法没有链
            · 流维度（左栏）：27 条流里，哪些没有任何通道在用
          「未绑」只用在**通道**上；流这边用「游离」。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '9px 14px', marginBottom: 6, flexShrink: 0, background: 'rgba(0,30,70,0.4)', border: '1px solid rgba(0,150,220,0.15)', borderRadius: 6 }}>
        <span style={{ color: '#c8e6ff', fontSize: 12, fontWeight: 600 }}>登记体检</span>
        <span style={{ color: DIM2, fontSize: 12 }}>通道 <b style={{ color: '#c8e6ff' }}>{stat.total}</b></span>
        {chip('已绑流', stat.mapped, 'mapped', GREEN, '该通道已绑定视频流')}
        {chip('通道未绑流', stat.nomap, 'nomap', AMBER, '已登记的通道里，哪些没有绑定视频流（注意：这是"通道"维度，不是"流"维度）')}
        {chip('名称待确认', stat.badname, 'badname', AMBER, '名称含 ? 或为空')}
        {chip('已停用', stat.stopped, 'stopped', DIM2, '通道被停用 → 不轮询')}
        {chip('无链算法通道', stat.nochain, 'nochain', RED, '该通道声明的算法里，没有任何一个"现网有链在跑" → 它永远不会产出记录')}
        {chip('游离的流', stat.unused, 'free', CYAN, '27 条视频流里，没有被任何通道使用的那几条（点它右栏会切成流视图）')}
        <span style={{ color: DIM, fontSize: 11, borderLeft: '1px solid rgba(0,120,200,0.25)', paddingLeft: 10 }}>
          悬空引用 <b style={{ color: stat.dangling ? RED : DIM }}>{stat.dangling}</b> ·
          已配围栏 <b style={{ color: stat.roiCh ? GREEN : DIM }}>{stat.roiCh}</b>
        </span>
        {(filter !== 'all' || view !== 'channels') && (
          <button onClick={() => { setFilter('all'); setView('channels') }} style={btn(DIM2)}>清除筛选</button>
        )}
      </div>

      {/* 口径说明：把"流 → 通道 → 算法"三层讲清（这是这个页面最容易误读的地方） */}
      <div style={{ flexShrink: 0, marginBottom: 10, padding: '6px 12px', background: 'rgba(0,20,60,0.3)', border: '1px solid rgba(0,120,200,0.15)', borderRadius: 6, color: DIM2, fontSize: 11.5, lineHeight: 1.75 }}>
        <b style={{ color: '#9fd8ff' }}>三层口径</b>：
        ① <b>流</b>（{streams.length} 条）只是可播放的源，与算法无关 →
        ② <b>通道</b>（{stat.total} 条）靠 <code>stream_id</code> 绑一条流，靠 <b>AI类型</b> 声明"该跑哪些算法" →
        ③ <b>算法链</b>（各链自己的配置文件，<b>不在本页</b>）才是真正抓帧/推理的那一层。
        <span style={{ color: AMBER }}>→ 绑了流 ≠ 勾了算法 ≠ 算法会跑</span>；
        本页能保证的是 ①② 与"记录能不能被驾驶舱看到"，第 ③ 层要改链配置（堆头链 <code>stack_config.json</code> / TASK 任务 / 边缘链）。
      </div>

      <div style={{ flex: 1, display: 'flex', gap: 16, minHeight: 0 }}>
        {/* ── 左栏：本地可用的流（平台侧接入来源已永久移除，这里是唯一的"可接入来源"清单） ── */}
        <div style={{ width: '38%', display: 'flex', flexDirection: 'column', border: '1px solid rgba(0,150,220,0.15)', borderRadius: 6, overflow: 'hidden', minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '9px 14px', background: 'rgba(0,30,70,0.5)', borderBottom: '1px solid rgba(0,150,220,0.15)' }}>
            <span style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 600 }}>游离的流（未被任何通道使用）</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: DIM, fontSize: 11 }}>{unusedStreams.length} 条</span>
              <button onClick={() => setShowAdd(v => !v)} style={btn(CYAN)}>{showAdd ? '收起' : '＋ 手工新增通道'}</button>
            </span>
          </div>

          {/* 手工新增通道（默认收起） */}
          {showAdd && (
            <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(0,150,220,0.15)', background: 'rgba(0,20,60,0.35)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <label style={{ color: DIM2, fontSize: 11 }}>
                  通道编号（国标 20 位，必填）
                  <input value={addForm.channelSipId} onChange={e => setAddForm(f => ({ ...f, channelSipId: e.target.value }))}
                    placeholder="如 56331706881318000301" style={{ ...inputStyle, width: '100%', maxWidth: 'none', marginTop: 3 }} />
                </label>
                <label style={{ color: DIM2, fontSize: 11 }}>
                  通道名称（必填）
                  <input value={addForm.channelName} onChange={e => setAddForm(f => ({ ...f, channelName: e.target.value }))}
                    placeholder="业务口径名称" style={{ ...inputStyle, width: '100%', maxWidth: 'none', marginTop: 3 }} />
                </label>
                <label style={{ color: DIM2, fontSize: 11 }}>
                  设备名（可空，默认 NVR）
                  <input value={addForm.deviceName} onChange={e => setAddForm(f => ({ ...f, deviceName: e.target.value }))}
                    placeholder="如 NVR(172.16.8.51)" style={{ ...inputStyle, width: '100%', maxWidth: 'none', marginTop: 3 }} />
                </label>
                <label style={{ color: DIM2, fontSize: 11 }}>
                  关联视频流（可空）
                  <select value={addForm.streamId} onChange={e => setAddForm(f => ({ ...f, streamId: e.target.value }))}
                    style={{ ...inputStyle, width: '100%', maxWidth: 'none', marginTop: 3 }}>
                    <option value="">暂不映射</option>
                    {streams.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
              </div>
              {addForm.channelSipId.trim() && !/^\d{15,22}$/.test(addForm.channelSipId.trim()) && (
                <div style={{ color: AMBER, fontSize: 11, marginTop: 6 }}>⚠ 编号看起来不是纯数字（现网既有的都是 20 位数字），确认无误再提交。</div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                <button disabled={busyId === '__add__'} onClick={submitAdd} style={btn(GREEN, busyId === '__add__')}>
                  {busyId === '__add__' ? '提交中…' : '新增'}
                </button>
                <button onClick={() => setShowAdd(false)} style={btn(DIM2)}>取消</button>
                <span style={{ color: DIM, fontSize: 11 }}>编号已存在的会被拦住（不会覆盖既有登记）</span>
              </div>
            </div>
          )}

          <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
            {unusedStreams.length === 0 ? (
              <div style={{ color: DIM, fontSize: 12, padding: 16, textAlign: 'center' }}>全部流都已被通道占用</div>
            ) : (
              <>
                {quickPairs.length > 0 && (
                  <div style={{ background: 'rgba(255,215,64,0.08)', border: '1px solid rgba(255,215,64,0.25)', borderRadius: 4, padding: '8px 10px', marginBottom: 8 }}>
                    <div style={{ color: AMBER, fontSize: 12, marginBottom: 6 }}>
                      可一键补映射：有 {quickPairs.length} 条通道未绑流，且存在唯一同名流
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {quickPairs.map(({ c, s }) => (
                        <div key={c.channelSipId} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                          <span style={{ color: '#c8e6ff', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.channelName}</span>
                          <span style={{ color: DIM }}>→</span>
                          <span style={{ color: DIM2, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s!.name}</span>
                          <button onClick={() => setStream(c, s!.id)} style={{ ...btn(CYAN), flexShrink: 0 }}>补映射</button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {unusedStreams.map(s => (
                    <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', background: 'rgba(0,20,60,0.3)', border: '1px solid rgba(0,120,200,0.15)', borderRadius: 3, fontSize: 12 }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: s.offline ? DIM : GREEN, flexShrink: 0 }} />
                      <span style={{ color: '#c8e6ff', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                      <span style={{ color: DIM, fontSize: 10, flexShrink: 0 }}>{s.group || '—'}{s.offline ? ' · 离线' : ''}</span>
                    </div>
                  ))}
                </div>
                <div style={{ color: DIM, fontSize: 11, marginTop: 8, lineHeight: 1.7 }}>
                  要把某条流挂到通道上，用右侧每行的「映射视频流」下拉；若已有同名通道，可直接点上面的「补映射」。
                  要接入一条<b style={{ color: DIM2 }}>全新的通道</b>，用本栏右上角的「＋ 手工新增通道」。
                </div>
              </>
            )}
          </div>
        </div>

        {/* ── 右栏 ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', border: '1px solid rgba(0,150,220,0.15)', borderRadius: 6, overflow: 'hidden', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '9px 14px', background: 'rgba(0,30,70,0.5)', borderBottom: '1px solid rgba(0,150,220,0.15)', flexWrap: 'wrap' }}>
            {view === 'channels' ? (
              <span style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 600 }}>
                已接入通道与映射（{shown.length}{filter !== 'all' ? ` / ${local.length}` : ''}）
              </span>
            ) : (
              <span style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 600 }}>
                游离的视频流 · 未被任何通道使用（{freeStreamRows.length}
                {stat.dupStream ? ` · 其中 ${stat.dupStream} 条同点位已有通道` : ''}）
              </span>
            )}
            <span style={{ color: DIM, fontSize: 11, display: 'inline-flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              {view === 'channels' ? (
                <>
                  <span><span style={{ color: GREEN }}>●</span> 正常（启用+已绑流）</span>
                  <span><span style={{ color: AMBER }}>●</span> 未绑流（不联动摄像头）</span>
                  <span><span style={{ color: DIM }}>●</span> 已停用</span>
                  <span><Check size={12} color={GREEN} style={{ verticalAlign: 'middle' }} /> 算法有链 / <X size={12} color={RED} style={{ verticalAlign: 'middle' }} /> 算法无链</span>
                </>
              ) : (
                <span>这里的「游离」是<b style={{ color: DIM2 }}>流</b>维度：27 条流里没被任何通道用的；点左栏或上方 chip 可切回通道视图</span>
              )}
            </span>
          </div>

          {/* ── 流视图：把左栏那批"游离的流"放进同一套列表里，可筛可操作 ── */}
          {view === 'streams' ? (
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {freeStreamRows.length === 0 ? (
                <div style={{ color: DIM, fontSize: 12, padding: 30, textAlign: 'center' }}>没有游离的流（全部流都被通道使用了）</div>
              ) : (
                freeStreamRows.map(({ s, sameName, target }) => (
                  <div key={s.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(180px,1.5fr) 1fr 130px', gap: 10, padding: '10px 14px', borderBottom: '1px solid rgba(0,80,150,0.12)', alignItems: 'center' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <span style={{ color: s.offline ? DIM : GREEN, marginRight: 6 }}>●</span>{s.name}
                      </div>
                      <div style={{ color: DIM, fontSize: 10, marginTop: 2 }}>
                        {s.group || '—'} · {s.offline ? '离线' : '在线'} · streamId {String(s.id).slice(0, 8)}
                      </div>
                    </div>
                    <div style={{ fontSize: 11, color: DIM2, minWidth: 0 }}>
                      {sameName.length === 0 ? (
                        <span>无同名/近名通道</span>
                      ) : (
                        <>
                          <span style={{ color: AMBER }}>⚠ 同点位已有通道</span>：
                          {sameName.map(c => (
                            <div key={c.channelSipId} style={{ marginTop: 2 }}>
                              · {c.channelName}
                              <span style={{ color: DIM }}>
                                {c.streamId ? `（已绑流 ${streamById[c.streamId]?.name || '?'}）` : '（未绑流，可补映射）'}
                              </span>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      {target ? (
                        <button onClick={() => setStream(target, s.id)} style={btn(CYAN)}>补映射到「{target.channelName.slice(0, 8)}」</button>
                      ) : (
                        <span style={{ color: DIM, fontSize: 11 }}>
                          {sameName.length > 0 ? '该点位已有通道在用别的流' : '需先「＋ 手工新增通道」'}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
              <div style={{ padding: '10px 14px', color: DIM, fontSize: 11.5, lineHeight: 1.75, borderTop: '1px solid rgba(0,80,150,0.12)' }}>
                「游离」<b style={{ color: DIM2 }}>不等于有问题</b>：它们只是还没被任何通道引用。
                要接入：① 若这条流该替换某通道现在用的流 → 用通道行里的「映射视频流」下拉改；
                ② 若该点位已有通道、只是想补上 → 点「补映射」；③ 全新点位 → 先「＋ 手工新增通道」。
                <br />
                <span style={{ color: AMBER }}>⚠ 绑上流只是"能被引用"，不等于会被算法处理</span> ——
                还要看 ③ 算法链里有没有配这条通道（见上方"三层口径"）。
              </div>
            </div>
          ) : (
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {shown.length === 0 ? (
              <div style={{ color: DIM, fontSize: 12, padding: 30, textAlign: 'center' }}>
                {local.length === 0 ? '暂无已接入通道'
                  : filter === 'nomap'
                    ? '没有任何通道处于「未绑流」状态 —— 这是正常的（当前所有通道都已绑流）。'
                      + '你想看的"没被任何通道使用的流"是另一个维度，请点上方「游离的流」chip'
                    : '当前筛选下没有通道'}
              </div>
            ) : (
              shown.map(({ c, st, dangling, roiAlgos, badName, live, dead }) => {
                const dot = !c.enabled ? DIM : (c.streamId ? GREEN : AMBER)
                const suggested = streams.find(s => normName(s.name) === normName(c.channelName))
                return (
                  <div key={c.channelSipId} style={{ display: 'grid', gridTemplateColumns: 'minmax(150px,1.15fr) 1.15fr 1.3fr 96px 88px 66px', gap: 10, padding: '10px 14px', borderBottom: '1px solid rgba(0,80,150,0.12)', alignItems: 'center' }}>
                    {/* 名称 / 设备 / 接入时间 */}
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, boxShadow: c.enabled && c.streamId ? `0 0 6px ${GREEN}` : 'none', flexShrink: 0 }} />
                        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.channelName}</span>
                        <button onClick={() => renameChannel(c)} title="改显示名" style={{ background: 'transparent', border: 'none', color: DIM2, cursor: 'pointer', fontSize: 12, flexShrink: 0, padding: 0 }}><Pencil size={12} style={{ verticalAlign: 'middle' }} /></button>
                      </div>
                      <div style={{ color: DIM, fontSize: 10, marginTop: 2 }}>
                        {c.deviceName || '—'} · 接入于 {fmtCN(c.createdAt)}
                      </div>
                      <div style={{ marginTop: 3, display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                        {badName && <span title="名称含 ? / 为空，建议用名称旁的 ✎ 改成业务口径" style={{ fontSize: 10, color: AMBER, border: `1px solid ${AMBER}55`, borderRadius: 2, padding: '0 4px' }}>⚠ 名称待确认</span>}
                        {dangling && <span style={{ fontSize: 10, color: RED, border: `1px solid ${RED}55`, borderRadius: 2, padding: '0 4px' }}>⚠ 流引用失效</span>}
                        {roiAlgos.length > 0 && (
                          <span title={roiAlgos.join('、')} style={{ fontSize: 10, color: GREEN, border: `1px solid ${GREEN}55`, borderRadius: 2, padding: '0 4px' }}>
                            围栏 {roiAlgos.length} 个算法
                          </span>
                        )}

                      </div>
                    </div>

                    {/* 流映射 */}
                    <div>
                      <select value={c.streamId || ''} onChange={e => setStream(c, e.target.value || null)} style={inputStyle}>
                        <option value="">未映射（不联动摄像头）</option>
                        {streams.map(s => {
                          const owner = streamOwner[s.id]
                          const occupied = owner && owner !== c.channelName
                          return <option key={s.id} value={s.id}>{s.name}{occupied ? `（已被「${owner}」占用）` : ''}{suggested && suggested.id === s.id ? ' ✓推荐' : ''}</option>
                        })}
                      </select>
                      <div style={{ color: DIM, fontSize: 10, marginTop: 2 }}>
                        {st ? `${st.group || '—'} · ${st.offline ? '离线' : '在线'}` : (c.streamId ? '⚠ 该流已不在流清单里' : '草稿态：不出摄像头告警')}
                      </div>
                    </div>

                    {/* AI 类型 */}
                    <div>
                      <div style={{ color: DIM2, fontSize: 11, marginBottom: 4 }}>AI类型（{c.aiTypes.length}）</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 70, overflowY: 'auto', padding: 4, border: '1px solid rgba(0,120,200,0.18)', borderRadius: 3, background: 'rgba(0,20,60,0.3)' }}>
                        {aiTypes.map(t => {
                          const checked = c.aiTypes.includes(t)
                          return (
                            <label key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#c8e6ff', fontSize: 11, cursor: 'pointer', padding: '2px 5px', borderRadius: 2, background: checked ? 'rgba(0,170,255,0.12)' : 'transparent', border: `1px solid ${checked ? 'rgba(0,170,255,0.3)' : 'transparent'}` }}>
                              <input type="checkbox" checked={checked} onChange={() => setChannelAiTypes(c, checked ? c.aiTypes.filter(x => x !== t) : [...c.aiTypes, t])} style={{ cursor: 'pointer' }} />
                              {t}
                            </label>
                          )
                        })}
                      </div>
                    </div>

                    {/* 🔴 算法链路：声明的每个算法，现网到底有没有链在跑
                        （页面能看到的最接近"算法会不会真的跑"的判据；真正的链配置在各链自己的文件里） */}
                    <div title={'声明了 ' + (c.aiTypes || []).length + ' 个算法；现网有链在跑 ' + live.length + ' 个，无链 ' + dead.length + ' 个'}>
                      <div style={{ color: DIM2, fontSize: 11, marginBottom: 4 }}>算法链路</div>
                      {(c.aiTypes || []).length === 0 ? (
                        <span style={{ fontSize: 10.5, color: AMBER }}>未声明任何算法</span>
                      ) : (
                        <>
                          {live.length > 0 && (
                            <div style={{ fontSize: 10.5, color: GREEN, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              {live.map(a => <span key={a}>✓ {a}</span>)}
                            </div>
                          )}
                          {dead.length > 0 && (
                            <div style={{ fontSize: 10.5, color: RED, display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 2 }}>
                              {dead.map(a => <span key={a}>✕ {a}</span>)}
                            </div>
                          )}
                          <div style={{ fontSize: 10, color: DIM, marginTop: 3 }}>
                            {live.length > 0
                              ? (live.length === (c.aiTypes || []).length ? '全部算法有链' : `${dead.length} 个算法现网无链（永远不会产出）`)
                              : '⚠ 全部算法现网无链 → 这条通道不会产出任何记录'}
                          </div>
                        </>
                      )}
                    </div>

                    <button onClick={() => toggleEnabled(c)} style={btn(c.enabled ? GREEN : DIM)}>{c.enabled ? '启用中' : '已停用'}</button>
                    <button disabled={busyId === c.channelSipId} onClick={() => removeChannel(c)} style={btn(RED, busyId === c.channelSipId)}>移除</button>
                  </div>
                )
              })
            )}
          </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 10, color: DIM, fontSize: 11, flexShrink: 0, lineHeight: 1.7 }}>
        接入后通道进入轮询；<b style={{ color: DIM2 }}>映射视频流 + 启用</b> → 驾驶舱对应摄像头图标在 AI 推送时红闪告警（30 分钟内有效）。
        改动 30s 内生效，无需重启。<br />
        时间一律<b style={{ color: DIM2 }}>上海时（UTC+8）</b>。数据源：通道 <code style={{ color: '#9fd8ff' }}>/api/iot-channels</code> ·
        流 <code style={{ color: '#9fd8ff' }}>/api/streams</code> · 算法主数据 <code style={{ color: '#9fd8ff' }}>/api/ai-types</code> ·
        <b style={{ color: DIM2 }}>算法链状态</b> <code style={{ color: '#9fd8ff' }}>/api/ai-types/health</code>（near 7 天有数据即判"有链"）。<br />
        <AlertCircle size={13} color="#ff4444" style={{ verticalAlign: 'middle' }} /> <b style={{ color: AMBER }}>「算法链路」这一列只能回答"该算法有没有链在跑"，不能回答"这条通道有没有被链配进去"</b> ——
        后者在各链自己的配置文件里（堆头链 <code style={{ color: '#9fd8ff' }}>/soft/data/stack-chain/stack_config.json</code>、
        TASK 的 6 个任务、边缘链 <code style={{ color: '#9fd8ff' }}>/soft/data/edge-detect/edge_config.json</code>），
        <b>不在驾驶舱库里</b>。若要在本页直接看到"链侧到底配了哪些通道"，需要新增一个只读接口（已列为待办）。<br />
        接入来源 = 左侧「游离的流」+「＋ 手工新增通道」。（原先"从平台拉取远程通道再接入"的路径<b style={{ color: DIM2 }}>已永久移除</b>：
        平台侧通道清单接口恒返回 HTTP 200 + 空清单，该路径已无输入源。）
      </div>
    </div>
  )
}
