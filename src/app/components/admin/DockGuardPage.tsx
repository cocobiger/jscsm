import { useState, useEffect, useCallback } from 'react'
import { authFetch } from '../../lib/apiFetch'
import { Shield, Save, RotateCcw, CircleDot, AlertTriangle } from 'lucide-react'

// ── 机场布防配置页（dock-guard 服务）：人员检测 ROI / 时段 / 阈值 / 实时状态 ──

const CYAN = '#00aaff'
const GREEN = '#4ade80'
const RED = '#ff4444'
const AMBER = '#ffb74d'
const DIM = '#5a8aaa'
const mono = { fontFamily: "'JetBrains Mono', monospace" } as const

const card: React.CSSProperties = {
  background: 'rgba(4,14,35,0.7)',
  border: '1px solid rgba(0,80,150,0.25)',
  borderRadius: 8,
  padding: '14px 16px',
}
const btn = (bg: string, fg: string, bd: string): React.CSSProperties => ({
  padding: '6px 14px', fontSize: 12, borderRadius: 4, cursor: 'pointer', fontWeight: 600,
  border: `1px solid ${bd}`, background: bg, color: fg,
})
const input: React.CSSProperties = {
  background: 'rgba(2,10,28,0.9)', border: '1px solid rgba(0,120,200,0.3)',
  color: '#c8e6ff', borderRadius: 4, padding: '4px 8px', fontSize: 12,
  fontFamily: "'JetBrains Mono', monospace", width: 72,
}

interface DockCfg {
  streamId: string; url: string; name?: string; enabled?: boolean
  conf?: number; nightConf?: number; nightBright?: number
  roi?: number[][]; frames?: number; cooldown?: number
  minHeight?: number; maxHeight?: number; interval?: number; hours?: string
}
interface DockStatus {
  armed: boolean; stream_ok: boolean; detects: number; alerts: number
  persons: number; is_night: boolean; bright: number; last_ms: number
  last_alert_ts: number; last_report_ok: boolean; last_boxes: any[]
}
interface GuardStatus { ok?: boolean; version?: string; gpu?: string; docks?: Record<string, DockStatus> }

// ROI 编辑器（SVG 16:9 画布，归一化坐标 [0,1]）
function RoiEditor({ roi, onChange }: { roi: number[][]; onChange: (r: number[][]) => void }) {
  const W = 320, H = 180

  const toNorm = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width * W
    const y = (e.clientY - rect.top) / rect.height * H
    return [Math.min(1, Math.max(0, +(x / W).toFixed(3))), Math.min(1, Math.max(0, +(y / H).toFixed(3)))]
  }, [])

  const handleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const [nx, ny] = toNorm(e)
    // 命中已有顶点（<10px）→ 删除；否则追加
    const hit = roi.findIndex(p => Math.abs(p[0] * W - nx * W) < 10 && Math.abs(p[1] * H - ny * H) < 10)
    if (hit >= 0) onChange(roi.filter((_, i) => i !== hit))
    else onChange([...roi, [nx, ny]])
  }

  const poly = roi.map(p => `${p[0] * W},${p[1] * H}`).join(' ')

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <span style={{ color: DIM, fontSize: 11 }}>
          <CircleDot size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
          点击画面添加布防顶点（点击已有顶点可删除；≥3 点自动闭合；空=全画面）
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" style={btn('rgba(255,80,80,0.15)', RED, 'rgba(255,80,80,0.4)')}
          onClick={() => onChange([])}>
          清空=全画面
        </button>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} onClick={handleClick}
        style={{ width: '100%', maxWidth: 560, background: 'rgba(2,10,28,0.9)',
          border: '1px dashed rgba(0,170,255,0.4)', borderRadius: 6, cursor: 'crosshair' }}>
        {/* 参考网格 */}
        {[0.25, 0.5, 0.75].map(g => (
          <g key={g} stroke="rgba(0,170,255,0.08)">
            <line x1={g * W} y1={0} x2={g * W} y2={H} />
            <line x1={0} y1={g * H} x2={W} y2={g * H} />
          </g>
        ))}
        {/* 多边形（≥3 点自动闭合） */}
        {roi.length >= 3 && <polygon points={poly} fill="rgba(0,200,255,0.12)" stroke={CYAN} strokeWidth={1.5} />}
        {roi.length >= 2 && <polyline points={poly} fill="none" stroke={CYAN} strokeWidth={1.2} strokeDasharray="4 3" />}
        {roi.map((p, i) => (
          <g key={i}>
            <circle cx={p[0] * W} cy={p[1] * H} r={5} fill="#061530" stroke={CYAN} strokeWidth={1.5} />
            <text x={p[0] * W + 7} y={p[1] * H - 4} fill="#7ac4ff" fontSize={8} fontFamily="JetBrains Mono, monospace">
              {i + 1}
            </text>
          </g>
        ))}
      </svg>
    </div>
  )
}

