import { useState, useEffect, useCallback } from 'react'
import type { AlertItem } from './AlertPanel'
import { apiFetch, authFetch } from '../lib/apiFetch'
import type { AggregateWarning } from '../context/DashboardContext'

const LEVEL_COLORS: Record<number, { bg: string; border: string; text: string; label: string }> = {
  1: { bg: 'rgba(33,150,243,0.1)', border: 'rgba(33,150,243,0.4)', text: '#64b5f6', label: '注意' },
  2: { bg: 'rgba(255,215,64,0.1)', border: 'rgba(255,215,64,0.4)', text: '#ffd740', label: '轻度' },
  3: { bg: 'rgba(255,112,67,0.1)', border: 'rgba(255,112,67,0.4)', text: '#ff7043', label: '中度' },
  4: { bg: 'rgba(244,67,54,0.12)', border: 'rgba(244,67,54,0.5)', text: '#ff4444', label: '重度' },
}

const CYAN = '#00aaff'
const GREEN = '#00e676'

// 聚合事件展开后最多展示的图片数（其余仅以数字统计，降低前端图片加载负担）
const MAX_AGG_IMAGES = 10

interface Props {
  alerts: AlertItem[]  // 内存中的告警（含 AI识别等非采集类），作为补充
  onClose: () => void
}

const PLATE_TYPES = ['道路扬尘 AI识别', '违规车辆 AI识别']
const DUST_AI_TYPES = ['扬尘超标 AI识别']
function isPlateType(type: string) { return PLATE_TYPES.includes(type) }
function isDustAiType(type: string) { return DUST_AI_TYPES.includes(type) }

// 预警类型 → 等级
const levelOf = (wt: string): 1 | 2 | 3 | 4 => wt === 'cross' ? 3 : wt === 'growth5h' ? 2 : wt === 'fixed' ? 2 : 1

// 后端预警记录（含持久化的处理状态）
interface WarnRecord {
  id: string; createdAt: string; monitorTime?: string; pointName?: string
  code?: string; name?: string; value?: number; unit?: string; standardValue?: number
  warningType: string; warningLabel?: string; reason?: string
  status?: string; handledAt?: string; handledBy?: string
  lat?: number; lon?: number
}

// 统一的展示行结构
interface Row {
  id: string; fullTime: string; sortKey: string
  level: 1 | 2 | 3 | 4; type: string; location: string
  value: string; standard: string; isPlate: boolean
  handled: boolean; handledAt?: string; handledBy?: string
  backend: boolean  // 是否后端记录（可持久化处理）
}

// 聚合告警行（命中推送规则后折叠为 1 条）
interface AggRow {
  kind: 'aggregate'
  id: string; fullTime: string; sortKey: string
  level: number; handled: boolean; backend: boolean
  agg: AggregateWarning
}

function fmtFull(iso?: string, monitorTime?: string): string {
  if (iso) {
    const d = new Date(iso)
    if (!isNaN(d.getTime())) {
      const mm = String(d.getMonth() + 1).padStart(2, '0')
      const dd = String(d.getDate()).padStart(2, '0')
      return `${mm}-${dd} ${d.toTimeString().slice(0, 8)}`
    }
  }
  return (monitorTime || '').slice(5) || '—'
}

const LEVEL_FILTERS = [
  { key: 0, label: '全部等级' },
  { key: 4, label: '重度' },
  { key: 3, label: '中度' },
  { key: 2, label: '轻度' },
  { key: 1, label: '注意' },
]

