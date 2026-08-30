import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../../lib/apiFetch'
import { getApiKey } from '../../lib/apiFetch'

// 带 API Key 的原始 fetch（保留 Response 供 .ok 判断）
function apiFetchRaw(url: string, options: RequestInit = {}): Promise<Response> {
  const key = getApiKey()
  const headers: Record<string, string> = { ...(options.headers as any || {}) }
  if (key) headers['Authorization'] = 'Bearer ' + key
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json'
  return fetch(url, { ...options, headers })
}

const CYAN = '#00aaff'
const GREEN = '#00e676'
const AMBER = '#ffd740'
const ORANGE = '#ff7043'
const RED = '#ff4444'
const PURPLE = '#ab47bc'

const SOURCE_TYPES = ['cq_api', 'html_crawl', 'http', 'mqtt', 'mysql', 'tcp'] as const
const SOURCE_TYPE_LABELS: Record<string, string> = {
  cq_api: '重庆AQI接口', html_crawl: '网页爬取', http: 'HTTP接口', mqtt: 'MQTT', mysql: '数据库', tcp: 'TCP',
}

const WARNING_COLORS: Record<string, string> = {
  fixed: ORANGE, growth5h: AMBER, cross: RED, none: '#3a5a70',
}

interface DataSource {
  id: string; source_name: string; source_type: string; source_url: string
  auth_info: string; collect_cycle: number; timeout: number; enabled: number
  point_code: string; point_filter: string[]; breaker_open?: boolean
  request_method?: string; request_body?: string; lon?: number | string; lat?: number | string
}

interface Warning {
  id: string; pointName: string; code: string; name: string; value: number; unit: string
  warningType: string; warningLabel: string; reason: string; monitorTime: string
  createdAt: string; status: string
}

interface CollectLog {
  id: string; time: string; source: string; point: string; status: string; detail: string
}

const EMPTY_DS: Omit<DataSource, 'id'> = {
  source_name: '', source_type: 'cq_api', source_url: '', auth_info: '',
  collect_cycle: 300, timeout: 10000, enabled: 0, point_code: '', point_filter: [],
  request_method: 'POST', request_body: '', lon: '', lat: '',
}

function Input({ label, value, onChange, placeholder, type = 'text', mono }: {
  label: string; value: string | number; onChange: (v: string) => void
  placeholder?: string; type?: string; mono?: boolean
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 4 }}>{label}</label>
      <input
        type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{
          width: '100%', padding: '7px 10px', background: 'rgba(0,20,60,0.6)',
          border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3, color: '#c8e6ff',
          fontSize: 13, fontFamily: mono ? "'JetBrains Mono',monospace" : 'inherit', outline: 'none',
        }}
      />
    </div>
  )
}

type Tab = 'sources' | 'warnings' | 'rules' | 'logs'

// 预警规则编辑表单行
interface RuleRow {
  code: string
  label: string
  safeMax: string        // 不预警上限
  growthMin: string      // 5h增长区间下限（空=无）
  growthMax: string      // 5h增长区间上限（空=无上限）
  cross: string          // 跨阈值，逗号分隔（从低到高）
}

const RULE_ROW_DEFS: { code: string; label: string; hasGrowth: boolean; hasCross: boolean }[] = [
  { code: 'PM25', label: 'PM2.5', hasGrowth: true, hasCross: true },
  { code: 'PM10', label: 'PM10', hasGrowth: true, hasCross: true },
  { code: 'SO2', label: 'SO₂', hasGrowth: false, hasCross: false },
  { code: 'NO2', label: 'NO₂', hasGrowth: true, hasCross: false },
  { code: 'O3', label: 'O₃', hasGrowth: false, hasCross: true },
  { code: 'CO', label: 'CO', hasGrowth: false, hasCross: false },
]