// 机场配置卡片
function DockCard({ dc, status, onPatch, onRemove }: {
  dc: DockCfg; status?: DockStatus
  onPatch: (patch: Partial<DockCfg>) => void; onRemove: () => void
}) {
  const num = (k: keyof DockCfg) => String(dc[k] ?? '')
  const setNum = (k: keyof DockCfg, v: string) => onPatch({ [k]: v === '' ? undefined : Number(v) } as Partial<DockCfg>)
  const on = !!dc.enabled
  return (
    <div style={{ ...card, border: `1px solid ${on ? 'rgba(0,170,255,0.35)' : 'rgba(120,140,160,0.2)'}` }}>
      {/* 头部：名称 + 启停 + 实时状态 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <Shield size={16} color={on ? CYAN : DIM} />
        <input value={dc.name || dc.streamId} onChange={e => onPatch({ name: e.target.value })}
          style={{ ...input, width: 190, fontWeight: 600, color: on ? '#e6f7ff' : DIM }} />
        <span style={{ color: DIM, fontSize: 11, ...mono }}>{dc.streamId}</span>
        <span style={{ flex: 1 }} />
        {/* 实时状态 */}
        {status && (
          <span style={{ fontSize: 11, color: DIM, ...mono }}>
            {status.stream_ok ? <b style={{ color: GREEN }}>●流在线</b> : <b style={{ color: DIM }}>○流离线</b>}
            {' '}| 布防:{status.armed ? <b style={{ color: GREEN }}>ON</b> : <b style={{ color: AMBER }}>OFF</b>}
            {' '}| 检测:{status.persons}人 | 告警:{status.alerts}
            {status.is_night && <b style={{ color: '#7ac4ff' }}> 🌙夜</b>}
          </span>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 12, color: DIM }}>
          <input type="checkbox" checked={on} onChange={e => onPatch({ enabled: e.target.checked })} />
          布防
        </label>
        <button type="button" style={btn('rgba(255,80,80,0.1)', DIM, 'rgba(255,80,80,0.3)')} onClick={onRemove} title="移除该路布防">✕</button>
      </div>
      {/* 参数行 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '8px 14px', marginBottom: 10 }}>
        {[
          ['conf', '日间阈值', 0.05, 0.95], ['nightConf', '夜间阈值', 0.05, 0.95], ['nightBright', '判夜亮度', 1, 100],
          ['frames', '连续帧数', 1, 10], ['cooldown', '冷却(秒)', 1, 3600], ['minHeight', '最小高度比', 0.005, 0.5],
          ['maxHeight', '最大高度比', 0.1, 1], ['interval', '抽帧间隔(s)', 0.2, 10], ['hours', '布防时段', 0, 24],
        ].map(([k, label, min, max]) => {
          const key = k as keyof DockCfg
          return (
            <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: DIM, whiteSpace: 'nowrap' }}>
              <span style={{ width: 84 }}>{label}</span>
              <input type="number" step="any" min={min as number} max={max as number} value={num(key)}
                onChange={e => setNum(key, e.target.value)}
                style={{ ...input, width: 64 }} />
            </label>
          )
        })}
      </div>
      {/* ROI 编辑器 */}
      <RoiEditor roi={dc.roi || []} onChange={(r) => onPatch({ roi: r })} />
      {/* 最近告警框预览 */}
      {status && status.last_boxes.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 11, color: AMBER }}>
          最近检测框: {status.last_boxes.map((b: any) => `(${b[0]},${b[1]},${b[2]},${b[3]})@${b[4]}`).join(' ')}
        </div>
      )}
    </div>
  )
}

