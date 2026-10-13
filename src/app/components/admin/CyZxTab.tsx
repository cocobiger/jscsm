/**
 * CyZxTab.tsx —— 智治推送 →「三级城运贯通」子页（批次 0 对应前端）
 *
 * 定位：把 AI 事件贯通到**三级城运中心（事件中心）**的后台配置与观测面板。
 * 设计口径与后端 `cyzx.js` 严格对应；五个子标签：
 *   ① 通道配置 ② 事件类型映射 ③ 码表 ④ 上报记录 ⑤ 配置自检
 *
 * 🔴 三条必须在 UI 上守住的原则：
 *   1) **码值只来自城运官方码表** —— 界面不提供"猜码值"，只提供"填报"和"导入"。
 *   2) **未就绪 = 不可上报** —— 「启用」与「码值非空」双条件；未满足的行显式标红"不可上报"。
 *   3) **自检未清零不许开总开关** —— 前端软拦（后端也有硬拦）。
 *
 * 风格沿用本页既有暗色主题（CYAN 主色 / SECTION_BG 卡片底）。
 */
import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../../lib/apiFetch'
// 图标统一用 lucide-react —— 与驾驶舱后台侧栏同一套线性图标，避免 emoji 风格不一致
import { Landmark, ShieldCheck, Plug, FolderTree, BookOpen, Upload, Save, CheckCheck, Search, ClipboardCheck, SendHorizontal, RefreshCw, Plus, Undo2, MapPin, Download, Radio } from 'lucide-react'

const CYAN = '#00aaff'
const GREEN = '#00e676'
const AMBER = '#ffd740'
const RED = '#ff4444'
const PURPLE = '#ab47bc'
const SECTION_BG = 'rgba(0,15,40,0.5)'
const TXT = '#c8e6ff'
const SUB = '#5a8aaa'
const DIM = '#3a5a70'

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '7px 10px', background: 'rgba(0,20,60,0.6)',
  border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3, color: TXT,
  fontSize: 13, outline: 'none', boxSizing: 'border-box',
}
const labelStyle: React.CSSProperties = { color: SUB, fontSize: 12, display: 'block', marginBottom: 4 }
const btnStyle = (color: string, ghost = false): React.CSSProperties => ({
  padding: '6px 14px', fontSize: 12, borderRadius: 3, cursor: 'pointer',
  border: `1px solid ${color}55`, background: ghost ? 'transparent' : `${color}18`,
  color: ghost ? SUB : color,
})
const cardStyle: React.CSSProperties = {
  background: SECTION_BG, border: '1px solid rgba(0,100,180,0.2)', borderRadius: 4,
  padding: 16, marginBottom: 12,
}
const badge = (color: string): React.CSSProperties => ({
  padding: '1px 7px', fontSize: 11, borderRadius: 2, background: `${color}18`, color,
})

// ── 与后端 cyzx.js 对齐的类型 ────────────────────────────────
interface CyzxConfig {
  enabled: boolean; baseUrl: string; sourceSystemCode: string; reportModeDefault: string
  authMode: string; token: string; tokenSet?: boolean; eventNature: string; isTest: boolean
  coordMode: string; callbackUrl: string; timeoutMs: number; retry: number
  perRecordEnabled: boolean; perRecordIntervalMs: number; perRecordLookbackH: number
  perRecordBatch: number; perRecordGate: string; perRecordGateConf: number
  llmUrl: string; llmModel: string; llmTimeoutMs: number
  cancelOnReviewFalse: boolean; systemYkzUserId: string; systemYkzUserName: string; cancelReasonTemplate: string
  fileDownloadDir: string
  connectTest: { at: string; ok: boolean; httpStatus: number | null; ms: number | null; error: string | null } | null
  updatedAt: string | null; updatedBy: string | null; _source?: string
}
interface MapRow {
  ai_type: string; source_key: string; cy_lv1: string; cy_lv2: string; cy_lv3: string
  cy_event_type: string; report_mode: string; granularity: string; scene_code: string
  enabled: boolean; note: string; mapped: boolean; ready: boolean
}
interface HealthItem { id: string; name: string; status: 'pass' | 'fail' | 'warn'; detail: string; hint: string }
interface Health {
  ok: boolean; summary: { fail: number; warn: number; pass: number; total: number }
  items: HealthItem[]; counters: Record<string, unknown>; checkedAt: string
}
interface ReportRow {
  id: number; event_num: string; warning_id: string; ai_type: string; cy_event_type: string
  report_mode: string; granularity: string; state: string; skip_reason: string
  success: number; retry_count: number; created_at: string
}
interface TaskOrder {
  id: number; task_order_id: string; event_num: string; task_code: string; task_name: string
  department_id: string; state: string; received_at: string; updated_at: string; disposal_count: number
}
interface Disposal {
  id: number; task_order_id: string; event_num: string; executor_id: string; executor: string
  executor_phone: string; execute_dept_id: string; execute_dept: string; execute_time: string
  execute_content: string; execute_node: string; attachments: string; is_last: number
  sync_state: string; sync_at: string | null; sync_error: string | null; created_at: string; created_by: string
}
interface CancelCandidate {
  event_num: string; warning_id: string; ai_type: string; created_at: string
  review: string | null; cancel_state: string | null; cancel_reason: string | null
}
interface DailyRow { date: string; should: number; sent: number; failed: number; pending: number; skipped: number; gated: number; cancelled: number; gap: number }
interface Reconcile {
  windowHours: number; since: string; should: number; sent: number; pending: number
  failed: number; gap: number; skippedByConfig: number; note: string
}

const STATE_COLOR: Record<string, string> = { pending: AMBER, sent: GREEN, failed: RED, skipped: DIM }
// 自检状态 → 色点（与后台顶栏 MQTT 指示灯同一写法：小圆点，不用 emoji）
const STATUS_DOT: Record<string, string> = { pass: GREEN, fail: RED, warn: AMBER }

type SubTab = 'config' | 'map' | 'codes' | 'reports' | 'health' | 'disposal' | 'ops'

export function CyZxTab() {
  const [sub, setSub] = useState<SubTab>('health')

  const TABS: { key: SubTab; label: string; Icon: typeof Landmark }[] = [
    { key: 'health', label: '配置自检', Icon: ShieldCheck },
    { key: 'config', label: '通道配置', Icon: Plug },
    { key: 'map', label: '事件类型映射', Icon: FolderTree },
    { key: 'codes', label: '码表', Icon: BookOpen },
    { key: 'reports', label: '上报记录', Icon: Upload },
    { key: 'disposal', label: '事项单与处置', Icon: ClipboardCheck },
    { key: 'ops', label: '撤销与运维', Icon: Undo2 },
  ]

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: '16px 24px 40px' }}>
      {/* 面包屑 + 说明 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <Landmark size={17} color={CYAN} />
        <span style={{ color: TXT, fontSize: 15, fontWeight: 700 }}>三级城运贯通</span>
        <span style={{ ...badge(AMBER), marginLeft: 4 }}>批次 2 · 总开关关闭时零请求</span>
      </div>
      <div style={{ color: SUB, fontSize: 12, marginBottom: 14, lineHeight: 1.7 }}>
        把 AI 事件上报到城运中心事件中心。出站受**总开关**约束（关闭 ⇒ 零请求）。两种口径并行：
        <span style={{ color: CYAN }}>「聚合」</span>按现有研判规则折叠后上报（如堆头未覆盖）；
        <span style={{ color: CYAN }}>「逐条」</span>逐条直出、不经研判闸门（如渣土车冒装，判罚证据不可漏）。
      </div>

      {/* 子标签 */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid rgba(0,80,150,0.2)' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setSub(t.key)} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 18px', fontSize: 13, borderRadius: '3px 3px 0 0', cursor: 'pointer',
            border: '1px solid rgba(0,80,150,0.2)',
            background: sub === t.key ? 'rgba(0,170,255,0.08)' : 'transparent',
            color: sub === t.key ? CYAN : SUB, fontWeight: sub === t.key ? 600 : 400,
            borderBottom: sub === t.key ? '1px solid rgba(3,10,28,0.98)' : '1px solid rgba(0,80,150,0.2)',
          }}><t.Icon size={14} /> {t.label}</button>
        ))}
      </div>

      {sub === 'health' && <HealthPanel />}
      {sub === 'config' && <ConfigPanel />}
      {sub === 'map' && <MapPanel />}
      {sub === 'codes' && <CodesPanel />}
      {sub === 'reports' && <ReportsPanel />}
      {sub === 'disposal' && <DisposalPanel />}
      {sub === 'ops' && <OpsPanel />}
    </div>
  )
}

