import { authFetch } from '../../lib/apiFetch'
import { useEffect, useState } from 'react'

const CYAN = '#00aaff'
const GREEN = '#00e676'
const AMBER = '#ffd740'
const RED = '#ff4444'

// ── 点位类型 ────────────────────────────────────────────────
// 注：camera 类点位由视频流同步自动维护，不在本页手动录入
const POINT_TYPES = ['air', 'water', 'watermon', 'uav', 'alert'] as const
type PointType = typeof POINT_TYPES[number]
const TYPE_LABELS: Record<string, string> = {
  air: '大气监测点', water: '水质监测点', watermon: '流域监测站', uav: '无人机机场', alert: '告警点', camera: '摄像头(自动)',
}
const TYPE_COLORS: Record<string, string> = {
  air: '#1a7fff', water: '#00e5ff', watermon: '#00c8c8', uav: '#ab47bc', alert: '#ff4444', camera: '#00b84a',
}

// 各类型关联的扩展字段（除 name/lon/lat 外）
type FieldDef = { key: string; label: string; kind: 'number' | 'text'; unit?: string }
const TYPE_FIELDS: Record<string, FieldDef[]> = {
  air: [
    { key: 'aqi', label: 'AQI', kind: 'number' },
    { key: 'pm25', label: 'PM2.5', kind: 'number', unit: 'μg/m³' },
    { key: 'pm10', label: 'PM10', kind: 'number', unit: 'μg/m³' },
    { key: 'so2', label: 'SO₂', kind: 'number', unit: 'μg/m³' },
    { key: 'no2', label: 'NO₂', kind: 'number', unit: 'μg/m³' },
  ],
  water: [
    { key: 'ph', label: 'pH', kind: 'number' },
    { key: 'do_', label: '溶解氧', kind: 'number', unit: 'mg/L' },
    { key: 'nh3', label: '氨氮', kind: 'number', unit: 'mg/L' },
    { key: 'tp', label: '总磷', kind: 'number', unit: 'mg/L' },
  ],
  alert: [
    { key: 'alertType', label: '告警类型', kind: 'text' },
    { key: 'level', label: '告警等级', kind: 'number', unit: '1-4' },
  ],
  watermon: [],
  uav: [],
}
const ALL_KNOWN_KEYS = Array.from(new Set(Object.values(TYPE_FIELDS).flat().map(f => f.key)))

interface Point {
  id: string
  type: string
  name: string
  lon: number
  lat: number
  [k: string]: unknown
}

interface FormState {
  name: string
  type: PointType
  lon: string
  lat: string
  extra: Record<string, string>
}
const EMPTY: FormState = { name: '', type: 'air', lon: '', lat: '', extra: {} }

// ── shared input primitives（与 VideoStreamPage 一致） ──────
function Input({ label, value, onChange, placeholder, mono, type = 'text', hint }: {
  label: string; value: string; onChange: (v: string) => void
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
          outline: 'none', boxSizing: 'border-box',
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
          outline: 'none', boxSizing: 'border-box',
        }}
      >
        {options.map(o => <option key={o} value={o}>{labels ? labels[o] : o}</option>)}
      </select>
    </div>
  )
}