export function DockGuardPage() {
  const [status, setStatus] = useState<GuardStatus | null>(null)
  const [docks, setDocks] = useState<DockCfg[]>([])
  const [extra, setExtra] = useState<Record<string, any>>({})
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const loadConfig = useCallback(async () => {
    try {
      const r = await authFetch('/api/dock-guard/config')
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const d = await r.json()
      if (d.ok) {
        const cfg = d.config || {}
        setDocks((cfg.docks || []).map((x: any) => ({ ...x })))
        const { docks, ...rest } = cfg
        setExtra(rest)
      } else setMsg({ ok: false, text: d.error || '读取失败' })
    } catch (e: any) { setMsg({ ok: false, text: e.message }) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { loadConfig() }, [loadConfig])
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const r = await authFetch('/api/dock-guard/status')
        if (r.ok) setStatus(await r.json())
      } catch { /* 静默 */ }
    }, 5000)
    return () => clearInterval(t)
  }, [])

  const patchDock = (i: number, patch: Partial<DockCfg>) =>
    setDocks(prev => prev.map((d, j) => j === i ? { ...d, ...patch } : d))
  const removeDock = (i: number) => setDocks(prev => prev.filter((_, j) => j !== i))
  const addDock = () => setDocks(prev => [...prev, {
    streamId: 'sikong_NEW', url: 'http://127.0.0.1:6080/jsc/sikong_NEW.live.flv',
    name: '新机场', enabled: true, conf: 0.35, nightConf: 0.45, nightBright: 25,
    roi: [], frames: 3, cooldown: 60, minHeight: 0.02, maxHeight: 0.6, interval: 1.0, hours: '0-24',
  }])

  const save = async () => {
    setMsg({ ok: true, text: '保存中…' })
    try {
      const r = await authFetch('/api/dock-guard/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...extra, docks }),
      })
      const d = await r.json()
      if (d.ok) { setMsg({ ok: true, text: '✅ 已保存并热重载（4 路 worker 重启中，约 10s 生效）' }); setTimeout(() => setMsg(null), 5000) }
      else setMsg({ ok: false, text: d.error || '保存失败' })
    } catch (e: any) { setMsg({ ok: false, text: e.message }) }
  }

  return (
    <div style={{ padding: 16, maxWidth: 1240 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 17, color: '#e6f7ff', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Shield size={18} color={CYAN} /> 机场人员入侵布防
        </h2>
        <span style={{ color: DIM, fontSize: 12 }}>无人机机场摄像头 · 人员靠近自动预警（dock-guard v{status?.version || '-'}）</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: DIM, ...mono }}>GPU: {status?.gpu || '…'}</span>
        <button type="button" style={btn('rgba(0,140,255,0.18)', CYAN, 'rgba(0,140,255,0.5)', )} onClick={loadConfig}>刷新配置</button>
        <button type="button" style={btn('rgba(0,180,90,0.18)', GREEN, 'rgba(0,180,90,0.5)')} onClick={addDock}>+ 新增机场</button>
        <button type="button" style={btn('rgba(0,200,255,0.22)', '#e6f7ff', 'rgba(0,200,255,0.6)')} onClick={save}>
          <Save size={12} style={{ verticalAlign: -2, marginRight: 4 }} />保存并热重载
        </button>
      </div>

      {msg && (
        <div style={{ padding: '8px 14px', marginBottom: 10, borderRadius: 6, fontSize: 12,
          background: msg.ok ? 'rgba(0,180,90,0.12)' : 'rgba(255,80,80,0.12)',
          border: `1px solid ${msg.ok ? 'rgba(0,180,90,0.4)' : 'rgba(255,80,80,0.4)'}`,
          color: msg.ok ? GREEN : RED }}>
          {msg.text}
        </div>
      )}

      {!status && loading && <div style={{ color: DIM, fontSize: 12 }}>加载中…</div>}

      {/* 全局摘要 */}
      {status && status.docks && (
        <div style={{ ...card, marginBottom: 12, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          {Object.entries(status.docks).map(([sid, st]) => (
            <span key={sid} style={{ fontSize: 11, color: DIM, ...mono, whiteSpace: 'nowrap' }}>
              {sid.replace('sikong_', '').slice(0, 12)}
              {st.armed ? <b style={{ color: GREEN }}> 布防中</b> : <b style={{ color: AMBER }}> 未布防</b>}
              {st.stream_ok && <b style={{ color: CYAN }}> ●</b>}
              {st.persons > 0 && <b style={{ color: RED }}> 人{st.persons}</b>}
              {st.last_report_ok && st.last_alert_ts > 0 && <b style={{ color: RED }}> ⚠最近告警</b>}
            </span>
          ))}
        </div>
      )}

      {/* 机场配置卡 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(560px, 1fr))', gap: 14 }}>
        {docks.map((dc, i) => (
          <DockCard key={dc.streamId + i} dc={dc} status={status?.docks?.[dc.streamId]}
            onPatch={p => patchDock(i, p)} onRemove={() => removeDock(i)} />
        ))}
      </div>

      {docks.length === 0 && !loading && (
        <div style={{ ...card, color: AMBER, fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertTriangle size={14} /> 暂无布防机场，点击右上「+ 新增机场」添加。
        </div>
      )}

      <div style={{ marginTop: 14, color: DIM, fontSize: 11, lineHeight: 1.8 }}>
        💡 <b>布防说明</b>：ROI 多边形=允许检测的区域（建议只圈停机坪，边缘路人不会误报）；「清空=全画面」=不限定区域。
        夜间（亮度&lt;判夜亮度）自动采用夜间阈值；连续 N 帧检测到人且冷却期结束才告警（防瞬时误报）。
        保存后自动热重载，约 10s 内生效；当前非任务时段流不在线属正常，流上线即自动检测。
      </div>
    </div>
  )
}