// ════════════════════════════════════════════════════════════
//  ⑤ 配置自检
// ════════════════════════════════════════════════════════════
function HealthPanel() {
  const [h, setH] = useState<Health | null>(null)
  const [loading, setLoading] = useState(true)
  const [dry, setDry] = useState<any>(null)
  const [dryBusy, setDryBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try { setH(await apiFetch<Health>('/api/cyzx/health')) }
    catch (e: any) { alert('自检失败: ' + (e?.error || e?.message || e)) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const runDry = async () => {
    setDryBusy(true)
    try {
      const r = await apiFetch<any>('/api/cyzx/dry-run', {
        method: 'POST', body: JSON.stringify({ aiType: '渣土车冒装' }),
      })
      setDry(r)
    } catch (e: any) { alert('干跑失败: ' + (e?.error || e?.message || e)) }
    finally { setDryBusy(false) }
  }

  if (loading) return <div style={{ color: SUB, padding: 40, textAlign: 'center' }}>检查中...</div>
  if (!h) return <div style={{ color: RED, padding: 20 }}>自检不可用</div>

  const s = h.summary
  const overall = s.fail > 0 ? RED : (s.warn > 0 ? AMBER : GREEN)
  const overallText = s.fail > 0 ? `不可上线 · ${s.fail} 项阻断` : (s.warn > 0 ? `基本就绪 · ${s.warn} 项待办` : '全部就绪')

  return (
    <>
      <div style={{ ...cardStyle, borderColor: `${overall}55` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ color: overall, fontSize: 15, fontWeight: 700 }}>{overallText}</div>
            <div style={{ color: SUB, fontSize: 12, marginTop: 4 }}>
              检查时间 {h.checkedAt} · 通过 {s.pass} · 待办 {s.warn} · 阻断 {s.fail}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={btnStyle(CYAN, true)} onClick={load}>重新检查</button>
            <button style={btnStyle(PURPLE)} onClick={runDry} disabled={dryBusy}>
              {dryBusy ? '生成中...' : '干跑一条报文'}
            </button>
          </div>
        </div>
        {s.fail > 0 && (
          <div style={{ color: AMBER, fontSize: 12, marginTop: 10, lineHeight: 1.7 }}>
            未清零时不允许打开总开关（此前端会拦，后端也有硬拦）。逐项补齐后再回来点「重新检查」。
          </div>
        )}
      </div>

      <div style={cardStyle}>
        {/* 🔴 条数必须取自接口返回值：曾写死「8 条」，批次 2.5 加了「近24h对账缺口」后变成 9 条 ⇒ 汇总说 9、标题说 8 自相矛盾 */}
        <div style={{ color: TXT, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>自检明细（{h.items.length} 条）</div>
        {h.items.map(it => (
          <div key={it.id} style={{
            display: 'flex', gap: 10, padding: '8px 0', alignItems: 'flex-start',
            borderBottom: '1px solid rgba(0,80,150,0.12)',
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%', marginTop: 5, flexShrink: 0,
              background: STATUS_DOT[it.status] || DIM,
              boxShadow: it.status === 'fail' ? `0 0 6px ${RED}` : 'none',
            }} />
            <span style={{ color: TXT, fontSize: 13, minWidth: 130 }}>{it.name}</span>
            <span style={{ color: it.status === 'fail' ? AMBER : SUB, fontSize: 12, flex: 1, lineHeight: 1.6 }}>
              {it.detail}{it.hint ? <span style={{ color: DIM }}>（{it.hint}）</span> : ''}
            </span>
          </div>
        ))}

        {/* ── 样例说明（提醒：数字是示意，判据看颜色）────────────────────
            为什么加这一段：明细只告诉"还没配"，但**没告诉"配好之后该长什么样"**，
            值守员没法对照、容易反复试。给一份"配好后"的样例当参照。 */}
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed rgba(0,100,180,0.3)' }}>
          <div style={{ color: TXT, fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
            样例：<span style={{ color: GREEN }}>9 项全部配好之后</span>长这样
            <span style={{ ...badge(PURPLE), marginLeft: 8 }}>示意 · 非真实数据</span>
          </div>
          <div style={{ color: DIM, fontSize: 11.5, lineHeight: 1.8, marginBottom: 8 }}>
            下面右列的数字/地址<b style={{ color: SUB }}>只是举例</b>（实际以城运给的与你导入的为准）。
            <b style={{ color: AMBER }}>判断是否配好，请只看左边圆点的颜色</b>：🟢 通过 · 🟡 待办 · 🔴 阻断。
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ ...TH, width: 150 }}>检查项</th>
                <th style={{ ...TH, width: 190 }}>未配好（现在这样）</th>
                <th style={TH}>配好之后（样例）</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['总开关', '未开启', '已开启', '联调通过后再开；关着时系统零请求'],
                ['网关地址', '未填写', 'https://cyzx.cq.gov.cn', '城运给的地址；点「连通性测试」应回 200'],
                ['应用识别码', '未填写', 'HBJSC001', '城运三级平台分配给我方的标识'],
                ['可上报事件类型', '可上报 0 个 · 共 28 行', '可上报 28 个 · 共 28 行', '每类都要「启用=开」且「码值非空」'],
                ['自闭环 sceneCode', '需补', '已配齐（YABM0001 …）', '只有自闭环模式的事件类型才需要；否则显示「无需补」'],
                ['行政区划码表', '未导入', '已导入 3240 条', '县/街道/社区/网格四级，缺了区县码解析不出来'],
                ['渝快政组织码表', '未导入', '已导入 1856 条', '不填不传该字段，填了才会带上处置单位'],
                ['事件等级映射', '未配置', '已配置', '不配则按 0（一般）上报'],
                ['近24h对账缺口', '应推 0 · 已推 0 · 缺口 0', '应推 128 · 已推 128 · 缺口 0', '缺口必须为 0；被门控挡下的不计入缺口'],
              ].map(([name, before, after, note], i) => (
                <tr key={i} style={{ borderBottom: '1px solid rgba(0,80,150,0.1)' }}>
                  <td style={{ ...TD, color: TXT, whiteSpace: 'nowrap' }}>{name}</td>
                  <td style={{ ...TD, color: AMBER }}>{before}</td>
                  <td style={{ ...TD, color: GREEN }}>{after}
                    <span style={{ color: DIM, fontWeight: 400 }}>　— {note}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ color: DIM, fontSize: 11, marginTop: 8, lineHeight: 1.8 }}>
            提示：把 9 项全部变绿之后，点最上面的「<b style={{ color: SUB }}>干跑一条报文</b>」再核对一次字段，
            就可以按「使用说明」第 ③ 节的流程开总开关放量了。
          </div>
        </div>
      </div>

      {dry && (
        <div style={cardStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ color: TXT, fontSize: 13, fontWeight: 600 }}>
              干跑结果 —— {dry.ready ? <span style={{ color: GREEN }}>校验通过</span> : <span style={{ color: RED }}>存在阻断项</span>}
            </div>
            <div style={{ ...badge(PURPLE) }}>只组装报文 · 未发送任何请求</div>
          </div>
          <div style={{ color: SUB, fontSize: 12, marginBottom: 8 }}>
            告警 {dry.warning?.id} · {dry.warning?.aiType} · {dry.warning?.channelName} · 模式 {dry.reportMode}
          </div>
          {!dry.ready && (
            <div style={{ color: RED, fontSize: 12, marginBottom: 8 }}>
              阻断项：{dry.blockers?.join('、')}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))', gap: 6, marginBottom: 10 }}>
            {(dry.checks || []).map((c: any, i: number) => (
              <div key={i} style={{ fontSize: 12, color: c.ok ? SUB : RED }}>
                {c.ok ? '✓' : '✕'} {c.name}{c.detail ? `：${c.detail}` : ''}
              </div>
            ))}
          </div>
          <pre style={{
            background: 'rgba(0,10,30,0.7)', border: '1px solid rgba(0,100,180,0.2)',
            borderRadius: 3, padding: 12, color: '#9ad0f5', fontSize: 11.5,
            maxHeight: 320, overflow: 'auto', margin: 0,
          }}>{JSON.stringify(dry.payload, null, 2)}</pre>
        </div>
      )}
    </>
  )
}

// ════════════════════════════════════════════════════════════
//  ① 通道配置
// ════════════════════════════════════════════════════════════
function ConfigPanel() {
  const [cfg, setCfg] = useState<CyzxConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  const load = useCallback(async () => {
    try { const r = await apiFetch<{ config: CyzxConfig }>('/api/cyzx/config'); setCfg(r.config) }
    catch (e: any) { alert('加载配置失败: ' + (e?.error || e?.message || e)) }
  }, [])
  useEffect(() => { load() }, [load])

  const set = (k: keyof CyzxConfig, v: any) => setCfg(c => c ? { ...c, [k]: v } : c)

  const save = async () => {
    if (!cfg) return
    setSaving(true)
    try {
      // 安全阀：自检有阻断项时不允许打开总开关（后端也会拦）
      if (cfg.enabled) {
        const h = await apiFetch<Health>('/api/cyzx/health')
        if (h.summary.fail > 0) {
          alert(`还有 ${h.summary.fail} 项阻断未清零，不能打开总开关：\n` +
            h.items.filter(i => i.status === 'fail').map(i => '· ' + i.name + '：' + i.detail).join('\n'))
          setSaving(false); return
        }
      }
      const body: any = { ...cfg }
      delete body.connectTest; delete body.updatedAt; delete body.updatedBy; delete body._source; delete body.tokenSet
      const r = await apiFetch<{ config: CyzxConfig }>('/api/cyzx/config', { method: 'PUT', body: JSON.stringify(body) })
      setCfg(r.config)
      alert('已保存（配置立刻生效，无需重启服务）')
    } catch (e: any) { alert('保存失败: ' + (e?.error || e?.message || e)) }
    finally { setSaving(false) }
  }

  const test = async () => {
    setTesting(true)
    try {
      const r = await apiFetch<any>('/api/cyzx/test-connect', { method: 'POST', body: JSON.stringify({}) })
      const res = r.result || {}
      alert(res.ok
        ? `连通成功\nHTTP ${res.httpStatus} · ${res.ms}ms\n时间 ${res.at}`
        : `连通失败\n${res.error || ''}\n耗时 ${res.ms}ms`)
      load()
    } catch (e: any) { alert('测试异常: ' + (e?.error || e?.message || e)) }
    finally { setTesting(false) }
  }

  if (!cfg) return <div style={{ color: SUB, padding: 40, textAlign: 'center' }}>加载中...</div>

  const ct = cfg.connectTest
  return (
    <>
      <div style={{ ...cardStyle, borderColor: cfg.enabled ? `${RED}55` : undefined }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ color: cfg.enabled ? RED : SUB, fontSize: 14, fontWeight: 700 }}>
              {cfg.enabled ? '总开关：已开启（会真实上报）' : '总开关：关闭（零请求）'}
            </div>
            <div style={{ color: DIM, fontSize: 12, marginTop: 4 }}>
              配置来源：{cfg._source || 'db'}{cfg.updatedAt ? ` · 最后修改 ${cfg.updatedAt} by ${cfg.updatedBy}` : ''}
            </div>
          </div>
          <button style={btnStyle(cfg.enabled ? RED : GREEN)} onClick={() => set('enabled', !cfg.enabled)}>
            {cfg.enabled ? '关闭总开关' : '开启总开关'}
          </button>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={{ color: TXT, fontSize: 13, fontWeight: 600, marginBottom: 12 }}>网关与准入</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 12 }}>
          <div><label style={labelStyle}>网关地址 baseUrl</label>
            <input style={inputStyle} value={cfg.baseUrl} onChange={e => set('baseUrl', e.target.value)} placeholder="城运给，如 https://xxx.gov.cn" /></div>
          <div><label style={labelStyle}>应用识别码 sourceSystemCode</label>
            <input style={inputStyle} value={cfg.sourceSystemCode} onChange={e => set('sourceSystemCode', e.target.value)} placeholder="三级平台分配" /></div>
          <div><label style={labelStyle}>鉴权方式 authMode</label>
            <select style={inputStyle} value={cfg.authMode} onChange={e => set('authMode', e.target.value)}>
              <option value="none">none</option><option value="token">token</option><option value="sign">sign</option>
            </select></div>
          <div><label style={labelStyle}>令牌 token（只写不读，界面显示掩码）</label>
            <input style={inputStyle} type="text" value={cfg.token} onChange={e => set('token', e.target.value)} placeholder="不回显明文；不改动请勿填写" /></div>
          <div><label style={labelStyle}>我方接收地址 callbackUrl（注册给城运）</label>
            <input style={inputStyle} value={cfg.callbackUrl} onChange={e => set('callbackUrl', e.target.value)} placeholder="城运推事项单/抄告的目标地址" /></div>
          <div><label style={labelStyle}>全局缺省上报模式 reportModeDefault</label>
            <select style={inputStyle} value={cfg.reportModeDefault} onChange={e => set('reportModeDefault', e.target.value)}>
              <option value="eventReport">派单闭环（eventReport / 接口 4.1）</option>
              <option value="selfReport">自闭环（selfReport / 接口 4.7）</option>
            </select></div>
          <div><label style={labelStyle}>事件单属性 eventNature</label>
            <select style={inputStyle} value={cfg.eventNature} onChange={e => set('eventNature', e.target.value)}>
              <option value="1">1 测试单</option><option value="2">2 演练单</option><option value="3">3 正常单</option>
            </select></div>
          <div><label style={labelStyle}>坐标系 coordMode</label>
            <select style={inputStyle} value={cfg.coordMode} onChange={e => set('coordMode', e.target.value)}>
              <option value="84">84 坐标</option><option value="2000">2000 坐标</option>
            </select></div>
          <div><label style={labelStyle}>测试标 isTest</label>
            <button style={btnStyle(cfg.isTest ? AMBER : DIM)} onClick={() => set('isTest', !cfg.isTest)}>
              {cfg.isTest ? 'true（测试事件，不会发往正式环境）' : 'false（正式事件）'}
            </button></div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' }}>
          <button style={btnStyle(GREEN)} onClick={save} disabled={saving}>{saving ? '保存中...' : '保存配置'}</button>
          <button style={btnStyle(CYAN, true)} onClick={test} disabled={testing}>{testing ? '测试中...' : '连通性测试'}</button>
          {ct && (
            <span style={{ fontSize: 12, color: ct.ok ? GREEN : RED }}>
              上次测试 {ct.at} {ct.ok ? `成功 HTTP ${ct.httpStatus} ${ct.ms}ms` : `失败：${ct.error || ''}`}
            </span>
          )}
        </div>
      </div>

      <div style={cardStyle}>
        <div style={{ color: TXT, fontSize: 13, fontWeight: 600, marginBottom: 4 }}>逐条口径（如渣土车冒装）</div>
        <div style={{ color: DIM, fontSize: 12, marginBottom: 12 }}>
          逐条口径不经研判闸门（否则低位点永远攒不到阈值、会静默漏推）。这里单独控制它的开关与上报前门控。
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 12 }}>
          <div><label style={labelStyle}>逐条扫描开关 perRecordEnabled</label>
            <button style={btnStyle(cfg.perRecordEnabled ? CYAN : DIM)} onClick={() => set('perRecordEnabled', !cfg.perRecordEnabled)}>
              {cfg.perRecordEnabled ? '已启用' : '未启用'}
            </button></div>
          <div><label style={labelStyle}>上报前门控 perRecordGate</label>
            <select style={inputStyle} value={cfg.perRecordGate} onChange={e => set('perRecordGate', e.target.value)}>
              <option value="off">off（不门控，全量逐条）</option>
              <option value="min_confidence">min_confidence（置信度阈值）</option>
              <option value="review">review（人工复核确认为真才报）</option>
              <option value="llm">llm（本地大模型判图，判否不报）</option>
            </select>
            <div style={{ color: DIM, fontSize: 10.5, marginTop: 3, lineHeight: 1.6 }}>
              {cfg.perRecordGate === 'off' && '全量上报（误报率约 58%，慎用）'}
              {cfg.perRecordGate === 'min_confidence' && '低于阈值不报；建议 ≥0.90（需先测真值）'}
              {cfg.perRecordGate === 'review' && '只推「人工复核确认为真」的记录；未复核一律不推'}
              {cfg.perRecordGate === 'llm' && '调本地多模态模型判图；判否不报，判定失败一律放行'}
            </div>
          </div>
          <div><label style={labelStyle}>门控阈值 perRecordGateConf</label>
            <input style={inputStyle} type="number" step="0.01" min="0" max="1"
              value={cfg.perRecordGateConf} onChange={e => set('perRecordGateConf', Number(e.target.value))} /></div>
          <div><label style={labelStyle}>回看窗口 perRecordLookbackH（小时）</label>
            <input style={inputStyle} type="number" value={cfg.perRecordLookbackH}
              onChange={e => set('perRecordLookbackH', Number(e.target.value))} /></div>
          <div><label style={labelStyle}>单次处理上限 perRecordBatch</label>
            <input style={inputStyle} type="number" value={cfg.perRecordBatch}
              onChange={e => set('perRecordBatch', Number(e.target.value))} /></div>
          <div><label style={labelStyle}>扫描周期 perRecordIntervalMs</label>
            <input style={inputStyle} type="number" value={cfg.perRecordIntervalMs}
              onChange={e => set('perRecordIntervalMs', Number(e.target.value))} /></div>
          {cfg.perRecordGate === 'llm' && (
            <>
              <div><label style={labelStyle}>LLM 地址 llmUrl（空=env/默认 127.0.0.1:11434）</label>
                <input style={inputStyle} value={cfg.llmUrl} onChange={e => set('llmUrl', e.target.value)} placeholder="http://127.0.0.1:11434" /></div>
              <div><label style={labelStyle}>LLM 模型 llmModel</label>
                <input style={inputStyle} value={cfg.llmModel} onChange={e => set('llmModel', e.target.value)} placeholder="qwen2.5vl:7b" /></div>
              <div><label style={labelStyle}>LLM 超时 llmTimeoutMs</label>
                <input style={inputStyle} type="number" value={cfg.llmTimeoutMs}
                  onChange={e => set('llmTimeoutMs', Number(e.target.value))} /></div>
            </>
          )}
        </div>
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(0,80,150,0.18)' }}>
          <div style={{ color: TXT, fontSize: 13, fontWeight: 600, marginBottom: 4 }}>撤销（4.11）</div>
          <div style={{ color: DIM, fontSize: 12, marginBottom: 10 }}>
            Q5 决策：<b style={{ color: AMBER }}>复核判定为 AI 误报（review=false）⇒ 自动撤销已上报的事件单</b>。
            撤销接口要求传渝快政人员ID，自动撤销需要一个系统账号 ⇒ 必须先填下面的「自动撤销人员ID」。
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 12 }}>
            <div><label style={labelStyle}>自动撤销开关 cancelOnReviewFalse</label>
              <button style={btnStyle(cfg.cancelOnReviewFalse ? GREEN : DIM)} onClick={() => set('cancelOnReviewFalse', !cfg.cancelOnReviewFalse)}>
                {cfg.cancelOnReviewFalse ? '已启用（复核判误报自动撤）' : '已关闭'}
              </button></div>
            <div><label style={labelStyle}>自动撤销人员ID（渝快政）⛔ 待城运给</label>
              <input style={inputStyle} value={cfg.systemYkzUserId} onChange={e => set('systemYkzUserId', e.target.value)} placeholder="撤销接口必传" /></div>
            <div><label style={labelStyle}>自动撤销人员名称</label>
              <input style={inputStyle} value={cfg.systemYkzUserName} onChange={e => set('systemYkzUserName', e.target.value)} /></div>
            <div><label style={labelStyle}>默认撤销原因</label>
              <input style={inputStyle} value={cfg.cancelReasonTemplate} onChange={e => set('cancelReasonTemplate', e.target.value)} /></div>
            <div><label style={labelStyle}>附件下载落地目录（4.9）</label>
              <input style={inputStyle} value={cfg.fileDownloadDir} onChange={e => set('fileDownloadDir', e.target.value)} placeholder="cyzx-files" /></div>
          </div>
          {!cfg.systemYkzUserId && (
            <div style={{ marginTop: 8, color: AMBER, fontSize: 12 }}>
              未填「自动撤销人员ID」时，自动撤销会被**拒绝**（不会静默失败），请在拿到城运提供的人员ID后填写。
            </div>
          )}
        </div>
      </div>
    </>
  )
}

