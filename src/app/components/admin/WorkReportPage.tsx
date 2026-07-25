import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { apiFetch, authFetch } from '../../lib/apiFetch'
import * as XLSX from 'xlsx'
import { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, HeadingLevel } from 'docx'

// ── 类型 ──────────────────────────────────────────────
type WRecord = {
  id: string
  created_at: string
  event_type: string
  location: string
  status: string
  platform_name: string
  trigger_count: number
  closed_at: string
  hasReport: boolean
  report_path: string
}
type WResp = {
  period: { label: string; start: string; end: string }
  summary: {
    total: number; pushed: number; processing: number; closed: number
    byType: { event_type: string; count: number }[]
    byPlatform: { platform_name: string; count: number }[]
    byStatus: { status: string; label: string; count: number }[]
  }
  trend: { bucket: string; count: number }[]
  records: WRecord[]
}
type Tpl = { id: string; name: string; is_default: boolean; kind?: string }
type Platform = { id: string; name: string }

const STATUS_LABEL: Record<string, string> = { pushed: '已推送', processing: '受理中', closed: '已结案' }
const STATUS_COLOR: Record<string, string> = { pushed: '#5a8aaa', processing: '#ffd740', closed: '#00e676' }
const PIE_COLORS = ['#00aaff', '#ffd740', '#00e676', '#ff4444', '#a06bff', '#ff8a3d']

const inputStyle: React.CSSProperties = {
  padding: '7px 10px', background: 'rgba(0,20,60,0.6)',
  border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3, color: '#c8e6ff',
  fontSize: 13, outline: 'none', boxSizing: 'border-box',
}
const labelStyle: React.CSSProperties = { color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 4 }
const btnStyle = (color: string, ghost = false): React.CSSProperties => ({
  padding: '6px 14px', fontSize: 12, borderRadius: 3, cursor: 'pointer',
  border: `1px solid ${color}55`,
  background: ghost ? 'transparent' : `${color}18`,
  color: ghost ? '#5a8aaa' : color,
})
const SECTION_BG = 'rgba(0,15,40,0.5)'

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name; a.click()
  URL.revokeObjectURL(url)
}

