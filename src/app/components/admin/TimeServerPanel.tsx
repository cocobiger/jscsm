import { useState, useEffect, useCallback, useRef } from 'react'
import { authFetch, apiFetch } from '../../lib/apiFetch'
import { fmtShanghai } from '../../lib/time'
import { roleAtLeast, type Role } from '../../lib/auth'

/**
 * 系统设置 · 时间服务器  2026-10-04 一期（只读）→ 2026-10-05 二期（方案 B 可写）
 *
 * 写权限的真相（写清避免误解）：
 *  · 驾驶舱后端以 User=jsc 运行，**无 sudo 权限** → 改不了 /etc/systemd/**、也重启不了 systemd-timesyncd。
 *  · 故本页的「保存并同步」**不直接改系统**，只做两件事：写 kv_config 的期望值 + 落一个请求文件
 *    /var/lib/easyaiot-timesync/request.json；由 **root 侧应用器**接手：写 drop-in → 重启
 *    systemd-timesyncd → 按「真的收到应答」判定 → 失败**自动回滚**。
 *  · 判定不看「服务活着」，也不只看 ServerAddress（它只是「正在尝试连接的地址」，
 *    IP 字面量一解析就填上，死源也会被填）。真判据 = ServerAddress 在期望集合内
 *    **且 NTPMessage.Stratum ≥ 1 且应用器独立 SNTP 反测成功**。
 *  · NVR / 相机层**只展示不控制**：实测该型号 NVR 固件「客户端在发包但从不应用 NTP」，
 *    给它一个「改授时」开关会给出虚假承诺。
 *  · 编辑区**仅管理员可见**：后端对写操作默认要求 admin（鉴权中间件 requiredRoleForWrite）。
 */

const CYAN = '#00aaff'
const GREEN = '#00e676'
const AMBER = '#ffd740'
const RED = '#ff5252'
const PURPLE = '#b388ff'

// 与后端/应用器**同一套**白名单：天然拒绝 ':' → 从根上挡住 host:port
const VAL_RE = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/
const MAX_FALLBACKS = 8

interface ProbeTarget {
  host: string; n: number; nOk: number; ok: boolean; err?: string
  stratum?: number; refid?: string
  offsetMsMed?: number; offsetMsRange?: number; rttMsMed?: number
}
interface DeviceRow {
  kind?: string; label?: string; ip?: string
  samples?: number; ticks?: number; dur_s?: number
  offset_ms?: number; spread_ms?: number; thr?: number; verdict?: string
}
interface SnapRow { ip?: string; ch?: number; tag?: string; osd?: string; lag_ms?: number; err?: string | null }
type Outcome = 'applied' | 'no-change' | 'rolled-back' | 'rejected'
interface ApplyRun {
  version?: string; reqId?: string; state?: string; outcome?: Outcome
  requestedBy?: string; requestedAt?: string; finishedAt?: string; elapsedMs?: number
  target?: { primary?: string; fallbacks?: string[] } | null
  before?: { primary?: string; fallbacks?: string[] } | null
  verify?: { serverAddress?: string; stratum?: number | null; reference?: string | null; synchronized?: string; hasReply?: boolean } | null
  verifyOk?: boolean; verifyDetail?: string; waitedS?: number
  rollback?: { attempted?: boolean; ok?: boolean; detail?: string } | null
  backupPath?: string | null; note?: string | null; error?: string | null
}
interface ApplyState {
  dir?: string; requestPath?: string; installed?: boolean; pending?: boolean
  lastRequest?: { reqId?: string | null; requestedAt?: string | null; requestedBy?: string | null } | null
  lastRun?: ApplyRun | null
  lastResult?: ApplyRun | null
}
interface TsStatus {
  ok: boolean; generatedAt: string
  host: { name: string; machine: string; ip: string }
  expect: { primary: string; fallbacks: string[]; note?: string; updatedAt?: string | null; updatedBy?: string | null; source?: string | null }
  expectMeta?: { updatedAt?: string | null; updatedBy?: string | null; source?: string | null; reqId?: string | null }
  applyState?: ApplyState
  local: {
    showTimesync: any; timedatectl: any
    allowed?: string[]; conform?: boolean; conformDetail?: string
    replied?: boolean; effective?: boolean
    isPrimary?: boolean; isLanSource?: boolean
  }
  probe: { targets: ProbeTarget[] }
  audit: null | { ts?: number; serverTime?: string; source?: any; db?: string; elapsedS?: number; deviceCount?: number; snapCount?: number }
  remote: null | { ok: boolean; url: string; err?: string }
  devices: DeviceRow[]; snapOsd: SnapRow[]
  readonly: boolean; readonlyReason?: string; writeMode?: string
}

