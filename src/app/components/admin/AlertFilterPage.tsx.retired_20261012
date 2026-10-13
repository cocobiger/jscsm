import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../../lib/apiFetch'

// ── T8: 告警信息管理 · 过滤规则（5 维度条件 → 命中即从告警列表隐藏）──
const CYAN = '#00aaff'
const GREEN = '#00e676'
const RED = '#ff4444'

const btn = (color: string): React.CSSProperties => ({
  padding: '5px 12px', fontSize: 12, borderRadius: 3, border: `1px solid ${color}55`,
  background: `${color}15`, color, cursor: 'pointer',
})
const inputStyle: React.CSSProperties = {
  background: 'rgba(0,20,60,0.4)', border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3,
  color: '#c8e6ff', fontSize: 12, padding: '6px 10px', outline: 'none', width: '100%', boxSizing: 'border-box',
}

// 来源 4 枚举（与 SOURCE_META 一致）
const SOURCE_OPTIONS: Array<{ key: string; icon: string; label: string }> = [
  { key: 'cq_api', icon: '📊', label: '气体监测' },
  { key: 'iotcloud', icon: '📹', label: 'AI 视频分析' },
  { key: 'straw-engine', icon: '🔥', label: '秸秆检测' },
  { key: 'chengyun-platform', icon: '🏛️', label: '城运中心' },
]
// 等级 4 枚举（与 AlertHistoryModal LEVEL_COLORS 一致）
const LEVEL_OPTIONS: Array<{ key: number; label: string; color: string }> = [
  { key: 4, label: '重度', color: '#ff4444' },
  { key: 3, label: '中度', color: '#ff7043' },
  { key: 2, label: '轻度', color: '#ffd740' },
  { key: 1, label: '注意', color: '#64b5f6' },
]

interface FilterRule {
  id: string
  name: string
  enabled: boolean
  sources: string[]          // 空 = 不限来源
  locations: string[]        // 空 = 不限位置（channelName/pointName/deviceName/location 子串匹配）
  minConfidence: number | null  // null = 不限；命中 = AI 置信度(换算%) < 该值
  severities: number[]       // 空 = 不限等级（1注意 2轻度 3中度 4重度）
  remark: string
  createdAt: string
  updatedAt: string
}
interface FormState {
  name: string
  sources: string[]
  locations: string[]
  minConfidence: number | null
  severities: number[]
  remark: string
  enabled: boolean
}
const EMPTY_FORM: FormState = { name: '', sources: [], locations: [], minConfidence: null, severities: [], remark: '', enabled: true }

const srcLabel = (k: string) => SOURCE_OPTIONS.find(s => s.key === k)
const sevLabel = (n: number) => LEVEL_OPTIONS.find(l => l.key === n)