export function GasMonitorPage() {
  const [tab, setTab] = useState<Tab>('sources')
  const [sources, setSources] = useState<DataSource[]>([])
  const [warnings, setWarnings] = useState<Warning[]>([])
  const [logs, setLogs] = useState<CollectLog[]>([])
  const [ruleRows, setRuleRows] = useState<RuleRow[]>([])
  const [growthRatio, setGrowthRatio] = useState('0.4')
  const [form, setForm] = useState<Omit<DataSource, 'id'>>(EMPTY_DS)
  const [editId, setEditId] = useState<string | null>(null)
  // 预警记录分页（每页 100 条）
  const WARN_PAGE_SIZE = 100
  const [warnPage, setWarnPage] = useState(1)
  const warnTotalPages = Math.max(1, Math.ceil(warnings.length / WARN_PAGE_SIZE))
  const safeWarnPage = Math.min(warnPage, warnTotalPages)
  const pagedWarnings = warnings.slice((safeWarnPage - 1) * WARN_PAGE_SIZE, safeWarnPage * WARN_PAGE_SIZE)
  const [showForm, setShowForm] = useState(false)
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState('')

  const flash = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 3500) }

  const loadSources = useCallback(() => {
    apiFetchRaw('/api/datasources').then(r => r.json()).then(setSources).catch(() => {})
  }, [])
  const loadWarnings = useCallback(() => {
    apiFetchRaw('/api/warnings?limit=100&exclude_type=iot-video-analysis').then(r => r.json()).then(setWarnings).catch(() => {})
  }, [])
  const loadLogs = useCallback(() => {
    apiFetchRaw('/api/collect-logs?limit=100').then(r => r.json()).then(setLogs).catch(() => {})
  }, [])

  const loadRules = useCallback(() => {
    apiFetchRaw('/api/warning-rules').then(r => r.json()).then((data) => {
      const sm = data.safeMax || {}
      const cross = data.crossThresholds || {}
      const growth = data.growthRange || {}
      setGrowthRatio(data.growthRatio != null ? String(data.growthRatio) : '0.4')
      setRuleRows(RULE_ROW_DEFS.map(d => {
        const g = growth[d.code]
        return {
          code: d.code,
          label: d.label,
          safeMax: sm[d.code] != null ? String(sm[d.code]) : '',
          growthMin: g && g.min != null ? String(g.min) : '',
          growthMax: g && g.max != null && Number.isFinite(Number(g.max)) ? String(g.max) : '',
          cross: (cross[d.code] || []).slice().sort((a: number, b: number) => a - b).join(','),
        }
      }))
    }).catch(() => {})
  }, [])

  useEffect(() => {
    loadSources(); loadWarnings(); loadLogs(); loadRules()
  }, [loadSources, loadWarnings, loadLogs, loadRules])

  const saveRules = async () => {
    const num = (s: string, fallback: number | null = null) => {
      const n = Number(s.trim())
      return s.trim() === '' ? fallback : (isNaN(n) ? null : n)
    }
    const safeMax: Record<string, number> = {}
    const crossThresholds: Record<string, number[]> = {}
    const growthRange: Record<string, { min: number; max: number }> = {}
    let valid = true
    const ratio = Number(growthRatio)
    if (!growthRatio.trim() || isNaN(ratio) || ratio <= 0) {
      flash('增长比例必须为正数'); valid = false
    }
    for (const r of ruleRows) {
      const sm = num(r.safeMax)
      if (r.safeMax.trim() === '' || sm === null || (sm != null && sm < 0)) {
        flash(`${r.label} 不预警上限无效`); valid = false; break
      }
      safeMax[r.code] = sm as number
      // 跨阈值（从低到高输入，逗号分隔）
      if (r.cross.trim()) {
        const arr = r.cross.split(/[,，\s]+/).filter(Boolean).map(Number)
        if (arr.some(isNaN) || arr.length === 0) {
          flash(`${r.label} 跨阈值格式无效（用逗号分隔数字）`); valid = false; break
        }
        crossThresholds[r.code] = arr
      }
      // 增长区间（可留空 = 不启用该污染物的增长预警）
      if (r.growthMin.trim() || r.growthMax.trim()) {
        const min = num(r.growthMin)
        const max = num(r.growthMax, null)
        if (min === null || (r.growthMax.trim() !== '' && max === null) || (min != null && min < 0)) {
          flash(`${r.label} 5小时增长区间无效`); valid = false; break
        }
        growthRange[r.code] = { min: min as number, max: (max == null || r.growthMax.trim() === '') ? Infinity : max }
      }
    }
    if (!valid) return
    const body: Record<string, any> = { safeMax, growthRatio: ratio }
    if (Object.keys(crossThresholds).length) body.crossThresholds = crossThresholds
    if (Object.keys(growthRange).length) body.growthRange = growthRange
    try {
      const resp = await apiFetchRaw('/api/warning-rules', { method: 'PUT', body: JSON.stringify(body) })
      if (!resp.ok) {
        let msg = `HTTP ${resp.status}`
        try { const j = await resp.json(); if (j && j.error) msg = j.error } catch {}
        flash(`保存失败：${msg}`)
        return
      }
      flash('预警规则已保存并生效')
      loadRules()
    } catch (e) {
      flash('保存失败：无法连接后端服务')
    }
  }

  const resetRules = () => {
    apiFetchRaw('/api/warning-rules', {
      method: 'PUT',
      body: JSON.stringify({
        safeMax: { PM25: 35, PM10: 50, SO2: 20, NO2: 30, O3: 160, CO: 1 },
        crossThresholds: { PM25: [75, 115, 150], PM10: [150, 250, 350], O3: [160] },
        growthRange: { PM25: { min: 35, max: 60 }, PM10: { min: 50, max: 120 }, NO2: { min: 30, max: Infinity } },
        growthRatio: 0.4,
      }),
    }).then(r => r.json()).then(() => { flash('已恢复默认阈值'); loadRules() }).catch(() => flash('重置失败'))
  }


  const handleSave = async () => {
    if (!form.source_name) { flash('请填写数据源名称'); return }
    const filterArr = typeof (form.point_filter as any) === 'string'
      ? String(form.point_filter).split(/[,，\s]+/).filter(Boolean)
      : form.point_filter
    const body = { ...form, point_filter: filterArr }
    try {
      const resp = editId
        ? await apiFetchRaw(`/api/datasources/${editId}`, { method: 'PATCH', body: JSON.stringify(body) })
        : await apiFetchRaw('/api/datasources', { method: 'POST', body: JSON.stringify(body) })
      if (!resp.ok) {
        let msg = `HTTP ${resp.status}`
        try { const j = await resp.json(); if (j && j.error) msg = j.error } catch {}
        flash(`保存失败：${msg}`)
        return
      }
      loadSources(); setShowForm(false); setEditId(null); setForm(EMPTY_DS); flash('已保存')
    } catch (e) {
      flash(`保存失败：无法连接后端服务（请确认 server 已启动且 /api 代理生效）`)
    }
  }

  const handleEdit = (ds: DataSource) => {
    setForm({ ...ds, point_filter: ds.point_filter || [] }); setEditId(ds.id); setShowForm(true)
  }
  const handleDelete = (id: string) => {
    apiFetchRaw(`/api/datasources/${id}`, { method: 'DELETE' }).then(() => { loadSources(); flash('已删除') }).catch(() => {})
  }
  const toggleEnabled = (ds: DataSource) => {
    apiFetchRaw(`/api/datasources/${ds.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: ds.enabled ? 0 : 1 }) })
      .then(() => loadSources()).catch(() => {})
  }
  const testSource = (ds: DataSource) => {
    setBusy(ds.id)
    apiFetchRaw(`/api/datasources/${ds.id}/test`, { method: 'POST' }).then(r => r.json()).then(res => {
      setBusy('')
      flash(res.ok ? `连通成功，获取 ${res.count} 条数据` : `连通失败：${res.error || '未知'}`)
    }).catch(() => { setBusy(''); flash('测试请求失败') })
  }
  const runCollect = (ds: DataSource) => {
    setBusy(ds.id)
    apiFetchRaw(`/api/collect/run/${ds.id}`, { method: 'POST' }).then(r => r.json()).then(res => {
      setBusy('')
      if (res.ok) { flash(`采集完成：获取${res.fetched} 入库${res.ingested} 预警${res.warnings}`); loadWarnings(); loadLogs() }
      else flash(`采集失败：${res.error || '未知'}`)
    }).catch(() => { setBusy(''); flash('采集请求失败') })
  }
  const clearBreaker = (ds: DataSource) => {
    apiFetchRaw(`/api/datasources/${ds.id}/clear-breaker`, { method: 'POST' })
      .then(r => r.json()).then(() => flash('熔断已清除，可重新采集')).catch(() => flash('清除失败'))
  }

  const TABS: { key: Tab; label: string }[] = [
    { key: 'sources', label: '数据源配置' },
    { key: 'warnings', label: `预警记录 (${warnings.length})` },
    { key: 'rules', label: '预警规则' },
    { key: 'logs', label: '采集日志' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, padding: '14px 20px 0', borderBottom: '1px solid rgba(0,80,150,0.2)', flexShrink: 0 }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '7px 16px', fontSize: 13, borderRadius: '4px 4px 0 0', cursor: 'pointer',
            border: `1px solid ${tab === t.key ? CYAN : 'transparent'}`, borderBottom: 'none',
            background: tab === t.key ? `${CYAN}18` : 'transparent', color: tab === t.key ? CYAN : '#5a8aaa',
          }}>{t.label}</button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', scrollbarWidth: 'none' }}>
        {/* ── 数据源配置 ── */}
        {tab === 'sources' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
              <h3 style={{ color: '#c8e6ff', fontSize: 15, fontWeight: 600, flex: 1 }}>数据源配置</h3>
              <button onClick={() => { setForm(EMPTY_DS); setEditId(null); setShowForm(true) }}
                style={{ padding: '6px 16px', fontSize: 12, borderRadius: 3, border: `1px solid ${GREEN}55`, background: `${GREEN}18`, color: GREEN, cursor: 'pointer' }}>
                + 新增数据源
              </button>
            </div>

            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(0,80,150,0.2)' }}>
                  {['状态', '名称', '类型', '地址', '采集周期', '归属点位', '操作'].map(h => (
                    <th key={h} style={{ padding: '8px 10px', textAlign: 'left', color: '#5a8aaa', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sources.map((ds, i) => (
                  <tr key={ds.id} style={{ borderBottom: '1px solid rgba(0,50,100,0.15)', background: i % 2 ? 'rgba(0,20,50,0.2)' : 'transparent' }}>
                    <td style={{ padding: '8px 10px' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: ds.enabled ? GREEN : '#3a5a70', boxShadow: ds.enabled ? `0 0 5px ${GREEN}` : 'none' }} />
                        <span style={{ color: ds.enabled ? GREEN : '#5a8aaa', fontSize: 11 }}>{ds.enabled ? '启用' : '禁用'}</span>
                      </span>
                    </td>
                    <td style={{ padding: '8px 10px', color: '#c8e6ff' }}>{ds.source_name}</td>
                    <td style={{ padding: '8px 10px' }}>
                      <span style={{ padding: '1px 7px', borderRadius: 2, fontSize: 11, background: `${CYAN}18`, color: CYAN, border: `1px solid ${CYAN}30` }}>
                        {SOURCE_TYPE_LABELS[ds.source_type] || ds.source_type}
                      </span>
                    </td>
                    <td style={{ padding: '8px 10px', color: '#3a5a70', fontFamily: "'JetBrains Mono',monospace", fontSize: 11, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ds.source_url || '—'}</td>
                    <td style={{ padding: '8px 10px', color: '#7ab8e0' }}>{ds.collect_cycle}s</td>
                    <td style={{ padding: '8px 10px', color: '#7ab8e0' }}>{(ds.point_filter || []).join(',') || ds.point_code || '—'}</td>
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                      <button onClick={() => toggleEnabled(ds)} style={btnStyle(ds.enabled ? RED : GREEN)}>{ds.enabled ? '禁用' : '启用'}</button>
                      <button onClick={() => testSource(ds)} disabled={busy === ds.id} style={btnStyle(CYAN)}>{busy === ds.id ? '...' : '测试'}</button>
                      <button onClick={() => runCollect(ds)} disabled={busy === ds.id} style={btnStyle(AMBER)}>采集</button>
                      <button onClick={() => clearBreaker(ds)} style={btnStyle(PURPLE)} title="清除熔断状态">解除熔断</button>
                      <button onClick={() => handleEdit(ds)} style={btnStyle(CYAN)}>编辑</button>
                      <button onClick={() => handleDelete(ds.id)} style={btnStyle(RED)}>删除</button>
                    </td>
                  </tr>
                ))}
                {sources.length === 0 && <tr><td colSpan={7} style={{ padding: '30px 0', textAlign: 'center', color: '#3a5a70' }}>暂无数据源</td></tr>}
              </tbody>
            </table>
          </div>
        )}

        {/* ── 预警记录 ── */}
        {tab === 'warnings' && (
          <>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(0,80,150,0.2)' }}>
                {['监测时间', '点位', '污染物', '监测值', '预警类型', '判定依据'].map(h => (
                  <th key={h} style={{ padding: '8px 10px', textAlign: 'left', color: '#5a8aaa', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pagedWarnings.map((w, i) => (
                <tr key={w.id} style={{ borderBottom: '1px solid rgba(0,50,100,0.15)', background: i % 2 ? 'rgba(0,20,50,0.2)' : 'transparent' }}>
                  <td style={{ padding: '8px 10px', color: '#7ab8e0', fontFamily: "'JetBrains Mono',monospace", fontSize: 11 }}>{w.monitorTime}</td>
                  <td style={{ padding: '8px 10px', color: '#c8e6ff' }}>{w.pointName}</td>
                  <td style={{ padding: '8px 10px', color: '#7ab8e0' }}>{w.name} ({w.code})</td>
                  <td style={{ padding: '8px 10px', color: AMBER, fontFamily: "'JetBrains Mono',monospace" }}>{w.value} {w.unit}</td>
                  <td style={{ padding: '8px 10px' }}>
                    <span style={{ padding: '1px 8px', borderRadius: 2, fontSize: 11, background: `${WARNING_COLORS[w.warningType]}20`, color: WARNING_COLORS[w.warningType], border: `1px solid ${WARNING_COLORS[w.warningType]}40` }}>{w.warningLabel}</span>
                  </td>
                  <td style={{ padding: '8px 10px', color: '#5a8aaa', fontSize: 11 }}>{w.reason}</td>
                </tr>
              ))}
              {pagedWarnings.length === 0 && <tr><td colSpan={6} style={{ padding: '30px 0', textAlign: 'center', color: '#3a5a70' }}>暂无预警记录</td></tr>}
            </tbody>
          </table>
          {warnings.length > WARN_PAGE_SIZE && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
              <button onClick={() => setWarnPage(p => Math.max(1, p - 1))} disabled={safeWarnPage <= 1} style={btnStyle(CYAN)}>‹ 上一页</button>
              <span style={{ color: '#7ab8e0', fontSize: 12, fontFamily: "'JetBrains Mono',monospace" }}>第 {safeWarnPage} / {warnTotalPages} 页</span>
              <button onClick={() => setWarnPage(p => Math.min(warnTotalPages, p + 1))} disabled={safeWarnPage >= warnTotalPages} style={btnStyle(CYAN)}>下一页 ›</button>
              <span style={{ color: '#3a5a70', fontSize: 11, marginLeft: 'auto' }}>每页 {WARN_PAGE_SIZE} 条</span>
            </div>
          )}
          </>
        )}

        {/* ── 预警规则（可编辑） ── */}
        {tab === 'rules' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ color: '#c8e6ff', fontSize: 15, fontWeight: 600, flex: 1 }}>污染物预警规则阈值（后台可配置，保存即生效）</h3>
              <button onClick={resetRules} style={btnStyle('#8899aa')} title="恢复为内置默认阈值">恢复默认</button>
              <button onClick={saveRules} style={{ ...btnStyle(GREEN), marginLeft: 6, fontWeight: 600 }}>保存并生效</button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <label style={{ color: '#5a8aaa', fontSize: 12 }}>5小时增长比例 ≥</label>
              <input type="number" step="0.05" min="0.01" value={growthRatio}
                onChange={e => setGrowthRatio(e.target.value)}
                style={{ width: 90, padding: '5px 8px', background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3, color: '#c8e6ff', fontSize: 13, outline: 'none' }} />
              <span style={{ color: '#5a8aaa', fontSize: 12 }}>（如 0.4 = 40%）</span>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(0,80,150,0.2)' }}>
                  {['污染物', '不预警上限', '5小时增长区间 (min~max)', '跨阈值 (逗号分隔，从低到高)', '固定值预警'].map(h => (
                    <th key={h} style={{ padding: '8px 10px', textAlign: 'left', color: '#5a8aaa', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
                <tr>
                  <td style={{ padding: '2px 10px', color: '#3a5a70', fontSize: 10 }}>单位：PM2.5/PM10/SO₂/NO₂/O₃ 为 μg/m³，CO 为 mg/m³</td>
                  <td colSpan={4} />
                </tr>
              </thead>
              <tbody>
                {ruleRows.map((r, i) => {
                  const def = RULE_ROW_DEFS.find(d => d.code === r.code)!
                  const setRow = (patch: Partial<RuleRow>) => setRuleRows(rows => rows.map(x => x.code === r.code ? { ...x, ...patch } : x))
                  return (
                    <tr key={r.code} style={{ borderBottom: '1px solid rgba(0,50,100,0.15)', background: i % 2 ? 'rgba(0,20,50,0.2)' : 'transparent' }}>
                      <td style={{ padding: '8px 10px', color: '#c8e6ff', fontWeight: 600, whiteSpace: 'nowrap' }}>{r.label} <span style={{ color: '#3a5a70', fontSize: 10 }}>({r.code})</span></td>
                      <td style={{ padding: '6px 10px' }}>
                        <input type="number" min="0" value={r.safeMax} onChange={e => setRow({ safeMax: e.target.value })}
                          style={inputStyle} placeholder={r.code === 'SO2' ? '严格小于' : '≤'} />
                      </td>
                      <td style={{ padding: '6px 10px' }}>
                        {def.hasGrowth ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <input type="number" min="0" value={r.growthMin} onChange={e => setRow({ growthMin: e.target.value })} style={{ ...inputStyle, width: 70 }} placeholder="min" />
                            ~
                            <input type="number" min="0" value={r.growthMax} onChange={e => setRow({ growthMax: e.target.value })} style={{ ...inputStyle, width: 70 }} placeholder="空=∞" />
                          </span>
                        ) : <span style={{ color: '#3a5a70' }}>—</span>}
                      </td>
                      <td style={{ padding: '6px 10px' }}>
                        {def.hasCross ? (
                          <input value={r.cross} onChange={e => setRow({ cross: e.target.value })}
                            style={{ ...inputStyle, width: 180 }} placeholder="如 75,115,150" />
                        ) : <span style={{ color: '#3a5a70' }}>—</span>}
                      </td>
                      <td style={{ padding: '6px 10px', color: ORANGE, whiteSpace: 'nowrap' }}>
                        {r.code === 'CO' ? `> ${r.safeMax || '—'}` : '无'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <div style={{ marginTop: 12, color: '#3a5a70', fontSize: 11, lineHeight: 1.8 }}>
              说明：5小时增长预警以「当前 + 前4小时」窗口内最低值为基准，增长 ≥ 上方的增长比例即触发；跨阈值预警要求前一小时 ≤ 阈值、当前 &gt; 阈值（填写多个阈值时从低到高，用逗号分隔）。SO₂ 为严格小于上限不预警；CO 超过上限即固定值预警。保存后立即生效于后续采集数据的判定。
            </div>
          </div>
        )}

        {/* ── 采集日志 ── */}
        {tab === 'logs' && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(0,80,150,0.2)' }}>
                {['时间', '来源', '点位', '状态', '详情'].map(h => (
                  <th key={h} style={{ padding: '8px 10px', textAlign: 'left', color: '#5a8aaa', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs.map((l, i) => (
                <tr key={l.id} style={{ borderBottom: '1px solid rgba(0,50,100,0.15)', background: i % 2 ? 'rgba(0,20,50,0.2)' : 'transparent' }}>
                  <td style={{ padding: '8px 10px', color: '#7ab8e0', fontFamily: "'JetBrains Mono',monospace", fontSize: 11 }}>{new Date(l.time).toLocaleString('zh-CN')}</td>
                  <td style={{ padding: '8px 10px', color: '#7ab8e0' }}>{l.source}</td>
                  <td style={{ padding: '8px 10px', color: '#c8e6ff' }}>{l.point}</td>
                  <td style={{ padding: '8px 10px' }}>
                    <span style={{ color: l.status === 'ok' ? GREEN : l.status === 'skip' ? AMBER : RED }}>{l.status}</span>
                  </td>
                  <td style={{ padding: '8px 10px', color: '#5a8aaa', fontSize: 11 }}>{l.detail}</td>
                </tr>
              ))}
              {logs.length === 0 && <tr><td colSpan={5} style={{ padding: '30px 0', textAlign: 'center', color: '#3a5a70' }}>暂无采集日志</td></tr>}
            </tbody>
          </table>
        )}
      </div>

      {/* 表单抽屉 */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.6)', display: 'flex', justifyContent: 'flex-end' }}
          onClick={e => { if (e.target === e.currentTarget) setShowForm(false) }}>
          <div style={{ width: 400, height: '100%', background: '#040e25', borderLeft: '1px solid rgba(0,150,220,0.3)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid rgba(0,80,150,0.2)', color: '#c8e6ff', fontSize: 14, fontWeight: 600 }}>
              {editId ? '编辑数据源' : '新增数据源'}
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', scrollbarWidth: 'none' }}>
              <Input label="数据源名称 *" value={form.source_name} onChange={v => setForm(f => ({ ...f, source_name: v }))} placeholder="如：重庆市空气质量发布" />
              <div style={{ marginBottom: 12 }}>
                <label style={{ color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 4 }}>数据源类型</label>
                <select value={form.source_type} onChange={e => setForm(f => ({ ...f, source_type: e.target.value }))}
                  style={{ width: '100%', padding: '7px 10px', background: 'rgba(0,20,60,0.8)', border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3, color: '#c8e6ff', fontSize: 13, outline: 'none' }}>
                  {SOURCE_TYPES.map(t => <option key={t} value={t}>{SOURCE_TYPE_LABELS[t]}</option>)}
                </select>
              </div>
              <Input label="地址/URL" value={form.source_url} onChange={v => setForm(f => ({ ...f, source_url: v }))} placeholder="https://..." mono />
              <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: 8, marginBottom: 12 }}>
                <div>
                  <label style={{ color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 4 }}>请求方式</label>
                  <select value={form.request_method || 'POST'} onChange={e => setForm(f => ({ ...f, request_method: e.target.value }))}
                    style={{ width: '100%', padding: '7px 8px', background: 'rgba(0,20,60,0.8)', border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3, color: '#c8e6ff', fontSize: 13, outline: 'none' }}>
                    <option>POST</option><option>GET</option>
                  </select>
                </div>
                <Input label="请求体 (form body)" value={form.request_body || ''} onChange={v => setForm(f => ({ ...f, request_body: v }))} placeholder="stationname=周家坝" mono />
              </div>
              <Input label="归属点位编码" value={form.point_code} onChange={v => setForm(f => ({ ...f, point_code: v }))} placeholder="如：wanzhou" />
              <Input label="点位过滤(逗号分隔)" value={Array.isArray(form.point_filter) ? form.point_filter.join(',') : form.point_filter}
                onChange={v => setForm(f => ({ ...f, point_filter: v as any }))} placeholder="周家坝,百安坝" />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <Input label="经度 (lon)" value={form.lon ?? ''} onChange={v => setForm(f => ({ ...f, lon: v }))} placeholder="108.372488" mono />
                <Input label="纬度 (lat)" value={form.lat ?? ''} onChange={v => setForm(f => ({ ...f, lat: v }))} placeholder="30.840472" mono />
              </div>
              <div style={{ color: '#3a5a70', fontSize: 11, marginBottom: 8, marginTop: -4 }}>填写后该监测站会在地图上以 🏠 标注，点击显示最近采集数据</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <Input label="采集周期(秒)" type="number" value={form.collect_cycle} onChange={v => setForm(f => ({ ...f, collect_cycle: Number(v) || 300 }))} mono />
                <Input label="超时(ms)" type="number" value={form.timeout} onChange={v => setForm(f => ({ ...f, timeout: Number(v) || 10000 }))} mono />
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: 8 }}>
                <input type="checkbox" checked={!!form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked ? 1 : 0 }))} style={{ accentColor: GREEN }} />
                <span style={{ color: '#5a8aaa', fontSize: 12 }}>启用该数据源</span>
              </label>
              <div style={{ marginTop: 14, padding: '10px 12px', background: 'rgba(0,100,200,0.06)', border: '1px solid rgba(0,150,220,0.12)', borderRadius: 4, color: '#5a8aaa', fontSize: 11, lineHeight: 1.7 }}>
                重庆AQI接口：填 getThirtySixHourAQI 接口完整URL（从浏览器F12-网络面板复制）；点位过滤填区县名如「万州」。网页爬取类型填发布页地址。其余类型为占位，需真实参数后启用。
              </div>
            </div>
            <div style={{ padding: '14px 20px', borderTop: '1px solid rgba(0,80,150,0.2)', display: 'flex', gap: 8 }}>
              <button onClick={handleSave} style={{ flex: 1, padding: '8px 0', fontSize: 13, borderRadius: 3, border: `1px solid ${GREEN}55`, background: `${GREEN}18`, color: GREEN, cursor: 'pointer' }}>保存</button>
              <button onClick={() => setShowForm(false)} style={{ padding: '8px 20px', fontSize: 13, borderRadius: 3, border: '1px solid rgba(0,100,180,0.2)', background: 'transparent', color: '#5a8aaa', cursor: 'pointer' }}>取消</button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 200, padding: '10px 20px', background: 'rgba(0,30,70,0.95)', border: `1px solid ${CYAN}40`, borderRadius: 4, color: '#c8e6ff', fontSize: 13, boxShadow: '0 4px 20px rgba(0,0,0,0.5)' }}>
          {toast}
        </div>
      )}
    </div>
  )
}

function btnStyle(color: string): React.CSSProperties {
  return {
    padding: '3px 8px', fontSize: 11, borderRadius: 2, marginRight: 4,
    border: `1px solid ${color}44`, background: `${color}12`, color, cursor: 'pointer',
  }
}

const inputStyle: React.CSSProperties = {
  width: 64, padding: '5px 8px', background: 'rgba(0,20,60,0.6)',
  border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3, color: '#c8e6ff',
  fontSize: 12, outline: 'none', fontFamily: "'JetBrains Mono',monospace",
}