export function WorkReportPage() {
  // ── 周期 / 筛选状态 ──
  const [range, setRange] = useState<'week' | 'month' | 'quarter' | 'year'>('month')
  const [custom, setCustom] = useState(false)
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [filterType, setFilterType] = useState('')
  const [filterPlatform, setFilterPlatform] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [region, setRegion] = useState('')
  const [appliedRegion, setAppliedRegion] = useState('')

  const [data, setData] = useState<WResp | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [typeOptions, setTypeOptions] = useState<string[]>([])
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [templates, setTemplates] = useState<Tpl[]>([])
  const [tplId, setTplId] = useState('')

  const [busy, setBusy] = useState<string | null>(null)

  // ── 台账客户端搜索/排序/分页 ──
  const [kw, setKw] = useState('')
  const [sortAsc, setSortAsc] = useState(false)
  const [page, setPage] = useState(1)
  const PAGE_SIZE = 15

  const setBusySafe = (v: string | null) => { try { setBusy(v) } catch {} }

  // 区域输入防抖
  useEffect(() => {
    const t = setTimeout(() => setAppliedRegion(region), 400)
    return () => clearTimeout(t)
  }, [region])

  // 枚举：事件类型 + 平台 + 工作报表模板
  useEffect(() => {
    ;(async () => {
      try {
        const [hist, plats, tpls] = await Promise.all([
          apiFetch<any[]>('/api/smart-push/history?limit=500'),
          apiFetch<Platform[]>('/api/smart-push/platforms'),
          apiFetch<Tpl[]>('/api/smart-push/report-templates?kind=workreport'),
        ])
        const types = Array.from(new Set((hist || []).map((h: any) => h.event_type).filter(Boolean)))
        setTypeOptions(types)
        setPlatforms(plats || [])
        setTemplates(tpls || [])
        const def = (tpls || []).find(t => t.is_default)
        if (def) setTplId(def.id)
      } catch (e: any) { /* 非阻断：枚举缺失不影响主查询 */ }
    })()
  }, [])

  // 主查询
  const buildParams = useCallback(() => {
    const p: Record<string, string> = {}
    if (custom && start && end) { p.start = start; p.end = end }
    else p.range = range
    if (filterType) p.eventType = filterType
    if (filterPlatform) p.platformId = filterPlatform
    if (filterStatus) p.status = filterStatus
    if (appliedRegion) p.region = appliedRegion
    return p
  }, [custom, start, end, range, filterType, filterPlatform, filterStatus, appliedRegion])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const qs = new URLSearchParams(buildParams()).toString()
      const d = await apiFetch<WResp>('/api/smart-push/work-report' + (qs ? `?${qs}` : ''))
      setData(d)
      setPage(1)
    } catch (e: any) {
      setError(e?.error || e?.message || '查询失败')
      setData(null)
    } finally { setLoading(false) }
  }, [buildParams])

  useEffect(() => { load() }, [load])

  // ── 台账处理：搜索 + 排序 + 分页 ──
  const shown = useMemo(() => {
    if (!data) return []
    let rows = data.records
    const k = kw.trim().toLowerCase()
    if (k) rows = rows.filter(r =>
      (r.location || '').toLowerCase().includes(k) ||
      (r.event_type || '').toLowerCase().includes(k) ||
      (r.platform_name || '').toLowerCase().includes(k) ||
      (r.id || '').toLowerCase().includes(k))
    rows = [...rows].sort((a, b) => {
      const cmp = (a.created_at || '').localeCompare(b.created_at || '')
      return sortAsc ? cmp : -cmp
    })
    return rows
  }, [data, kw, sortAsc])

  const totalPages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE))
  const pageRows = useMemo(() => shown.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [shown, page])

  // ── 导出：PDF（后端渲染）──
  const exportPdf = async () => {
    setBusySafe('pdf')
    try {
      const params = buildParams()
      const resp = await authFetch('/api/smart-push/work-report/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId: tplId || undefined, params }),
      })
      if (!resp.ok) throw new Error('PDF 生成失败')
      const blob = await resp.blob()
      downloadBlob(blob, `work-report-${Date.now()}.pdf`)
    } catch (e: any) { alert('导出 PDF 失败: ' + (e?.error || e?.message || e)) }
    finally { setBusySafe(null) }
  }

  // ── 导出：Excel（浏览器内）──
  const exportExcel = () => {
    if (!data) return
    const wb = XLSX.utils.book_new()
    const detail = XLSX.utils.json_to_sheet(data.records.map(r => ({
      '推送时间': r.created_at, '事件类型': r.event_type, '地点': r.location, '平台': r.platform_name,
      '状态': STATUS_LABEL[r.status] || r.status, '触发次数': r.trigger_count,
      '结案时间': r.closed_at || '—', '结案报告': r.hasReport ? '已生成' : '未生成',
    })))
    XLSX.utils.book_append_sheet(wb, detail, '处置明细')
    const sum = XLSX.utils.json_to_sheet([
      { '指标': '推送总数', '数值': data.summary.total },
      { '指标': '已结案', '数值': data.summary.closed },
      { '指标': '受理中', '数值': data.summary.processing },
      { '指标': '已推送', '数值': data.summary.pushed },
    ])
    XLSX.utils.book_append_sheet(wb, sum, '汇总')
    const byType = XLSX.utils.json_to_sheet(data.summary.byType.map(r => ({ '事件类型': r.event_type, '数量': r.count })))
    XLSX.utils.book_append_sheet(wb, byType, '按类型')
    const byStatus = XLSX.utils.json_to_sheet(data.summary.byStatus.map(r => ({ '处置状态': r.label, '数量': r.count })))
    XLSX.utils.book_append_sheet(wb, byStatus, '按状态')
    XLSX.writeFile(wb, `work-report-${Date.now()}.xlsx`)
  }

  // ── 导出：Word（浏览器内）──
  const exportWord = async () => {
    if (!data) return
    setBusySafe('word')
    try {
      const header = new TableRow({
        children: ['推送时间', '事件类型', '地点', '平台', '状态', '触发次数', '结案时间'].map(t =>
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: t, bold: true })] })] })),
      })
      const rows = data.records.map(r => new TableRow({
        children: [
          r.created_at, r.event_type, r.location, r.platform_name,
          STATUS_LABEL[r.status] || r.status, String(r.trigger_count), r.closed_at || '—',
        ].map(v => new TableCell({ children: [new Paragraph(v)] })),
      }))
      const table = new Table({ rows: [header, ...rows] })
      const doc = new Document({
        sections: [{
          children: [
            new Paragraph({ text: '智慧治理推送处置工作报表', heading: HeadingLevel.HEADING_1 }),
            new Paragraph(`统计周期：${data.period.label}　　生成时间：${new Date().toLocaleString('zh-CN')}`),
            new Paragraph(`推送总数：${data.summary.total}　已结案：${data.summary.closed}　受理中：${data.summary.processing}　已推送：${data.summary.pushed}`),
            new Paragraph({ text: '处置明细台账', heading: HeadingLevel.HEADING_2 }),
            table,
          ],
        }],
      })
      const blob = await Packer.toBlob(doc)
      downloadBlob(blob, `work-report-${Date.now()}.docx`)
    } catch (e: any) { alert('导出 Word 失败: ' + (e?.message || e)) }
    finally { setBusySafe(null) }
  }

  // ── 单条结案报告下载（复用 SmartPushPage 套路）──
  const exportClosure = async (id: string) => {
    setBusySafe('closure-' + id)
    try {
      await apiFetch(`/api/smart-push/history/${id}/report`, { method: 'POST' })
      const resp = await authFetch(`/api/smart-push/history/${id}/report`)
      if (!resp.ok) throw new Error('下载失败')
      const blob = await resp.blob()
      downloadBlob(blob, `closure-report-${id}.pdf`)
    } catch (e: any) { alert('导出结案报告失败: ' + (e?.error || e?.message || e)) }
    finally { setBusySafe(null) }
  }

  const s = data?.summary
  const periodLabel = data?.period.label || ''

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 18, color: '#c8e6ff' }}>
      {/* 标题 + 导出 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#e6f3ff' }}>智治推送处置工作报表</div>
          <div style={{ fontSize: 12, color: '#5a8aaa', marginTop: 2 }}>
            统计周期：{periodLabel || '—'}　工作留痕 · 迅速查找 · 周期汇报
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={btnStyle('#00aaff')} disabled={busy === 'pdf'} onClick={exportPdf}>
            {busy === 'pdf' ? '生成中…' : '导出 PDF'}
          </button>
          <button style={btnStyle('#00e676')} onClick={exportExcel}>导出 Excel</button>
          <button style={btnStyle('#ffd740')} disabled={busy === 'word'} onClick={exportWord}>
            {busy === 'word' ? '生成中…' : '导出 Word'}
          </button>
        </div>
      </div>

      {/* 周期 + 筛选 */}
      <div style={{ background: SECTION_BG, border: '1px solid rgba(0,150,220,0.15)', borderRadius: 6, padding: 14, marginBottom: 14 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }}>
          <div>
            <span style={labelStyle}>统计周期</span>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['week', 'month', 'quarter', 'year'] as const).map(r => (
                <button key={r} onClick={() => { setCustom(false); setRange(r) }}
                  style={btnStyle('#00aaff', !custom && range === r)}>
                  {r === 'week' ? '本周' : r === 'month' ? '本月' : r === 'quarter' ? '本季' : '本年'}
                </button>
              ))}
              <button onClick={() => setCustom(true)} style={btnStyle('#00aaff', custom)}>自定义</button>
            </div>
          </div>
          {custom && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <div><span style={labelStyle}>起</span><input type="date" value={start} onChange={e => setStart(e.target.value)} style={inputStyle} /></div>
              <div><span style={labelStyle}>止</span><input type="date" value={end} onChange={e => setEnd(e.target.value)} style={inputStyle} /></div>
            </div>
          )}
          <div>
            <span style={labelStyle}>事件类型</span>
            <select value={filterType} onChange={e => setFilterType(e.target.value)} style={{ ...inputStyle, minWidth: 150 }}>
              <option value="">全部类型</option>
              {typeOptions.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <span style={labelStyle}>目标平台</span>
            <select value={filterPlatform} onChange={e => setFilterPlatform(e.target.value)} style={{ ...inputStyle, minWidth: 150 }}>
              <option value="">全部平台</option>
              {platforms.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <span style={labelStyle}>处置状态</span>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ ...inputStyle, minWidth: 120 }}>
              <option value="">全部状态</option>
              <option value="pushed">已推送</option>
              <option value="processing">受理中</option>
              <option value="closed">已结案</option>
            </select>
          </div>
          <div>
            <span style={labelStyle}>区域关键词</span>
            <input type="text" value={region} onChange={e => setRegion(e.target.value)} placeholder="地点/关键词" style={{ ...inputStyle, minWidth: 150 }} />
          </div>
          <div>
            <span style={labelStyle}>报表模板</span>
            <select value={tplId} onChange={e => setTplId(e.target.value)} style={{ ...inputStyle, minWidth: 150 }}>
              {templates.length === 0 && <option value="">（默认模板）</option>}
              {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <button style={btnStyle('#00e676')} onClick={load} disabled={loading}>{loading ? '查询中…' : '查询'}</button>
        </div>
      </div>

      {error && <div style={{ color: '#ff7777', marginBottom: 10 }}>⚠ {error}</div>}

      {/* 汇总卡片 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 14 }}>
        {[
          { k: '推送总数', v: s?.total ?? 0, c: '#00aaff' },
          { k: '已结案', v: s?.closed ?? 0, c: '#00e676' },
          { k: '受理中', v: s?.processing ?? 0, c: '#ffd740' },
          { k: '已推送', v: s?.pushed ?? 0, c: '#5a8aaa' },
        ].map(card => (
          <div key={card.k} style={{ background: SECTION_BG, border: `1px solid ${card.c}44`, borderRadius: 6, padding: '14px 16px' }}>
            <div style={{ fontSize: 12, color: '#5a8aaa' }}>{card.k}</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: card.c, marginTop: 4 }}>{card.v}</div>
          </div>
        ))}
      </div>

      {/* 图表 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr', gap: 12, marginBottom: 14 }}>
        <div style={{ background: SECTION_BG, border: '1px solid rgba(0,150,220,0.15)', borderRadius: 6, padding: 12 }}>
          <div style={{ fontSize: 13, color: '#9ec5e6', marginBottom: 6 }}>推送趋势</div>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={data?.trend || []} margin={{ top: 5, right: 16, bottom: 5, left: -16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(95,138,170,0.2)" />
              <XAxis dataKey="bucket" tick={{ fontSize: 11, fill: '#7fa8c8' }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#7fa8c8' }} />
              <Tooltip contentStyle={{ background: '#0a1830', border: '1px solid #1c3a5e', color: '#c8e6ff', fontSize: 12 }} />
              <Line type="monotone" dataKey="count" name="推送数" stroke="#00aaff" strokeWidth={2} dot={{ r: 2 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div style={{ background: SECTION_BG, border: '1px solid rgba(0,150,220,0.15)', borderRadius: 6, padding: 12 }}>
          <div style={{ fontSize: 13, color: '#9ec5e6', marginBottom: 6 }}>按事件类型分布</div>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data?.summary.byType || []} margin={{ top: 5, right: 12, bottom: 5, left: -16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(95,138,170,0.2)" />
              <XAxis dataKey="event_type" tick={{ fontSize: 10, fill: '#7fa8c8' }} interval={0} angle={-20} textAnchor="end" height={50} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#7fa8c8' }} />
              <Tooltip contentStyle={{ background: '#0a1830', border: '1px solid #1c3a5e', color: '#c8e6ff', fontSize: 12 }} />
              <Bar dataKey="count" name="数量" fill="#00aaff" />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div style={{ background: SECTION_BG, border: '1px solid rgba(0,150,220,0.15)', borderRadius: 6, padding: 12 }}>
          <div style={{ fontSize: 13, color: '#9ec5e6', marginBottom: 6 }}>按处置状态分布</div>
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie data={data?.summary.byStatus || []} dataKey="count" nameKey="label" cx="50%" cy="50%" outerRadius={80} label>
                {data?.summary.byStatus.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
              </Pie>
              <Tooltip contentStyle={{ background: '#0a1830', border: '1px solid #1c3a5e', color: '#c8e6ff', fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11, color: '#7fa8c8' }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* 明细台账 */}
      <div style={{ background: SECTION_BG, border: '1px solid rgba(0,150,220,0.15)', borderRadius: 6, padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ fontSize: 14, color: '#e6f3ff', fontWeight: 600 }}>处置明细台账（{shown.length} 条）</div>
          <input type="text" value={kw} onChange={e => { setKw(e.target.value); setPage(1) }} placeholder="台账内搜索：地点/类型/平台/ID" style={{ ...inputStyle, width: 260 }} />
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ color: '#9ec5e6', textAlign: 'left' }}>
                <th style={thStyle} onClick={() => { setSortAsc(v => !v); setPage(1) }} title="点击切换时间排序">推送时间 ⇅</th>
                <th style={thStyle}>事件类型</th>
                <th style={thStyle}>地点</th>
                <th style={thStyle}>平台</th>
                <th style={thStyle}>状态</th>
                <th style={thStyle}>触发次数</th>
                <th style={thStyle}>结案时间</th>
                <th style={thStyle}>结案报告</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 && (
                <tr><td colSpan={8} style={{ padding: 20, textAlign: 'center', color: '#5a8aaa' }}>暂无数据</td></tr>
              )}
              {pageRows.map(r => (
                <tr key={r.id} style={{ borderTop: '1px solid rgba(0,150,220,0.1)' }}>
                  <td style={tdStyle}>{r.created_at}</td>
                  <td style={tdStyle}>{r.event_type}</td>
                  <td style={tdStyle}>{r.location || '—'}</td>
                  <td style={tdStyle}>{r.platform_name}</td>
                  <td style={tdStyle}>
                    <span style={{ color: STATUS_COLOR[r.status] || '#9ec5e6' }}>{STATUS_LABEL[r.status] || r.status}</span>
                  </td>
                  <td style={tdStyle}>{r.trigger_count ?? '—'}</td>
                  <td style={tdStyle}>{r.closed_at || '—'}</td>
                  <td style={tdStyle}>
                    {r.hasReport
                      ? <button style={btnStyle('#00aaff', true)} disabled={busy === 'closure-' + r.id} onClick={() => exportClosure(r.id)}>
                          {busy === 'closure-' + r.id ? '生成中…' : '下载'}
                        </button>
                      : <span style={{ color: '#5a6a7a' }}>未生成</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* 分页 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, marginTop: 10 }}>
          <span style={{ fontSize: 12, color: '#5a8aaa' }}>第 {page} / {totalPages} 页</span>
          <button style={btnStyle('#00aaff', true)} disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>上一页</button>
          <button style={btnStyle('#00aaff', true)} disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>下一页</button>
        </div>
      </div>
    </div>
  )
}

const thStyle: React.CSSProperties = { padding: '8px 10px', borderBottom: '1px solid rgba(0,150,220,0.25)', color: '#9ec5e6', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }
const tdStyle: React.CSSProperties = { padding: '7px 10px', color: '#c8e6ff', verticalAlign: 'top' }