export function AlertFilterPage() {
  const [rules, setRules] = useState<FilterRule[]>([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<FormState>({ ...EMPTY_FORM })
  const [locInput, setLocInput] = useState('')
  const [chNames, setChNames] = useState<string[]>([])   // 已接入通道名（位置候选）

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3200) }

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([
      apiFetch<FilterRule[]>('/api/alert-filters').catch(() => []),
      apiFetch<Array<{ channelName: string }>>('/api/iot-channels').catch(() => []),
    ]).then(([rs, chs]) => {
      setRules(Array.isArray(rs) ? rs : [])
      if (Array.isArray(chs)) setChNames(chs.map(c => c.channelName).filter(Boolean))
      setLoading(false)
    }).catch(() => { setLoading(false) })
  }, [])
  useEffect(() => { load() }, [load])

  // 规则是否至少设置了一个维度（防空规则全隐藏告警）
  const hasAnyDim = (f: FormState) =>
    f.sources.length > 0 || f.locations.length > 0 || f.minConfidence !== null || f.severities.length > 0

  const openCreate = () => { setEditing(null); setForm({ ...EMPTY_FORM }); setFormOpen(true) }
  const openEdit = (r: FilterRule) => {
    setEditing(r.id)
    setForm({
      name: r.name, sources: r.sources || [], locations: r.locations || [],
      minConfidence: r.minConfidence, severities: (r.severities || []).map(Number),
      remark: r.remark || '', enabled: r.enabled,
    })
    setFormOpen(true)
  }
  const closeForm = () => { setFormOpen(false); setEditing(null) }

  const addLocation = (raw: string) => {
    const kw = raw.trim()
    if (!kw) return
    setForm(f => (f.locations.includes(kw) ? f : { ...f, locations: [...f.locations, kw] }))
    setLocInput('')
  }

  const save = async () => {
    if (!form.name.trim()) { flash('请填写规则名称'); return }
    if (!hasAnyDim(form)) { flash('请至少设置一个过滤维度（来源/位置/置信度/等级），否则会隐藏全部告警'); return }
    setBusy(true)
    try {
      const body = {
        name: form.name.trim(),
        sources: form.sources,
        locations: form.locations,
        minConfidence: form.minConfidence,
        severities: form.severities,
        remark: form.remark.trim(),
        enabled: form.enabled,
      }
      if (editing) await apiFetch(`/api/alert-filters/${editing}`, { method: 'PATCH', body: JSON.stringify(body) })
      else await apiFetch('/api/alert-filters', { method: 'POST', body: JSON.stringify(body) })
      flash(editing ? '规则已更新，即时生效' : '规则已创建，即时生效')
      closeForm()
      load()
    } catch (e: any) { flash('保存失败：' + (e?.error || String(e))) }
    finally { setBusy(false) }
  }
  const remove = async (id: string) => {
    if (!confirm('确定删除该过滤规则？删除后对应告警将重新出现在列表。')) return
    setBusy(true)
    try {
      await apiFetch(`/api/alert-filters/${id}`, { method: 'DELETE' })
      flash('规则已删除')
      load()
    } catch (e: any) { flash('删除失败：' + (e?.error || String(e))) }
    finally { setBusy(false) }
  }
  const toggleEnabled = async (r: FilterRule) => {
    try {
      await apiFetch(`/api/alert-filters/${r.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !r.enabled }) })
      load()
    } catch { flash('操作失败') }
  }

  const toggleInArr = <T,>(arr: T[], v: T): T[] => (arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v])
  const condSummary = (r: FilterRule): string => {
    const parts: string[] = []
    if (r.sources.length) parts.push('来源=' + r.sources.map(k => srcLabel(k)?.label || k).join('/'))
    if (r.locations.length) parts.push('位置~' + r.locations.join('、'))
    if (r.minConfidence !== null) parts.push(`置信度<${r.minConfidence}%`)
    if (r.severities.length) parts.push('等级=' + r.severities.map(n => sevLabel(n)?.label || String(n)).join('/'))
    return parts.join(' 且 ') || '（未设条件）'
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexShrink: 0 }}>
        <div>
          <div style={{ color: '#c8e6ff', fontSize: 16, fontWeight: 600 }}>告警信息管理 · 过滤规则</div>
          <div style={{ color: '#3a5a70', fontSize: 12, marginTop: 3 }}>
            按「来源 / 位置 / AI置信度 / 等级」配置过滤：命中规则的告警即时从告警列表隐藏（数据仍完整保留在库与统计，仅不再展示）
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} style={btn(CYAN)}>刷新</button>
          <button disabled={busy} onClick={openCreate} style={btn(GREEN)}>{busy ? '处理中…' : '新增过滤规则'}</button>
        </div>
      </div>

      {toast && (
        <div style={{ position: 'fixed', top: 80, right: 40, zIndex: 3000, background: 'rgba(0,40,80,0.95)', border: '1px solid rgba(0,150,220,0.3)', borderRadius: 6, padding: '10px 20px', color: CYAN, fontSize: 13 }}>
          {toast}
        </div>
      )}

      <span style={{ color: '#3a5a70', fontSize: 12, marginBottom: 8, flexShrink: 0 }}>
        共 <span style={{ color: CYAN, fontFamily: "'JetBrains Mono', monospace" }}>{rules.length}</span> 条规则 · 启用 <span style={{ color: GREEN, fontFamily: "'JetBrains Mono', monospace" }}>{rules.filter(r => r.enabled).length}</span> 条
      </span>

      {/* 规则列表 */}
      <div style={{ flex: 1, overflow: 'auto', border: '1px solid rgba(0,150,220,0.15)', borderRadius: 6 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 2.2fr 80px 70px 1.2fr', background: 'rgba(0,30,70,0.5)', padding: '8px 12px', fontSize: 11, color: '#3a5a70', fontWeight: 600, borderBottom: '1px solid rgba(0,150,220,0.15)', position: 'sticky', top: 0, zIndex: 2 }}>
          <span>规则名称</span><span>命中条件</span><span>启用</span><span>操作</span><span>备注</span>
        </div>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, color: '#3a5a70', fontSize: 13 }}>加载中…</div>
        ) : rules.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, color: '#3a5a70', fontSize: 13 }}>
            暂无过滤规则 —— 点右上「新增过滤规则」创建（如：隐藏某监测点低置信度的 AI 告警）
          </div>
        ) : (
          rules.map(r => (
            <div key={r.id} style={{
              display: 'grid', gridTemplateColumns: '1.6fr 2.2fr 80px 70px 1.2fr',
              padding: '8px 12px', borderBottom: '1px solid rgba(0,80,150,0.12)', alignItems: 'center', fontSize: 12, gap: 6,
            }}>
              <span style={{ color: '#c8e6ff', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{r.name}</span>
              <span style={{ color: '#9ad6f0', lineHeight: 1.7, minWidth: 0 }}>{condSummary(r)}</span>
              <span>
                <button onClick={() => toggleEnabled(r)} style={{
                  padding: '2px 8px', borderRadius: 10, fontSize: 11, cursor: 'pointer',
                  border: `1px solid ${r.enabled ? 'rgba(0,230,118,0.4)' : 'rgba(120,120,120,0.3)'}`,
                  background: r.enabled ? 'rgba(0,230,118,0.12)' : 'rgba(80,80,80,0.12)',
                  color: r.enabled ? GREEN : '#7a8a99',
                }}>{r.enabled ? '启用' : '禁用'}</button>
              </span>
              <span style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => openEdit(r)} style={{ ...btn(CYAN), padding: '3px 10px' }}>编辑</button>
                <button onClick={() => remove(r.id)} style={{ ...btn(RED), padding: '3px 10px' }}>删除</button>
              </span>
              <span style={{ color: '#3a5a70', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, fontSize: 11 }}>{r.remark || '—'}</span>
            </div>
          ))
        )}
      </div>

      {/* 新增/编辑表单 */}
      {formOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(2,8,20,0.8)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={e => { if (e.target === e.currentTarget) closeForm() }}>
          <div style={{ width: 620, maxWidth: '94vw', maxHeight: '88vh', overflowY: 'auto', background: 'linear-gradient(180deg,#040e25,#030c1e)', border: '1px solid rgba(0,150,220,0.3)', borderRadius: 6, padding: 20, boxShadow: '0 0 40px rgba(0,120,255,0.12)' }}>
            <div style={{ color: '#c8e6ff', fontSize: 15, fontWeight: 600, marginBottom: 16 }}>{editing ? '编辑过滤规则' : '新增过滤规则'}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Field label="规则名称">
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="如：隐藏苏商码头低置信度 dust" style={inputStyle} />
              </Field>

              <Field label="① 来源（多选，不选 = 不限）">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {SOURCE_OPTIONS.map(s => {
                    const checked = form.sources.includes(s.key)
                    return (
                      <label key={s.key} style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6, color: '#c8e6ff', fontSize: 12, cursor: 'pointer',
                        padding: '3px 9px', borderRadius: 3,
                        background: checked ? 'rgba(0,170,255,0.15)' : 'transparent',
                        border: `1px solid ${checked ? 'rgba(0,170,255,0.4)' : 'rgba(0,120,200,0.2)'}`,
                      }}>
                        <input type="checkbox" checked={checked} onChange={() => setForm(f => ({ ...f, sources: toggleInArr(f.sources, s.key) }))} style={{ cursor: 'pointer' }} />
                        {s.icon} {s.label}
                      </label>
                    )
                  })}
                </div>
              </Field>

              <Field label="② 位置（通道/监测点名包含关键字即命中；多关键字，不填 = 不限）">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', padding: 8, border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3, background: 'rgba(0,20,60,0.4)' }}>
                  {form.locations.map(kw => (
                    <span key={kw} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 3, background: 'rgba(0,170,255,0.12)', border: '1px solid rgba(0,170,255,0.3)', color: '#9ad6f0', fontSize: 12 }}>
                      {kw}
                      <button type="button" onClick={() => setForm(f => ({ ...f, locations: f.locations.filter(x => x !== kw) }))} style={{ padding: 0, border: 'none', background: 'transparent', color: '#ff8080', cursor: 'pointer', fontSize: 13, lineHeight: 1 }}>×</button>
                    </span>
                  ))}
                  <input
                    value={locInput}
                    onChange={e => setLocInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addLocation(locInput) } }}
                    onBlur={() => { if (locInput.trim()) addLocation(locInput) }}
                    placeholder={form.locations.length ? '继续输入关键字回车…' : '如：苏商码头、九龙沙场、周家坝'}
                    style={{ ...inputStyle, width: 200, border: 'none', background: 'transparent', padding: '2px 4px', flex: '0 1 auto' }}
                  />
                </div>
                {chNames.length > 0 && (
                  <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                    <span style={{ color: '#3a5a70', fontSize: 11 }}>已接入通道：</span>
                    {chNames.slice(0, 14).map(n => (
                      <button key={n} type="button" onClick={() => setForm(f => (f.locations.includes(n) ? f : { ...f, locations: [...f.locations, n] }))} style={{
                        fontSize: 11, padding: '1px 8px', borderRadius: 10, cursor: 'pointer', color: '#5a8aaa',
                        border: '1px dashed rgba(90,138,170,0.5)', background: 'transparent',
                      }}>{n}</button>
                    ))}
                  </div>
                )}
              </Field>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 14 }}>
                <Field label="③ AI 置信度下限（% ，0/空 = 不限）">
                  <input
                    type="number" min={0} max={100}
                    value={form.minConfidence ?? ''}
                    onChange={e => { const v = e.target.value; setForm(f => ({ ...f, minConfidence: v === '' ? null : Math.max(0, Math.min(100, Number(v))) })) }}
                    placeholder="如 40 = 隐藏 40% 以下" style={inputStyle}
                  />
                </Field>
                <Field label="④ 等级（多选，不选 = 不限）">
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {LEVEL_OPTIONS.map(lv => {
                      const checked = form.severities.includes(lv.key)
                      return (
                        <label key={lv.key} style={{
                          display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer',
                          padding: '2px 8px', borderRadius: 3, color: checked ? '#fff' : lv.color,
                          background: checked ? lv.color + '55' : 'transparent',
                          border: `1px solid ${lv.color}88`,
                        }}>
                          <input type="checkbox" checked={checked} onChange={() => setForm(f => ({ ...f, severities: toggleInArr(f.severities, lv.key) }))} style={{ cursor: 'pointer' }} />
                          {lv.label}
                        </label>
                      )
                    })}
                  </div>
                </Field>
              </div>

              <Field label="备注（可选）">
                <input value={form.remark} onChange={e => setForm(f => ({ ...f, remark: e.target.value }))} placeholder="记录规则用途 / 依据" style={inputStyle} />
              </Field>

              <Field label="启用">
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: '#5a8aaa', fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} />
                  {form.enabled ? '启用（命中即隐藏）' : '禁用（暂不生效）'}
                </label>
              </Field>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
              <button type="button" onClick={closeForm} style={btn('#5a8aaa')}>取消</button>
              <button type="button" disabled={busy} onClick={save} style={btn(GREEN)}>{busy ? '保存中…' : '保存'}</button>
            </div>
            <div style={{ marginTop: 12, color: '#3a5a70', fontSize: 11, lineHeight: 1.7 }}>
              说明：规则内各维度「同时满足」才命中；多条规则「任一命中」即隐藏。命中仅影响告警列表展示，原始记录完整保留（库内数据、趋势统计、AI分析存档均不受影响），随时可停用/删除规则恢复显示。
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
