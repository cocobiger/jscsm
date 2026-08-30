import { useCallback, useEffect, useState } from 'react'
import { CK, alpha } from '../../lib/cockpitTheme'

interface MonitorState {
  hostname?: string
  platform?: string
  cpu?: { model?: string; cores?: number; usage?: number | null }
  memory?: { total?: number; used?: number; percent?: number }
  load?: { load1?: number; load5?: number; load15?: number }
  uptime?: number
  disks?: { mount: string; size: string; used: string; avail: string; pct: number }[]
  services?: { name: string; status: string }[]
  ports?: { port: number; status: string }[]
  timestamp?: string
}
interface AlertRecord { time: string; count: number; alerts: { level: string; msg: string }[] }

const card = { background: 'rgba(0,20,50,0.4)', border: `1px solid rgba(0,150,220,0.15)`, borderRadius: 6, padding: '14px 16px' }
const barBg = { background: 'rgba(0,60,120,0.4)', borderRadius: 3, overflow: 'hidden' as const }

function fmtBytes(b?: number) {
  if (!b) return '0'
  const g = b / 1024 ** 3
  if (g >= 1) return g.toFixed(1) + ' GB'
  return (b / 1024 ** 2).toFixed(0) + ' MB'
}
function fmtUptime(s?: number) {
  if (!s) return '-'
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  return `${d} 天 ${h} 小时`
}

export function ServerMonitorPage() {
  const [state, setState] = useState<MonitorState | null>(null)
  const [alerts, setAlerts] = useState<AlertRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [mailTest, setMailTest] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/monitor/status')
      const d = await r.json()
      if (d.ok) { setState(d.state); setAlerts(d.alerts || []) }
    } catch {}
    setLoading(false)
  }, [])

  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t) }, [load])

  const testEmail = async () => {
    setMailTest('发送中...')
    try {
      const r = await fetch('/api/monitor/test-email', { method: 'POST' })
      const d = await r.json()
      setMailTest(d.sent ? '邮件已发送' : '发送失败，请检查配置')
    } catch { setMailTest('请求失败') }
    setTimeout(() => setMailTest(''), 8000)
  }

  const barColor = (pct: number) => pct >= 95 ? CK.red : pct >= 85 ? CK.amber : CK.cyan

  return (
    <div style={{ padding: '12px 16px 24px', color: CK.textMain }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0, color: CK.textMain, letterSpacing: 1 }}>服务器运行监控</h2>
          <p style={{ fontSize: 11, color: CK.textDim, margin: '4px 0 0', fontFamily: "'JetBrains Mono', monospace" }}>
            {state?.hostname || '--'} · 每 5 分钟自动检查 · 异常邮件告警
          </p>
        </div>
        <button onClick={testEmail} style={{ background: alpha(CK.cyan, 0.15), color: CK.cyan, border: `1px solid ${alpha(CK.cyan, 0.4)}`, padding: '6px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
          发送测试邮件
        </button>
      </div>
      {mailTest && <div style={{ ...card, marginBottom: 12, fontSize: 12, color: CK.cyan, borderColor: alpha(CK.cyan, 0.3) }}>{mailTest}</div>}

      {loading ? <div style={{ color: CK.textDim, fontSize: 12 }}>加载中...</div> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginBottom: 14 }}>
            {[
              { label: 'CPU 使用率', val: state?.cpu?.usage != null ? state.cpu.usage + '%' : 'N/A', sub: `${state?.cpu?.cores || 0} 核` },
              { label: '内存使用率', val: (state?.memory?.percent ?? 0) + '%', sub: `${fmtBytes(state?.memory?.used)} / ${fmtBytes(state?.memory?.total)}` },
              { label: '系统负载', val: state?.load?.load5?.toFixed(2) ?? '-', sub: `1min ${state?.load?.load1?.toFixed(2) ?? '-'}` },
              { label: '运行时长', val: fmtUptime(state?.uptime), sub: '持续在线' },
            ].map(c => (
              <div key={c.label} style={card}>
                <div style={{ fontSize: 11, color: CK.textDim }}>{c.label}</div>
                <div style={{ fontSize: 22, fontWeight: 600, color: CK.cyan, margin: '4px 0', fontFamily: "'JetBrains Mono', monospace" }}>{c.val}</div>
                <div style={{ fontSize: 11, color: CK.textFaint }}>{c.sub}</div>
              </div>
            ))}
          </div>

          <div style={card} style={{ ...card, marginBottom: 14 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 12px', color: CK.cyan, letterSpacing: 1 }}>磁盘使用</h3>
            {(state?.disks || []).map(d => (
              <div key={d.mount} style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                  <span style={{ color: CK.textMain, fontFamily: "'JetBrains Mono', monospace" }}>{d.mount}</span>
                  <span style={{ color: d.pct >= 85 ? CK.red : CK.textSub }}>
                    {d.pct}% · 已用 {d.used} · 可用 {d.avail}
                  </span>
                </div>
                <div style={barBg}>
                  <div style={{ width: `${Math.min(d.pct, 100)}%`, background: barColor(d.pct), height: '100%', borderRadius: 3, height: 6 }} />
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
            <div style={card}>
              <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 12px', color: CK.cyan }}>关键服务</h3>
              {(state?.services || []).map(s => (
                <div key={s.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: `1px solid ${alpha(CK.borderSoft, 0.5)}`, fontSize: 12 }}>
                  <span style={{ color: CK.textMain, fontFamily: "'JetBrains Mono', monospace" }}>{s.name}</span>
                  <span style={{ color: s.status === 'running' ? CK.green : CK.red, fontWeight: 500 }}>
                    {s.status === 'running' ? '● 运行中' : '✗ ' + s.status}
                  </span>
                </div>
              ))}
            </div>
            <div style={card}>
              <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 12px', color: CK.cyan }}>关键端口</h3>
              {(state?.ports || []).map(p => (
                <div key={p.port} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: `1px solid ${alpha(CK.borderSoft, 0.5)}`, fontSize: 12 }}>
                  <span style={{ color: CK.textMain, fontFamily: "'JetBrains Mono', monospace" }}>端口 {p.port}</span>
                  <span style={{ color: p.status === 'open' ? CK.green : CK.red, fontWeight: 500 }}>
                    {p.status === 'open' ? '● 正常' : '✗ 未监听'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div style={card}>
            <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 12px', color: CK.cyan }}>最近告警记录</h3>
            {alerts.length === 0 ? (
              <div style={{ fontSize: 12, color: CK.textFaint, textAlign: 'center', padding: 16 }}>暂无告警记录 — 系统正常</div>
            ) : (
              <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                {alerts.map((a, i) => (
                  <div key={i} style={{ border: `1px solid ${alpha(CK.borderSoft, 0.6)}`, borderRadius: 4, padding: '8px 10px', marginBottom: 6, fontSize: 11 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, color: CK.textSub }}>
                      <span>{new Date(a.time).toLocaleString('zh-CN')}</span>
                      <span style={{ color: a.alerts.some(x => x.level === 'critical') ? CK.red : CK.amber }}>{a.count} 条</span>
                    </div>
                    {a.alerts.map((x, j) => (
                      <div key={j} style={{ color: x.level === 'critical' ? CK.red : CK.amber, marginBottom: 2 }}>[{x.level}] {x.msg}</div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
