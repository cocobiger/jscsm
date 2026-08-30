import { useState, useEffect, useCallback, useMemo } from 'react'
import { apiFetch, authFetch } from '../../lib/apiFetch'
import { roleAtLeast, type CurrentUser } from '../../lib/auth'
import { IotChannelManage } from './IotChannelManage'
import { AI_ANALYSIS_TYPES as DEFAULT_AI_TYPES, type PushRule } from '../../context/DashboardContext'

const CYAN = '#00aaff'
const GREEN = '#00e676'
const AMBER = '#ffd740'
const RED = '#ff4444'
const PURPLE = '#b388ff'

// 通用按钮样式（模块级，供 IotArchivePage 与 PushRulePanel 共用）
const btn = (color: string): React.CSSProperties => ({
  padding: '5px 12px', fontSize: 12, borderRadius: 3, border: `1px solid ${color}55`,
  background: `${color}15`, color, cursor: 'pointer',
})

interface IotRecord {
  id: string
  createdAt: string
  time: string
  fullTime: string
  aiType: string
  aiConfidence: number
  level: number
  imageUrl: string | null
  channelName: string
  deviceName: string
}

interface IotChannel {
  channelName: string
  spid: string
  deviceId: string
  streamId: string
  lat: number | null
  lon: number | null
  total: number
  latestAt: string
  records: IotRecord[]
}

interface StatusChannel {
  spid: string
  name: string
  streamId: string
  alerting: boolean
  lastEventAt: string
  lastEventType: string
}

const inputStyle: React.CSSProperties = {
  padding: '6px 10px', background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.25)',
  borderRadius: 3, color: '#c8e6ff', fontSize: 13, outline: 'none',
}

const LEVEL_LABEL = ['', '注意', '轻度', '中度', '重度']
function confColor(c: number) { return c >= 0.7 ? RED : c >= 0.5 ? AMBER : c >= 0.3 ? '#ffd740' : '#64b5f6' }
function levelColor(l: number) { return ['', '#64b5f6', AMBER, '#ff7043', RED][l] || '#64b5f6' }

interface Props {
  user: CurrentUser
}