const fmtMs = (v?: number | null) => {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  const a = Math.abs(v)
  const sign = v >= 0 ? '+' : '−'
  if (a >= 1000) return `${sign}${(a / 1000).toFixed(2)} s`
  return `${sign}${a.toFixed(1)} ms`
}
// 极差 / 抖动 = 无方向的离散度 → 不带正负号（带号会被误读成"往某个方向偏"）
const fmtRange = (v?: number | null) => {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a >= 1000) return `${(a / 1000).toFixed(2)} s`
  return `${a.toFixed(1)} ms`
}
// NTP refid 是 4 字节 ASCII；公网源实测返回不可打印字节（如 "#\u0060\u0000"）→ 仅可打印时展示
const fmtRefid = (r?: string) => (r && /^[\x20-\x7e]{1,8}$/.test(r.trim()) ? r.trim() : '')
const toneOfOffset = (v?: number | null, warn = 300, bad = 1000) => {
  if (v === null || v === undefined || !isFinite(v)) return '#3a5a70'
  const a = Math.abs(v)
  return a <= warn ? GREEN : a <= bad ? AMBER : RED
}
const kindLabel = (k?: string) => k === 'nvr' ? 'NVR' : k === 'ipc' ? '相机' : k === 'server' ? '服务器' : (k || '—')
// 结果档位的「人话」与配色：一句话说清发生了什么、以及**系统是否回到了可用状态**
const OUTCOME_META: Record<Outcome, { label: string; hint: string; color: string; icon: string }> = {
  'applied': { label: '同步成功', hint: '已写入配置并重启授时服务，且回读确认收到应答', color: GREEN, icon: '✓' },
  'no-change': { label: '无需变更', hint: '系统当前配置已等于期望值，未重启服务（幂等跳过）', color: CYAN, icon: '➖' },
  'rolled-back': { label: '已自动回滚', hint: '新源未能生效，系统已恢复到改动前的配置（未被改坏）', color: RED, icon: '↩️' },
  'rejected': { label: '已被拒绝', hint: '期望值未通过校验，系统未被改动', color: AMBER, icon: '🚫' },
}
// 客户端预校验：与后端**同规则**，把错误在按下按钮前就说清楚（后端仍会再校验一次）
function validateExpect(primary: string, fallbacks: string[]): string | null {
  const p = primary.trim()
  if (!p) return '主源地址不能为空'
  if (!VAL_RE.test(p)) {
    return p.indexOf(':') >= 0
      ? "主源地址不能带端口 —— systemd-timesyncd 的 NTP= 不支持 host:port（写 172.16.8.254:123 会被当主机名解析，不报错、不记日志）"
      : '主源地址不合法：只允许字母/数字/点/下划线/连字符，且不能以符号开头或结尾'
  }
  const uniq = Array.from(new Set(fallbacks.map(x => x.trim()).filter(Boolean)))
  if (!uniq.length) return '至少要有 1 个备源 —— systemd 的 FallbackNTP 不允许留空（留空会退回编译期内置默认的公网源）'
  if (uniq.length > MAX_FALLBACKS) return `备源最多 ${MAX_FALLBACKS} 个`
  for (const x of uniq) {
    if (!VAL_RE.test(x)) return `备源「${x}」不合法${x.indexOf(':') >= 0 ? '（不能带端口）' : ''}`
  }
  return null
}

