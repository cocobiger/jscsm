/**
 * StackChainPanel.tsx —— 「堆头未覆盖」链后台配置面板（批次4 / Step3 · 2026-09-20）
 *
 * 设计原则（与后端契约严格对齐）：
 *   ① **单一真源在 11 机** `/soft/data/stack-chain/stack_config.json`。
 *      本组件不缓存配置，只做「读 → 编辑 → 提交增量 → 回读刷新」。
 *   ② **字段说明一律来自后端** `tunable[k].desc`（含值域 min/max、只读护栏 desc），
 *      前端不复制任何语义文案 → 后端改了说明，页面自动跟着变，不会"文档与界面不一致"。
 *      前端只维护「中文显示名」这一层纯展示映射（LABELS）。
 *   ③ **只提交改动键**（diff 提交）：避免把 `null`（＝未显式设置、用默认值）写回去，
 *      也避免"改一个字段顺带覆盖别人刚改的另一个字段"。
 *   ④ 生效语义显式告知：常驻链每轮重读配置 → **≤2 秒生效、无需重启**（后端 apply_hint 原话）。
 */
import { useState, useEffect, useCallback, useMemo } from 'react'
import { apiFetch } from '../../lib/apiFetch'
import { roleAtLeast, type CurrentUser } from '../../lib/auth'

const CYAN = '#00aaff'
const GREEN = '#00e676'
const AMBER = '#ffd740'
const RED = '#ff4444'
const DIM = '#5a8aaa'

const btn = (color: string, disabled = false): React.CSSProperties => ({
  padding: '5px 14px', fontSize: 12, borderRadius: 3, border: `1px solid ${color}55`,
  background: disabled ? 'transparent' : `${color}15`, color: disabled ? '#3a5a70' : color,
  cursor: disabled ? 'default' : 'pointer',
})

const inputStyle: React.CSSProperties = {
  padding: '5px 8px', background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.25)',
  borderRadius: 3, color: '#c8e6ff', fontSize: 12, outline: 'none', width: '100%',
}

/** 纯展示层：中文显示名（语义/值域/说明全部来自后端 desc，不在此重复） */
const LABELS: Record<string, string> = {
  enabled: '整链总开关',
  interval_s: '抓图间隔（秒）',
  daily_window: '每日生效时段',
  frame_source: '帧来源',
  parallel_max: '实时抓帧并发上限',
  max_frame_age_s: '常驻帧最大帧龄（秒）',
  keep_frames: '保留原始帧',
  keep_days: '帧保留天数',
  min_free_gb: '磁盘余量安全线（GB）',
  keep_forever_enabled: '高置信帧永久保留',
  keep_forever_conf: '永久保留门限（置信度）',
  infrared_enabled: '红外/黑白门控',
  sharpness_enabled: '清晰度门控',
  min_stack_conf: '告警门限（置信度）',
  min_sharpness: '清晰度门限（Laplacian 方差）',
  min_color_frac: '红外判据（彩色像素占比）',
  min_record_interval_s: '同通道冷却（秒）',
  record_no_detection: '记录「无检出」负样本',
}
const labelOf = (k: string) => LABELS[k] || k

interface Tunable { type: 'bool' | 'int' | 'float' | 'enum' | 'window'; min?: number | string[] | null; max?: number | null; desc: string }
interface Guardrail { value: any; desc: string }
interface Channel { name: string; channel_sip_id: string; enable: boolean }
interface Status {
  ok: boolean
  upstream?: { base: string; ok: boolean; error: string | null }
  error?: string
  values?: Record<string, any>
  defaults?: Record<string, any>
  tunable?: Record<string, Tunable>
  readonly?: Record<string, Guardrail>
  channels?: Channel[]
  backups?: string[]
  apply_hint?: string
  config_path?: string
  config_mtime?: number
  presets?: { interval_s?: number[]; daily_window?: Array<{ label: string; value: Array<{ start: string; end: string }> }> }
  history?: Array<Record<string, any>>
}
interface Change { from: any; to: any }

