import { useCallback, useEffect, useMemo, useState } from 'react'
import { CK, alpha } from '../../lib/cockpitTheme'
import { fmtShanghai } from '../../lib/time'
import { authFetch } from '../../lib/apiFetch'

const MONO = "'JetBrains Mono', monospace"

/** 磁盘（细化：容量 + inode + 读写速率） */
interface Disk {
  mount: string; device?: string; fsType?: string
  size: number; used: number; avail: number; pct: number
  sizeText?: string; usedText?: string; availText?: string
  inode?: { iused?: number; ifree?: number; ipct?: number }
  io?: { read_mbps?: number; write_mbps?: number; read_iops?: number; write_iops?: number }
}
interface GpuProc { pid: string; name: string; memMB: number | null }
interface Gpu {
  index: number; name: string; driver?: string
  util?: number | null; memUtil?: number | null
  memTotalMB?: number | null; memUsedMB?: number | null; memFreeMB?: number | null; memPercent?: number | null
  tempC?: number | null; tempMemC?: number | null
  powerW?: number | null; powerLimitW?: number | null; powerMaxW?: number | null
  clockSM?: number | null; clockMaxSM?: number | null; clockMem?: number | null
  fanPercent?: number | null; pstate?: string
  processes?: GpuProc[]
}
interface DiskTopBlock { path: string; depth: number; elapsed_s: number; items: { path: string; bytes: number }[] }
interface HostState {
  id: string; name: string; role?: string; local?: boolean; ok: boolean; error?: string
  hostname?: string; ips?: string[]; platform?: string; arch?: string
  ts?: number; latencyMs?: number
  cpu?: { model?: string; cores?: number; usage?: number | null }
  memory?: { total?: number; used?: number; avail?: number; percent?: number; swap_total?: number; swap_used?: number; swap_percent?: number }
  load?: { load1?: number; load5?: number; load15?: number }
  uptime?: number
  disks?: Disk[]
  diskTop?: { ts?: number; running?: boolean; data?: DiskTopBlock[] }
  gpu?: { available?: boolean; gpus?: Gpu[]; processes?: GpuProc[]; error?: string }
  services?: { name: string; status: string; running?: boolean }[]
  ports?: { port: number; status: string; listening?: boolean }[]
}
interface MonitorState {
  multi?: boolean; hosts?: HostState[]
  lastCollectTs?: number; alertCount?: number
  /** 后端判定「调用方未登录」时置 true —— 只回最小健康摘要（无目录树/进程/服务端口清单） */
  limited?: boolean
  // 向后兼容字段（v1 单机）
  hostname?: string; cpu?: HostState['cpu']; memory?: HostState['memory']
  load?: HostState['load']; uptime?: number; disks?: Disk[]
  services?: HostState['services']; ports?: HostState['ports']
}
interface AlertRecord { time: string; count: number; alerts: { level: string; msg: string }[] }

const card = { background: 'rgba(0,20,50,0.4)', border: `1px solid rgba(0,150,220,0.15)`, borderRadius: 6, padding: '14px 16px' }
const barBg = { background: 'rgba(0,60,120,0.4)', borderRadius: 3, overflow: 'hidden' as const }

function fmtBytes(b?: number) {
  if (b == null) return '-'
  const g = b / 1024 ** 3
  if (g >= 1024) return (g / 1024).toFixed(2) + ' T'
  if (g >= 1) return g.toFixed(1) + ' G'
  return (b / 1024 ** 2).toFixed(0) + ' M'
}
function fmtUptime(s?: number) {
  if (!s) return '-'
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  return d > 0 ? `${d} 天 ${h} 小时` : `${h} 小时`
}
function pctColor(p: number) { return p >= 90 ? CK.red : p >= 75 ? CK.orange : p >= 60 ? CK.amber : CK.cyan }

function Bar({ pct, h = 6 }: { pct: number; h?: number }) {
  return (
    <div style={barBg}>
      <div style={{ width: `${Math.min(Math.max(pct, 0), 100)}%`, background: pctColor(pct), borderRadius: 3, height: h, transition: 'width .3s' }} />
    </div>
  )
}