export function TimeServerPanel({ role }: { role?: Role }) {
  const [d, setD] = useState<TsStatus | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [showDev, setShowDev] = useState(false)
  const [showOsd, setShowOsd] = useState(false)
  // ── 二期：编辑态 ──
  const [primary, setPrimary] = useState('')
  const [fallbacks, setFallbacks] = useState<string[]>([''])
  const [note, setNote] = useState('')
  const [formErr, setFormErr] = useState('')
  const [saving, setSaving] = useState(false)
  const [pendingReqId, setPendingReqId] = useState('')
  const [notice, setNotice] = useState<{ kind: 'ok' | 'warn' | 'bad' | 'info'; text: string } | null>(null)
  const formSig = useRef('')
  const alive = useRef(true)

  const isAdmin = roleAtLeast(role, 'admin')

  const load = useCallback(async () => {
    setBusy(true); setErr('')
    try {
      const r = await authFetch('/api/time-server/status')
      const j = await r.json()
      if (!r.ok || !j?.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      setD(j)
    } catch (e: any) { setErr(e?.message || String(e)) }
    finally { setBusy(false) }
  }, [])
  useEffect(() => { alive.current = true; load(); return () => { alive.current = false } }, [load])

  // 服务端期望值变化时才回填表单（避免把用户正在输入的内容冲掉）
  useEffect(() => {
    if (!d) return
    const sig = `${d.expect.primary}|${(d.expect.fallbacks || []).join(',')}|${d.expect.note || ''}`
    if (sig === formSig.current) return
    formSig.current = sig
    setPrimary(d.expect.primary)
    setFallbacks((d.expect.fallbacks && d.expect.fallbacks.length ? d.expect.fallbacks : ['']).slice())
    setNote(d.expect.note || '')
  }, [d])

  // 提交后轮询：等应用器把**这个 reqId** 跑完（path 触发秒级；失败也在秒级回滚）
  const pollUntilDone = useCallback(async (reqId: string) => {
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 3000))
      if (!alive.current) return
      try {
        const r = await authFetch('/api/time-server/status')
        const j = await r.json()
        if (r.ok && j?.ok) {
          setD(j)
          const last: ApplyRun | null | undefined = j?.applyState?.lastRun
          if (last && last.reqId === reqId) {
            setPendingReqId('')
            return
          }
        }
      } catch { /* 继续轮询 */ }
    }
    if (!alive.current) return
    setPendingReqId('')
    setNotice({ kind: 'warn', text: '等待应用器超时（60 s）—— 请点「刷新」查看最新结果' })
  }, [])

  const submit = async (apply: boolean) => {
    setFormErr(''); setNotice(null)
    const vErr = validateExpect(primary, fallbacks)
    if (vErr) { setFormErr(vErr); return }
    setSaving(true)
    try {
      const body: any = { primary: primary.trim(), fallbacks: Array.from(new Set(fallbacks.map(x => x.trim()).filter(Boolean))), note: note.trim(), apply }
      const j = await apiFetch<any>('/api/time-server/expect', { method: 'POST', body: JSON.stringify(body) })
      if (j?.applyError) {
        setNotice({ kind: 'bad', text: '期望值已保存，但同步请求未能提交：' + j.applyError })
        await load(); return
      }
      if (apply && j?.apply?.reqId) {
        setPendingReqId(j.apply.reqId)
        setNotice({ kind: 'info', text: `已提交同步请求（reqId ${j.apply.reqId}），等待 root 侧应用器执行…` })
        setSaving(false)
        await pollUntilDone(j.apply.reqId)
        return
      }
      setNotice({ kind: 'ok', text: '期望值已保存（未触发同步）' })
      await load()
    } catch (e: any) {
      setFormErr(e?.error || e?.message || String(e))
    } finally { setSaving(false) }
  }

  const resync = async () => {
    setFormErr(''); setNotice(null)
    const vErr = validateExpect(primary, fallbacks)
    if (vErr) { setFormErr(vErr); return }
    setSaving(true)
    try {
      const j = await apiFetch<any>('/api/time-server/apply', {
        method: 'POST',
        body: JSON.stringify({ primary: primary.trim(), fallbacks: Array.from(new Set(fallbacks.map(x => x.trim()).filter(Boolean))), note: note.trim() }),
      })
      if (j?.reqId) {
        setPendingReqId(j.reqId)
        setNotice({ kind: 'info', text: `已提交同步请求（reqId ${j.reqId}），等待 root 侧应用器执行…` })
        setSaving(false)
        await pollUntilDone(j.reqId)
        return
      }
      await load()
    } catch (e: any) {
      setFormErr(e?.error || e?.message || String(e))
    } finally { setSaving(false) }
  }

  const cell: React.CSSProperties = { padding: '7px 10px', borderBottom: '1px solid rgba(0,60,120,0.15)', fontSize: 12 }
  const head: React.CSSProperties = { color: '#5a8aaa', fontSize: 11, fontWeight: 600, padding: '7px 10px', textAlign: 'left', borderBottom: '1px solid rgba(0,80,150,0.25)', whiteSpace: 'nowrap' }
  const card: React.CSSProperties = { background: 'rgba(5,20,45,0.55)', border: '1px solid rgba(0,100,180,0.22)', borderRadius: 6, padding: '12px 14px' }
  const input: React.CSSProperties = { background: 'rgba(0,20,45,0.85)', border: '1px solid rgba(0,100,180,0.35)', borderRadius: 3, color: '#c8e6ff', fontSize: 12, padding: '5px 8px', fontFamily: 'inherit' }
  const btn = (color: string, disabled = false): React.CSSProperties => ({
    padding: '6px 14px', fontSize: 12, borderRadius: 3, cursor: disabled ? 'not-allowed' : 'pointer',
    border: `1px solid ${color}${disabled ? '44' : '66'}`, background: disabled ? 'transparent' : `${color}18`,
    color: disabled ? '#4a6a80' : color, fontWeight: 600,
  })

  if (err) {
    return (
      <div style={{ padding: '18px 20px' }}>
        <div style={{ ...card, borderColor: `${RED}55` }}>
          <div style={{ color: RED, fontSize: 13, fontWeight: 600 }}>读取时间服务器状态失败</div>
          <div style={{ color: '#7ab8e0', fontSize: 12, marginTop: 6 }}>{err}</div>
          <button onClick={load} style={{ ...btn(CYAN), marginTop: 10 }}>重试</button>
        </div>
      </div>
    )
  }
  if (!d) return <div style={{ padding: '18px 20px', color: '#5a8aaa', fontSize: 13 }}>{busy ? '正在读取…' : '暂无数据'}</div>

  const L = d.local, S = L.showTimesync || {}, T = L.timedatectl || {}
  const mainProbe = (d.probe.targets || [])[0]
  // ⚠ 「已生效」必须同时满足「在期望清单内」与「真收到应答」——只看 ServerAddress 会把死源判成生效
  const okNow = L.replied !== false && L.conform !== false
  const conformColor = okNow ? (L.isPrimary ? GREEN : AMBER) : RED
  const headline = !L.replied
    ? '异常：尚未收到 NTP 应答（当前只是「正在尝试连接」的地址）'
    : (L.conform ? (L.isPrimary ? '正常：正在使用期望的主授时源' : '正常：使用的是期望清单内的备源') : '异常：当前上游不在期望清单内')
  const auditAge = d.audit?.serverTime ? new Date(d.audit.serverTime.replace(' ', 'T') + '+08:00').getTime() : 0
  const auditAgeH = auditAge ? Math.round((Date.now() - auditAge) / 3600000 * 10) / 10 : null

  const A = d.applyState || {}
  const last: ApplyRun | null = A.lastRun || null
  const meta = last && last.outcome ? OUTCOME_META[last.outcome] : null
  const lastTargetStr = last?.target ? `NTP=${last.target.primary || '—'} · FallbackNTP=${(last.target.fallbacks || []).join(' ') || '—'}` : ''
  // 「期望值已改但还没同步到系统」——拿最近一次同步目标与当前期望值比
  const dirtyExpect = !!(last?.target && (
    last.target.primary !== d.expect.primary ||
    (last.target.fallbacks || []).join(',') !== (d.expect.fallbacks || []).join(',')
  ))

  return (
    <div style={{ paddingBottom: 8 }}>
      {/* 标题 */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12, flexShrink: 0, flexWrap: 'wrap', gap: 6 }}>
        <div style={{ width: 3, height: 18, background: PURPLE, borderRadius: 1, marginRight: 4 }} />
        <span style={{ color: '#c8e6ff', fontSize: 16, fontWeight: 700, letterSpacing: '0.05em' }}>🕐 时间服务器</span>
        <span style={{ color: '#3a5a70', fontSize: 12, marginLeft: 8 }}>本机系统钟的授时源 · 状态与期望值</span>
        <span style={{ marginLeft: 'auto', padding: '2px 8px', borderRadius: 3, fontSize: 11, fontWeight: 700,
          background: isAdmin ? `${PURPLE}18` : 'rgba(255,215,64,0.12)', color: isAdmin ? PURPLE : AMBER,
          border: `1px solid ${isAdmin ? PURPLE : AMBER}44` }}>{isAdmin ? '可编辑 · 管理员' : '只读'}</span>
        <button onClick={load} disabled={busy} style={btn(CYAN, busy)}>{busy ? '读取中…' : '刷新'}</button>
      </div>

      {/* 一句话结论 */}
      <div style={{ ...card, borderColor: `${conformColor}55`, background: `${conformColor}0e`, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ color: conformColor, fontSize: 15, fontWeight: 700 }}>{headline}</span>
          <span style={{ color: '#7ab8e0', fontSize: 12 }}>{L.conformDetail}</span>
        </div>
        <div style={{ color: '#5a8aaa', fontSize: 11, marginTop: 5 }}>
          主机 {d.host.name}（{d.host.machine} / {d.host.ip}） · 时区 {T.timeZone || '—'} · 数据生成 {fmtShanghai(d.generatedAt, 'short')}（上海时）
        </div>
      </div>

      {/* 同步结果 / 进行中 —— 只在有事可报时出现，避免噪音 */}
      {(pendingReqId || notice || (meta && last)) && (
        <div style={{ ...card, marginTop: 10, flexShrink: 0,
          borderColor: pendingReqId || (notice && notice.kind !== 'ok' && notice.kind !== 'info') ? `${AMBER}66` : `${meta?.color || CYAN}55`,
          background: `${meta?.color || (notice?.kind === 'bad' ? RED : notice?.kind === 'ok' ? GREEN : CYAN)}0d` }}>
          {pendingReqId ? (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ color: AMBER, fontSize: 13, fontWeight: 700 }}>⏳ 同步中…</span>
              <span style={{ color: '#7ab8e0', fontSize: 12 }}>
                reqId <code style={{ color: '#c8e6ff' }}>{pendingReqId}</code> · 应用器通常在数秒内完成；失败会自动回滚
              </span>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ color: meta?.color || (notice?.kind === 'bad' ? RED : Cy(notice?.kind)), fontSize: 13, fontWeight: 700 }}>
                  {meta ? `${meta.icon} 最近一次同步：${meta.label}` : '提示'}
                </span>
                {last && (
                  <span style={{ color: '#7ab8e0', fontSize: 12 }}>
                    {last.requestedBy ? `操作人 ${last.requestedBy} · ` : ''}{last.finishedAt ? fmtShanghai(last.finishedAt, 'short') + '（上海时）' : ''}
                    {last.elapsedMs != null ? ` · 耗时 ${(last.elapsedMs / 1000).toFixed(2)} s` : ''}
                    {last.waitedS != null && last.outcome === 'applied' ? ` · 生效等待 ${last.waitedS} s` : ''}
                  </span>
                )}
              </div>
              {meta && <div style={{ color: '#5a8aaa', fontSize: 11, marginTop: 4 }}>{meta.hint}</div>}
              {last?.verifyDetail && (
                <div style={{ color: '#7ab8e0', fontSize: 11, marginTop: 4 }}>生效判据：{last.verifyDetail}</div>
              )}
              {last?.error && (
                <div style={{ color: RED, fontSize: 11, marginTop: 4 }}>原因：{last.error}</div>
              )}
              {last?.rollback?.attempted && (
                <div style={{ color: last.rollback.ok ? GREEN : RED, fontSize: 11, marginTop: 4 }}>
                  回滚 {last.rollback.ok ? '成功' : '未完成'}：{last.rollback.detail}
                </div>
              )}
              {lastTargetStr && <div style={{ color: '#3a5a70', fontSize: 11, marginTop: 4 }}>落盘目标：{lastTargetStr}{last?.backupPath ? ` · 备份 ${String(last.backupPath).split('/').pop()}` : ''}</div>}
              {notice && <div style={{ color: notice.kind === 'bad' ? RED : notice.kind === 'ok' ? GREEN : AMBER, fontSize: 12, marginTop: 6 }}>{notice.text}</div>}
            </>
          )}
        </div>
      )}

      {/* 四个数字 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginTop: 12, flexShrink: 0 }}>
        {[
          { t: '当前上游', v: S.serverAddress || '—', s: S.stratum != null ? `Stratum ${S.stratum}${S.reference ? ' / ' + S.reference : ''}` : (L.replied ? '未读取到' : '未收到应答'), c: L.isLanSource ? GREEN : CYAN },
          { t: '本机钟偏差', v: fmtMs(mainProbe?.offsetMsMed), s: mainProbe?.ok ? `极差 ${fmtRange(mainProbe.offsetMsRange)} · RTT ${mainProbe.rttMsMed?.toFixed(2)} ms` : '探测失败', c: toneOfOffset(mainProbe?.offsetMsMed, 50, 200) },
          { t: '同步状态', v: T.synchronized === 'yes' ? '已同步' : (T.synchronized || '—'), s: `NTP 服务 ${T.ntpService || '—'}${L.replied ? '' : ' · 无应答'}`, c: T.synchronized === 'yes' && L.replied ? GREEN : RED },
          { t: '设备巡检', v: d.remote?.ok ? `${d.devices.length} 台` : '不可用', s: d.audit?.serverTime ? `最后 ${d.audit.serverTime.slice(5)}${auditAgeH != null ? `（${auditAgeH}h 前）` : ''}` : (d.remote?.err || '—'), c: d.remote?.ok ? CYAN : AMBER },
        ].map((k, i) => (
          <div key={i} style={card}>
            <div style={{ color: '#5a8aaa', fontSize: 11 }}>{k.t}</div>
            <div style={{ color: k.c, fontSize: 20, fontWeight: 700, lineHeight: 1.35 }}>{k.v}</div>
            <div style={{ color: '#3a5a70', fontSize: 11 }}>{k.s}</div>
          </div>
        ))}
      </div>

      {/* 期望值：管理员可编辑 / 其他人只读 */}
      <div style={{ ...card, marginTop: 12, flexShrink: 0, borderColor: isAdmin ? `${PURPLE}44` : undefined }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
          <span style={{ color: '#7ab8e0', fontSize: 12, fontWeight: 600 }}>期望值</span>
          <span style={{ color: '#3a5a70', fontSize: 11 }}>kv_config.time_server_expect</span>
          {d.expect.updatedBy && (
            <span style={{ color: '#3a5a70', fontSize: 11 }}>
              最后保存 {d.expect.updatedBy}{d.expect.updatedAt ? ` · ${d.expect.updatedAt}（上海时）` : ''}
            </span>
          )}
          {!isAdmin && <span style={{ color: AMBER, fontSize: 11, marginLeft: 'auto' }}>修改需要管理员权限</span>}
        </div>

        {!isAdmin ? (
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12 }}>
            <span style={{ color: '#5a8aaa' }}>主源 <b style={{ color: L.isPrimary ? GREEN : '#c8e6ff' }}>{d.expect.primary}</b></span>
            <span style={{ color: '#5a8aaa' }}>备源 {(d.expect.fallbacks || []).map((f, i) => <b key={i} style={{ color: '#c8e6ff', marginLeft: 4 }}>{f}</b>)}</span>
            <span style={{ color: '#3a5a70' }}>{d.expect.note || ''}</span>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ color: '#5a8aaa', fontSize: 11 }}>主源（NTP=）</span>
                <input value={primary} onChange={e => setPrimary(e.target.value)} spellCheck={false}
                  placeholder="172.16.8.254" style={{ ...input, width: 190 }} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 320px', minWidth: 280 }}>
                <span style={{ color: '#5a8aaa', fontSize: 11 }}>备源（FallbackNTP=，按顺序兜底，最多 {MAX_FALLBACKS} 个，至少 1 个）</span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {fallbacks.map((f, i) => (
                    <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input value={f} onChange={e => setFallbacks(fs => fs.map((x, j) => j === i ? e.target.value : x))}
                        spellCheck={false} placeholder={i === 0 ? '172.16.8.254' : 'ntp.ubuntu.com'} style={{ ...input, width: 190 }} />
                      <button onClick={() => setFallbacks(fs => fs.length <= 1 ? fs : fs.filter((_, j) => j !== i))}
                        disabled={fallbacks.length <= 1} title="删除这一条"
                        style={{ ...btn(RED, fallbacks.length <= 1), padding: '4px 9px' }}>×</button>
                      {i === 0 && <span style={{ color: '#3a5a70', fontSize: 11 }}>第 1 条＝主源的原地重试</span>}
                    </div>
                  ))}
                  <button onClick={() => setFallbacks(fs => fs.length >= MAX_FALLBACKS ? fs : [...fs, ''])}
                    disabled={fallbacks.length >= MAX_FALLBACKS}
                    style={{ ...btn(CYAN, fallbacks.length >= MAX_FALLBACKS), alignSelf: 'flex-start', padding: '3px 10px' }}>＋ 添加备源</button>
                </div>
              </label>
            </div>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10 }}>
              <span style={{ color: '#5a8aaa', fontSize: 11 }}>备注（仅记录用途，不下发给系统）</span>
              <input value={note} onChange={e => setNote(e.target.value)} spellCheck={false}
                placeholder="例如：主源＝局域网一级授时源" style={{ ...input, width: '100%', boxSizing: 'border-box' }} />
            </label>

            {formErr && <div style={{ color: RED, fontSize: 12, marginTop: 8 }}>⚠ {formErr}</div>}
            {dirtyExpect && !formErr && (
              <div style={{ color: AMBER, fontSize: 11, marginTop: 8 }}>
                当前期望值与「最近一次同步目标」不一致 —— 点「立即重新同步」把它落到系统。
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button onClick={() => submit(true)} disabled={saving || !!pendingReqId} style={btn(PURPLE, saving || !!pendingReqId)}>
                {saving && pendingReqId ? '执行中…' : '保存并立即同步'}</button>
              <button onClick={() => submit(false)} disabled={saving || !!pendingReqId} style={btn(CYAN, saving || !!pendingReqId)}>仅保存</button>
              <button onClick={resync} disabled={saving || !!pendingReqId} style={btn(AMBER, saving || !!pendingReqId)}>立即重新同步</button>
              <span style={{ color: '#3a5a70', fontSize: 11 }}>
                先校验 → 落库 → 落请求文件 → root 侧应用器执行（写 drop-in、重启服务、回读确认，失败自动回滚）
              </span>
            </div>
          </>
        )}
      </div>

      {/* 授时源探测 */}
      {(d.probe.targets || []).length > 0 && (
        <div style={{ ...card, marginTop: 12, flexShrink: 0 }}>
          <div style={{ color: '#7ab8e0', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>授时源探测（本机独立 SNTP，只看不改）</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={head}>目标</th><th style={head}>成功</th><th style={head}>层级</th>
              <th style={head}>偏差中位</th><th style={head}>极差</th><th style={head}>RTT</th>
            </tr></thead>
            <tbody>
              {(d.probe.targets || []).map((t, i) => (
                <tr key={i}>
                  <td style={cell}>
                    <span style={{ color: '#c8e6ff' }}>{t.host}</span>
                    {i === 0 && <span style={{ marginLeft: 6, fontSize: 10, color: GREEN, border: `1px solid ${GREEN}44`, borderRadius: 3, padding: '0 4px' }}>主源</span>}
                  </td>
                  <td style={{ ...cell, color: t.ok ? GREEN : RED }}>{t.nOk}/{t.n}</td>
                  <td style={{ ...cell, color: '#7ab8e0' }}>{t.stratum != null ? `${t.stratum}${fmtRefid(t.refid) ? ' / ' + fmtRefid(t.refid) : ''}` : '—'}</td>
                  <td style={{ ...cell, color: toneOfOffset(t.offsetMsMed, 50, 200) }}>{fmtMs(t.offsetMsMed)}</td>
                  <td style={{ ...cell, color: '#7ab8e0' }}>{fmtRange(t.offsetMsRange)}</td>
                  <td style={{ ...cell, color: '#7ab8e0' }}>{t.rttMsMed != null ? t.rttMsMed.toFixed(2) + ' ms' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 设备层 */}
      <div style={{ ...card, marginTop: 12, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: '#7ab8e0', fontSize: 12, fontWeight: 600 }}>
            设备层（NVR / 相机 {d.devices.length} 台）
          </span>
          <span style={{ color: AMBER, fontSize: 11 }}>只展示 · 不控制</span>
          <button onClick={() => setShowDev(!showDev)} style={{ ...btn(CYAN), marginLeft: 'auto', padding: '3px 10px' }}>
            {showDev ? '收起' : '展开'}</button>
        </div>
        {!d.remote?.ok && (
          <div style={{ color: AMBER, fontSize: 11, marginTop: 6 }}>
            数据源不可达：{d.remote?.url}（{d.remote?.err}）—— 该数据由 11 机 timekit 日巡检产生并经 5001 静态服务发布
          </div>
        )}
        {d.remote?.ok && (
          <div style={{ color: '#3a5a70', fontSize: 11, marginTop: 4 }}>
            来源 11 机 timekit 日巡检（{d.audit?.db ? 'db=' + d.audit.db : ''} 耗时 {d.audit?.elapsedS ?? '—'}s）·
            相机 NTP 已开，NVR 固件不应用 NTP → 偏差大属已知且已由补偿表覆盖，不影响帧内 OSD 定位
          </div>
        )}
        {showDev && (
          <div style={{ marginTop: 8, maxHeight: 320, overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={head}>设备</th><th style={head}>类型</th><th style={head}>IP</th>
                <th style={head}>偏差</th><th style={head}>抖动</th><th style={head}>阈值</th><th style={head}>判定</th>
              </tr></thead>
              <tbody>
                {(d.devices || []).map((x, i) => (
                  <tr key={i}>
                    <td style={{ ...cell, color: '#c8e6ff' }}>{x.label || '—'}</td>
                    <td style={{ ...cell, color: '#7ab8e0' }}>{kindLabel(x.kind)}</td>
                    <td style={{ ...cell, color: '#7ab8e0' }}>{x.ip || '—'}</td>
                    <td style={{ ...cell, color: toneOfOffset(x.offset_ms, x.kind === 'nvr' ? 1500 : 300, x.kind === 'nvr' ? 5000 : 1000) }}>{fmtMs(x.offset_ms)}</td>
                    <td style={{ ...cell, color: '#3a5a70' }}>{fmtRange(x.spread_ms)}</td>
                    <td style={{ ...cell, color: '#3a5a70' }}>{x.thr != null ? x.thr + ' ms' : '—'}</td>
                    <td style={{ ...cell, color: '#7ab8e0' }}>{x.verdict || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 快照 OSD 校验 */}
      <div style={{ ...card, marginTop: 12, marginBottom: 8, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: '#7ab8e0', fontSize: 12, fontWeight: 600 }}>快照 OSD 校验（{d.snapOsd.length} 路）</span>
          <span style={{ color: '#3a5a70', fontSize: 11 }}>画面 OSD vs 服务器钟之差＝取帧延迟，不是钟差</span>
          <button onClick={() => setShowOsd(!showOsd)} style={{ ...btn(CYAN), marginLeft: 'auto', padding: '3px 10px' }}>
            {showOsd ? '收起' : '展开'}</button>
        </div>
        {showOsd && (
          <div style={{ marginTop: 8, maxHeight: 220, overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={head}>通道</th><th style={head}>相机 IP</th><th style={head}>画面 OSD</th><th style={head}>延迟</th></tr></thead>
              <tbody>
                {(d.snapOsd || []).map((x, i) => (
                  <tr key={i}>
                    <td style={{ ...cell, color: '#c8e6ff' }}>{x.tag || '-'}</td>
                    <td style={{ ...cell, color: '#7ab8e0' }}>{x.ip}{x.ch != null ? ' ch' + x.ch : ''}</td>
                    <td style={{ ...cell, color: '#7ab8e0' }}>{x.osd || (x.err ? '读取失败' : '—')}</td>
                    <td style={{ ...cell, color: '#7ab8e0' }}>{fmtMs(x.lag_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 权限与实现说明 */}
      <div style={{ color: '#3a5a70', fontSize: 11, paddingBottom: 6, lineHeight: 1.7 }}>
        {d.readonlyReason}
        {A.dir && <> · 同步目录 <code>{A.dir}</code>{A.installed === false ? '（未安装 root 侧应用器）' : ''}</>}
      </div>
    </div>
  )
}

// 小工具：通知颜色（notice 无 outcome 时的兜底色）
function Cy(kind?: string) {
  return kind === 'bad' ? RED : kind === 'ok' ? GREEN : AMBER
}