// ── main component ───────────────────────────────────────────
export function MapPointManage() {
  const [points, setPoints] = useState<Point[]>([])
  const [filter, setFilter] = useState<PointType | 'all'>('all')
  const [form, setForm] = useState<FormState>(EMPTY)
  const [editId, setEditId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null)
  const [rawExtra, setRawExtra] = useState('')   // 高级扩展字段 JSON
  const [error, setError] = useState('')

  const flash = (ok: boolean, text: string) => { setToast({ ok, text }); setTimeout(() => setToast(null), 3000) }

  const load = () => {
    authFetch('/api/map-points').then(r => r.ok ? r.json() : []).then(d => { if (Array.isArray(d)) setPoints(d) }).catch(() => {})
  }
  useEffect(() => { load() }, [])

  const filtered = filter === 'all' ? points : points.filter(p => p.type === filter)
  const typeCounts = POINT_TYPES.reduce<Record<string, number>>((acc, t) => {
    acc[t] = points.filter(p => p.type === t).length
    return acc
  }, {})

  const canSave = !!form.name && form.lon !== '' && form.lat !== '' &&
    !isNaN(Number(form.lon)) && !isNaN(Number(form.lat)) &&
    Number(form.lon) >= -180 && Number(form.lon) <= 180 &&
    Number(form.lat) >= -90 && Number(form.lat) <= 90

  const openAdd = () => {
    setForm(EMPTY); setEditId(null); setRawExtra(''); setError(''); setShowForm(true)
  }
  const openEdit = (p: Point) => {
    const extra: Record<string, string> = {}
    for (const f of TYPE_FIELDS[p.type] || []) {
      const v = p[f.key]
      if (v !== undefined && v !== null) extra[f.key] = String(v)
    }
    setForm({ name: p.name, type: (POINT_TYPES.includes(p.type as PointType) ? p.type : 'air') as PointType, lon: String(p.lon), lat: String(p.lat), extra })
    setEditId(p.id)
    setError('')
    // 预填非标准扩展字段（类型相关字段之外的其它字段）到 JSON 编辑器
    const known = new Set((TYPE_FIELDS[p.type] || []).map(f => f.key))
    const rest: Record<string, unknown> = {}
    for (const k of Object.keys(p)) {
      if (['id', 'type', 'name', 'lon', 'lat'].includes(k)) continue
      if (known.has(k)) continue
      rest[k] = p[k]
    }
    setRawExtra(Object.keys(rest).length ? JSON.stringify(rest, null, 2) : '')
    setShowForm(true)
  }

  const handleSave = async () => {
    if (!canSave) { setError('请填写名称与合法经纬度（经度 -180~180，纬度 -90~90）'); return }
    setError(''); setBusy(true)
    const payload: any = {
      name: form.name,
      type: form.type,
      lon: Number(form.lon),
      lat: Number(form.lat),
    }
    // 类型相关字段
    for (const f of TYPE_FIELDS[form.type] || []) {
      const v = form.extra[f.key]
      if (v !== undefined && v !== '') payload[f.key] = f.kind === 'number' ? Number(v) : v
    }
    // 编辑时清理其它类型遗留字段（置 undefined 由 JSON 序列化自动丢弃）
    if (editId) {
      for (const k of ALL_KNOWN_KEYS) {
        if (!(TYPE_FIELDS[form.type] || []).some(f => f.key === k)) payload[k] = undefined
      }
    }
    // 高级扩展字段 JSON
    if (rawExtra.trim()) {
      try {
        const parsed = JSON.parse(rawExtra)
        if (parsed && typeof parsed === 'object') Object.assign(payload, parsed)
      } catch (e: any) {
        setBusy(false); setError('扩展字段 JSON 解析失败：' + (e?.message || e))
        return
      }
    }

    try {
      const res = editId
        ? await authFetch(`/api/map-points/${editId}`, { method: 'PATCH', body: JSON.stringify(payload) })
        : await authFetch('/api/map-points', { method: 'POST', body: JSON.stringify(payload) })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setError(d.error || '保存失败')
      } else {
        flash(true, editId ? '已更新点位' : '已添加点位')
        setForm(EMPTY); setEditId(null); setRawExtra(''); setShowForm(false)
        load()
      }
    } catch (e: any) {
      setError(e?.error || e?.message || '保存失败')
    } finally { setBusy(false) }
  }

  const handleDelete = async (p: Point) => {
    if (!confirm(`确认删除点位「${p.name}」？此操作不可撤销。`)) return
    try {
      const res = await authFetch(`/api/map-points/${p.id}`, { method: 'DELETE' })
      if (res.ok) { flash(true, '已删除点位'); load() }
      else { const d = await res.json().catch(() => ({})); flash(false, d.error || '删除失败') }
    } catch (e: any) { flash(false, e?.error || '删除失败') }
  }

  // 列表里展示的类型相关字段摘要
  const extraSummary = (p: Point) => {
    const fields = TYPE_FIELDS[p.type] || []
    return fields
      .map(f => { const v = p[f.key]; return v !== undefined && v !== null ? `${f.label}:${v}` : null })
      .filter(Boolean)
      .join('  ')
  }

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Left: list */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid rgba(0,80,150,0.2)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <h2 style={{ color: '#c8e6ff', fontSize: 16, fontWeight: 600, flex: 1 }}>地图点位管理</h2>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            <button onClick={() => setFilter('all')} style={filterBtn('all', filter === 'all')}>全部 <span style={{ color: '#3a5a70', marginLeft: 3 }}>{points.length}</span></button>
            {POINT_TYPES.map(t => (
              <button key={t} onClick={() => setFilter(t)} style={filterBtn(t, filter === t)}>
                {TYPE_LABELS[t]} <span style={{ color: '#3a5a70', marginLeft: 3 }}>{typeCounts[t] ?? 0}</span>
              </button>
            ))}
          </div>
          <button onClick={openAdd} style={{ padding: '6px 16px', fontSize: 12, borderRadius: 3, border: `1px solid ${GREEN}55`, background: `${GREEN}18`, color: GREEN, cursor: 'pointer' }}>+ 添加点位</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
              <tr style={{ background: 'rgba(4,14,35,0.98)', borderBottom: '1px solid rgba(0,80,150,0.2)' }}>
                {['名称', '类型', '坐标 (Lat, Lon)', '类型数据', '操作'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: '#5a8aaa', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((p, i) => {
                const color = TYPE_COLORS[p.type] || '#5a8aaa'
                const sum = extraSummary(p)
                return (
                  <tr key={p.id} style={{ borderBottom: '1px solid rgba(0,50,100,0.15)', background: i % 2 === 0 ? 'transparent' : 'rgba(0,20,50,0.2)' }}>
                    <td style={{ padding: '9px 12px', color: '#c8e6ff', fontWeight: 500 }}>{p.name}</td>
                    <td style={{ padding: '9px 12px' }}>
                      <span style={{ padding: '2px 8px', borderRadius: 2, background: `${color}18`, color, fontSize: 11, border: `1px solid ${color}30` }}>{TYPE_LABELS[p.type] || p.type}</span>
                    </td>
                    <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>
                      <span style={{ color: '#00aaff', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
                        {Number(p.lat).toFixed(4)}<br />
                        <span style={{ color: '#3a5a70' }}>{Number(p.lon).toFixed(4)}</span>
                      </span>
                    </td>
                    <td style={{ padding: '9px 12px', color: '#5a8aaa', fontSize: 11 }}>{sum || <span style={{ color: '#2a4a60' }}>—</span>}</td>
                    <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>
                      <button onClick={() => openEdit(p)} style={{ padding: '3px 8px', fontSize: 11, borderRadius: 2, marginRight: 4, border: '1px solid rgba(0,150,220,0.3)', background: 'rgba(0,80,180,0.15)', color: CYAN, cursor: 'pointer' }}>编辑</button>
                      <button onClick={() => handleDelete(p)} style={{ padding: '3px 8px', fontSize: 11, borderRadius: 2, border: `1px solid ${RED}33`, background: `${RED}0d`, color: '#ff7070', cursor: 'pointer' }}>删除</button>
                    </td>
                  </tr>
                )
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={5} style={{ padding: '40px 0', textAlign: 'center', color: '#3a5a70', fontSize: 13 }}>暂无该类型点位</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Right: form drawer */}
      {showForm && (
        <div style={{ width: 360, flexShrink: 0, borderLeft: '1px solid rgba(0,150,220,0.2)', background: 'rgba(0,15,40,0.95)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid rgba(0,80,150,0.2)', flexShrink: 0 }}>
            <span style={{ color: '#c8e6ff', fontSize: 14, fontWeight: 600 }}>{editId ? '编辑点位' : '添加点位'}</span>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', scrollbarWidth: 'none' }}>
            <Input label="点位名称 *" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} placeholder="如：周家坝监测站" />
            <Select label="点位类型" value={form.type} options={POINT_TYPES} labels={TYPE_LABELS}
              onChange={v => setForm(f => ({ ...f, type: v, extra: {} }))}
              hint="摄像头(camera)由视频流自动维护，不在此手动录入" />

            {/* 经纬度 */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 4 }}>坐标 *</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div>
                  <div style={{ color: '#3a5a70', fontSize: 10, marginBottom: 3 }}>纬度 (Lat)</div>
                  <input type="number" step="0.0001" value={form.lat}
                    onChange={e => setForm(f => ({ ...f, lat: e.target.value }))}
                    placeholder="30.8404"
                    style={coordInputStyle} />
                </div>
                <div>
                  <div style={{ color: '#3a5a70', fontSize: 10, marginBottom: 3 }}>经度 (Lon)</div>
                  <input type="number" step="0.0001" value={form.lon}
                    onChange={e => setForm(f => ({ ...f, lon: e.target.value }))}
                    placeholder="108.3723"
                    style={coordInputStyle} />
                </div>
              </div>
              {form.lat !== '' && form.lon !== '' && !isNaN(Number(form.lat)) && !isNaN(Number(form.lon)) && (
                <div style={{ marginTop: 6, padding: '5px 8px', background: 'rgba(0,170,255,0.06)', border: '1px solid rgba(0,170,255,0.15)', borderRadius: 3, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#5a8aaa" strokeWidth="2"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" /><circle cx="12" cy="9" r="2.5" /></svg>
                  <span style={{ color: '#5a8aaa', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>{Number(form.lat).toFixed(4)}, {Number(form.lon).toFixed(4)}</span>
                  <a href={`https://uri.amap.com/marker?position=${form.lon},${form.lat}&name=${encodeURIComponent(form.name || '点位')}`} target="_blank" rel="noreferrer" style={{ color: AMBER, fontSize: 10, marginLeft: 'auto', textDecoration: 'none' }}>在地图查看 →</a>
                </div>
              )}
            </div>

            {/* 类型相关字段 */}
            {(TYPE_FIELDS[form.type] || []).length > 0 && (
              <div style={{ background: 'rgba(0,60,120,0.08)', border: '1px solid rgba(0,150,220,0.2)', borderRadius: 4, padding: '14px', marginBottom: 12 }}>
                <div style={{ color: '#7ab8e0', fontSize: 12, fontWeight: 600, marginBottom: 12 }}>{TYPE_LABELS[form.type]} 监测数据</div>
                {(TYPE_FIELDS[form.type] || []).map(f => (
                  <Input key={f.key} label={`${f.label}${f.unit ? ` (${f.unit})` : ''}`}
                    value={form.extra[f.key] || ''}
                    onChange={v => setForm(s => ({ ...s, extra: { ...s.extra, [f.key]: v } }))}
                    type={f.kind === 'number' ? 'number' : 'text'}
                    placeholder={f.kind === 'number' ? '0' : ''}
                    mono={f.kind === 'number'} />
                ))}
              </div>
            )}

            {/* 高级扩展字段 JSON */}
            <div style={{ marginBottom: 8 }}>
              <label style={{ color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 4 }}>扩展字段（JSON，可选）</label>
              <textarea value={rawExtra} onChange={e => setRawExtra(e.target.value)} placeholder={'{\n  "remark": "备注信息"\n}'}
                style={{ width: '100%', minHeight: 80, padding: '8px 10px', background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3, color: '#c8e6ff', fontSize: 12, fontFamily: "'JetBrains Mono', monospace", outline: 'none', resize: 'vertical', boxSizing: 'border-box' }} />
              <div style={{ color: '#3a5a70', fontSize: 10, marginTop: 3 }}>用于补充任意其它字段（如备注、设备编号），会合并进点位数据</div>
            </div>

            {error && <div style={{ color: RED, fontSize: 12, marginBottom: 8 }}>✗ {error}</div>}
          </div>

          <div style={{ padding: '14px 20px', borderTop: '1px solid rgba(0,80,150,0.2)', display: 'flex', gap: 8, flexShrink: 0 }}>
            <button onClick={handleSave} disabled={busy || !canSave} style={{ flex: 1, padding: '8px 0', fontSize: 13, borderRadius: 3, border: `1px solid ${GREEN}55`, background: `${GREEN}18`, color: canSave ? GREEN : '#3a5a70', cursor: canSave ? 'pointer' : 'default' }}>保存</button>
            <button onClick={() => { setForm(EMPTY); setEditId(null); setRawExtra(''); setShowForm(false) }} style={{ padding: '8px 20px', fontSize: 13, borderRadius: 3, border: '1px solid rgba(0,100,180,0.2)', background: 'transparent', color: '#5a8aaa', cursor: 'pointer' }}>取消</button>
          </div>
        </div>
      )}

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 4000, background: '#061530', border: `1px solid ${toast.ok ? GREEN : RED}55`, borderRadius: 4, padding: '10px 20px', color: '#c8e6ff', fontSize: 13, boxShadow: '0 4px 20px rgba(0,0,0,0.5)' }}>
          {toast.ok ? '✓ ' : '✗ '}{toast.text}
        </div>
      )}
    </div>
  )
}

const coordInputStyle: React.CSSProperties = {
  width: '100%', padding: '7px 10px', background: 'rgba(0,20,60,0.6)',
  border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3, color: '#00aaff',
  fontSize: 12, fontFamily: "'JetBrains Mono', monospace", outline: 'none', boxSizing: 'border-box',
}

function filterBtn(key: string, active: boolean): React.CSSProperties {
  return {
    padding: '4px 10px', fontSize: 11, borderRadius: 3,
    border: `1px solid ${active ? CYAN : 'rgba(0,150,220,0.2)'}`,
    background: active ? `${CYAN}18` : 'transparent',
    color: active ? CYAN : '#5a8aaa', cursor: 'pointer', whiteSpace: 'nowrap',
  }
}