/** 把后端 desc 里的 `**粗体**` 与 `` `代码` `` 渲染成节点（desc 是 markdown-lite） */
function renderDesc(s: string) {
  const parts: React.ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0, m: RegExpExecArray | null, i = 0
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) parts.push(s.slice(last, m.index))
    const t = m[0]
    if (t.startsWith('**')) parts.push(<b key={i++} style={{ color: '#8fd4ff', fontWeight: 600 }}>{t.slice(2, -2)}</b>)
    else parts.push(<code key={i++} style={{ background: 'rgba(0,150,220,0.12)', padding: '0 4px', borderRadius: 2, fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>{t.slice(1, -1)}</code>)
    last = m.index + t.length
  }
  if (last < s.length) parts.push(s.slice(last))
  return parts
}

/** 统一比较（daily_window 需按值比较，不能比引用） */
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b)

export function StackChainPanel({ user }: { user: CurrentUser }) {
  const isAdmin = roleAtLeast(user.role, 'admin')
  const [st, setSt] = useState<Status | null>(null)
  const [draft, setDraft] = useState<Record<string, any>>({})
  const [chDraft, setChDraft] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'warn'; text: string } | null>(null)
  const [rollbackTo, setRollbackTo] = useState('')
  const [result, setResult] = useState<any>(null)

  const tun = st?.tunable || {}
  const vals = st?.values || {}
  const defs = st?.defaults || {}

  const flash = (kind: 'ok' | 'err' | 'warn', text: string) => {
    setMsg({ kind, text })
    setTimeout(() => setMsg(null), 6000)
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await apiFetch<Status>('/api/stack-config/status')
      setSt(d)
      // draft = 当前生效值：null（未显式写入）→ 用默认值展示，并单独标记
      const v: Record<string, any> = {}
      for (const k of Object.keys(d.tunable || {})) v[k] = (d.values?.[k] === null || d.values?.[k] === undefined) ? (d.defaults?.[k] ?? null) : d.values?.[k]
      setDraft(v)
      const cm: Record<string, boolean> = {}
      for (const c of d.channels || []) cm[c.channel_sip_id] = c.enable
      setChDraft(cm)
    } catch (e: any) {
      setSt({ ok: false, error: e?.error || String(e) })
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  // 改动集合（只提交 diff）
  const dirtyKeys = useMemo(() => {
    const out: string[] = []
    for (const k of Object.keys(tun)) {
      // 值为 null 的键（未显式设置）若用户没改，就不算 diff → 不会被写回 null
      if (vals[k] === null || vals[k] === undefined) {
        if (draft[k] !== (defs[k] ?? null)) out.push(k)
        continue
      }
      if (!same(draft[k], vals[k])) out.push(k)
    }
    return out
  }, [tun, vals, defs, draft])
  const dirtyCh = useMemo(
    () => (st?.channels || []).filter(c => chDraft[c.channel_sip_id] !== c.enable).map(c => c.channel_sip_id),
    [st, chDraft])
  const dirtyCount = dirtyKeys.length + dirtyCh.length

  const numeric = (k: string, v: string) => {
    const t = tun[k]?.type
    if (t === 'int') return v === '' ? '' : Math.round(Number(v))
    return v === '' ? '' : Number(v)
  }

  const save = async () => {
    if (!dirtyCount || !isAdmin) return
    setBusy(true); setResult(null)
    try {
      const values: Record<string, any> = {}
      for (const k of dirtyKeys) {
        const t = tun[k]?.type
        if (t === 'int') values[k] = Math.round(Number(draft[k]))
        else if (t === 'float') values[k] = Number(draft[k])
        else values[k] = draft[k]
      }
      const body: Record<string, any> = {}
      if (Object.keys(values).length) body.values = values
      if (dirtyCh.length) { const m: Record<string, boolean> = {}; for (const s of dirtyCh) m[s] = chDraft[s]; body.channels_enable = m }
      const r = await apiFetch<any>('/api/stack-config/apply', { method: 'POST', body: JSON.stringify(body) })
      setResult(r)
      flash('ok', '已保存' + (r?.note ? ' · ' + r.note : '') + '（备份 ' + (r?.backup || '?') + '）')
      await load()
    } catch (e: any) {
      flash('err', '保存失败：' + (e?.error || e))
    } finally { setBusy(false) }
  }

  const doRollback = async () => {
    if (!rollbackTo || !isAdmin) return
    setBusy(true); setResult(null)
    try {
      const r = await apiFetch<any>('/api/stack-config/rollback', { method: 'POST', body: JSON.stringify({ backup: rollbackTo }) })
      setResult(r)
      const n = Object.keys(r?.changed || {}).length
      flash('ok', '已回滚（' + n + ' 项变更）· 来源 ' + (r?.from || rollbackTo))
      setRollbackTo('')
      await load()
    } catch (e: any) {
      flash('err', '回滚失败：' + (e?.error || e))
    } finally { setBusy(false) }
  }

  /** 数值型控件（带值域提示 + 进度感的滑块用于门限类） */
  const numField = (k: string) => {
    const t = tun[k]; if (!t) return null
    const isFloat = t.type === 'float'
    const isDirty = dirtyKeys.includes(k)
    return (
      <div key={k} style={cardStyle}>
        <FieldHead label={labelOf(k)} desc={t.desc} dirty={isDirty} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
          <input type="number" value={draft[k] ?? ''} step={isFloat ? 0.01 : 1}
            min={typeof t.min === 'number' ? t.min : undefined} max={t.max ?? undefined}
            onChange={e => setDraft(d => ({ ...d, [k]: numeric(k, e.target.value) }))}
            style={{ ...inputStyle, width: 110, fontFamily: "'JetBrains Mono', monospace" }} />
          <span style={{ color: DIM, fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
            范围 {String(t.min ?? '—')} – {String(t.max ?? '—')}
            {!same(vals[k], defs[k]) && <span style={{ marginLeft: 10, color: '#3a5a70' }}>默认 {String(defs[k])}</span>}
          </span>
        </div>
      </div>
    )
  }

  const boolField = (k: string, hint?: string) => {
    const t = tun[k]; if (!t) return null
    const isDirty = dirtyKeys.includes(k)
    const notExplicit = vals[k] === null || vals[k] === undefined
    const on = !!draft[k]
    return (
      <div key={k} style={cardStyle}>
        <FieldHead label={labelOf(k)} desc={t.desc} dirty={isDirty} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
          <button onClick={() => setDraft(d => ({ ...d, [k]: !on }))} style={{
            ...btn(on ? GREEN : '#546e7a'), minWidth: 76,
          }}>{on ? '已开启' : '已关闭'}</button>
          {notExplicit && !isDirty && (
            <span style={{ fontSize: 11, color: AMBER }}>默认（配置里未显式写入，生效值＝默认）</span>
          )}
          {hint && <span style={{ fontSize: 11, color: '#3a5a70' }}>{hint}</span>}
        </div>
      </div>
    )
  }

  const enumField = (k: string) => {
    const t = tun[k]; if (!t) return null
    const opts = Array.isArray(t.min) ? (t.min as string[]) : []
    const isDirty = dirtyKeys.includes(k)
    return (
      <div key={k} style={cardStyle}>
        <FieldHead label={labelOf(k)} desc={t.desc} dirty={isDirty} />
        <select value={draft[k] ?? ''} onChange={e => setDraft(d => ({ ...d, [k]: e.target.value }))}
          style={{ ...inputStyle, marginTop: 8, width: 220 }}>
          {opts.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
    )
  }

  /** 多段时段编辑器（最多 6 段；跨天需拆两段——这条语义来自后端 desc/校验） */
  const windowField = (k: string) => {
    const t = tun[k]; if (!t) return null
    const segs: Array<{ start: string; end: string }> = Array.isArray(draft[k]) ? draft[k] : []
    const isDirty = dirtyKeys.includes(k)
    const set = (n: Array<{ start: string; end: string }>) => setDraft(d => ({ ...d, [k]: n }))
    return (
      <div key={k} style={{ ...cardStyle, gridColumn: '1 / -1' }}>
        <FieldHead label={labelOf(k)} desc={t.desc} dirty={isDirty} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8, alignItems: 'center' }}>
          {segs.length === 0 && <span style={{ color: AMBER, fontSize: 12 }}>当前为空 ＝ 全天生效（不限制时段）</span>}
          {segs.map((s, i) => (
            <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3, padding: '3px 6px' }}>
              <input type="time" value={s.start} onChange={e => { const n = segs.slice(); n[i] = { ...n[i], start: e.target.value }; set(n) }}
                style={{ ...inputStyle, width: 96, padding: '2px 4px' }} />
              <span style={{ color: DIM }}>→</span>
              <input type="time" value={s.end} onChange={e => { const n = segs.slice(); n[i] = { ...n[i], end: e.target.value }; set(n) }}
                style={{ ...inputStyle, width: 96, padding: '2px 4px' }} />
              <button onClick={() => set(segs.filter((_, j) => j !== i))} style={{ ...btn(RED), padding: '2px 8px' }}>×</button>
            </span>
          ))}
          {segs.length < 6 && (
            <button onClick={() => set([...segs, { start: '08:00', end: '19:00' }])} style={btn(CYAN)}>+ 加一段</button>
          )}
        </div>
        {(st?.presets?.daily_window || []).length > 0 && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <span style={{ color: '#3a5a70', fontSize: 11, alignSelf: 'center' }}>快捷：</span>
            {(st?.presets?.daily_window || []).map((p, i) => (
              <button key={i} onClick={() => set(p.value)} style={btn('#7fb3d5')}>{p.label}</button>
            ))}
          </div>
        )}
      </div>
    )
  }

  if (loading && !st) return <div style={{ color: DIM, padding: 20 }}>加载堆头链配置中…</div>

  if (st && !st.ok) {
    return (
      <div style={{ padding: 16, overflow: 'auto' }}>
        <div style={{ padding: 14, borderRadius: 5, border: '1px solid rgba(255,68,68,0.35)', background: 'rgba(255,68,68,0.06)', color: '#ff8080', fontSize: 13 }}>
          <b>读不到堆头链配置</b>
          <div style={{ marginTop: 6, color: '#e0a0a0' }}>{st.error || '未知错误'}</div>
          {st.upstream && (
            <div style={{ marginTop: 6, fontSize: 12, color: DIM, fontFamily: "'JetBrains Mono', monospace" }}>
              上游 = {st.upstream.base}（{st.upstream.ok ? '可达' : '不可达: ' + st.upstream.error}）
            </div>
          )}
          <div style={{ marginTop: 10 }}><button onClick={load} style={btn(CYAN)}>重试</button></div>
        </div>
      </div>
    )
  }

  const ch = st?.channels || []

  return (
    <div style={{ flex: 1, overflow: 'auto', paddingRight: 4 }}>
      {/* ── 顶部：生效语义 + 状态 + 操作 ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 320 }}>
          <div style={{ color: '#c8e6ff', fontSize: 15, fontWeight: 600 }}>堆头未覆盖 · 定时抓图与门限</div>
          <div style={{ color: AMBER, fontSize: 12, marginTop: 4 }}>{st?.apply_hint || '保存后由常驻链下一轮重读配置生效'}</div>
          <div style={{ color: '#3a5a70', fontSize: 11, marginTop: 3, fontFamily: "'JetBrains Mono', monospace" }}>
            真源 {st?.config_path}
            {st?.config_mtime ? ' · 最后写入 ' + new Date(st.config_mtime * 1000 + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' (上海时)' : ''}
            {' · 上游 ' + (st?.upstream?.base || '')}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {!isAdmin && (
            <span style={{ fontSize: 11, color: AMBER, border: `1px solid ${AMBER}55`, borderRadius: 3, padding: '4px 8px' }}>
              只读：当前身份（{user.role}）无修改权限
            </span>
          )}
          <button onClick={load} disabled={busy} style={btn(CYAN, busy)}>刷新</button>
          <button onClick={() => { setDraft({ ...draft }); setChDraft({ ...chDraft }); setRollbackTo(''); setResult(null); load() }} disabled={busy} style={btn('#7fb3d5', busy)}>放弃改动</button>
          <button onClick={save} disabled={busy || !dirtyCount || !isAdmin} style={btn(GREEN, busy || !dirtyCount || !isAdmin)}>
            {busy ? '提交中…' : `保存${dirtyCount ? '（' + dirtyCount + ' 项）' : ''}`}
          </button>
        </div>
      </div>

      {msg && (
        <div style={{
          marginBottom: 10, padding: '8px 12px', borderRadius: 4, fontSize: 12,
          border: `1px solid ${(msg.kind === 'ok' ? GREEN : msg.kind === 'err' ? RED : AMBER)}55`,
          background: `${(msg.kind === 'ok' ? GREEN : msg.kind === 'err' ? RED : AMBER)}12`,
          color: msg.kind === 'ok' ? GREEN : msg.kind === 'err' ? '#ff8080' : AMBER,
        }}>{msg.text}</div>
      )}

      {/* ── ① 调度 ── */}
      <Section title="调度（抓图节奏 / 生效时段 / 帧来源）"
        note="间隔与时段决定「跑多密、什么时候跑」；帧来源决定「用常驻取帧器还是每轮实时抓帧」。">
        <div style={gridStyle}>
          {boolField('enabled')}
          {numField('interval_s')}
          {enumField('frame_source')}
          {numField('parallel_max')}
          {numField('max_frame_age_s')}
          {windowField('daily_window')}
        </div>
        {(st?.presets?.interval_s || []).length > 0 && (
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <span style={{ color: '#3a5a70', fontSize: 11, alignSelf: 'center' }}>间隔快捷：</span>
            {(st?.presets?.interval_s || []).map(v => (
              <button key={v} onClick={() => setDraft(d => ({ ...d, interval_s: v }))} style={btn('#7fb3d5')}>{v}s</button>
            ))}
          </div>
        )}
      </Section>

      {/* ── ② 逐路开关 ── */}
      <Section title={`逐路开关（${ch.filter(c => chDraft[c.channel_sip_id]).length}/${ch.length} 启用）`}
        note="单独停某一路的堆头识别；其它路不受影响。关掉后该路不再抓帧、不再产生记录。">
        <div style={{ ...gridStyle, gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
          {ch.map(c => {
            const on = !!chDraft[c.channel_sip_id]
            const dirty = dirtyCh.includes(c.channel_sip_id)
            return (
              <div key={c.channel_sip_id} style={{ ...cardStyle, marginBottom: 0, borderColor: dirty ? AMBER + '77' : 'rgba(0,120,200,0.2)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: on ? GREEN : '#546e7a', boxShadow: on ? `0 0 6px ${GREEN}88` : 'none' }} />
                  <span style={{ color: '#c8e6ff', fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.name}>{c.name}</span>
                  <button onClick={() => {
                    // 2026-10-10：停用为危险动作（点错即停一路抓图）——加二次确认
                    if (on && !window.confirm(`停用「${c.name}」？\n\n停用后该路不再抓帧、不再产生记录（其它路不受影响）。`)) return
                    setChDraft(m => ({ ...m, [c.channel_sip_id]: !on }))
                  }} style={btn(on ? RED : GREEN)}>{on ? '停用' : '启用'}</button>
                </div>
                <div style={{ color: '#3a5a70', fontSize: 10, marginTop: 5, fontFamily: "'JetBrains Mono', monospace" }}>{c.channel_sip_id}</div>
              </div>
            )
          })}
        </div>
      </Section>

      {/* ── ③ 识别门限 ── */}
      <Section title="识别门限"
        note="决定「哪些帧进去推理、什么结果算告警」。调低告警门限会多收边界样本（也更容易误报）。">
        <div style={gridStyle}>
          {numField('min_stack_conf')}
          {numField('min_sharpness')}
          {numField('min_color_frac')}
          {numField('min_record_interval_s')}
        </div>
      </Section>

      {/* ── ④ 门控总闸 ── */}
      <Section title="门控总闸"
        note="关掉会放进原本被拦下的帧（红外/模糊），一般只在专项排查期临时关。">
        <div style={gridStyle}>
          {boolField('infrared_enabled')}
          {boolField('sharpness_enabled')}
        </div>
      </Section>

      {/* ── ⑤ 帧与磁盘保留 ── */}
      <Section title="帧与磁盘保留"
        note="「保留天数 × 抓图频率」是乘法关系：调密抓图前先看这里，否则磁盘会被迅速吃掉。">
        <div style={gridStyle}>
          {boolField('keep_frames')}
          {numField('keep_days')}
          {numField('min_free_gb')}
          {boolField('keep_forever_enabled')}
          {numField('keep_forever_conf')}
          {boolField('record_no_detection')}
        </div>
      </Section>

      {/* ── ⑥ 只读护栏 ── */}
      {(st?.readonly && Object.keys(st.readonly).length > 0) && (
        <Section title="只读护栏（后台展示，不可改）"
          note="这些值改动属发布行为（换权重/改输入尺寸/改归档目录），需要走代码或部署，故不在此开放。">
          <div style={gridStyle}>
            {Object.entries(st.readonly).map(([k, g]) => (
              <div key={k} style={{ ...cardStyle, borderColor: 'rgba(120,120,120,0.25)', background: 'rgba(30,30,40,0.35)' }}>
                <FieldHead label={labelOf(k)} desc={g.desc} locked />
                <div style={{ marginTop: 8, color: '#8a9aa8', fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }}>
                  🔒 {String(g.value)}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* ── ⑦ 备份与回滚 ── */}
      <Section title="备份与回滚"
        note="每次保存/回滚都会先留一份「改之前」的快照。回滚只恢复上表这些可调键与逐路开关，不动通道等其它配置。">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={rollbackTo} onChange={e => setRollbackTo(e.target.value)} style={{ ...inputStyle, width: 320 }}>
            <option value="">选择要回滚到的备份…</option>
            {(st?.backups || []).map(b => <option key={b} value={b}>{b}</option>)}
          </select>
          <button onClick={doRollback} disabled={busy || !rollbackTo || !isAdmin} style={btn(AMBER, busy || !rollbackTo || !isAdmin)}>回滚到该备份</button>
          <span style={{ color: '#3a5a70', fontSize: 11 }}>共 {(st?.backups || []).length} 份</span>
        </div>
      </Section>

      {/* ── ⑧ 本次提交结果 ── */}
      {result && (
        <Section title="本次提交结果" note="后端逐项回读校验后的实际差异（值取自 11 机回读，不是前端推测）。">
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#9fc7e0' }}>
            <div>ok = {String(result.ok)} {result.error ? '· error = ' + result.error : ''}</div>
            {result.backup && <div>backup = {result.backup}</div>}
            {result.note && <div>note = {result.note}</div>}
            {result.stripped?.length ? <div style={{ color: AMBER }}>stripped（未提交，值=null 表示用默认值）= {result.stripped.join(',')}</div> : null}
            {result.warnings?.length ? <div style={{ color: AMBER }}>{result.warnings.join(' / ')}</div> : null}
            <div style={{ marginTop: 6 }}>
              {Object.entries((result.changed || {}) as Record<string, Change>).map(([k, v]) => (
                <div key={k} style={{ color: same(v.from, v.to) ? '#5a8aaa' : GREEN }}>
                  {k}: {JSON.stringify(v.from)} → {JSON.stringify(v.to)}
                </div>
              ))}
              {!Object.keys(result.changed || {}).length && <span style={{ color: '#5a8aaa' }}>（无字段变更）</span>}
            </div>
          </div>
        </Section>
      )}

      {/* ── ⑨ 操作历史 ── */}
      <Section title={`操作历史（最近 ${Math.min(20, (st?.history || []).length)} 条）`}
        note="谁、什么时候、改了什么、成功与否。这份记录存在驾驶舱后端，不随配置回滚。">
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
          {(st?.history || []).slice(0, 20).map((h, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, padding: '3px 0', borderBottom: '1px solid rgba(0,120,200,0.08)' }}>
              <span style={{ color: '#5a8aaa', width: 150 }}>{h.at}</span>
              <span style={{ color: h.result === 'ok' ? GREEN : '#ff8080', width: 60 }}>{h.action}</span>
              <span style={{ color: '#8fa8bb', width: 80 }}>{h.by}</span>
              <span style={{ color: '#9fc7e0', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {h.error ? 'err: ' + h.error : Object.keys(h.changed || {}).join(', ') || '—'}
              </span>
            </div>
          ))}
          {!(st?.history || []).length && <span style={{ color: '#5a8aaa' }}>暂无记录</span>}
        </div>
      </Section>

      {/* ── 吸底操作条（2026-10-10：滚到底部改完字段后就地保存，免滚回顶部）── */}
      {dirtyCount > 0 && (
        <div style={{
          position: 'sticky', bottom: 0, marginTop: 12, padding: '10px 14px',
          background: 'rgba(0,14,40,0.96)', border: `1px solid ${AMBER}55`, borderRadius: 6,
          display: 'flex', alignItems: 'center', gap: 12, zIndex: 10,
        }}>
          <span style={{ color: AMBER, fontSize: 12, flex: 1 }}>有 {dirtyCount} 项改动待保存</span>
          <button onClick={() => { setChDraft({ ...chDraft }); load() }} disabled={busy} style={btn('#7fb3d5', busy)}>放弃改动</button>
          <button onClick={save} disabled={busy || !isAdmin} style={btn(GREEN, busy || !isAdmin)}>
            {busy ? '提交中…' : `保存（${dirtyCount} 项）`}
          </button>
        </div>
      )}
    </div>
  )
}

const gridStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 10,
}
const cardStyle: React.CSSProperties = {
  border: '1px solid rgba(0,120,200,0.2)', borderRadius: 5, padding: '10px 12px',
  background: 'rgba(0,20,60,0.35)',
}

function FieldHead({ label, desc, dirty, locked }: { label: string; desc: string; dirty?: boolean; locked?: boolean }) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 600 }}>{label}</span>
        {locked && <span style={{ fontSize: 10, color: '#8a9aa8' }}>只读</span>}
        {dirty && <span style={{ fontSize: 10, color: AMBER, border: `1px solid ${AMBER}55`, borderRadius: 8, padding: '0 6px' }}>已改动</span>}
      </div>
      <div style={{ color: DIM, fontSize: 11, lineHeight: 1.55, marginTop: 4 }}>{renderDesc(desc || '')}</div>
    </>
  )
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16, border: '1px solid rgba(0,120,200,0.18)', borderRadius: 6, padding: '12px 14px', background: 'rgba(0,14,40,0.25)' }}>
      <div style={{ color: CYAN, fontSize: 13, fontWeight: 600, marginBottom: note ? 3 : 10 }}>{title}</div>
      {note && <div style={{ color: '#3a5a70', fontSize: 11, marginBottom: 10 }}>{note}</div>}
      {children}
    </div>
  )
}