// ════════════════════════════════════════════════════════════
//  ② 事件类型映射（表格化 · UX 批次 A）
//  A-1 卡片→表格 ｜ A-2 目录只读/sceneCode条件显示/模式显示实际生效值
//  A-3 启用改开关 ｜ A-4 筛选+搜索+批量启用 ｜ A-5 行动指引 + 红色只留待办子集
// ════════════════════════════════════════════════════════════

type RowFilter = 'all' | 'todo' | 'ready' | 'per_record' | 'aggregate'

/** 生效上报模式：继承时用全局缺省（A-2：让用户看得出实际会走 4.1 还是 4.7） */
function effMode(r: MapRow, globalDefault: string): 'eventReport' | 'selfReport' {
  const m = (r.report_mode && r.report_mode !== 'inherit') ? r.report_mode : globalDefault
  return m === 'selfReport' ? 'selfReport' : 'eventReport'
}
// 中文在前、接口编号括注在后（4.x 是城运接口编号，不是步骤号）
const MODE_LABEL: Record<string, string> = { eventReport: '派单闭环（4.1）', selfReport: '自闭环（4.7）' }

function Switch({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} title={on ? '点击停用' : '点击启用'} style={{
      width: 34, height: 18, borderRadius: 9, padding: 0, cursor: 'pointer', position: 'relative',
      border: `1px solid ${on ? GREEN : 'rgba(0,150,220,0.3)'}`,
      background: on ? 'rgba(0,230,118,0.25)' : 'rgba(255,255,255,0.05)',
    }}>
      <span style={{
        position: 'absolute', top: 1.5, left: on ? 17 : 1.5, width: 13, height: 13, borderRadius: '50%',
        background: on ? GREEN : '#5a8aaa', transition: 'left .15s',
      }} />
    </button>
  )
}

const TH: React.CSSProperties = {
  textAlign: 'left', padding: '8px 10px', color: SUB, fontSize: 12, fontWeight: 400,
  borderBottom: '1px solid rgba(0,80,150,0.3)', whiteSpace: 'nowrap', position: 'sticky', top: 0,
  background: 'rgba(4,14,32,0.98)', zIndex: 1,
}
const TD: React.CSSProperties = { padding: '6px 10px', borderBottom: '1px solid rgba(0,80,150,0.1)', verticalAlign: 'middle' }

