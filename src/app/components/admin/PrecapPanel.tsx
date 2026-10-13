/**
 * PrecapPanel.tsx —— 「视频缓存（B′ 回看）」链后台配置面板（2026-10-10）
 *
 * 设计原则（与 StackChainPanel 同构，与后端契约严格对齐）：
 *   ① **单一真源在 11 机** `/soft/data/plate-precap/precap_config.json`；
 *      由 11 机接口渲染 systemd（drop-in + 6 个 writer unit）。本组件只做
 *      「读 → 编辑 → 提交增量 → 回读刷新」，不缓存配置。
 *   ② 字段说明一律来自后端 `tunable[k].desc`（含值域），前端只维护中文显示名（LABELS）。
 *   ③ 只提交改动键（diff 提交）。
 *   ④ 🔴 生效语义（与 stack 链**完全不同**，必须醒目告知）：
 *      · A 组（回看逻辑）→ 保存后 11 机自动延迟重启 alarm-processor（≈5 秒中断）；
 *      · B 组（写入器）→ **逐路滚动重启 writer**（每路 ≈30 秒回看缓冲重建，6 路全改 ≈1 分钟）。
 *      因此 B 组有改动时，前端会先弹确认框。
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

/** 纯展示层：中文显示名（语义/值域/说明全部来自后端 desc） */
const LABELS: Record<string, string> = {
  // A 组：回看逻辑
  precap_enabled: 'B′ 回看总开关',
  back_s: '回看档位（秒）',
  lag_ms: '编码/传输延迟（毫秒）',
  task_lag_ms: 'TASK 延迟兜底（毫秒）',
  channels: '参与回看的通道',
  max_stale_s: '心跳陈旧判据（秒）',
  // B 组：写入器
  writer_fps: '回看帧率（帧/秒）',
  writer_width: '回看帧宽度（px）',
  writer_keep_s: '环形窗口（秒）',
  writer_q: 'JPEG 质量（2 最好）',
  // 只读护栏
  writer_no_frame_s: '写入器看门狗（秒）',
  writer_dir: '缓冲目录',
  osd_mod: 'OSD 读取模块',
}
const labelOf = (k: string) => LABELS[k] || k

/** A 组（重启 alarm-processor ≈5s）/ B 组（逐路滚动重启 writer ≈每路 30s） */
const GROUP_A = ['precap_enabled', 'back_s', 'lag_ms', 'task_lag_ms', 'channels', 'max_stale_s']
const GROUP_B = ['writer_fps', 'writer_width', 'writer_keep_s', 'writer_q']

interface Tunable { type: 'bool' | 'int' | 'float' | 'enum' | 'window' | 'fseq' | 'sips' | 'enum_int'; min?: number | string[] | null; max?: number | null; desc: string }
interface Guardrail { value: any; desc: string }
interface Status {
  ok: boolean
  upstream?: { base: string; ok: boolean; error: string | null }
  error?: string
  values?: Record<string, any>
  defaults?: Record<string, any>
  tunable?: Record<string, Tunable>
  readonly?: Record<string, Guardrail>
  live_env?: Record<string, string>
  live_consistent?: boolean
  units?: Record<string, { fps?: number | null; width?: number | null; keep_s?: number | null; q?: number | null }>
  channels_map?: Record<string, string>
  backups?: string[]
  apply_hint?: string
  config_path?: string
  config_mtime?: number
  presets?: Record<string, Array<{ label: string; value: any }>>
  history?: Array<Record<string, any>>
}
interface Change { from: any; to: any }

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

const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b)