export function AlertHistoryModal({ alerts, onClose }: Props) {
  const [tab, setTab] = useState<'pending' | 'handled'>('pending')
  const [records, setRecords] = useState<WarnRecord[]>([])
  const [aggregates, setAggregates] = useState<AggregateWarning[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [levelFilter, setLevelFilter] = useState(0)
  const [keyword, setKeyword] = useState('')
  const [busy, setBusy] = useState(false)

  // 拉后端全量历史（aggregate=1：命中推送规则的同组折叠为聚合告警）
  const load = useCallback(() => {
    setLoading(true)
    authFetch('/api/warnings?limit=500&aggregate=1')
      .then(r => r.ok ? r.json() : [])
      .then((d: any[]) => {
        setRecords(Array.isArray(d) ? d.filter(x => !x.isAggregate) : [])
        setAggregates(Array.isArray(d) ? d.filter((x: any): x is AggregateWarning => x.isAggregate) : [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])
  useEffect(() => { load() }, [load])

  // 后端预警 → Row
  const backendRows: Row[] = records.map(w => ({
    id: w.id,
    fullTime: fmtFull(w.createdAt, w.monitorTime),
    sortKey: w.createdAt || w.monitorTime || '',
    level: levelOf(w.warningType),
    type: `${w.name || w.code || ''} ${w.warningLabel || ''}`.trim(),
    location: w.pointName || '市监测站',
    value: `${w.value ?? ''}${w.unit ? ' ' + w.unit : ''}`,
    standard: w.standardValue != null ? `${w.standardValue}${w.unit ? ' ' + w.unit : ''}` : (w.reason || '—'),
    isPlate: false,
    handled: w.status === 'handled',
    handledAt: w.handledAt ? fmtFull(w.handledAt) : undefined,
    handledBy: w.handledBy,
    backend: true,
  }))

  // 内存中的非后端告警（AI识别等），用 warn- 前缀去重，避免和后端重复
  const backendIdSet = new Set(records.map(w => `warn-${w.id}`))
  const memRows: Row[] = alerts
    .filter(a => !backendIdSet.has(a.id) && !a.id.startsWith('warn-'))
    .map(a => ({
      id: a.id,
      fullTime: a.fullTime || a.time,
      sortKey: a.fullTime || a.time,
      level: a.level,
      type: a.type,
      location: a.location,
      value: a.value,
      standard: a.standard,
      isPlate: isPlateType(a.type) || isDustAiType(a.type),
      handled: false,
      backend: false,
    }))

  // 聚合告警 → AggRow（命中推送规则后折叠为 1 条）
  const aggRows: AggRow[] = aggregates.map(a => ({
    kind: 'aggregate' as const,
    id: `${a.ruleId}:${a.channelSipId ?? ''}:${a.aiType}`,
    fullTime: fmtFull(a.latestTime),
    sortKey: a.latestTime || '',
    level: (a.maxLevel as 1 | 2 | 3 | 4) || 1,
    handled: false,
    backend: true,
    agg: a,
  }))

  let allRows = [...backendRows, ...memRows, ...aggRows].sort((a, b) => b.sortKey.localeCompare(a.sortKey))
  // 筛选
  if (levelFilter) allRows = allRows.filter(r => r.level === levelFilter)
  if (keyword.trim()) {
    const k = keyword.trim().toLowerCase()
    allRows = allRows.filter(r => {
      if (r.kind === 'aggregate') return `${r.agg.channelName} ${r.agg.aiType}`.toLowerCase().includes(k)
      return `${r.type} ${r.location} ${r.value}`.toLowerCase().includes(k)
    })
  }
  const pending = allRows.filter(r => !r.handled)
  const handledList = allRows.filter(r => r.handled)
  const displayList = tab === 'pending' ? pending : handledList

  // 展开/收起聚合行的 drill-down
  const toggleExpand = (id: string) => setExpanded(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  // 聚合告警「标记处理」：把组内全部原始记录标为已处理（方案 X）
  const handleGroup = async (row: AggRow) => {
    setBusy(true)
    try {
      await authFetch('/api/warnings/handle-group', {
        method: 'POST',
        body: JSON.stringify({ memberIds: row.agg.memberIds, handledBy: '值守人员' }),
      })
      load()
    } catch { /* 静默 */ }
    finally { setBusy(false) }
  }

  // 标记处理 / 撤销（后端记录持久化；内存告警仅本地）
  const setStatus = async (row: Row, handled: boolean) => {
    if (!row.backend) return  // 内存告警（AI识别）无后端记录，跳过
    setBusy(true)
    try {
      await apiFetch(`/api/warnings/${row.id}`, { method: 'PATCH', body: JSON.stringify({ status: handled ? 'handled' : 'pending' }) })
      load()
    } catch { /* 静默 */ }
    finally { setBusy(false) }
  }
  const handleAll = async () => {
    setBusy(true)
    try { await apiFetch('/api/warnings/handle-all', { method: 'POST', body: JSON.stringify({}) }); load() }
    catch {}
    finally { setBusy(false) }
  }

  // 导出 CSV
  const exportCsv = () => {
    const head = ['时间', '等级', '类型', '点位', '数值', '标准/限值', '状态', '处理时间']
    const lvLabel = (l: number) => LEVEL_COLORS[l]?.label || ''
    const rows = allRows.map(r => {
      if (r.kind === 'aggregate') {
        return [r.fullTime, lvLabel(r.level), `${r.agg.channelName} 检测到 ${r.agg.aiType} 频发（聚合 ${r.agg.count} 条）`, `${r.agg.windowHours}h 时间窗`, '', '', '未处理', '']
      }
      return [r.fullTime, lvLabel(r.level), r.type, r.location, r.value, r.standard, r.handled ? '已处理' : '未处理', r.handledAt || '']
    })
    const csv = [head, ...rows].map(cols => cols.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })  // BOM 防 Excel 乱码
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `告警记录_${new Date().toISOString().slice(0, 10)}.csv`
    a.click(); URL.revokeObjectURL(url)
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(2,8,20,0.85)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        width: 920, maxWidth: '95vw', maxHeight: '88vh',
        background: 'linear-gradient(180deg, #040e25 0%, #030c1e 100%)',
        border: '1px solid rgba(255,68,68,0.25)', borderRadius: 6,
        boxShadow: '0 0 60px rgba(255,50,50,0.12), 0 0 20px rgba(0,120,255,0.1)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          height: 52, padding: '0 20px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderBottom: '1px solid rgba(255,68,68,0.2)',
          background: 'linear-gradient(90deg, rgba(255,68,68,0.07), transparent)', flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 3, height: 16, background: '#ff4444', borderRadius: 1 }} />
            <span style={{ color: '#c8e6ff', fontSize: 15, fontWeight: 600, letterSpacing: '0.05em' }}>告警记录</span>
            <span style={{ color: '#3a5a70', fontSize: 12 }}>（按时间倒序 · 实时同步后端）</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ color: '#3a5a70', fontSize: 12 }}>
              未处理 <span style={{ color: '#ff7043', fontFamily: "'JetBrains Mono', monospace" }}>{pending.length}</span>
              　已处理 <span style={{ color: GREEN, fontFamily: "'JetBrains Mono', monospace" }}>{handledList.length}</span>
            </span>
            <button onClick={onClose} style={{
              width: 28, height: 28, borderRadius: 4,
              border: '1px solid rgba(255,68,68,0.25)', background: 'rgba(255,68,68,0.1)',
              color: '#ff8080', cursor: 'pointer', fontSize: 14,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>✕</button>
          </div>
        </div>

        {/* Toolbar: tabs + filters */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px 0', borderBottom: '1px solid rgba(0,80,150,0.2)', flexShrink: 0, flexWrap: 'wrap' }}>
          {([['pending', '未处理'], ['handled', '已处理']] as const).map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)} style={{
              padding: '6px 18px', fontSize: 13, borderRadius: '3px 3px 0 0',
              border: `1px solid ${tab === key ? 'rgba(0,170,255,0.3)' : 'transparent'}`,
              borderBottom: tab === key ? '1px solid #030c1e' : '1px solid transparent',
              background: tab === key ? 'rgba(0,170,255,0.08)' : 'transparent',
              color: tab === key ? CYAN : '#5a8aaa', cursor: 'pointer',
              fontWeight: tab === key ? 600 : 400, marginBottom: -1,
            }}>
              {label}
              <span style={{ marginLeft: 6, fontSize: 11, color: tab === key ? (key === 'pending' ? '#ff7043' : GREEN) : '#3a5a70', fontFamily: "'JetBrains Mono', monospace" }}>
                {key === 'pending' ? pending.length : handledList.length}
              </span>
            </button>
          ))}
          <div style={{ flex: 1 }} />
          {/* 等级筛选 */}
          <select value={levelFilter} onChange={e => setLevelFilter(Number(e.target.value))} style={{
            padding: '5px 8px', background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.25)',
            borderRadius: 3, color: '#c8e6ff', fontSize: 12, outline: 'none', marginBottom: 6,
          }}>
            {LEVEL_FILTERS.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
          {/* 搜索 */}
          <input value={keyword} onChange={e => setKeyword(e.target.value)} placeholder="搜索类型/点位/数值" style={{
            padding: '5px 10px', width: 160, background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.25)',
            borderRadius: 3, color: '#c8e6ff', fontSize: 12, outline: 'none', marginBottom: 6,
          }} />
          <button onClick={exportCsv} style={{
            padding: '5px 12px', fontSize: 12, borderRadius: 3, marginBottom: 6,
            border: '1px solid rgba(0,170,255,0.3)', background: 'rgba(0,170,255,0.08)', color: CYAN, cursor: 'pointer',
          }}>导出CSV</button>
        </div>

        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none', padding: '8px 16px 12px' }}>
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, color: '#3a5a70', fontSize: 13 }}>加载中…</div>
          ) : displayList.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, color: '#3a5a70', fontSize: 13 }}>
              暂无{tab === 'pending' ? '未处理' : '已处理'}告警
            </div>
          ) : (
            displayList.map((row, idx) => {
              // ── 聚合告警行（命中推送规则）──
              if (row.kind === 'aggregate') {
                const a = row.agg
                const style = LEVEL_COLORS[row.level] || LEVEL_COLORS[1]
                const isOpen = expanded.has(row.id)
                // 仅展示前 MAX_AGG_IMAGES 张图片；其余以数字统计（降低前端图片加载负担）
                const shownMembers = [...(a.members || [])]
                  .sort((x, y) => (y.createdAt || '').localeCompare(x.createdAt || ''))
                  .slice(0, MAX_AGG_IMAGES)
                const hiddenCount = (a.members?.length || 0) - shownMembers.length
                return (
                  <div key={row.id} style={{
                    margin: '4px 0', borderRadius: 4,
                    background: 'rgba(0,40,90,0.18)',
                    border: `1px solid ${style.border}`,
                    overflow: 'hidden',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 12px' }}>
                      <span style={{ width: 22, height: 22, borderRadius: 3, flexShrink: 0, background: 'rgba(0,50,100,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3a5a70', fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}>{idx + 1}</span>
                      <span style={{ padding: '2px 7px', borderRadius: 2, flexShrink: 0, background: style.border, color: style.text, fontSize: 11, fontWeight: 600 }}>{style.label}</span>
                      <span style={{ padding: '1px 6px', borderRadius: 2, flexShrink: 0, border: '1px solid rgba(0,170,255,0.3)', color: CYAN, fontSize: 10 }}>聚合</span>
                      <span style={{ color: '#5a8aaa', fontSize: 11, flexShrink: 0, fontFamily: "'JetBrains Mono', monospace", minWidth: 96 }}>{row.fullTime}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 600 }}>{a.channelName} 检测到 {a.aiType} 频发</div>
                        <div style={{ color: '#3a5a70', fontSize: 11 }}>{a.windowHours}h 内 {a.count}+ 条 · 共 {a.memberIds.length} 条命中</div>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        <button disabled={busy} onClick={() => handleGroup(row)} style={{
                          padding: '4px 12px', fontSize: 11, borderRadius: 3,
                          border: '1px solid rgba(0,230,118,0.35)', background: 'rgba(0,230,118,0.1)', color: GREEN,
                          cursor: busy ? 'wait' : 'pointer', whiteSpace: 'nowrap',
                        }}>标记处理</button>
                        <button onClick={() => toggleExpand(row.id)} style={{
                          padding: '4px 10px', fontSize: 11, borderRadius: 3,
                          border: '1px solid rgba(0,150,220,0.25)', background: 'rgba(0,100,180,0.1)', color: '#5a8aaa',
                          cursor: 'pointer', whiteSpace: 'nowrap',
                        }}>{isOpen ? '收起' : `展开(${a.memberIds.length})`}</button>
                      </div>
                    </div>
                    {isOpen && (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 8, padding: '10px 12px', borderTop: `1px solid ${style.border}`, background: 'rgba(0,15,40,0.35)' }}>
                        {shownMembers.map(m => (
                          <div key={m.id} style={{ borderRadius: 3, overflow: 'hidden', border: '1px solid rgba(0,120,200,0.2)', background: '#020a18' }}>
                            <div style={{ width: '100%', height: 64, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              {m.picUrl ? (
                                <img src={`/api/iot-image?url=${encodeURIComponent(m.picUrl)}`} alt={a.aiType} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                              ) : <span style={{ color: '#2a4a60', fontSize: 9 }}>无图</span>}
                            </div>
                            <div style={{ padding: '3px 5px', fontSize: 9, color: '#5a8aaa', fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {m.createdAt ? fmtFull(m.createdAt).slice(5) : '—'}
                            </div>
                          </div>
                        ))}
                        {hiddenCount > 0 && (
                          <div style={{ borderRadius: 3, overflow: 'hidden', border: '1px dashed rgba(0,150,220,0.3)', background: 'rgba(0,20,60,0.3)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 64, gap: 2 }}>
                            <span style={{ color: '#9ad6f0', fontSize: 16, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>+{hiddenCount}</span>
                            <span style={{ color: '#5a8aaa', fontSize: 9 }}>张以数字统计</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              }
              // ── 普通单行告警 ──
              const style = LEVEL_COLORS[row.level]
              return (
                <div key={row.id} style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '9px 12px', margin: '4px 0',
                  background: row.handled ? 'rgba(0,230,118,0.04)' : style.bg,
                  border: `1px solid ${row.handled ? 'rgba(0,230,118,0.15)' : style.border}`,
                  borderRadius: 3, opacity: row.handled ? 0.78 : 1, transition: 'all 0.2s',
                }}>
                  <span style={{ width: 22, height: 22, borderRadius: 3, flexShrink: 0, background: 'rgba(0,50,100,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3a5a70', fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}>{idx + 1}</span>
                  <span style={{ padding: '2px 7px', borderRadius: 2, flexShrink: 0, background: row.handled ? 'rgba(0,230,118,0.15)' : style.border, color: row.handled ? GREEN : style.text, fontSize: 11, fontWeight: 600 }}>{row.handled ? '已处理' : style.label}</span>
                  <span style={{ color: '#5a8aaa', fontSize: 11, flexShrink: 0, fontFamily: "'JetBrains Mono', monospace", minWidth: 96 }}>{row.fullTime}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 500 }}>{row.type}{!row.backend && <span style={{ color: '#3a5a70', fontSize: 10, marginLeft: 6 }}>AI</span>}</div>
                    <div style={{ color: '#5a8aaa', fontSize: 11 }}>{row.location}</div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0, minWidth: 120 }}>
                    <div style={{ color: row.handled ? GREEN : style.text, fontSize: 12, fontWeight: 600, fontFamily: row.isPlate ? "'JetBrains Mono', monospace" : 'inherit' }}>{row.value}</div>
                    <div style={{ color: '#3a5a70', fontSize: 11 }}>{row.isPlate ? row.standard : `限值 ${row.standard}`}</div>
                  </div>
                  {row.handled && row.handledAt && (
                    <div style={{ textAlign: 'right', flexShrink: 0, minWidth: 90 }}>
                      <div style={{ color: '#3a5a70', fontSize: 10 }}>处理时间</div>
                      <div style={{ color: GREEN, fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}>{row.handledAt}</div>
                    </div>
                  )}
                  {row.backend ? (
                    <button disabled={busy} onClick={() => setStatus(row, !row.handled)} style={{
                      padding: '4px 12px', fontSize: 11, borderRadius: 3, flexShrink: 0,
                      border: `1px solid ${row.handled ? 'rgba(0,150,220,0.25)' : 'rgba(0,230,118,0.35)'}`,
                      background: row.handled ? 'rgba(0,100,180,0.1)' : 'rgba(0,230,118,0.1)',
                      color: row.handled ? '#5a8aaa' : GREEN, cursor: busy ? 'wait' : 'pointer', whiteSpace: 'nowrap',
                    }}>{row.handled ? '撤销处理' : '标记处理'}</button>
                  ) : (
                    <span style={{ flexShrink: 0, fontSize: 10, color: '#3a5a70', minWidth: 64, textAlign: 'center' }}>非采集类</span>
                  )}
                </div>
              )
            })
          )}
        </div>

        {/* Footer */}
        <div style={{
          height: 44, padding: '0 20px', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderTop: '1px solid rgba(0,80,150,0.2)', background: 'rgba(0,20,50,0.3)',
        }}>
          <span style={{ color: '#3a5a70', fontSize: 11 }}>
            共 {allRows.length} 条　·　处理状态已同步后端，刷新/多端可见
          </span>
          {tab === 'pending' && pending.some(r => r.backend) && (
            <button disabled={busy} onClick={handleAll} style={{
              padding: '4px 14px', fontSize: 11, borderRadius: 3,
              border: '1px solid rgba(0,230,118,0.3)', background: 'rgba(0,230,118,0.08)',
              color: GREEN, cursor: busy ? 'wait' : 'pointer',
            }}>全部标记处理</button>
          )}
        </div>
      </div>
    </div>
  )
}