export function IotArchivePage({ user }: Props) {
  const [channels, setChannels] = useState<IotChannel[]>([])
  const [statusMap, setStatusMap] = useState<Record<string, StatusChannel>>({})
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState('')
  const [channelFilter, setChannelFilter] = useState<string>('')   // '' = 全部
  const [typeFilter, setTypeFilter] = useState<string>('')         // '' = 全部
  const [keyword, setKeyword] = useState('')
  const [busy, setBusy] = useState(false)
  const [page, setPage] = useState(1)
  const PAGE_SIZE = 10
  const [jump, setJump] = useState('')
  const [tab, setTab] = useState<'archive' | 'channels' | 'rules'>('archive')
  const isAdmin = roleAtLeast(user.role, 'admin')

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3000) }

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([
      apiFetch<{ channels: IotChannel[] }>('/api/iot-analysis/archive').catch(() => ({ channels: [] })),
      apiFetch<{ channels: StatusChannel[] }>('/api/iot-analysis/status').catch(() => ({ channels: [] })),
    ]).then(([arc, st]) => {
      setChannels(Array.isArray(arc?.channels) ? arc.channels : [])
      const m: Record<string, StatusChannel> = {}
      for (const c of (st?.channels || [])) m[c.spid] = c
      setStatusMap(m)
      setLoading(false)
    }).catch(() => { setLoading(false); flash('加载失败') })
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [load])

  // 扁平化记录（带上通道坐标），按通道名→时间倒序排列（满足「按通道分类排列」）
  const allRows = useMemo(() => {
    const rows: Array<IotRecord & { lat: number | null; lon: number | null; spid: string }> = []
    for (const ch of channels) {
      for (const rec of ch.records) {
        rows.push({ ...rec, lat: ch.lat, lon: ch.lon, spid: ch.spid })
      }
    }
    rows.sort((a, b) => {
      // 先按通道名分组，再按时间倒序
      if (a.channelName !== b.channelName) return a.channelName.localeCompare(b.channelName)
      return (b.createdAt || '').localeCompare(a.createdAt || '')
    })
    return rows
  }, [channels])

  const aiTypes = useMemo(() => Array.from(new Set(allRows.map(r => r.aiType).filter(Boolean))), [allRows])

  const filtered = useMemo(() => {
    let r = allRows
    if (channelFilter) r = r.filter(x => x.spid === channelFilter)
    if (typeFilter) r = r.filter(x => x.aiType === typeFilter)
    if (keyword.trim()) {
      const k = keyword.trim().toLowerCase()
      r = r.filter(x => `${x.channelName} ${x.aiType} ${x.deviceName}`.toLowerCase().includes(k))
    }
    return r
  }, [allRows, channelFilter, typeFilter, keyword])

  // 前端分页：每页 10 条
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(Math.max(1, page), totalPages)
  const pagedRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
  useEffect(() => { setPage(1) }, [channelFilter, typeFilter, keyword])

  const totalRecords = allRows.length
  const alertingCount = channels.filter(c => statusMap[c.spid]?.alerting).length

  // 导出 CSV
  const exportCsv = () => {
    const head = ['通道', 'AI类型', '置信度(%)', '等级', '时间', '坐标', '图片地址']
    const rows = filtered.map(r => [
      r.channelName, r.aiType, String(Math.round(r.aiConfidence * 100)),
      LEVEL_LABEL[r.level] || '', r.fullTime || r.time,
      (typeof r.lat === 'number' && typeof r.lon === 'number') ? `${r.lat},${r.lon}` : '',
      r.imageUrl || '',
    ])
    const csv = [head, ...rows].map(cols => cols.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `AI分析存档_${new Date().toISOString().slice(0, 10)}.csv`
    a.click(); URL.revokeObjectURL(url)
    flash('已导出 CSV')
  }

  // 模拟触发（演示：注入当前时间记录，使对应摄像头红闪；仅管理员）
  const simulate = async () => {
    const spid = channelFilter || channels[0]?.spid
    if (!spid) { flash('暂无通道'); return }
    setBusy(true)
    try {
      await apiFetch('/api/iot-analysis/simulate', { method: 'POST', body: JSON.stringify({ spid }) })
      flash('已模拟触发，驾驶舱对应摄像头将红闪 30 分钟')
      load()
    } catch (e: any) { flash('触发失败：' + (e?.error || e)) }
    finally { setBusy(false) }
  }

  // 模拟走完结案流程（验证 AI 置信度范围/均值变量）：注入 N 张 AI 图 → 聚合事件 → 推送 → 回执 → 结案 → 出 PDF
  const simulateClosure = async () => {
    const spid = channelFilter || channels[0]?.spid
    if (!spid) { flash('暂无通道'); return }
    setBusy(true)
    try {
      const data = await apiFetch('/api/iot-analysis/simulate-closure', { method: 'POST', body: JSON.stringify({ spid }) })
      const c = data.conf || {}
      const range = (c.min || c.max) ? `置信度 ${c.min}~${c.max}，均值 ${c.avg}（${c.count} 张）` : '置信度数据为空'
      flash(`已模拟结案流程：${data.imageCount} 张 AI 分析图，${range}，结案报告已生成`)
      if (data.reportUrl) {
        try {
          // 报告下载接口需鉴权；直接 window.open 不带 token 会被判未登录，
          // 故用 authFetch 带 token 取 blob 后本地打开
          const resp = await authFetch(data.reportUrl)
          if (resp.ok) {
            const blob = await resp.blob()
            const url = URL.createObjectURL(blob)
            window.open(url, '_blank')
            setTimeout(() => URL.revokeObjectURL(url), 60000)
          } else {
            flash('报告已生成，但打开失败（鉴权），可在对应 history 处重新下载')
          }
        } catch { flash('报告已生成，但打开失败，可在对应 history 处重新下载') }
      }
      load()
    } catch (e: any) { flash('模拟结案失败：' + (e?.error || e)) }
    finally { setBusy(false) }
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: 20, overflow: 'hidden' }}>
      {/* 子标签：存档记录 / 通道接入（仅 admin） */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexShrink: 0 }}>
        {([['archive', '存档记录'], ...(isAdmin ? [['channels', '通道接入'], ['rules', '事件研判逻辑']] : [])] as const).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key as 'archive' | 'channels' | 'rules')} style={{
            padding: '6px 18px', fontSize: 13, borderRadius: 3,
            border: `1px solid ${tab === key ? 'rgba(0,170,255,0.35)' : 'rgba(0,120,200,0.2)'}`,
            background: tab === key ? 'rgba(0,170,255,0.1)' : 'transparent',
            color: tab === key ? CYAN : '#5a8aaa', cursor: 'pointer', fontWeight: tab === key ? 600 : 400,
          }}>{label}</button>
        ))}
        <div style={{ flex: 1 }} />
        <span style={{ color: '#3a5a70', fontSize: 11, alignSelf: 'center' }}>IoTCloud 视频分析 · 与驾驶舱摄像头地理坐标触发对应</span>
      </div>

      {tab === 'archive' ? (
      <>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <div style={{ color: '#c8e6ff', fontSize: 16, fontWeight: 600 }}>AI分析存档</div>
          <div style={{ color: '#3a5a70', fontSize: 12, marginTop: 3 }}>IoTCloud 视频分析记录 · 按通道分类归档 · 与驾驶舱摄像头地理坐标触发对应</div>
          <div style={{ color: '#2e5a80', fontSize: 11, marginTop: 3 }}>本页为外部 IoTCloud 通道分析记录；自研算法推理记录见「AI 检测复检」「算法调参」</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} style={btn(CYAN)}>刷新</button>
          <button onClick={exportCsv} style={btn(GREEN)}>导出CSV</button>
          {roleAtLeast(user.role, 'admin') && (
            <>
              <button disabled={busy} onClick={simulate} style={btn(AMBER)}>{busy ? '触发中…' : '模拟触发'}</button>
              <button disabled={busy} onClick={simulateClosure} style={btn(PURPLE)} title="注入多张 AI 分析图并模拟走完 推送→回执→结案→出PDF 全流程，验证 AI 置信度范围/均值变量">模拟走完结案流程</button>
            </>
          )}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', top: 80, right: 40, zIndex: 3000, background: 'rgba(0,40,80,0.95)', border: '1px solid rgba(0,150,220,0.3)', borderRadius: 6, padding: '10px 20px', color: CYAN, fontSize: 13 }}>
          {toast}
        </div>
      )}

      {/* 通道概览卡片 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10, marginBottom: 14, flexShrink: 0 }}>
        {channels.map(ch => {
          const st = statusMap[ch.spid]
          const alerting = !!st?.alerting
          const active = channelFilter === ch.spid
          return (
            <div
              key={ch.spid}
              onClick={() => setChannelFilter(active ? '' : ch.spid)}
              style={{
                cursor: 'pointer', borderRadius: 5, padding: '10px 12px',
                border: `1px solid ${active ? CYAN + '88' : alerting ? 'rgba(255,68,68,0.4)' : 'rgba(0,120,200,0.22)'}`,
                background: active ? 'rgba(0,170,255,0.1)' : alerting ? 'rgba(255,68,68,0.05)' : 'rgba(0,20,60,0.35)',
                transition: 'all 0.15s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: alerting ? RED : '#00bcd4', boxShadow: alerting ? `0 0 8px ${RED}` : 'none' }} />
                <span style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ch.channelName}</span>
                {alerting && <span style={{ fontSize: 10, color: '#ff8080' }}>告警中</span>}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#5a8aaa', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
                <span>记录 <span style={{ color: '#c8e6ff' }}>{ch.total}</span></span>
                <span>{ch.latestAt ? ch.latestAt.slice(5) : '—'}</span>
              </div>
              <div style={{ color: '#3a5a70', fontSize: 10, marginTop: 3, fontFamily: "'JetBrains Mono', monospace" }}>
                {typeof ch.lat === 'number' ? `${ch.lat.toFixed(4)}, ${ch.lon?.toFixed(4)}` : '无坐标'}
              </div>
            </div>
          )
        })}
      </div>

      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexShrink: 0 }}>
        <select value={channelFilter} onChange={e => setChannelFilter(e.target.value)} style={inputStyle}>
          <option value="">全部通道</option>
          {channels.map(c => <option key={c.spid} value={c.spid}>{c.channelName}</option>)}
        </select>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={inputStyle}>
          <option value="">全部类型</option>
          {aiTypes.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <input value={keyword} onChange={e => setKeyword(e.target.value)} placeholder="搜索通道/类型/设备" style={{ ...inputStyle, width: 200 }} />
        <div style={{ flex: 1 }} />
        <span style={{ color: '#3a5a70', fontSize: 12 }}>
          共 <span style={{ color: '#c8e6ff', fontFamily: "'JetBrains Mono', monospace" }}>{filtered.length}</span> 条
          　通道 <span style={{ color: CYAN, fontFamily: "'JetBrains Mono', monospace" }}>{channels.length}</span>
          　<span style={{ color: alertingCount ? RED : '#3a5a70' }}>告警中 {alertingCount}</span>
        </span>
      </div>

      {/* 记录表格 */}
      <div style={{ flex: 1, overflow: 'auto', border: '1px solid rgba(0,150,220,0.15)', borderRadius: 6 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '64px 1.3fr 1.2fr 80px 70px 1.4fr 1.3fr', background: 'rgba(0,30,70,0.5)', padding: '8px 12px', fontSize: 11, color: '#3a5a70', fontWeight: 600, borderBottom: '1px solid rgba(0,150,220,0.15)', position: 'sticky', top: 0, zIndex: 2 }}>
          <span>缩略图</span><span>通道</span><span>AI类型</span><span>置信度</span><span>等级</span><span>时间</span><span>坐标</span>
        </div>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, color: '#3a5a70', fontSize: 13 }}>加载中…</div>
        ) : filtered.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, color: '#3a5a70', fontSize: 13 }}>暂无 AI 分析记录</div>
        ) : (
          pagedRows.map(r => (
            <div key={r.id} style={{
              display: 'grid', gridTemplateColumns: '64px 1.3fr 1.2fr 80px 70px 1.4fr 1.3fr',
              padding: '6px 12px', borderBottom: '1px solid rgba(0,80,150,0.12)',
              alignItems: 'center', fontSize: 12,
            }}>
              <div style={{ width: 52, height: 38, background: '#020a18', borderRadius: 3, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {r.imageUrl ? (
                  <img src={r.imageUrl} alt={r.aiType} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                ) : <span style={{ color: '#2a4a60', fontSize: 9 }}>无图</span>}
              </div>
              <span style={{ color: '#c8e6ff' }}>{r.channelName}</span>
              <span style={{ color: '#9ad6f0' }}>{r.aiType || '—'}</span>
              <span style={{ color: confColor(r.aiConfidence), fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>{Math.round(r.aiConfidence * 100)}%</span>
              <span style={{ padding: '1px 6px', borderRadius: 2, background: levelColor(r.level) + '22', color: levelColor(r.level), fontSize: 11, width: 'fit-content' }}>{LEVEL_LABEL[r.level] || '—'}</span>
              <span style={{ color: '#5a8aaa', fontFamily: "'JetBrains Mono', monospace" }}>{r.fullTime ? r.fullTime.slice(5) : (r.time || '—')}</span>
              <span style={{ color: '#3a5a70', fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
                {typeof r.lat === 'number' && typeof r.lon === 'number' ? `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}` : '—'}
              </span>
            </div>
          ))
        )}
      </div>

      {/* 分页栏 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, flexShrink: 0 }}>
        <span style={{ color: '#3a5a70', fontSize: 12 }}>
          第 <span style={{ color: '#c8e6ff', fontFamily: "'JetBrains Mono', monospace" }}>{safePage}</span> / {totalPages} 页 · 每页 {PAGE_SIZE} 条 · 共 {filtered.length} 条
        </span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} style={btn(CYAN)}>上一页</button>
          <input
            value={jump}
            onChange={e => setJump(e.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const n = parseInt(jump)
                if (n >= 1 && n <= totalPages) setPage(n)
                setJump('')
              }
            }}
            placeholder="跳页"
            style={{ ...inputStyle, width: 56, fontSize: 12 }}
          />
          <button
            disabled={!jump}
            onClick={() => {
              const n = parseInt(jump)
              if (n >= 1 && n <= totalPages) setPage(n)
              setJump('')
            }}
            style={btn(CYAN)}
          >跳转</button>
          <button disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)} style={btn(CYAN)}>下一页</button>
        </div>
      </div>

      {/* Footer hint */}
      <div style={{ marginTop: 10, color: '#3a5a70', fontSize: 11, flexShrink: 0 }}>
        通道产生 AI 分析推送时，驾驶舱对应摄像头图标将红闪告警（30 分钟内有效）；点击上方通道卡片可筛选该通道记录。
      </div>
      </>
      ) : (
        tab === 'channels' ? <IotChannelManage user={user} /> : <PushRulePanel user={user} />
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────
// AI 分析事件研判逻辑管理（降噪配置面板）
// ────────────────────────────────────────────────────────────
function PushRulePanel({ user }: { user: CurrentUser }) {
  const isAdmin = roleAtLeast(user.role, 'admin')
  const [rules, setRules] = useState<PushRule[]>([])
  const [channels, setChannels] = useState<Array<{ channelSipId: string; channelName: string }>>([])
  const [aiTypes, setAiTypes] = useState<string[]>([...DEFAULT_AI_TYPES])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState('')
  const [editing, setEditing] = useState<string | null>(null)   // 正在编辑的研判 id；null = 新建
  const [formOpen, setFormOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<{
    name: string; channelSipId: string; aiTypes: string[]; timeWindowHours: number; threshold: number; enabled: boolean
  }>({ name: '', channelSipId: '', aiTypes: [DEFAULT_AI_TYPES[0]], timeWindowHours: 24, threshold: 20, enabled: true })
  const [newType, setNewType] = useState('')

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3000) }

  const loadAiTypes = useCallback(() => {
    apiFetch<Array<{ name: string }>>('/api/ai-types')
      .then(d => { if (Array.isArray(d) && d.length > 0) setAiTypes(d.map(x => x.name)) })
      .catch(() => {})
  }, [])

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([
      apiFetch<PushRule[]>('/api/push-rules').catch(() => []),
      apiFetch<Array<{ channelSipId: string; channelName: string }>>('/api/iot-channels').catch(() => []),
      apiFetch<Array<{ name: string }>>('/api/ai-types').catch(() => []),
    ]).then(([rs, chs, ats]) => {
      setRules(Array.isArray(rs) ? rs : [])
      setChannels(Array.isArray(chs) ? chs : [])
      if (Array.isArray(ats) && ats.length > 0) setAiTypes(ats.map(x => x.name))
      setLoading(false)
    }).catch(() => { setLoading(false); flash('加载失败') })
  }, [])

  useEffect(() => { load() }, [load])

  // spid → 映射名
  const chNameMap = useMemo(() => {
    const m: Record<string, string> = {}
    for (const c of channels) m[c.channelSipId] = c.channelName
    return m
  }, [channels])

  const openCreate = () => {
    setEditing(null)
    setForm({ name: '', channelSipId: '', aiTypes: aiTypes.slice(0, 1), timeWindowHours: 24, threshold: 20, enabled: true })
    setFormOpen(true)
  }
  const openEdit = (r: PushRule) => {
    setEditing(r.id)
    setForm({
      name: r.name,
      channelSipId: r.channelSipId || '',
      aiTypes: r.aiTypes?.length ? r.aiTypes : aiTypes.slice(0, 1),
      timeWindowHours: r.timeWindowHours,
      threshold: r.threshold,
      enabled: r.enabled,
    })
    setFormOpen(true)
  }
  const closeForm = () => { setFormOpen(false); setEditing(null) }

  const save = async () => {
    console.log('[PushRule] save clicked', { form, editing })
    if (!form.name.trim()) { flash('请填写研判名称'); return }
    if (!Array.isArray(form.aiTypes) || form.aiTypes.length === 0) { flash('请至少选择一种 AI 类型'); return }
    setBusy(true)
    try {
      const body = {
        name: form.name.trim(),
        channelSipId: form.channelSipId || null,
        aiTypes: form.aiTypes,
        timeWindowHours: Number(form.timeWindowHours) || 24,
        threshold: Number(form.threshold) || 20,
        enabled: form.enabled,
      }
      console.log('[PushRule] sending body', body)
      if (editing) {
        const res = await apiFetch(`/api/push-rules/${editing}`, { method: 'PATCH', body: JSON.stringify(body) })
        console.log('[PushRule] PATCH response', res)
        flash('已更新研判')
      } else {
        const res = await apiFetch('/api/push-rules', { method: 'POST', body: JSON.stringify(body) })
        console.log('[PushRule] POST response', res)
        flash('已新增研判')
      }
      closeForm()
      load()
    } catch (e: any) { console.error('[PushRule] save error', e); flash('保存失败：' + (e?.error || e)) }
    finally { setBusy(false) }
  }
  const remove = async (id: string) => {
    if (!confirm('确定删除该事件研判逻辑？')) return
    setBusy(true)
    try {
      await apiFetch(`/api/push-rules/${id}`, { method: 'DELETE' })
      flash('已删除研判')
      load()
    } catch (e: any) { flash('删除失败：' + (e?.error || e)) }
    finally { setBusy(false) }
  }
  const toggleEnabled = async (r: PushRule) => {
    try {
      await apiFetch(`/api/push-rules/${r.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !r.enabled }) })
      load()
    } catch { flash('操作失败') }
  }

  // AI 类型管理
  const refreshAiTypes = async () => {
    try {
      const d = await apiFetch<Array<{ name: string }>>('/api/ai-types').catch(() => [])
      if (Array.isArray(d) && d.length > 0) setAiTypes(d.map(x => x.name))
    } catch {}
  }
  const addAiType = async () => {
    const n = newType.trim()
    if (!n) return
    setBusy(true)
    try {
      await apiFetch('/api/ai-types', { method: 'POST', body: JSON.stringify({ name: n }) })
      setNewType('')
      await refreshAiTypes()
      flash('已新增 AI 类型')
    } catch (e: any) { flash('新增失败：' + (e?.error || e)) }
    finally { setBusy(false) }
  }
  const delAiType = async (name: string) => {
    if (!confirm(`确定删除 AI 类型「${name}」？\n若该类型仍被启用研判或未处理告警引用，将无法删除。`)) return
    setBusy(true)
    try {
      await apiFetch(`/api/ai-types/${encodeURIComponent(name)}`, { method: 'DELETE' })
      await refreshAiTypes()
      // 若当前 form 选中了被删类型，也同步剔除
      setForm(f => ({ ...f, aiTypes: f.aiTypes.filter(x => x !== name) }))
      flash('已删除 AI 类型')
    } catch (e: any) { flash(e?.error || '删除失败') }
    finally { setBusy(false) }
  }

  const ruleCount = rules.length
  const enabledCount = rules.filter(r => r.enabled).length

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexShrink: 0 }}>
        <div>
          <div style={{ color: '#c8e6ff', fontSize: 16, fontWeight: 600 }}>AI分析事件研判逻辑</div>
          <div style={{ color: '#3a5a70', fontSize: 12, marginTop: 3 }}>
            某通道 + 某 AI 类型在 N 小时内超过 M 条 → 前端「告警信息」仅推送 1 条聚合告警（原始图片仍完整保留在存档）
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} style={btn(CYAN)}>刷新</button>
          {isAdmin && <button disabled={busy} onClick={openCreate} style={btn(GREEN)}>{busy ? '处理中…' : '新增研判'}</button>}
        </div>
      </div>

      {toast && (
        <div style={{ position: 'fixed', top: 80, right: 40, zIndex: 3000, background: 'rgba(0,40,80,0.95)', border: '1px solid rgba(0,150,220,0.3)', borderRadius: 6, padding: '10px 20px', color: CYAN, fontSize: 13 }}>
          {toast}
        </div>
      )}

      {/* AI 类型管理（仅 admin） */}
      {isAdmin && (
        <div style={{ flexShrink: 0, marginBottom: 12, padding: 10, border: '1px solid rgba(0,120,200,0.15)', borderRadius: 6, background: 'rgba(0,20,60,0.35)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ color: '#5a8aaa', fontSize: 12 }}>AI 类型管理（可自由增删）</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            {aiTypes.map(t => (
              <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 3, background: 'rgba(0,170,255,0.1)', border: '1px solid rgba(0,170,255,0.25)', color: '#c8e6ff', fontSize: 12 }}>
                {t}
                <button type="button" disabled={busy} onClick={() => delAiType(t)} style={{ padding: 0, border: 'none', background: 'transparent', color: '#ff8080', cursor: busy ? 'wait' : 'pointer', fontSize: 13, lineHeight: 1 }}>×</button>
              </span>
            ))}
            <input value={newType} onChange={e => setNewType(e.target.value)} onKeyDown={e => e.key === 'Enter' && addAiType()} placeholder="新增 AI 类型…" style={{ ...inputStyle, width: 140, marginLeft: 4 }} />
            <button type="button" disabled={busy} onClick={addAiType} style={{ ...btn(GREEN), padding: '4px 10px' }}>添加</button>
          </div>
        </div>
      )}

      <span style={{ color: '#3a5a70', fontSize: 12, marginBottom: 8, flexShrink: 0 }}>
        共 <span style={{ color: CYAN, fontFamily: "'JetBrains Mono', monospace" }}>{ruleCount}</span> 条研判 · 启用 <span style={{ color: GREEN, fontFamily: "'JetBrains Mono', monospace" }}>{enabledCount}</span> 条
      </span>

      {/* 研判列表 */}
      <div style={{ flex: 1, overflow: 'auto', border: '1px solid rgba(0,150,220,0.15)', borderRadius: 6 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1.4fr 1.2fr 90px 90px 70px 1fr', background: 'rgba(0,30,70,0.5)', padding: '8px 12px', fontSize: 11, color: '#3a5a70', fontWeight: 600, borderBottom: '1px solid rgba(0,150,220,0.15)', position: 'sticky', top: 0, zIndex: 2 }}>
          <span>研判名称</span><span>通道</span><span>AI类型</span><span>时间窗(h)</span><span>阈值(条)</span><span>启用</span><span>操作</span>
        </div>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, color: '#3a5a70', fontSize: 13 }}>加载中…</div>
        ) : rules.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, color: '#3a5a70', fontSize: 13 }}>暂无事件研判逻辑</div>
        ) : (
          rules.map(r => (
            <div key={r.id} style={{
              display: 'grid', gridTemplateColumns: '1.6fr 1.4fr 1.2fr 90px 90px 70px 1fr',
              padding: '8px 12px', borderBottom: '1px solid rgba(0,80,150,0.12)', alignItems: 'center', fontSize: 12,
            }}>
              <span style={{ color: '#c8e6ff', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
              <span style={{ color: '#9ad6f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.channelSipId ? (chNameMap[r.channelSipId] || r.channelSipId) : '全部通道'}</span>
              <span style={{ color: '#9ad6f0' }}>{r.aiTypes.join('、')}</span>
              <span style={{ color: '#5a8aaa', fontFamily: "'JetBrains Mono', monospace" }}>{r.timeWindowHours}</span>
              <span style={{ color: '#5a8aaa', fontFamily: "'JetBrains Mono', monospace" }}>{r.threshold}</span>
              <span>
                <button onClick={() => toggleEnabled(r)} disabled={!isAdmin} style={{
                  padding: '2px 8px', borderRadius: 10, fontSize: 11, cursor: isAdmin ? 'pointer' : 'default',
                  border: `1px solid ${r.enabled ? 'rgba(0,230,118,0.4)' : 'rgba(120,120,120,0.3)'}`,
                  background: r.enabled ? 'rgba(0,230,118,0.12)' : 'rgba(80,80,80,0.12)',
                  color: r.enabled ? GREEN : '#7a8a99',
                }}>{r.enabled ? '启用' : '禁用'}</button>
              </span>
              <span style={{ display: 'flex', gap: 6 }}>
                {isAdmin && <button onClick={() => openEdit(r)} style={{ ...btn(CYAN), padding: '3px 10px' }}>编辑</button>}
                {isAdmin && <button onClick={() => remove(r.id)} style={{ ...btn(RED), padding: '3px 10px' }}>删除</button>}
              </span>
            </div>
          ))
        )}
      </div>

      {/* 新增/编辑表单 */}
      {formOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(2,8,20,0.8)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={e => { if (e.target === e.currentTarget) closeForm() }}>
          <div style={{ width: 520, maxWidth: '92vw', background: 'linear-gradient(180deg,#040e25,#030c1e)', border: '1px solid rgba(0,150,220,0.3)', borderRadius: 6, padding: 20, boxShadow: '0 0 40px rgba(0,120,255,0.12)' }}>
            <div style={{ color: '#c8e6ff', fontSize: 15, fontWeight: 600, marginBottom: 16 }}>{editing ? '编辑事件研判逻辑' : '新增事件研判逻辑'}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Field label="研判名称">
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="如：龙泗路堆头未覆盖降噪" style={inputStyle} />
              </Field>
              <Field label="通道">
                <select value={form.channelSipId} onChange={e => setForm(f => ({ ...f, channelSipId: e.target.value }))} style={inputStyle}>
                  <option value="">全部通道（通配）</option>
                  {channels.map(c => <option key={c.channelSipId} value={c.channelSipId}>{c.channelName}</option>)}
                </select>
              </Field>
              <Field label="AI类型（多选）">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, maxHeight: 140, overflowY: 'auto', padding: 8, border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3, background: 'rgba(0,20,60,0.4)' }}>
                  {aiTypes.map(t => {
                    const checked = form.aiTypes.includes(t)
                    return (
                      <label key={t} style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6, color: '#c8e6ff', fontSize: 12, cursor: 'pointer',
                        padding: '3px 8px', borderRadius: 3,
                        background: checked ? 'rgba(0,170,255,0.15)' : 'transparent',
                        border: `1px solid ${checked ? 'rgba(0,170,255,0.4)' : 'rgba(0,120,200,0.2)'}`,
                      }}>
                        <input type="checkbox" checked={checked} onChange={() => setForm(f => {
                          const arr = f.aiTypes.includes(t) ? f.aiTypes.filter(x => x !== t) : [...f.aiTypes, t]
                          return { ...f, aiTypes: arr }
                        })} style={{ cursor: 'pointer' }} />
                        {t}
                      </label>
                    )
                  })}
                </div>
              </Field>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <Field label="时间窗（小时）">
                  <input type="number" min={1} value={form.timeWindowHours} onChange={e => setForm(f => ({ ...f, timeWindowHours: Number(e.target.value) || 24 }))} style={inputStyle} />
                </Field>
                <Field label="阈值（条）">
                  <input type="number" min={1} value={form.threshold} onChange={e => setForm(f => ({ ...f, threshold: Number(e.target.value) || 20 }))} style={inputStyle} />
                </Field>
              </div>
              <Field label="启用">
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: '#5a8aaa', fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} />
                  {form.enabled ? '启用（参与聚合降噪）' : '禁用（不生效）'}
                </label>
              </Field>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
              <button type="button" onClick={closeForm} style={btn('#5a8aaa')}>取消</button>
              <button type="button" disabled={busy} onClick={save} style={btn(GREEN)}>{busy ? '保存中…' : '保存'}</button>
            </div>
            <div style={{ marginTop: 12, color: '#3a5a70', fontSize: 11, lineHeight: 1.6 }}>
              说明：当该通道 + 选中的任一 AI 类型在「时间窗」内产生的 AI 分析记录 ≥「阈值」条时，前端「告警信息」把该类型折叠为 1 条聚合告警；每个 AI 类型独立计数。标记该聚合告警会把组内全部原始记录标记为已处理。原始图片始终保留在「AI分析存档」。
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{ color: '#5a8aaa', fontSize: 12 }}>{label}</span>
      {children}
    </label>
  )
}