export function PrecapPanel({ user }: { user: CurrentUser }) {
  const isAdmin = roleAtLeast(user.role, 'admin')
  const [st, setSt] = useState<Status | null>(null)
  const [draft, setDraft] = useState<Record<string, any>>({})
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
    setTimeout(() => setMsg(null), 8000)
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await apiFetch<Status>('/api/precap-config/status')
      setSt(d)
      const v: Record<string, any> = {}
      for (const k of Object.keys(d.tunable || {})) v[k] = (d.values?.[k] === null || d.values?.[k] === undefined) ? (d.defaults?.[k] ?? null) : d.values?.[k]
      setDraft(v)
    } catch (e: any) {
      setSt({ ok: false, error: e?.error || String(e) })
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const dirtyKeys = useMemo(() => {
    const out: string[] = []
    for (const k of Object.keys(tun)) {
      if (vals[k] === null || vals[k] === undefined) {
        if (!same(draft[k], defs[k] ?? null)) out.push(k)
        continue
      }
      if (!same(draft[k], vals[k])) out.push(k)
    }
    return out
  }, [tun, vals, defs, draft])
  const dirtyA = dirtyKeys.filter(k => GROUP_A.includes(k))
  const dirtyB = dirtyKeys.filter(k => GROUP_B.includes(k))
  const dirtyCount = dirtyKeys.length

  const numeric = (k: string, v: string) => {
    const t = tun[k]?.type
    if (t === 'int' || t === 'enum_int') return v === '' ? '' : Math.round(Number(v))
    return v === '' ? '' : Number(v)
  }

  const save = async () => {
    if (!dirtyCount || !isAdmin) return
    if (dirtyB.length) {
      const okGo = window.confirm(
        'B 组（写入器）有 ' + dirtyB.length + ' 项改动：\n' +
        '  ' + dirtyB.map(labelOf).join('、') + '\n\n' +
        '保存将【逐路滚动重启 6 路写入器】，每路约 30 秒回看缓冲重建（合计约 1 分钟）。\n' +
        '重启期间该路回看暂时取不到帧（不影响告警主链）。\n\n确认继续？')
      if (!okGo) return
    }
    setBusy(true); setResult(null)
    try {
      const values: Record<string, any> = {}
      for (const k of dirtyKeys) {
        const t = tun[k]?.type
        if (t === 'int' || t === 'enum_int') values[k] = Math.round(Number(draft[k]))
        else if (t === 'float') values[k] = Number(draft[k])
        else values[k] = draft[k]
      }
      const r = await apiFetch<any>('/api/precap-config/apply', { method: 'POST', body: JSON.stringify({ values }) })
      setResult(r)
      flash('ok', '已保存' + (r?.notes?.length ? ' · ' + r.notes[0] : '') + (r?.backups?.config ? '（备份 ' + r.backups.config + '）' : ''))
      await load()
    } catch (e: any) {
      flash('err', '保存失败：' + (e?.error || e))
    } finally { setBusy(false) }
  }

  const doRollback = async () => {
    if (!rollbackTo || !isAdmin) return
    const okGo = window.confirm('回滚到 ' + rollbackTo + '？\n该备份若含 B 组差异，将触发逐路滚动重启（约 1 分钟）。')
    if (!okGo) return
    setBusy(true); setResult(null)
    try {
      const r = await apiFetch<any>('/api/precap-config/rollback', { method: 'POST', body: JSON.stringify({ backup: rollbackTo }) })
      setResult(r)
      const n = Object.keys(r?.changed || {}).length
      flash('ok', '已回滚（' + n + ' 项）· 来源 ' + (r?.from || rollbackTo))
      setRollbackTo('')
      await load()
    } catch (e: any) {
      flash('err', '回滚失败：' + (e?.error || e))
    } finally { setBusy(false) }
  }

  const numField = (k: string) => {
    const t = tun[k]; if (!t) return null
    const isFloat = t.type === 'float'
    const isDirty = dirtyKeys.includes(k)
    return (
      <div key={k} style={cardStyle}>
        <FieldHead label={labelOf(k)} desc={t.desc} dirty={isDirty} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
          <input type="number" value={draft[k] ?? ''} step={isFloat ? 0.1 : 1}
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

  const boolField = (k: string) => {
    const t = tun[k]; if (!t) return null
    const isDirty = dirtyKeys.includes(k)
    const on = !!draft[k]
    return (
      <div key={k} style={cardStyle}>
        <FieldHead label={labelOf(k)} desc={t.desc} dirty={isDirty} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
          <button onClick={() => setDraft(d => ({ ...d, [k]: !on }))} style={{ ...btn(on ? GREEN : '#546e7a'), minWidth: 76 }}>
            {on ? '已开启' : '已关闭'}
          </button>
        </div>
      </div>
    )
  }

  /** 档位列表编辑器（fseq）：文本输入 + 预设快捷；自动排序去重由 11 机校验再规范 */
  const fseqField = (k: string) => {
    const t = tun[k]; if (!t) return null
    const arr: number[] = Array.isArray(draft[k]) ? draft[k] : []
    const isDirty = dirtyKeys.includes(k)
    const presets = st?.presets?.[k] || []
    return (
      <div key={k} style={{ ...cardStyle, gridColumn: '1 / -1' }}>
        <FieldHead label={labelOf(k)} desc={t.desc} dirty={isDirty} />
        <div style={{ display: 'flex', gap: 10, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input value={arr.join(',')}
            onChange={e => setDraft(d => ({
              ...d, [k]: e.target.value.split(/[,，]/).map(x => Number(x.trim())).filter(x => !isNaN(x) && x > 0),
            }))}
            style={{ ...inputStyle, width: 240, fontFamily: "'JetBrains Mono', monospace" }} />
          <span style={{ color: DIM, fontSize: 11 }}>逗号分隔（秒），≤6 档，保存时自动排序去重</span>
        </div>
        {presets.length > 0 && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <span style={{ color: '#3a5a70', fontSize: 11, alignSelf: 'center' }}>快捷：</span>
            {presets.map((p, i) => (
              <button key={i} onClick={() => setDraft(d => ({ ...d, [k]: p.value }))} style={btn('#7fb3d5')}>{p.label}</button>
            ))}
          </div>
        )}
      </div>
    )
  }

  /** 通道多选（sips）：6 路道路枪机复选 */
  const sipsField = (k: string) => {
    const t = tun[k]; if (!t) return null
    const arr: string[] = Array.isArray(draft[k]) ? draft[k] : []
    const isDirty = dirtyKeys.includes(k)
    const map = st?.channels_map || {}
    const toggle = (sip: string) => {
      const on = arr.includes(sip)
      setDraft(d => ({ ...d, [k]: on ? arr.filter(x => x !== sip) : [...arr, sip] }))
    }
    return (
      <div key={k} style={{ ...cardStyle, gridColumn: '1 / -1' }}>
        <FieldHead label={labelOf(k)} desc={t.desc} dirty={isDirty} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8, marginTop: 8 }}>
          {Object.entries(map).map(([sip, name]) => {
            const on = arr.includes(sip)
            return (
              <div key={sip} style={{ ...cardStyle, marginBottom: 0, padding: '8px 10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: on ? GREEN : '#546e7a', boxShadow: on ? `0 0 6px ${GREEN}88` : 'none' }} />
                  <span style={{ color: '#c8e6ff', fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={name}>{name}</span>
                  <button onClick={() => toggle(sip)} style={btn(on ? RED : GREEN, false)}>{on ? '移除' : '加入'}</button>
                </div>
                <div style={{ color: '#3a5a70', fontSize: 10, marginTop: 4, fontFamily: "'JetBrains Mono', monospace" }}>{sip}</div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  if (loading && !st) return <div style={{ color: DIM, padding: 20 }}>加载视频缓存配置中…</div>

  if (st && !st.ok) {
    return (
      <div style={{ padding: 16, overflow: 'auto' }}>
        <div style={{ padding: 14, borderRadius: 5, border: '1px solid rgba(255,68,68,0.35)', background: 'rgba(255,68,68,0.06)', color: '#ff8080', fontSize: 13 }}>
          <b>读不到视频缓存配置</b>
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

  const live = st?.live_env || {}
  const units = st?.units || {}
  const consistent = st?.live_consistent

  return (
    <div style={{ flex: 1, overflow: 'auto', paddingRight: 4 }}>
      {/* ── 顶部：生效语义 + 状态 + 操作 ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 320 }}>
          <div style={{ color: '#c8e6ff', fontSize: 15, fontWeight: 600 }}>视频缓存（B′ 回看）· 环形缓冲与回看参数</div>
          <div style={{ color: AMBER, fontSize: 12, marginTop: 4 }}>{st?.apply_hint || 'A 组保存后约 5 秒自动重启生效；B 组逐路滚动重启（每路约 30 秒）'}</div>
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
          {isAdmin && dirtyA.length > 0 && (
            <span style={{ fontSize: 11, color: AMBER, border: `1px solid ${AMBER}55`, borderRadius: 3, padding: '4px 8px' }}>
              A 组 {dirtyA.length} 项 · 保存后自动重启
            </span>
          )}
          {isAdmin && dirtyB.length > 0 && (
            <span style={{ fontSize: 11, color: '#ff9800', border: '1px solid #ff980055', borderRadius: 3, padding: '4px 8px' }}>
              B 组 {dirtyB.length} 项 · 逐路重启 writer
            </span>
          )}
          <button onClick={load} disabled={busy} style={btn(CYAN, busy)}>刷新</button>
          <button onClick={() => { setRollbackTo(''); setResult(null); load() }} disabled={busy} style={btn('#7fb3d5', busy)}>放弃改动</button>
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

      {/* ── ⓪ 生效状态（live vs file）── */}
      <Section title="生效状态（进程实际值 vs 配置真源）"
        note="A 组保存后会自动重启（约 5 秒），重启完成后本区域应显示「一致」；若显示不一致且刚保存过，稍后刷新即可。">
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
          <div style={{ color: consistent ? GREEN : AMBER, marginBottom: 6 }}>
            {consistent ? '✓ 一致（alarm-processor 进程环境 = 配置真源）' : '⚠ 不一致——可能"已保存但尚未重启"（A 组保存后约 5 秒自动重启；稍后点刷新）'}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 4, color: '#9fc7e0' }}>
            {Object.entries(live).map(([k, v]) => (
              <div key={k}>{k} = {v || '（空）'}</div>
            ))}
          </div>
        </div>
      </Section>

      {/* ── ① A 组：回看逻辑（重启 alarm-processor ≈5s）── */}
      <Section title="A 组 · 回看逻辑（保存后 ≈5 秒自动重启，短暂中断）"
        note="决定「怎么回看」：档位、锚点延迟、参与通道。B′ 原理：事件帧没读出牌时，从环形缓冲取「事件时刻往前 N 秒」的帧再识别。">
        <div style={gridStyle}>
          {boolField('precap_enabled')}
          {numField('lag_ms')}
          {numField('task_lag_ms')}
          {numField('max_stale_s')}
          {fseqField('back_s')}
          {sipsField('channels')}
        </div>
      </Section>

      {/* ── ② B 组：写入器（逐路滚动重启 ≈30s/路）── */}
      <Section title="B 组 · 写入器（保存后逐路滚动重启，每路 ≈30 秒缓冲重建）"
        note="决定「缓冲帧本身」：帧率/宽度/窗口/质量。⚠ 改小宽度或质量会伤小牌/放大号可读性；改大帧率/窗口会增加内存带宽与 /dev/shm 占用。">
        <div style={gridStyle}>
          {numField('writer_fps')}
          {numField('writer_width')}
          {numField('writer_keep_s')}
          {numField('writer_q')}
        </div>
        {(st?.presets?.writer_width || []).length > 0 && (
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <span style={{ color: '#3a5a70', fontSize: 11, alignSelf: 'center' }}>宽度快捷：</span>
            {(st?.presets?.writer_width || []).map((p, i) => (
              <button key={i} onClick={() => setDraft(d => ({ ...d, writer_width: p.value }))} style={btn('#7fb3d5')}>{p.label}</button>
            ))}
          </div>
        )}
        {(st?.presets?.writer_fps || []).length > 0 && (
          <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
            <span style={{ color: '#3a5a70', fontSize: 11, alignSelf: 'center' }}>帧率快捷：</span>
            {(st?.presets?.writer_fps || []).map((p, i) => (
              <button key={i} onClick={() => setDraft(d => ({ ...d, writer_fps: p.value }))} style={btn('#7fb3d5')}>{p.label}</button>
            ))}
          </div>
        )}
      </Section>

      {/* ── ③ 各 unit 实际参数（只读展示）── */}
      <Section title="各写入器 unit 实际参数（ExecStart，只读展示）"
        note="这是 6 个 writer 服务当前真实的启动参数（改上面 B 组并保存后，这里会随之更新）。">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 8 }}>
          {Object.entries(units).map(([ch, a]) => (
            <div key={ch} style={{ ...cardStyle, marginBottom: 0, padding: '8px 10px' }}>
              <div style={{ color: '#c8e6ff', fontSize: 12, fontWeight: 600 }}>{ch}</div>
              <div style={{ color: '#9fc7e0', fontSize: 11, marginTop: 4, fontFamily: "'JetBrains Mono', monospace" }}>
                fps={String(a.fps)} · width={String(a.width)} · keep={String(a.keep_s)}s · q={String(a.q)}
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ── ④ 只读护栏 ── */}
      {(st?.readonly && Object.keys(st.readonly).length > 0) && (
        <Section title="只读护栏（后台展示，不可改）"
          note="这些值属算法资产/基础设施（看门狗、缓冲目录、OSD 模块），需要走代码或部署，故不在此开放。">
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

      {/* ── ⑤ 备份与回滚 ── */}
      <Section title="备份与回滚"
        note="每次保存/回滚前，11 机会同时备份「配置真源 / drop-in / 各 unit」。回滚 = 用所选备份的值再执行一次完整 apply（含重启），仍受同样安全流程保护。">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={rollbackTo} onChange={e => setRollbackTo(e.target.value)} style={{ ...inputStyle, width: 340 }}>
            <option value="">选择要回滚到的备份…</option>
            {(st?.backups || []).map(b => <option key={b} value={b}>{b}</option>)}
          </select>
          <button onClick={doRollback} disabled={busy || !rollbackTo || !isAdmin} style={btn(AMBER, busy || !rollbackTo || !isAdmin)}>回滚到该备份</button>
          <span style={{ color: '#3a5a70', fontSize: 11 }}>共 {(st?.backups || []).length} 份</span>
        </div>
      </Section>

      {/* ── ⑥ 本次提交结果 ── */}
      {result && (
        <Section title="本次提交结果" note="后端（11 机）逐项回读校验后的实际差异与重启结果，不是前端推测。">
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#9fc7e0' }}>
            <div>ok = {String(result.ok)} {result.error ? '· error = ' + result.error : ''}</div>
            {result.stripped?.length ? <div style={{ color: AMBER }}>stripped（未提交）= {result.stripped.join(',')}</div> : null}
            {result.self_restart_scheduled ? <div style={{ color: AMBER }}>A 组已写入：alarm-processor 将于数秒后自动重启</div> : null}
            {result.writer_restarts?.length ? (
              <div style={{ marginTop: 4 }}>
                B 组逐路重启结果：
                {result.writer_restarts.map((w: any, i: number) => (
                  <span key={i} style={{ marginLeft: 8, color: w.active === 'active' ? GREEN : '#ff8080' }}>{w.ch}：{w.active}</span>
                ))}
              </div>
            ) : null}
            {result.notes?.length ? <div style={{ color: AMBER, marginTop: 4 }}>{result.notes.join(' / ')}</div> : null}
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

      {/* ── ⑦ 操作历史 ── */}
      <Section title={`操作历史（最近 ${Math.min(20, (st?.history || []).length)} 条）`}
        note="谁、什么时候、改了什么、成功与否。这份记录存在驾驶舱后端，不随配置回滚。">
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
          {(st?.history || []).slice(0, 20).map((h, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, padding: '3px 0', borderBottom: '1px solid rgba(0,120,200,0.08)' }}>
              <span style={{ color: '#5a8aaa', width: 150 }}>{h.at}</span>
              <span style={{ color: h.result === 'ok' ? GREEN : '#ff8080', width: 70 }}>{h.action}</span>
              <span style={{ color: '#8fa8bb', width: 80 }}>{h.by}</span>
              <span style={{ color: '#9fc7e0', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {h.error ? 'err: ' + h.error : Object.keys(h.changed || {}).join(', ') || '—'}
              </span>
            </div>
          ))}
          {!(st?.history || []).length && <span style={{ color: '#5a8aaa' }}>暂无记录</span>}
        </div>
      </Section>

      {/* ── 吸底操作条（2026-10-10：滚到底部改完字段后就地保存；含 A/B 组影响标记）── */}
      {dirtyCount > 0 && (
        <div style={{
          position: 'sticky', bottom: 0, marginTop: 12, padding: '10px 14px',
          background: 'rgba(0,14,40,0.96)', border: `1px solid ${AMBER}55`, borderRadius: 6,
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', zIndex: 10,
        }}>
          <span style={{ color: AMBER, fontSize: 12, flex: 1 }}>
            有 {dirtyCount} 项改动待保存
            {dirtyA.length > 0 ? ` · A 组 ${dirtyA.length} 项（保存后自动重启）` : ''}
            {dirtyB.length > 0 ? ` · B 组 ${dirtyB.length} 项（逐路重启 writer）` : ''}
          </span>
          <button onClick={() => { setRollbackTo(''); setResult(null); load() }} disabled={busy} style={btn('#7fb3d5', busy)}>放弃改动</button>
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