function MapPanel() {
  const [rows, setRows] = useState<MapRow[]>([])
  const [draft, setDraft] = useState<Record<string, MapRow>>({})
  const [globalMode, setGlobalMode] = useState('eventReport')
  const [busy, setBusy] = useState(false)
  const [paste, setPaste] = useState('')
  const [showPaste, setShowPaste] = useState(false)
  const [filter, setFilter] = useState<RowFilter>('all')
  const [kw, setKw] = useState('')

  const load = useCallback(async () => {
    try {
      const [m, c] = await Promise.all([
        apiFetch<{ items: MapRow[] }>('/api/cyzx/event-type-map'),
        apiFetch<{ config: { reportModeDefault?: string } }>('/api/cyzx/config')
          .catch(() => ({ config: {} as { reportModeDefault?: string } })),
      ])
      setRows(m.items || [])
      setDraft({})
      setGlobalMode(c.config?.reportModeDefault || 'eventReport')
    } catch (e: any) { alert('加载映射失败: ' + (e?.error || e?.message || e)) }
  }, [])
  useEffect(() => { load() }, [load])

  const view = (r: MapRow): MapRow => draft[r.ai_type] || r
  const patch = (r: MapRow, k: keyof MapRow, v: any) =>
    setDraft(d => ({ ...d, [r.ai_type]: { ...(d[r.ai_type] || r), [k]: v } }))

  /** A-1/A-3：整表保存（只提交有改动的行） */
  const saveAll = async () => {
    const keys = Object.keys(draft)
    if (!keys.length) return
    setBusy(true)
    try {
      for (const k of keys) {
        const d = draft[k]
        await apiFetch('/api/cyzx/event-type-map', {
          method: 'PUT',
          body: JSON.stringify({
            ai_type: d.ai_type, cy_event_type: d.cy_event_type, report_mode: d.report_mode,
            granularity: d.granularity, scene_code: d.scene_code, enabled: d.enabled,
            cy_lv1: d.cy_lv1, cy_lv2: d.cy_lv2, cy_lv3: d.cy_lv3, note: d.note,
          }),
        })
      }
      await load()
      alert(`已保存 ${keys.length} 行改动`)
    } catch (e: any) { alert('保存失败: ' + (e?.error || e?.message || e)) }
    finally { setBusy(false) }
  }

  /** A-4：批量启用「已就绪」的行（码值非空但未启用） */
  const enableReady = async () => {
    const targets = rows.filter(r => !r.enabled && r.cy_event_type && !draft[r.ai_type])
    if (!targets.length) { alert('没有「已填码值但未启用」的行。\n请先在表格中粘贴/填写城运码值。'); return }
    if (!confirm(`将启用 ${targets.length} 行（已填码值但未启用）。\n注意：启用后自检通过、且总开关打开时即会上报。继续？`)) return
    setBusy(true)
    try {
      for (const t of targets) await apiFetch('/api/cyzx/event-type-map', {
        method: 'PUT', body: JSON.stringify({ ai_type: t.ai_type, enabled: true }),
      })
      await load(); alert(`已启用 ${targets.length} 行`)
    } catch (e: any) { alert('批量启用失败: ' + (e?.error || e?.message || e)) }
    finally { setBusy(false) }
  }

  const doImport = async () => {
    setBusy(true)
    try {
      const r = await apiFetch<any>('/api/cyzx/event-type-map/bulk', { method: 'POST', body: JSON.stringify({ text: paste }) })
      const x = r.result || {}
      alert(`导入完成\n总 ${x.total} 行 · 新增 ${x.created} · 更新 ${x.updated} · 失败 ${x.failed?.length || 0}` +
        (x.failed?.length ? '\n\n失败明细：\n' + x.failed.slice(0, 10).map((f: any) => f.row + ' → ' + f.error).join('\n') : ''))
      setPaste(''); setShowPaste(false); load()
    } catch (e: any) { alert('导入失败: ' + (e?.error || e?.message || e)) }
    finally { setBusy(false) }
  }

  const dirtyCount = Object.keys(draft).length
  const readyCount = rows.filter(r => r.ready).length
  const unmapped = rows.filter(r => !r.cy_event_type).length
  const filledNotEnabled = rows.filter(r => r.cy_event_type && !r.enabled).length

  const filtered = rows.filter(r => {
    const d = view(r)
    if (kw && !String(d.ai_type).toLowerCase().includes(kw.toLowerCase()) &&
        ![d.cy_lv1, d.cy_lv2, d.cy_lv3, d.cy_event_type].join('/').toLowerCase().includes(kw.toLowerCase())) return false
    if (filter === 'todo') return !(d.enabled && d.cy_event_type)
    if (filter === 'ready') return !!(d.enabled && d.cy_event_type)
    if (filter === 'per_record') return d.granularity === 'per_record'
    if (filter === 'aggregate') return d.granularity === 'aggregate'
    return true
  })

  const FILTERS: { k: RowFilter; label: string; n: number }[] = [
    { k: 'all', label: '全部', n: rows.length },
    { k: 'todo', label: '未就绪', n: rows.filter(r => !(view(r).enabled && view(r).cy_event_type)).length },
    { k: 'ready', label: '已就绪', n: readyCount },
    { k: 'per_record', label: '逐条', n: rows.filter(r => r.granularity === 'per_record').length },
    { k: 'aggregate', label: '聚合', n: rows.filter(r => r.granularity === 'aggregate').length },
  ]

  return (
    <>
      {/* ── 操作条 + 摘要 + 行动指引（A-5）── */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 12, lineHeight: 1.7 }}>
            <span style={{ color: GREEN, fontWeight: 600 }}>可上报 {readyCount}</span>
            <span style={{ color: DIM }}> / 共 {rows.length} 行 · </span>
            <span style={{ color: unmapped ? AMBER : DIM }}>未填码值 {unmapped}</span>
            {filledNotEnabled > 0 && <span style={{ color: AMBER }}> · 已填未启用 {filledNotEnabled}</span>}
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            {dirtyCount > 0 && (
              <button style={btnStyle(CYAN)} onClick={saveAll} disabled={busy}>
                <Save size={12} style={{ verticalAlign: 'middle' }} /> 保存改动（{dirtyCount}）
              </button>
            )}
            <button style={btnStyle(GREEN, filledNotEnabled === 0)} onClick={enableReady} disabled={busy || filledNotEnabled === 0}>
              <CheckCheck size={12} style={{ verticalAlign: 'middle' }} /> 批量启用已就绪{filledNotEnabled ? `（${filledNotEnabled}）` : ''}
            </button>
            <button style={btnStyle(PURPLE)} onClick={() => setShowPaste(v => !v)}>批量粘贴导入</button>
          </div>
        </div>

        {unmapped > 0 && (
          <div style={{ marginTop: 8, color: AMBER, fontSize: 12 }}>
            下一步：把城运给的码表粘进「批量粘贴导入」→ 点「批量启用已就绪」→ 回「配置自检」确认阻断清零。
          </div>
        )}

        {showPaste && (
          <div style={{ marginTop: 12 }}>
            <div style={{ color: SUB, fontSize: 12, marginBottom: 6 }}>
              列顺序：<code style={{ color: CYAN }}>我方类型,算法key,一级,二级,三级,码值,报告模式,口径,场景码,启用,备注</code>
              （带表头自动跳过；支持从 Excel 直接粘贴）
            </div>
            <textarea style={{ ...inputStyle, minHeight: 140, fontFamily: 'monospace' }}
              value={paste} onChange={e => setPaste(e.target.value)}
              placeholder={'我方类型,算法key,一级,二级,三级,码值,报告模式,口径,场景码,启用,备注\n渣土车冒装,cover_det,城市管理,渣土运输,渣土车冒装,ac-011501,eventReport,per_record,,1,'} />
            <div style={{ marginTop: 8 }}>
              <button style={btnStyle(GREEN)} onClick={doImport} disabled={busy || !paste.trim()}>
                {busy ? '导入中...' : '确认导入'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── 筛选 + 搜索（A-4）── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        {FILTERS.map(f => (
          <button key={f.k} onClick={() => setFilter(f.k)} style={btnStyle(filter === f.k ? CYAN : DIM, filter !== f.k)}>
            {f.label} {f.n}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', position: 'relative' }}>
          <Search size={13} color={DIM} style={{ position: 'absolute', left: 8, top: 8 }} />
          <input style={{ ...inputStyle, width: 220, paddingLeft: 26 }} value={kw}
            onChange={e => setKw(e.target.value)} placeholder="搜索类型 / 目录 / 码值" />
        </div>
      </div>

      {/* ── 表格（A-1/A-2/A-3）── */}
      <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 400px)', border: '1px solid rgba(0,100,180,0.2)', borderRadius: 4 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr>
              <th style={{ ...TH, width: 150 }}>我方类型</th>
              <th style={{ ...TH, width: 150 }}>城运 eventType 码值 *</th>
              <th style={{ ...TH, width: 210 }}>三级目录（只读）</th>
              <th style={{ ...TH, width: 145 }}>上报模式（实际生效）</th>
              <th style={{ ...TH, width: 105 }}>上报口径</th>
              <th style={{ ...TH, width: 130 }}>sceneCode</th>
              <th style={{ ...TH, width: 66 }}>启用</th>
              <th style={{ ...TH, width: 84 }}>状态</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(r => {
              const d = view(r)
              const em = effMode(d, globalMode)
              const dirty = !!draft[r.ai_type]
              const ready = !!(d.enabled && d.cy_event_type)
              // A-5：红色只留给「该处理却还没处理」的子集 = 已填码值但未启用
              const todoRed = !!d.cy_event_type && !d.enabled
              return (
                <tr key={r.ai_type} style={{
                  background: todoRed ? 'rgba(255,68,68,0.06)' : (dirty ? 'rgba(0,170,255,0.05)' : 'transparent'),
                  borderLeft: todoRed ? `2px solid ${RED}` : (dirty ? `2px solid ${CYAN}` : '2px solid transparent'),
                }}>
                  <td style={TD}>
                    <div style={{ color: TXT, fontSize: 13 }}>{r.ai_type}</div>
                    <div style={{ color: DIM, fontSize: 10.5 }}>
                      {r.source_key ? `key=${r.source_key}` : ''}{dirty ? ' · 未保存' : ''}
                    </div>
                  </td>
                  <td style={TD}>
                    <input style={{ ...inputStyle, padding: '4px 8px', fontSize: 12 }} value={d.cy_event_type}
                      onChange={e => patch(r, 'cy_event_type', e.target.value)} placeholder="城运码表给" />
                  </td>
                  <td style={{ ...TD, color: DIM }}>{[d.cy_lv1, d.cy_lv2, d.cy_lv3].filter(Boolean).join(' / ') || '—'}</td>
                  <td style={TD}>
                    <select style={{ ...inputStyle, padding: '4px 6px', fontSize: 12 }} value={d.report_mode}
                      onChange={e => patch(r, 'report_mode', e.target.value)}>
                      <option value="inherit">继承全局</option>
                      <option value="eventReport">派单闭环（4.1）</option>
                      <option value="selfReport">自闭环（4.7）</option>
                    </select>
                    <div style={{ color: em === 'selfReport' ? AMBER : DIM, fontSize: 10.5, marginTop: 2 }}>
                      生效：{MODE_LABEL[em]}{d.report_mode === 'inherit' ? '（继承）' : ''}
                    </div>
                  </td>
                  <td style={TD}>
                    <select style={{ ...inputStyle, padding: '4px 6px', fontSize: 12 }} value={d.granularity}
                      onChange={e => patch(r, 'granularity', e.target.value)}>
                      <option value="aggregate">聚合事件</option>
                      <option value="per_record">逐条直出</option>
                    </select>
                  </td>
                  <td style={TD}>
                    {em === 'selfReport' ? (
                      <input style={{ ...inputStyle, padding: '4px 8px', fontSize: 12 }} value={d.scene_code}
                        onChange={e => patch(r, 'scene_code', e.target.value)} placeholder="YABM 开头" />
                    ) : <span style={{ color: DIM }}>—</span>}
                  </td>
                  <td style={{ ...TD, textAlign: 'center' }}>
                    <Switch on={!!d.enabled} onClick={() => patch(r, 'enabled', !d.enabled)} />
                  </td>
                  <td style={TD}>
                    <span style={badge(ready ? GREEN : (todoRed ? RED : DIM))}>{ready ? '可上报' : '不可上报'}</span>
                  </td>
                </tr>
              )
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={8} style={{ padding: 30, textAlign: 'center', color: DIM }}>没有匹配的行</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ color: DIM, fontSize: 11, marginTop: 8, lineHeight: 1.7 }}>
        码值只能来自城运官方码表——本界面不提供"猜码值"。<b>启用 = 开</b> 且 <b>码值非空</b> 才算「可上报」。
        红色行 = 已填码值但未启用（待处理）；蓝色左边 = 有未保存改动。
      </div>
    </>
  )
}
// ════════════════════════════════════════════════════════════
//  ③ 码表（B-3：导入后给前 10 行预览，避免"导了不知道对不对"）
// ════════════════════════════════════════════════════════════
function CodesPanel() {
  const [areaText, setAreaText] = useState('')
  const [orgText, setOrgText] = useState('')
  const [areaCnt, setAreaCnt] = useState(0)
  const [orgCnt, setOrgCnt] = useState(0)
  const [areaPrev, setAreaPrev] = useState<Record<string, string>[]>([])
  const [orgPrev, setOrgPrev] = useState<Record<string, string>[]>([])

  const refresh = useCallback(async () => {
    try {
      const h = await apiFetch<Health>('/api/cyzx/health')
      const num = (s?: string) => { const m = (s || '').match(/\d+/); return m ? Number(m[0]) : 0 }
      setAreaCnt(num(h.items.find(i => i.id === 'areaCode')?.detail))
      setOrgCnt(num(h.items.find(i => i.id === 'orgCode')?.detail))
    } catch { /* 忽略 */ }
  }, [])
  const loadPrev = useCallback(async () => {
    try {
      const [a, o] = await Promise.all([
        apiFetch<{ items: Record<string, string>[] }>('/api/cyzx/areas?limit=10'),
        apiFetch<{ items: Record<string, string>[] }>('/api/cyzx/orgs?limit=10'),
      ])
      setAreaPrev(a.items || []); setOrgPrev(o.items || [])
    } catch { /* 忽略 */ }
  }, [])
  useEffect(() => { refresh(); loadPrev() }, [refresh, loadPrev])

  const imp = async (kind: 'areas' | 'orgs', text: string) => {
    if (!text.trim()) return
    try {
      const r = await apiFetch<any>(`/api/cyzx/${kind}`, { method: 'POST', body: JSON.stringify({ text }) })
      kind === 'areas' ? setAreaText('') : setOrgText('')
      await Promise.all([refresh(), loadPrev()])
      const p = await apiFetch<{ items: Record<string, string>[] }>(`/api/cyzx/${kind}?limit=10`)
      const rows = (p.items || []).map(o => Object.values(o).slice(0, 4).join(' · ')).slice(0, 5).join('\n')
      alert(`导入完成：本次 ${r.imported} 条，累计 ${r.total} 条\n\n库中前 5 行：\n${rows || '(空)'}`)
    } catch (e: any) { alert('导入失败: ' + (e?.error || e?.message || e)) }
  }

  const prevTable = (rows: Record<string, string>[], cols: string[], labels: string[]) => (
    rows.length === 0 ? (
      <div style={{ color: DIM, fontSize: 12, marginTop: 8 }}>（库中暂无数据）</div>
    ) : (
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 8 }}>
        <thead><tr>{labels.map(l => <th key={l} style={{ ...TH, width: 'auto' }}>{l}</th>)}</tr></thead>
        <tbody>
          {rows.slice(0, 10).map((r, i) => (
            <tr key={i}>{cols.map(c => <td key={c} style={{ ...TD, color: TXT }}>{r[c] || '—'}</td>)}</tr>
          ))}
        </tbody>
      </table>
    )
  )

  return (
    <>
      <div style={{ color: DIM, fontSize: 12, marginBottom: 12, lineHeight: 1.7 }}>
        码表用于把「我方点位地址」解析成城运要求的 <code style={{ color: CYAN }}>belongCounty / belongStreet</code>
        （县与街道必须上下级匹配，不匹配会被城运拒单）。拿到城运码表文件后直接粘贴导入即可。
      </div>

      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <span style={{ color: TXT, fontSize: 13, fontWeight: 600 }}>行政区划码表</span>
          <span style={{ color: SUB, fontSize: 12 }}>已导入 <b style={{ color: areaCnt ? GREEN : DIM }}>{areaCnt}</b> 条</span>
        </div>
        <div style={{ color: SUB, fontSize: 12, marginBottom: 6 }}>
          列顺序：<code style={{ color: CYAN }}>区划码,名称,级别(county|street|community|grid),父码</code>
        </div>
        <textarea style={{ ...inputStyle, minHeight: 110, fontFamily: 'monospace' }}
          value={areaText} onChange={e => setAreaText(e.target.value)}
          placeholder={'区划码,名称,级别,父码\n500101,万州区,county,500000\n500101001,九龙街道,street,500101'} />
        <div style={{ marginTop: 8 }}>
          <button style={btnStyle(GREEN)} onClick={() => imp('areas', areaText)} disabled={!areaText.trim()}>导入区划码表</button>
        </div>
        {prevTable(areaPrev, ['code', 'name', 'level', 'parent_code'], ['区划码', '名称', '级别', '父码'])}
      </div>

      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <span style={{ color: TXT, fontSize: 13, fontWeight: 600 }}>渝快政组织机构码表</span>
          <span style={{ color: SUB, fontSize: 12 }}>已导入 <b style={{ color: orgCnt ? GREEN : DIM }}>{orgCnt}</b> 条</span>
        </div>
        <div style={{ color: SUB, fontSize: 12, marginBottom: 6 }}>
          列顺序：<code style={{ color: CYAN }}>orgId,名称,类型</code>（用于 suggestDealUnit / copyToUnit / taskDeptId）
        </div>
        <textarea style={{ ...inputStyle, minHeight: 100, fontFamily: 'monospace' }}
          value={orgText} onChange={e => setOrgText(e.target.value)}
          placeholder={'orgId,名称,类型\nGO_xxxxx,万州区城市管理局,dept'} />
        <div style={{ marginTop: 8 }}>
          <button style={btnStyle(GREEN)} onClick={() => imp('orgs', orgText)} disabled={!orgText.trim()}>导入组织码表</button>
        </div>
        {prevTable(orgPrev, ['org_id', 'name', 'type'], ['orgId', '名称', '类型'])}
      </div>
    </>
  )
}

// ════════════════════════════════════════════════════════════
//  ④ 上报记录 + 对账（B-1：客户端筛选 + 只看问题 + 分页）
// ════════════════════════════════════════════════════════════
const PAGE_SIZE = 50

type Sf = 'all' | 'pending' | 'sent' | 'failed' | 'skipped' | 'problem'
const SF_LABEL: { k: Sf; label: string }[] = [
  { k: 'all', label: '全部' }, { k: 'pending', label: '待上报' }, { k: 'sent', label: '已上报' },
  { k: 'failed', label: '失败' }, { k: 'skipped', label: '被跳过' }, { k: 'problem', label: '只看问题' },
]

function ReportsPanel() {
  const [items, setItems] = useState<ReportRow[]>([])
  const [stats, setStats] = useState<Record<string, number>>({})
  const [rec, setRec] = useState<Reconcile | null>(null)
  const [sf, setSf] = useState<Sf>('all')
  const [page, setPage] = useState(1)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await apiFetch<{ items: ReportRow[]; stats: Record<string, number> }>('/api/cyzx/reports?limit=500')
      setItems(r.items || []); setStats(r.stats || {})
      setRec(await apiFetch<Reconcile>('/api/cyzx/reconcile?hours=24'))
    } catch (e: any) { alert('加载记录失败: ' + (e?.error || e?.message || e)) }
  }, [])
  useEffect(() => { load() }, [load])

  const scanNow = async () => {
    setBusy(true)
    try {
      const r = await apiFetch<any>('/api/cyzx/scan-now', { method: 'POST', body: JSON.stringify({}) })
      alert('已触发一次逐条扫描\n' + JSON.stringify(r.result || r))
      load()
    } catch (e: any) { alert('触发失败: ' + (e?.error || e?.message || e)) }
    finally { setBusy(false) }
  }

  const filtered = items.filter(it => {
    if (sf === 'all') return true
    if (sf === 'problem') return it.state === 'failed' || it.state === 'skipped'
    return it.state === sf
  })
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const cur = Math.min(page, pages)
  const view = filtered.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE)

  return (
    <>
      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <div style={{ display: 'flex', gap: 18, fontSize: 12 }}>
            {(['pending', 'sent', 'failed', 'skipped'] as const).map(k => (
              <span key={k} style={{ color: STATE_COLOR[k], cursor: 'pointer' }}
                onClick={() => { setSf(k); setPage(1) }}>
                {({ pending: '待上报', sent: '已上报', failed: '失败', skipped: '被跳过' })[k]} {stats[k] || 0}
              </span>
            ))}
          </div>
          <button style={btnStyle(CYAN, true)} onClick={scanNow} disabled={busy}>
            {busy ? '执行中...' : '立即扫描一次'}
          </button>
        </div>
        {rec && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid rgba(0,80,150,0.15)', fontSize: 12, lineHeight: 1.8 }}>
            <span style={{ color: TXT }}>近 {rec.windowHours}h 对账：</span>
            <span style={{ color: SUB }}>应推 {rec.should} · 已推 {rec.sent} · </span>
            <span style={{ color: rec.gap > 0 ? RED : GREEN }}>缺口 {rec.gap}</span>
            <span style={{ color: SUB }}> · 待映射/缺场景码被跳过 {rec.skippedByConfig}</span>
            <div style={{ color: DIM, marginTop: 4 }}>{rec.note}</div>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {SF_LABEL.map(f => (
          <button key={f.k} style={btnStyle(sf === f.k ? (f.k === 'problem' ? RED : CYAN) : DIM, sf !== f.k)}
            onClick={() => { setSf(f.k); setPage(1) }}>{f.label}</button>
        ))}
        <span style={{ marginLeft: 'auto', color: DIM, fontSize: 12 }}>
          共 {filtered.length} 条{filtered.length > PAGE_SIZE ? ` · 第 ${cur}/${pages} 页` : ''}
        </span>
      </div>

      <div style={{ overflowX: 'auto', border: '1px solid rgba(0,100,180,0.2)', borderRadius: 4 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              {['幂等键 event_num', '我方类型', '城运码值', '模式 / 口径', '状态', '原因', '时间'].map(h => (
                <th key={h} style={TH}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.map(it => (
              <tr key={it.id} style={{ borderLeft: it.state === 'failed' ? `2px solid ${RED}` : '2px solid transparent' }}>
                <td style={{ ...TD, color: SUB, fontFamily: 'monospace' }}>{it.event_num}</td>
                <td style={{ ...TD, color: TXT }}>{it.ai_type}</td>
                <td style={{ ...TD, color: CYAN }}>{it.cy_event_type || '—'}</td>
                <td style={{ ...TD, color: SUB }}>{it.report_mode} / {it.granularity}</td>
                <td style={TD}><span style={badge(STATE_COLOR[it.state] || DIM)}>{it.state}</span></td>
                <td style={{ ...TD, color: DIM, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={it.skip_reason}>{it.skip_reason || '—'}</td>
                <td style={{ ...TD, color: SUB, whiteSpace: 'nowrap' }}>{it.created_at}</td>
              </tr>
            ))}
            {view.length === 0 && (
              <tr><td colSpan={7} style={{ padding: 30, textAlign: 'center', color: DIM }}>
                {sf === 'all' ? '暂无上报记录' : '该筛选下没有记录'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div style={{ display: 'flex', gap: 6, justifyContent: 'center', alignItems: 'center', marginTop: 12 }}>
          <button style={btnStyle(cur > 1 ? CYAN : DIM, cur <= 1)} disabled={cur <= 1} onClick={() => setPage(cur - 1)}>上一页</button>
          <span style={{ color: SUB, fontSize: 12 }}>{cur} / {pages}</span>
          <button style={btnStyle(cur < pages ? CYAN : DIM, cur >= pages)} disabled={cur >= pages} onClick={() => setPage(cur + 1)}>下一页</button>
        </div>
      )}
    </>
  )
}

// ════════════════════════════════════════════════════════════
//  ⑤ 事项单与处置（批次 2-3 处置工作台）
//  4.1 派单闭环：4.1 上报 → 收 4.2 事项单 → 录入处置 → 4.3 反馈
//  4.7 自闭环：录入处置 → 上报时内嵌 taskOrderOutPuts
// ════════════════════════════════════════════════════════════
const BLANK_DISP = {
  eventNum: '', taskOrderId: '', executorId: '', executor: '', executorPhone: '',
  executeDeptId: '', executeDept: '', executeTime: '', executeContent: '', executeNode: '办理', attachUrl: '',
}

function DisposalPanel() {
  const [tos, setTos] = useState<TaskOrder[]>([])
  const [disps, setDisps] = useState<Disposal[]>([])
  const [pending, setPending] = useState<ReportRow[]>([])
  const [form, setForm] = useState<typeof BLANK_DISP | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [a, b, c] = await Promise.all([
        apiFetch<{ items: TaskOrder[] }>('/api/cyzx/task-orders?limit=200'),
        apiFetch<{ items: Disposal[] }>('/api/cyzx/disposals?limit=200'),
        apiFetch<{ items: ReportRow[] }>('/api/cyzx/reports?limit=500'),
      ])
      setTos(a.items || []); setDisps(b.items || [])
      // 需要处置/上报的事件单号（pending / failed，去重）
      const seen = new Set<string>()
      const p = (c.items || []).filter(r => r.state === 'pending' || r.state === 'failed')
        .filter(r => { if (seen.has(r.event_num)) return false; seen.add(r.event_num); return true })
      setPending(p)
    } catch (e: any) { alert('加载失败: ' + (e?.error || e?.message || e)) }
  }, [])
  useEffect(() => { load() }, [load])

  const set = (k: keyof typeof BLANK_DISP, v: string) => setForm(f => f ? { ...f, [k]: v } : f)

  const save = async () => {
    if (!form) return
    if (!form.eventNum) { alert('事件单号 eventNum 必填'); return }
    if (!form.executeContent.trim()) { alert('处置意见必填（城运要求 taskOrderOutputArray 必须含 executeContent）'); return }
    setBusy(true)
    try {
      await apiFetch('/api/cyzx/disposal', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          attachments: form.attachUrl ? [{ url: form.attachUrl, fileType: '01', attachmentType: '1', fileName: '处置后.jpg' }] : [],
        }),
      })
      setForm(null); await load(); alert('处置已保存')
    } catch (e: any) { alert('保存失败: ' + (e?.error || e?.message || e)) }
    finally { setBusy(false) }
  }

  const reportNow = async (eventNum?: string) => {
    setBusy(true)
    try {
      const r = await apiFetch<any>('/api/cyzx/report-now', { method: 'POST', body: JSON.stringify(eventNum ? { eventNum } : {}) })
      const s = (r.results || []).filter((x: any) => x.state === 'sent').length
      alert(`已处理 ${r.processed || 0} 条，成功 ${s} 条`)
      await load()
    } catch (e: any) { alert('上报失败: ' + (e?.error || e?.message || e)) }
    finally { setBusy(false) }
  }

  const feedback = async (eventNum: string) => {
    if (!confirm(`向城运反馈「${eventNum}」的处置结果？`)) return
    setBusy(true)
    try {
      const r = await apiFetch<any>('/api/cyzx/feedback', { method: 'POST', body: JSON.stringify({ eventNum }) })
      alert(r.ok ? `反馈成功（HTTP ${r.httpStatus}）` : `反馈失败：${r.error || ''}`)
      await load()
    } catch (e: any) { alert('反馈异常: ' + (e?.error || e?.message || e)) }
    finally { setBusy(false) }
  }

  const dispOf = (ev: string) => disps.filter(d => d.event_num === ev)

  return (
    <>
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 12, lineHeight: 1.7 }}>
            <span style={{ color: AMBER, fontWeight: 600 }}>待处置/待上报 {pending.length}</span>
            <span style={{ color: DIM }}> · 事项单 </span><span style={{ color: TXT }}>{tos.length}</span>
            <span style={{ color: DIM }}> · 处置记录 </span><span style={{ color: TXT }}>{disps.length}</span>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button style={btnStyle(CYAN)} onClick={() => setForm({ ...BLANK_DISP, eventNum: pending[0]?.event_num || '' })} disabled={busy}>
              <Plus size={12} style={{ verticalAlign: 'middle' }} /> 录入处置
            </button>
            <button style={btnStyle(GREEN, true)} onClick={() => reportNow()} disabled={busy || pending.length === 0}>
              <SendHorizontal size={12} style={{ verticalAlign: 'middle' }} /> 立即上报全部待发
            </button>
            <button style={btnStyle(SUB, true)} onClick={load} disabled={busy}>
              <RefreshCw size={12} style={{ verticalAlign: 'middle' }} /> 刷新
            </button>
          </div>
        </div>
        <div style={{ marginTop: 8, color: DIM, fontSize: 11.5, lineHeight: 1.7 }}>
          <b style={{ color: TXT }}>派单闭环</b>：我方上报 → 城运派单（事项单入库）→ 我方录入处置 → 反馈处置结果。
          <b style={{ color: TXT }}>自闭环</b>：我方先录入处置，上报时把处置一起带上（内嵌 taskOrderOutPuts，含至少 1 条 logList）。
          <span style={{ color: DIM }}>（对应城运接口：派单闭环 4.1→4.2→4.3；自闭环 4.7→4.8）</span>
          <b style={{ color: AMBER }}> 未录入处置的自闭环事件会被跳过，不会被误发。</b>
        </div>
      </div>

      {form && (
        <div style={{ ...cardStyle, borderColor: 'rgba(0,170,255,0.4)' }}>
          <div style={{ color: TXT, fontSize: 13, fontWeight: 600, marginBottom: 12 }}>录入处置记录</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 10 }}>
            <div><label style={labelStyle}>事件单号 eventNum *</label>
              <input style={inputStyle} value={form.eventNum} onChange={e => set('eventNum', e.target.value)} list="cyzx-pending" />
              <datalist id="cyzx-pending">{pending.map(p => <option key={p.event_num} value={p.event_num} />)}</datalist></div>
            <div><label style={labelStyle}>事项单号（可空）</label>
              <input style={inputStyle} value={form.taskOrderId} onChange={e => set('taskOrderId', e.target.value)} /></div>
            <div><label style={labelStyle}>处置人</label>
              <input style={inputStyle} value={form.executor} onChange={e => set('executor', e.target.value)} /></div>
            <div><label style={labelStyle}>处置人手机号</label>
              <input style={inputStyle} value={form.executorPhone} onChange={e => set('executorPhone', e.target.value)} /></div>
            <div><label style={labelStyle}>处置部门ID（渝快政）</label>
              <input style={inputStyle} value={form.executeDeptId} onChange={e => set('executeDeptId', e.target.value)} /></div>
            <div><label style={labelStyle}>处置部门</label>
              <input style={inputStyle} value={form.executeDept} onChange={e => set('executeDept', e.target.value)} /></div>
            <div><label style={labelStyle}>处置时间（上海时，空=当前）</label>
              <input style={inputStyle} value={form.executeTime} onChange={e => set('executeTime', e.target.value)} placeholder="yyyy-MM-dd HH:mm:ss" /></div>
            <div><label style={labelStyle}>处置动作 executeNode</label>
              <input style={inputStyle} value={form.executeNode} onChange={e => set('executeNode', e.target.value)} /></div>
            <div><label style={labelStyle}>附件 URL（处置后照片）</label>
              <input style={inputStyle} value={form.attachUrl} onChange={e => set('attachUrl', e.target.value)} placeholder="http://…" /></div>
          </div>
          <div style={{ marginTop: 10 }}>
            <label style={labelStyle}>处置意见 executeContent *（城运必填）</label>
            <textarea style={{ ...inputStyle, minHeight: 70 }} value={form.executeContent}
              onChange={e => set('executeContent', e.target.value)} placeholder="如：已现场核查并责令整改苫盖，复查合格" />
          </div>
          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            <button style={btnStyle(GREEN)} onClick={save} disabled={busy}>{busy ? '保存中...' : '保存处置'}</button>
            <button style={btnStyle(SUB, true)} onClick={() => setForm(null)}>取消</button>
          </div>
        </div>
      )}

      {/* 待处置 / 待上报 */}
      <div style={{ color: TXT, fontSize: 13, fontWeight: 600, margin: '14px 0 8px' }}>待处置 / 待上报的事件</div>
      <div style={{ overflowX: 'auto', border: '1px solid rgba(0,100,180,0.2)', borderRadius: 4, marginBottom: 16 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead><tr>{['事件单号', '我方类型', '状态', '原因', '已录处置', '操作'].map(h => <th key={h} style={TH}>{h}</th>)}</tr></thead>
          <tbody>
            {pending.map(p => (
              <tr key={p.event_num} style={{ borderLeft: p.state === 'failed' ? `2px solid ${RED}` : `2px solid ${AMBER}` }}>
                <td style={{ ...TD, color: SUB, fontFamily: 'monospace' }}>{p.event_num}</td>
                <td style={{ ...TD, color: TXT }}>{p.ai_type}</td>
                <td style={TD}><span style={badge(STATE_COLOR[p.state] || DIM)}>{p.state}</span></td>
                <td style={{ ...TD, color: DIM, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.skip_reason}>{p.skip_reason || '—'}</td>
                <td style={{ ...TD, color: dispOf(p.event_num).length ? GREEN : DIM }}>{dispOf(p.event_num).length}</td>
                <td style={TD}>
                  <button style={btnStyle(CYAN, true)} onClick={() => setForm({ ...BLANK_DISP, eventNum: p.event_num })}>录入处置</button>
                  <button style={{ ...btnStyle(GREEN, true), marginLeft: 6 }} onClick={() => reportNow(p.event_num)}>上报</button>
                  {dispOf(p.event_num).length > 0 && (
                    <button style={{ ...btnStyle(PURPLE, true), marginLeft: 6 }} onClick={() => feedback(p.event_num)}>反馈</button>
                  )}
                </td>
              </tr>
            ))}
            {pending.length === 0 && (
              <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: DIM }}>
                没有待处置/待上报的事件（可能全部已上报，或总开关关闭且尚未扫描）
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 事项单（4.2 入站） */}
      <div style={{ color: TXT, fontSize: 13, fontWeight: 600, margin: '0 0 8px' }}>
        城运派单事项单（4.2 入站）
        <span style={{ color: DIM, fontSize: 11, fontWeight: 400, marginLeft: 8 }}>
          由城运业务协同网关推送，落库幂等（taskOrderId 唯一）
        </span>
      </div>
      <div style={{ overflowX: 'auto', border: '1px solid rgba(0,100,180,0.2)', borderRadius: 4, marginBottom: 16 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead><tr>{['事项单ID', '事件单号', '事项', '所属部门', '状态', '处置数', '收到时间'].map(h => <th key={h} style={TH}>{h}</th>)}</tr></thead>
          <tbody>
            {tos.map(t => (
              <tr key={t.task_order_id}>
                <td style={{ ...TD, color: SUB, fontFamily: 'monospace' }}>{t.task_order_id}</td>
                <td style={{ ...TD, color: SUB, fontFamily: 'monospace' }}>{t.event_num || '—'}</td>
                <td style={{ ...TD, color: TXT }}>{t.task_name || t.task_code || '—'}</td>
                <td style={{ ...TD, color: SUB }}>{t.department_id || '—'}</td>
                <td style={TD}><span style={badge(t.state === 'fed' ? GREEN : (t.state === 'disposed' ? CYAN : AMBER))}>{t.state}</span></td>
                <td style={{ ...TD, color: t.disposal_count ? GREEN : DIM }}>{t.disposal_count}</td>
                <td style={{ ...TD, color: SUB, whiteSpace: 'nowrap' }}>{t.received_at}</td>
              </tr>
            ))}
            {tos.length === 0 && (
              <tr><td colSpan={7} style={{ padding: 24, textAlign: 'center', color: DIM }}>
                暂无事项单（城运派单后由 <code style={{ color: CYAN }}>POST /cyzx/inbound/taskorder</code> 推送）
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 处置记录 */}
      <div style={{ color: TXT, fontSize: 13, fontWeight: 600, margin: '0 0 8px' }}>处置记录（含反馈同步态）</div>
      <div style={{ overflowX: 'auto', border: '1px solid rgba(0,100,180,0.2)', borderRadius: 4 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead><tr>{['事件单号', '处置人', '处置部门', '处置时间', '处置意见', '同步态', '录入人'].map(h => <th key={h} style={TH}>{h}</th>)}</tr></thead>
          <tbody>
            {disps.map(d => (
              <tr key={d.id}>
                <td style={{ ...TD, color: SUB, fontFamily: 'monospace' }}>{d.event_num}</td>
                <td style={{ ...TD, color: TXT }}>{d.executor || '—'}{d.executor_phone ? ` · ${d.executor_phone}` : ''}</td>
                <td style={{ ...TD, color: SUB }}>{d.execute_dept || '—'}</td>
                <td style={{ ...TD, color: SUB, whiteSpace: 'nowrap' }}>{d.execute_time}</td>
                <td style={{ ...TD, color: TXT, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.execute_content}>{d.execute_content}</td>
                <td style={TD}><span style={badge(d.sync_state === 'sent' ? GREEN : (d.sync_state === 'failed' ? RED : AMBER))}>{d.sync_state}</span>
                  {d.sync_error && <span style={{ color: DIM, fontSize: 10.5, marginLeft: 6 }} title={d.sync_error}>{d.sync_error.slice(0, 24)}</span>}</td>
                <td style={{ ...TD, color: DIM }}>{d.created_by || '—'}</td>
              </tr>
            ))}
            {disps.length === 0 && (
              <tr><td colSpan={7} style={{ padding: 24, textAlign: 'center', color: DIM }}>暂无处置记录</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

// ════════════════════════════════════════════════════════════
//  ⑥ 撤销与运维（批次 3）
//  4.11 撤销（含自动）· 4.10 更新 · 4.9 附件下载 · 4.5/4.12/4.13 入站 · 对账日报
// ════════════════════════════════════════════════════════════
/**
 * 城运《接口文档》的**接口编号**（形如 4.11）小标注。
 * 🔴 它不是"第几步"、也不是版本号 —— 因此**不放在标题最前面**（否则读者会以为是操作顺序），
 *    只作为标题右侧的灰色小标签，供联调时对着接口文档定位。
 */
const ApiNo = ({ no }: { no: string }) => (
  <span title="城运《接口文档》的接口编号（联调时对文档定位用），不是操作步骤" style={{
    fontSize: 11, color: DIM, border: '1px solid rgba(0,100,180,0.35)', borderRadius: 3,
    padding: '0 5px', marginLeft: 8, fontWeight: 400, whiteSpace: 'nowrap', cursor: 'help',
  }}>接口 {no}</span>
)

function OpsPanel() {
  const [cands, setCands] = useState<CancelCandidate[]>([])
  const [daily, setDaily] = useState<DailyRow[]>([])
  const [inbound, setInbound] = useState<{ updates: any[]; notices: any[] }>({ updates: [], notices: [] })
  const [manual, setManual] = useState('')
  const [upd, setUpd] = useState({ eventNum: '', lon: '', lat: '', eventAddress: '', eventTitle: '', eventContent: '' })
  const [dl, setDl] = useState({ url: '', fileName: '' })
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [a, b, c] = await Promise.all([
        apiFetch<{ items: CancelCandidate[] }>('/api/cyzx/cancel-candidates?limit=100'),
        apiFetch<{ rows: DailyRow[] }>('/api/cyzx/report-daily?days=7'),
        apiFetch<{ updates: any[]; notices: any[] }>('/api/cyzx/inbound-records?limit=50'),
      ])
      setCands(a.items || []); setDaily(b.rows || []); setInbound({ updates: c.updates || [], notices: c.notices || [] })
    } catch (e: any) { alert('加载失败: ' + (e?.error || e?.message || e)) }
  }, [])
  useEffect(() => { load() }, [load])

  const cancelNow = async (nums: string) => {
    if (!nums.trim()) return
    if (!confirm(`确认向城运撤销以下事件单？\n${nums}\n\n⚠️ 撤销不可逆。`)) return
    setBusy(true)
    try {
      const r = await apiFetch<any>('/api/cyzx/cancel', { method: 'POST', body: JSON.stringify({ eventNums: nums.split(/[,\s]+/).filter(Boolean) }) })
      alert(r.ok ? `撤销成功（HTTP ${r.httpStatus}）` : `撤销失败：${r.error || ''}`)
      setManual(''); await load()
    } catch (e: any) { alert('撤销异常: ' + (e?.error || e?.message || e)) }
    finally { setBusy(false) }
  }
  const autoScan = async () => {
    setBusy(true)
    try {
      const r = await apiFetch<any>('/api/cyzx/auto-cancel-scan', { method: 'POST', body: JSON.stringify({ limit: 100 }) })
      alert('自动撤销扫描结果：\n' + JSON.stringify(r.result || r, null, 2))
      await load()
    } catch (e: any) { alert('扫描异常: ' + (e?.error || e?.message || e)) }
    finally { setBusy(false) }
  }
  const doUpdate = async () => {
    setBusy(true)
    try {
      const r = await apiFetch<any>('/api/cyzx/update-event', { method: 'POST', body: JSON.stringify(upd) })
      alert(r.ok ? '已更新（4.10）' : '更新失败：' + (r.error || ''))
    } catch (e: any) { alert('更新异常: ' + (e?.error || e?.message || e)) }
    finally { setBusy(false) }
  }
  const doDownload = async () => {
    setBusy(true)
    try {
      const r = await apiFetch<any>('/api/cyzx/download-file', { method: 'POST', body: JSON.stringify(dl) })
      alert(r.ok ? `已下载并落盘：${r.saved || '(未落盘)'}（${r.bytes || 0} B）` : '下载失败：' + (r.error || ''))
    } catch (e: any) { alert('下载异常: ' + (e?.error || e?.message || e)) }
    finally { setBusy(false) }
  }

  const todo = cands.filter(c => (c.review === 'false') && !c.cancel_state)
  return (
    <>
      <div style={{ color: DIM, fontSize: 11.5, lineHeight: 1.8, marginBottom: 10 }}>
        本页各区块右侧的灰色「接口 4.x」是<b>城运《接口文档》的接口编号</b>（联调时对文档定位用），
        <b style={{ color: SUB }}>不是操作步骤、也不是版本号</b> —— 操作请按区块标题来。
      </div>

      {/* 撤销事件单（城运接口 4.11）*/}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ color: TXT, fontSize: 13, fontWeight: 600 }}>
            <Undo2 size={14} style={{ verticalAlign: 'middle' }} /> 撤销事件单<ApiNo no="4.11" />
          </div>
          <span style={{ color: DIM, fontSize: 12 }}>
            待自动撤销 <b style={{ color: todo.length ? AMBER : DIM }}>{todo.length}</b>
            （复核判为误报且尚未撤销）
          </span>
          <button style={{ ...btnStyle(AMBER), marginLeft: 'auto' }} onClick={autoScan} disabled={busy}>
            立即跑一次自动撤销扫描
          </button>
        </div>
        <div style={{ color: DIM, fontSize: 11.5, marginTop: 6, lineHeight: 1.7 }}>
          自动撤销判据：<code style={{ color: CYAN }}>warnings.data_json.review === 'false'</code>（复核结论=误报）。
          <b style={{ color: AMBER }}> review='miss'（漏检）不撤</b> —— 那是"没检出来"，与"误报"是两回事。
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <input style={{ ...inputStyle, flex: 1 }} value={manual} onChange={e => setManual(e.target.value)}
            placeholder="手动撤销：填 eventNum，多个用逗号分隔" />
          <button style={btnStyle(RED)} onClick={() => cancelNow(manual)} disabled={busy || !manual.trim()}>撤销</button>
        </div>
        <div style={{ overflowX: 'auto', marginTop: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr>{['事件单号', '我方类型', '复核结论', '撤销状态', '撤销原因', '上报时间'].map(h => <th key={h} style={TH}>{h}</th>)}</tr></thead>
            <tbody>
              {cands.map(c => (
                <tr key={c.event_num} style={{ borderLeft: c.review === 'false' && !c.cancel_state ? `2px solid ${AMBER}` : '2px solid transparent' }}>
                  <td style={{ ...TD, color: SUB, fontFamily: 'monospace' }}>{c.event_num}</td>
                  <td style={{ ...TD, color: TXT }}>{c.ai_type}</td>
                  <td style={TD}><span style={badge(c.review === 'false' ? RED : (c.review === 'true' ? GREEN : DIM))}>{c.review || '未复核'}</span></td>
                  <td style={TD}><span style={badge(c.cancel_state === 'sent' ? GREEN : (c.cancel_state === 'failed' ? RED : DIM))}>{c.cancel_state || '—'}</span></td>
                  <td style={{ ...TD, color: DIM, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.cancel_reason || ''}>{c.cancel_reason || '—'}</td>
                  <td style={{ ...TD, color: SUB, whiteSpace: 'nowrap' }}>{c.created_at}</td>
                </tr>
              ))}
              {cands.length === 0 && <tr><td colSpan={6} style={{ padding: 22, textAlign: 'center', color: DIM }}>暂无已上报记录</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* 4.10 + 4.9 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(360px,1fr))', gap: 12 }}>
        <div style={cardStyle}>
          <div style={{ color: TXT, fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
            <MapPin size={14} style={{ verticalAlign: 'middle' }} /> 更新事件单 · 经纬度与地址<ApiNo no="4.10" />
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            <input style={inputStyle} value={upd.eventNum} onChange={e => setUpd({ ...upd, eventNum: e.target.value })} placeholder="eventNum *" />
            <div style={{ display: 'flex', gap: 8 }}>
              <input style={inputStyle} value={upd.lon} onChange={e => setUpd({ ...upd, lon: e.target.value })} placeholder="lon *" />
              <input style={inputStyle} value={upd.lat} onChange={e => setUpd({ ...upd, lat: e.target.value })} placeholder="lat *" />
            </div>
            <input style={inputStyle} value={upd.eventAddress} onChange={e => setUpd({ ...upd, eventAddress: e.target.value })} placeholder="eventAddress *（必传）" />
            <input style={inputStyle} value={upd.eventTitle} onChange={e => setUpd({ ...upd, eventTitle: e.target.value })} placeholder="eventTitle（可选）" />
            <input style={inputStyle} value={upd.eventContent} onChange={e => setUpd({ ...upd, eventContent: e.target.value })} placeholder="eventContent（可选）" />
            <button style={btnStyle(CYAN)} onClick={doUpdate} disabled={busy}>提交更新</button>
          </div>
          <div style={{ color: DIM, fontSize: 11, marginTop: 6 }}>城运要求 eventNum / lon / lat / eventAddress 均必传，缺一即拒。</div>
        </div>

        <div style={cardStyle}>
          <div style={{ color: TXT, fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
            <Download size={14} style={{ verticalAlign: 'middle' }} /> 下载附件（落盘留证）<ApiNo no="4.9" />
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            <input style={inputStyle} value={dl.url} onChange={e => setDl({ ...dl, url: e.target.value })} placeholder="附件 url *（城运给的地址）" />
            <input style={inputStyle} value={dl.fileName} onChange={e => setDl({ ...dl, fileName: e.target.value })} placeholder="fileName（可选，不传按 URL 末段）" />
            <button style={btnStyle(CYAN)} onClick={doDownload} disabled={busy || !dl.url.trim()}>下载</button>
          </div>
          <div style={{ color: DIM, fontSize: 11, marginTop: 6 }}>落盘目录：<code>data/&lt;fileDownloadDir&gt;</code>；文件名做安全化（去路径分隔符与前导点）。</div>
        </div>
      </div>

      {/* 4.5 / 4.12 / 4.13 入站 */}
      <div style={cardStyle}>
        <div style={{ color: TXT, fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
          <Radio size={14} style={{ verticalAlign: 'middle' }} /> 入站订阅 —— 城运推给我们的动态<ApiNo no="4.5 / 4.12 / 4.13" />
        </div>
        <div style={{ color: DIM, fontSize: 11.5, marginBottom: 8 }}>
          由城运业务协同网关推送，共三类：<b style={{ color: TXT }}>事件单更新广播</b>、
          <b style={{ color: TXT }}>信息抄告</b>、<b style={{ color: TXT }}>日志抄告</b>。
          <br />落库接口：<code style={{ color: CYAN }}>/cyzx/inbound/event-update</code> ·
          <code style={{ color: CYAN }}>/copy-notice</code> · <code style={{ color: CYAN }}>/log-notice</code>
          （受 IP 白名单 + 令牌守卫）
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', gap: 12 }}>
          <div>
            <div style={{ color: SUB, fontSize: 12, marginBottom: 6 }}>事件单更新广播（{inbound.updates.length}）</div>
            <div style={{ overflowX: 'auto', border: '1px solid rgba(0,100,180,0.2)', borderRadius: 4 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead><tr>{['事件单号', '事件状态', '收到时间'].map(h => <th key={h} style={TH}>{h}</th>)}</tr></thead>
                <tbody>
                  {inbound.updates.map((u, i) => (
                    <tr key={i}><td style={{ ...TD, color: SUB, fontFamily: 'monospace' }}>{u.event_num}</td>
                      <td style={{ ...TD, color: TXT }}>{u.event_status || '—'}</td>
                      <td style={{ ...TD, color: SUB }}>{u.received_at}</td></tr>
                  ))}
                  {inbound.updates.length === 0 && <tr><td colSpan={3} style={{ padding: 16, textAlign: 'center', color: DIM }}>暂无</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <div style={{ color: SUB, fontSize: 12, marginBottom: 6 }}>抄告（{inbound.notices.length}）</div>
            <div style={{ overflowX: 'auto', border: '1px solid rgba(0,100,180,0.2)', borderRadius: 4 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead><tr>{['事件单号', '类型', '收到时间'].map(h => <th key={h} style={TH}>{h}</th>)}</tr></thead>
                <tbody>
                  {inbound.notices.map((n, i) => (
                    <tr key={i}><td style={{ ...TD, color: SUB, fontFamily: 'monospace' }}>{n.event_num}</td>
                      <td style={TD}><span style={badge(n.kind === 'log' ? CYAN : PURPLE)}>{n.kind === 'log' ? '日志抄告' : '信息抄告'}</span></td>
                      <td style={{ ...TD, color: SUB }}>{n.received_at}</td></tr>
                  ))}
                  {inbound.notices.length === 0 && <tr><td colSpan={3} style={{ padding: 16, textAlign: 'center', color: DIM }}>暂无</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* 对账日报 */}
      <div style={cardStyle}>
        <div style={{ color: TXT, fontSize: 13, fontWeight: 600, marginBottom: 4 }}>对账日报（近 7 天）</div>
        <div style={{ color: DIM, fontSize: 11.5, marginBottom: 8 }}>
          口径单列：只统计城运通道（cyzx_*），<b>不与智治推送统计混算</b>。
          `should = sent + failed + pending`；`gap = failed + pending`；`gated` = 被门控拦截（不计入 gap）。
        </div>
        <div style={{ overflowX: 'auto', border: '1px solid rgba(0,100,180,0.2)', borderRadius: 4 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr>{['日期', '应推', '已推', '失败', '待发', '缺口', '被跳过', '其中门控', '已撤销'].map(h => <th key={h} style={TH}>{h}</th>)}</tr></thead>
            <tbody>
              {daily.map(d => (
                <tr key={d.date}>
                  <td style={{ ...TD, color: TXT }}>{d.date}</td>
                  <td style={{ ...TD, color: SUB }}>{d.should}</td>
                  <td style={{ ...TD, color: d.sent ? GREEN : DIM }}>{d.sent}</td>
                  <td style={{ ...TD, color: d.failed ? RED : DIM }}>{d.failed}</td>
                  <td style={{ ...TD, color: d.pending ? AMBER : DIM }}>{d.pending}</td>
                  <td style={{ ...TD, color: d.gap ? RED : DIM, fontWeight: d.gap ? 600 : 400 }}>{d.gap}</td>
                  <td style={{ ...TD, color: DIM }}>{d.skipped}</td>
                  <td style={{ ...TD, color: DIM }}>{d.gated}</td>
                  <td style={{ ...TD, color: d.cancelled ? AMBER : DIM }}>{d.cancelled}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