function Metric({ label, value, unit, pct, color }: { label: string; value: string | number; unit?: string; pct?: number; color?: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10.5, color: CK.textDim, marginBottom: 3, whiteSpace: 'nowrap' }}>{label}</div>
      <div style={{ fontSize: 15, color: color || CK.textMain, fontFamily: MONO, fontWeight: 600, whiteSpace: 'nowrap' }}>
        {value}<span style={{ fontSize: 10.5, color: CK.textFaint, marginLeft: 2 }}>{unit}</span>
      </div>
      {pct != null && <div style={{ marginTop: 4 }}><Bar pct={pct} h={4} /></div>}
    </div>
  )
}

export function ServerMonitorPage() {
  const [state, setState] = useState<MonitorState | null>(null)
  const [alerts, setAlerts] = useState<AlertRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [mailTest, setMailTest] = useState('')
  const [activeId, setActiveId] = useState('')
  /** 后端据「是否已登录」判定：未登录只回最小健康摘要 */
  const [limited, setLimited] = useState(false)

  const load = useCallback(async () => {
    try {
      // 用 authFetch 带上会话 token：后端对「已登录」才返回全量
      // （免鉴权调用方只给最小健康摘要，见 monitor.js getPublicState）
      const r = await authFetch('/api/monitor/status')
      const d = await r.json()
      if (d.ok) { setState(d.state); setAlerts(d.alerts || []); setLimited(!!d.limited) }
    } catch { /* 静默：下个周期重试 */ }
    setLoading(false)
  }, [])

  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t) }, [load])

  const testEmail = async () => {
    setMailTest('发送中...')
    try {
      const r = await authFetch('/api/monitor/test-email', { method: 'POST' })
      const d = await r.json()
      setMailTest(d.sent ? '邮件已发送' : '发送失败，请检查 SMTP 配置')
    } catch { setMailTest('请求失败') }
    setTimeout(() => setMailTest(''), 8000)
  }

  /** 多机优先；老后端（无 hosts）时退化为单机视图 */
  const hosts: HostState[] = useMemo(() => {
    if (state?.hosts?.length) return state.hosts
    if (!state) return []
    return [{
      id: 'local', name: state.hostname || '本机', ok: true, hostname: state.hostname,
      cpu: state.cpu, memory: state.memory, load: state.load, uptime: state.uptime,
      disks: state.disks, services: state.services, ports: state.ports,
    }]
  }, [state])

  const host = hosts.find(h => h.id === activeId) || hosts[0] || null

  return (
    <div style={{ padding: '12px 16px 24px', color: CK.textMain }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0, color: CK.textMain, letterSpacing: 1 }}>服务器运行监控</h2>
          <p style={{ fontSize: 11, color: CK.textDim, margin: '4px 0 0', fontFamily: MONO }}>
            {hosts.length} 台主机 · 每 30 秒刷新 · 每 5 分钟告警检查
            {host?.latencyMs != null ? ` · 本机采集 ${host.latencyMs} ms` : ''}
          </p>
        </div>
        <button onClick={testEmail} style={{ background: alpha(CK.cyan, 0.15), color: CK.cyan, border: `1px solid ${alpha(CK.cyan, 0.4)}`, padding: '6px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
          发送测试邮件
        </button>
      </div>
      {mailTest && <div style={{ ...card, marginBottom: 12, fontSize: 12, color: CK.cyan, borderColor: alpha(CK.cyan, 0.3) }}>{mailTest}</div>}
      {limited && (
        <div style={{ ...card, marginBottom: 12, fontSize: 12, color: CK.amber, borderColor: alpha(CK.amber, 0.4) }}>
          🔒 未检测到有效登录会话 —— 当前仅显示最小健康摘要；重新登录后可查看内网目录占用、GPU 进程与服务 / 端口清单。
        </div>
      )}

      {/* 主机切换 */}
      {hosts.length > 1 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
          {hosts.map(h => {
            const on = !!host && h.id === host.id
            return (
              <button key={h.id} onClick={() => setActiveId(h.id)} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '7px 14px', fontSize: 12.5, borderRadius: 5, cursor: 'pointer',
                border: `1px solid ${on ? alpha(CK.cyan, 0.6) : alpha(CK.borderSoft, 0.9)}`,
                background: on ? alpha(CK.cyan, 0.12) : 'transparent',
                color: on ? CK.cyan : CK.textDim,
              }}>
                <span style={{
                  width: 7, height: 7, borderRadius: '50%', display: 'inline-block',
                  background: h.ok ? CK.green : CK.red,
                  boxShadow: h.ok ? `0 0 6px ${CK.green}` : `0 0 6px ${CK.red}`,
                }} />
                <span style={{ fontWeight: on ? 600 : 400 }}>{h.name}</span>
                <span style={{ fontFamily: MONO, fontSize: 10.5, color: CK.textFaint }}>{h.id}</span>
              </button>
            )
          })}
        </div>
      )}

      {loading ? <div style={{ color: CK.textDim, fontSize: 12 }}>加载中...</div> : !host ? (
        <div style={{ ...card, fontSize: 12, color: CK.textFaint }}>暂无监控数据</div>
      ) : !host.ok ? (
        <div style={{ ...card, fontSize: 13, color: CK.red, borderColor: alpha(CK.red, 0.35) }}>
          主机 {host.name}（{host.id}）指标不可达：{host.error || '未知错误'}
          <div style={{ fontSize: 11, color: CK.textFaint, marginTop: 6 }}>
            数据源：{host.local ? '本机采集' : 'HTTP agent（172.16.8.11:7101）'} · 下个采集周期自动重试
          </div>
        </div>
      ) : (
        <>
          {/* 主机概况 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, fontSize: 11.5, color: CK.textFaint, fontFamily: MONO, flexWrap: 'wrap' }}>
            <span style={{ color: CK.textSub }}>{host.hostname}</span>
            <span>·</span><span>{host.role}</span>
            <span>·</span><span>{host.platform} {host.arch}</span>
            {(host.ips || []).length > 0 && <><span>·</span><span>{(host.ips || []).slice(0, 3).join(' / ')}</span></>}
          </div>

          {/* KPI */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 14 }}>
            {[
              {
                label: 'CPU 使用率',
                val: host.cpu?.usage != null ? host.cpu.usage + '%' : 'N/A',
                sub: `${host.cpu?.cores || 0} 核 · ${(host.cpu?.model || '').split('@')[0].trim().slice(0, 22)}`,
              },
              {
                label: '内存使用率',
                val: host.memory?.percent != null ? host.memory.percent + '%' : 'N/A',
                sub: `${fmtBytes(host.memory?.used)} / ${fmtBytes(host.memory?.total)}` +
                  (host.memory?.swap_total ? ` · swap ${host.memory.swap_percent != null ? host.memory.swap_percent : 0}%` : ''),
              },
              {
                label: '系统负载',
                val: host.load?.load5?.toFixed(2) ?? '-',
                sub: `1min ${host.load?.load1?.toFixed(2) ?? '-'} · 15min ${host.load?.load15?.toFixed(2) ?? '-'}`,
              },
              { label: '运行时长', val: fmtUptime(host.uptime), sub: '持续在线' },
            ].map(c => (
              <div key={c.label} style={card}>
                <div style={{ fontSize: 11, color: CK.textDim }}>{c.label}</div>
                <div style={{ fontSize: 22, fontWeight: 600, color: CK.cyan, margin: '4px 0', fontFamily: MONO }}>{c.val}</div>
                <div style={{ fontSize: 11, color: CK.textFaint }}>{c.sub}</div>
              </div>
            ))}
          </div>

          {/* 磁盘（细化）+ TOP 目录 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.55fr) minmax(0, 1fr)', gap: 12, marginBottom: 14 }}>
            <div style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
                <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: CK.cyan, letterSpacing: 1 }}>磁盘与存储</h3>
                <span style={{ fontSize: 10.5, color: CK.textFaint, fontFamily: MONO }}>{(host.disks || []).length} 个挂载点</span>
              </div>
              {(host.disks || []).length === 0 && (
                <div style={{ fontSize: 12, color: CK.textFaint, padding: 12, textAlign: 'center' }}>无数据</div>
              )}
              {(host.disks || []).map(d => {
                const ino = d.inode || {}
                const io = d.io || {}
                return (
                  <div key={d.mount} style={{ padding: '9px 0', borderBottom: `1px solid ${alpha(CK.borderSoft, 0.5)}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, marginBottom: 5 }}>
                      <span style={{ color: CK.textMain, fontFamily: MONO, fontSize: 12.5, fontWeight: 600 }}>{d.mount}</span>
                      <span style={{ fontFamily: MONO, fontSize: 11.5, color: d.pct >= 85 ? CK.red : d.pct >= 70 ? CK.amber : CK.textSub, whiteSpace: 'nowrap' }}>
                        <b style={{ fontSize: 13, color: d.pct >= 85 ? CK.red : CK.cyan }}>{d.pct}%</b>
                        {'  '}{d.usedText || fmtBytes(d.used)} / {d.sizeText || fmtBytes(d.size)}
                      </span>
                    </div>
                    <Bar pct={d.pct} />
                    <div style={{ display: 'flex', gap: 12, fontSize: 10.5, color: CK.textFaint, marginTop: 5, fontFamily: MONO, flexWrap: 'wrap' }}>
                      <span>可用 {d.availText || fmtBytes(d.avail)}</span>
                      {d.device && <span>{d.device}</span>}
                      {d.fsType && <span>{d.fsType}</span>}
                      {ino.ipct != null && <span style={{ color: ino.ipct >= 85 ? CK.red : CK.textFaint }}>inode {ino.ipct}%</span>}
                      {io.read_mbps != null && <span style={{ color: io.read_mbps > 5 ? CK.teal : CK.textFaint }}>读 {io.read_mbps} MB/s</span>}
                      {io.write_mbps != null && <span style={{ color: io.write_mbps > 5 ? CK.teal : CK.textFaint }}>写 {io.write_mbps} MB/s</span>}
                    </div>
                  </div>
                )
              })}
            </div>

            <div style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
                <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: CK.cyan, letterSpacing: 1 }}>TOP 目录占用</h3>
                {host.diskTop?.running && <span style={{ fontSize: 10.5, color: CK.amber, fontFamily: MONO }}>后台计算中…</span>}
              </div>
              {!(host.diskTop?.data || []).length ? (
                <div style={{ fontSize: 12, color: CK.textFaint, padding: 12, textAlign: 'center' }}>
                  {host.diskTop?.running ? '正在扫描目录…' : '暂无数据'}
                </div>
              ) : (host.diskTop?.data || []).map(b => {
                const top = (b.items[0] && b.items[0].bytes) || 1
                return (
                  <div key={b.path} style={{ marginBottom: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, fontFamily: MONO, marginBottom: 4 }}>
                      <span style={{ color: CK.textSub }}>{b.path}</span>
                      <span style={{ color: CK.textFaint }}>{b.elapsed_s}s</span>
                    </div>
                    {b.items.slice(0, 5).map(it => (
                      <div key={it.path} style={{ marginBottom: 3 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, fontFamily: MONO, gap: 8 }}>
                          <span style={{ color: CK.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {it.path.indexOf(b.path) === 0 ? '.' + it.path.slice(b.path.length) : it.path}
                          </span>
                          <span style={{ color: CK.textMain, whiteSpace: 'nowrap' }}>{fmtBytes(it.bytes)}</span>
                        </div>
                        <div style={{ ...barBg, height: 3, marginTop: 2 }}>
                          <div style={{ width: `${(it.bytes / top) * 100}%`, height: '100%', background: alpha(CK.cyan, 0.55), borderRadius: 2 }} />
                        </div>
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          </div>

          {/* GPU */}
          <div style={{ ...card, marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: CK.cyan, letterSpacing: 1 }}>GPU</h3>
              <span style={{ fontSize: 10.5, color: CK.textFaint, fontFamily: MONO }}>
                {host.gpu?.available ? `${(host.gpu.gpus || []).length} 张卡` : '不可用'}
              </span>
            </div>
            {!host.gpu?.available ? (
              <div style={{ fontSize: 12, color: CK.textFaint, padding: 10, textAlign: 'center' }}>
                该主机未检测到 GPU{host.gpu?.error ? `（${host.gpu.error}）` : ''}
              </div>
            ) : (host.gpu.gpus || []).map(g => (
              <div key={g.index} style={{ padding: '6px 0', borderBottom: `1px solid ${alpha(CK.borderSoft, 0.5)}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, color: CK.textMain, fontWeight: 600 }}>
                    GPU{g.index} <span style={{ color: CK.textSub, fontWeight: 400 }}>{g.name}</span>
                  </span>
                  <span style={{ fontSize: 10.5, color: CK.textFaint, fontFamily: MONO }}>
                    {g.pstate}{g.driver ? ` · driver ${g.driver}` : ''}
                  </span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 14, marginBottom: 8 }}>
                  <Metric label="GPU 利用率" value={g.util != null ? g.util : '-'} unit="%" pct={g.util == null ? undefined : g.util}
                    color={g.util != null && g.util >= 90 ? CK.orange : CK.cyan} />
                  <Metric label="显存占用" value={g.memPercent != null ? g.memPercent : '-'} unit="%" pct={g.memPercent == null ? undefined : g.memPercent}
                    color={g.memPercent != null && g.memPercent >= 85 ? CK.red : CK.cyan} />
                  <Metric label="温度" value={g.tempC != null ? g.tempC : '-'} unit="°C"
                    color={g.tempC != null && g.tempC >= 85 ? CK.red : g.tempC != null && g.tempC >= 75 ? CK.amber : CK.cyan} />
                  <Metric label="功耗" value={g.powerW != null ? g.powerW : '-'} unit={`W / ${g.powerLimitW == null ? '-' : g.powerLimitW} W`} color={CK.cyan} />
                </div>
                <div style={{ display: 'flex', gap: 14, fontSize: 10.5, color: CK.textFaint, fontFamily: MONO, flexWrap: 'wrap', marginBottom: (g.processes || []).length ? 8 : 0 }}>
                  <span>显存 {g.memUsedMB == null ? '-' : g.memUsedMB} / {g.memTotalMB == null ? '-' : g.memTotalMB} MB（空闲 {g.memFreeMB == null ? '-' : g.memFreeMB} MB）</span>
                  <span>SM {g.clockSM == null ? '-' : g.clockSM} / {g.clockMaxSM == null ? '-' : g.clockMaxSM} MHz</span>
                  {g.clockMem != null && <span>显存时钟 {g.clockMem} MHz</span>}
                  {g.fanPercent != null && <span>风扇 {g.fanPercent}%</span>}
                  {g.tempMemC != null && <span>显存温度 {g.tempMemC}°C</span>}
                </div>
                {(g.processes || []).length > 0 && (
                  <div style={{ background: 'rgba(0,0,0,0.22)', borderRadius: 4, padding: '6px 9px' }}>
                    <div style={{ fontSize: 10.5, color: CK.textDim, marginBottom: 4 }}>占用进程（{(g.processes || []).length}）</div>
                    {(g.processes || []).map((p, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 10.5, fontFamily: MONO, marginBottom: 2 }}>
                        <span style={{ color: CK.textFaint, flexShrink: 0 }}>pid {p.pid}</span>
                        <span style={{ color: CK.textSub, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                        <span style={{ color: CK.cyan, flexShrink: 0 }}>{p.memMB == null ? '-' : p.memMB + ' MB'}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* 服务 / 端口 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
            <div style={card}>
              <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 12px', color: CK.cyan }}>关键服务</h3>
              {(host.services || []).length === 0 && <div style={{ fontSize: 12, color: CK.textFaint, padding: 10 }}>无数据</div>}
              {(host.services || []).map(s => {
                const ok = s.running == null ? s.status === 'running' : s.running
                return (
                  <div key={s.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: `1px solid ${alpha(CK.borderSoft, 0.5)}`, fontSize: 12 }}>
                    <span style={{ color: CK.textMain, fontFamily: MONO }}>{s.name}</span>
                    <span style={{ color: ok ? CK.green : CK.red, fontWeight: 500 }}>{ok ? '● 运行中' : '✕ ' + s.status}</span>
                  </div>
                )
              })}
            </div>
            <div style={card}>
              <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 12px', color: CK.cyan }}>关键端口</h3>
              {(host.ports || []).length === 0 && <div style={{ fontSize: 12, color: CK.textFaint, padding: 10 }}>无数据</div>}
              {(host.ports || []).map(p => {
                const ok = p.listening == null ? p.status === 'open' : p.listening
                return (
                  <div key={p.port} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: `1px solid ${alpha(CK.borderSoft, 0.5)}`, fontSize: 12 }}>
                    <span style={{ color: CK.textMain, fontFamily: MONO }}>端口 {p.port}</span>
                    <span style={{ color: ok ? CK.green : CK.red, fontWeight: 500 }}>{ok ? '● 正常' : '✕ 未监听'}</span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* 告警 */}
          <div style={card}>
            <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 12px', color: CK.cyan }}>最近告警记录</h3>
            {alerts.length === 0 ? (
              <div style={{ fontSize: 12, color: CK.textFaint, textAlign: 'center', padding: 16 }}>暂无告警记录 — 系统正常</div>
            ) : (
              <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                {alerts.map((a, i) => (
                  <div key={i} style={{ border: `1px solid ${alpha(CK.borderSoft, 0.6)}`, borderRadius: 4, padding: '8px 10px', marginBottom: 6, fontSize: 11 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, color: CK.textSub }}>
                      <span>{fmtShanghai(a.time)}</span>
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
