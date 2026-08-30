import { useCallback, useEffect, useRef, useState } from 'react'
import { CK, alpha } from '../../lib/cockpitTheme'
import { authFetch } from '../../lib/apiFetch'

// ── 算法调参：自研推理引擎参数优化（注册表驱动，多算法可扩展）──
// 数据边界：自研算法（source='straw-engine'）参数调优；IoTCloud 通道分析见「AI分析存档」

interface ParamDef {
  type: string
  range?: [number, number]
  step?: number
  options?: number[]
  default: number
  label: string
  group: string
  desc?: string
}
interface AlgDef {
  name: string
  aiType: string
  desc?: string
  params: Record<string, ParamDef>
  fitness?: Record<string, number>
}
interface TrialRow {
  fitness: number
  recall: number
  fp_rate: number
  latency: number
  [k: string]: number
}
interface TuneOut {
  algId: string
  algName: string
  method: string
  best: Record<string, number>
  bestScore: { fitness: number; recall: number; fp_rate: number; latency: number }
  top: TrialRow[]
  evalStats?: { nTrue: number; nFalse: number }
  generatedAt?: string
}
interface TaskStatus {
  running: boolean
  task: null | {
    algId: string
    method: string
    status: string
    startedAt?: string
    finishedAt?: string | null
    progress?: { done: number; total: number; best: number } | null
    lastLog?: string[]
    out?: TuneOut | null
  }
}

const card: React.CSSProperties = { background: 'rgba(0,20,50,0.4)', border: `1px solid rgba(0,150,220,0.15)`, borderRadius: 6, padding: '14px 16px' }
const btn = (bg: string, color: string, border: string): React.CSSProperties => ({
  background: bg, color, border: `1px solid ${border}`, padding: '6px 14px', borderRadius: 4, fontSize: 12, cursor: 'pointer',
})
const sel: React.CSSProperties = { background: 'rgba(0,20,50,0.5)', color: CK.textMain, border: `1px solid ${alpha(CK.borderSoft, 0.6)}`, padding: '5px 8px', borderRadius: 4, fontSize: 12 }
const mono = { fontFamily: "'JetBrains Mono', monospace" } as const

export function TunePage() {
  const [algs, setAlgs] = useState<Record<string, AlgDef>>({})
  const [algId, setAlgId] = useState('straw_fire')
  const [values, setValues] = useState<Record<string, number>>({})
  const [method, setMethod] = useState<'grid' | 'optuna' | 'single'>('grid')
  const [maxFpRate, setMaxFpRate] = useState(0.40)
  const [trials, setTrials] = useState(30)
  const [task, setTask] = useState<TaskStatus>({ running: false, task: null })
  const [history, setHistory] = useState<any[]>([])
  const [msg, setMsg] = useState('')
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const alg = algs[algId]

  // 初始化：注册表 + 历史
  useEffect(() => {
    loadAll()
    return () => { if (timer.current) clearInterval(timer.current) }
  }, [])

  const loadAll = async () => {
    try {
      const [a, h, s] = await Promise.all([
        authFetch('/api/tune/algorithms').then(r => r.json()),
        authFetch('/api/tune/history').then(r => r.json()),
        authFetch('/api/tune/status').then(r => r.json()),
      ])
      if (a.ok) setAlgs(a.algorithms || {})
      if (h.ok) setHistory(h.history || [])
      if (s.ok && s.task) setTask(s)
      else setTask({ running: false, task: null })
    } catch { setMsg('加载失败') }
  }

  // 切换算法 → 重置参数面板为该算法默认值
  const switchAlg = (id: string) => {
    setAlgId(id)
    const a = algs[id]
    if (a) {
      const v: Record<string, number> = {}
      for (const [k, p] of Object.entries(a.params)) v[k] = p.default
      setValues(v)
    }
  }

  // 轮询任务状态
  const poll = useCallback(async () => {
    try {
      const r = await authFetch('/api/tune/status').then(x => x.json())
      if (!r.ok) return
      setTask(r)
      if (!r.running && timer.current) { clearInterval(timer.current); timer.current = null }
    } catch {}
  }, [])

  const runTune = async () => {
    const body: Record<string, any> = { algId, method }
    if (method === 'grid') body.maxFpRate = maxFpRate
    if (method === 'optuna') body.trials = trials
    if (method === 'single') {
      // 单点验证：用当前面板全参数
      body.params = values
    } else if (alg) {
      // grid/optuna：非搜索键（性能/时序/人员）用面板值固定，搜索键由引擎扫描
      const fixed: Record<string, number> = {}
      for (const [k, p] of Object.entries(alg.params)) {
        if (!['confSmoke', 'confFire', 'iou'].includes(k)) fixed[k] = values[k] ?? p.default
      }
      body.params = fixed
    }
    setMsg('')
    const r = await authFetch('/api/tune/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json())
    if (r.ok) {
      setMsg('调参已启动')
      if (timer.current) clearInterval(timer.current)
      timer.current = setInterval(poll, 2500)
      poll()
    } else {
      setMsg(r.error || '启动失败')
    }
  }

  const stopPoll = () => { if (timer.current) { clearInterval(timer.current); timer.current = null } }

  const applyBest = async () => {
    const params = task.task?.out?.best
    if (!params) { setMsg('暂无搜索结果'); return }
    const r = await authFetch('/api/tune/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ params }) }).then(x => x.json())
    setMsg(r.ok ? '已写入 config.json（重启 straw-engine 生效）: ' + (r.output || []).join(' | ') : (r.error || '应用失败'))
    loadAll()
  }

  const rollback = async () => {
    const r = await authFetch('/api/tune/rollback', { method: 'POST' }).then(x => x.json())
    setMsg(r.ok ? '已回滚 config.json（重启 straw-engine 生效）' : (r.error || '回滚失败'))
    loadAll()
  }

  // 参数面板：按 group 分组
  const groups = alg ? [...new Set(Object.values(alg.params).map(p => p.group))] : []

  const renderParam = (key: string, p: ParamDef) => {
    const v = values[key] ?? p.default
    return (
      <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(0,20,50,0.35)', borderRadius: 5, padding: '7px 10px', minWidth: 200 }}>
        <div style={{ fontSize: 11, color: CK.textSub, minWidth: 74 }} title={p.desc}>{p.label}</div>
        {p.options ? (
          <select value={v} onChange={e => setValues({ ...values, [key]: Number(e.target.value) })} style={sel}>
            {p.options.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : (
          <>
            <input type="range" min={p.range![0]} max={p.range![1]} step={p.step || 0.05} value={v}
              onChange={e => setValues({ ...values, [key]: Number(e.target.value) })}
              style={{ flex: 1, accentColor: CK.cyan }} />
            <span style={{ ...mono, fontSize: 12, color: CK.cyan, width: 42, textAlign: 'right' }}>{v}</span>
          </>
        )}
      </div>
    )
  }

  const t = task.task
  const prog = t?.progress
  const pct = prog && prog.total ? Math.round(prog.done / prog.total * 100) : 0
  const best = t?.out?.best

  return (
    <div style={{ padding: 18, height: '100%', overflow: 'auto', color: CK.textMain }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600, color: CK.textMain }}>算法调参</div>
          <div style={{ fontSize: 11, color: CK.textFaint, marginTop: 2 }}>自研推理引擎参数优化 · 注册表驱动（新算法=注册 manifest 即自动出现在下拉）· 与「AI分析存档」（IoTCloud 外部记录）相互独立</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select value={algId} onChange={e => switchAlg(e.target.value)} style={sel}>
            {Object.entries(algs).map(([id, a]) => <option key={id} value={id}>{a.name}（{id}）</option>)}
          </select>
          <select value={method} onChange={e => setMethod(e.target.value as any)} style={sel}>
            <option value="grid">网格搜索（检测参数扫描）</option>
            <option value="optuna">Optuna 贝叶斯</option>
            <option value="single">单点验证（当前参数）</option>
          </select>
          <button onClick={loadAll} style={btn('rgba(0,20,50,0.4)', CK.textSub, alpha(CK.border, 0.3))}>刷新</button>
        </div>
      </div>

      {alg && (
        <>
          {/* 算法说明 + 搜索配置 */}
          <div style={{ ...card, marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: CK.textSub, marginBottom: 8 }}>{alg.desc || ''}</div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', fontSize: 12, color: CK.textDim }}>
              {method === 'grid' && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  误报率上限
                  <input type="range" min={0.1} max={0.6} step={0.05} value={maxFpRate} onChange={e => setMaxFpRate(Number(e.target.value))} style={{ width: 120, accentColor: CK.amber }} />
                  <b style={{ color: CK.amber, ...mono }}>{maxFpRate}</b>
                </label>
              )}
              {method === 'optuna' && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  trial 次数
                  <input type="number" min={5} max={200} value={trials} onChange={e => setTrials(Number(e.target.value))} style={{ ...sel, width: 70, ...mono }} />
                </label>
              )}
              <button onClick={runTune} disabled={task.running}
                style={btn(task.running ? 'rgba(0,20,50,0.3)' : alpha(CK.cyan, 0.18), task.running ? CK.textDim : CK.cyan, alpha(CK.cyan, 0.4))}>
                {task.running ? '运行中…' : '▶ 启动调参'}
              </button>
              {task.running && <button onClick={stopPoll} style={btn('rgba(0,20,50,0.4)', CK.textDim, alpha(CK.border, 0.3))}>停止刷新</button>}
              <span style={{ color: CK.textFaint }}>评估集 {t?.out?.evalStats?.nTrue ?? alg.evalSet ? '' : ''}· 网格约 8min / optuna 约 15min / 单点秒级</span>
            </div>
          </div>

          {/* 参数空间（Schema 驱动） */}
          <div style={{ ...card, marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: CK.textDim, marginBottom: 8 }}>参数空间 <span style={{ color: CK.textFaint, fontSize: 11 }}>（网格只搜 检测组 3 项；其他组为固定值，单点验证用全部当前值）</span></div>
            {groups.map(g => (
              <div key={g} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 11, color: CK.textFaint, marginBottom: 4 }}>{g}</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {Object.entries(alg.params).filter(([, p]) => p.group === g).map(([k, p]) => renderParam(k, p))}
                </div>
              </div>
            ))}
          </div>

          {/* 运行进度 */}
          {task.running && (
            <div style={{ ...card, marginBottom: 10, borderColor: alpha(CK.cyan, 0.35) }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: CK.textSub, marginBottom: 6 }}>
                <span>搜索中… 方法={t?.method}</span>
                <span style={mono}>{prog ? `${prog.done}/${prog.total}` : '启动中'} · 当前最优 <b style={{ color: CK.cyan }}>{prog?.best?.toFixed(2) ?? '-'}</b></span>
              </div>
              <div style={{ height: 6, background: 'rgba(0,20,50,0.6)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: `linear-gradient(90deg, ${CK.cyanSoft}, ${CK.cyan})`, transition: 'width .5s' }} />
              </div>
              {t?.lastLog && (
                <pre style={{ ...mono, fontSize: 11, color: CK.textFaint, marginTop: 8, maxHeight: 70, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{t.lastLog.join('')}</pre>
              )}
            </div>
          )}

          {/* 结果 */}
          {best && (
            <div style={{ ...card, marginBottom: 10, borderColor: alpha(CK.green, 0.3) }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: CK.green, fontWeight: 600 }}>最优参数（{t?.out?.algName}）</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={applyBest} style={btn(alpha(CK.green, 0.15), CK.green, alpha(CK.green, 0.4))}>✅ 应用最优</button>
                  <button onClick={rollback} style={btn('rgba(0,20,50,0.4)', CK.amber, alpha(CK.border, 0.3))}>↩ 回滚</button>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, marginBottom: 8 }}>
                {Object.entries(best).map(([k, v]) => <span key={k} style={mono}>{k} = <b style={{ color: CK.cyan }}>{v}</b></span>)}
                <span style={{ color: CK.textDim }}>| 评估 {t?.out?.evalStats?.nTrue ?? '?'}真烟 + {t?.out?.evalStats?.nFalse ?? '?'}无烟</span>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                <thead>
                  <tr style={{ color: CK.textDim }}>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>fitness</th>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>recall</th>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>fp_rate</th>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>latency</th>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>参数</th>
                  </tr>
                </thead>
                <tbody>
                  {(t?.out?.top || []).map((r, i) => (
                    <tr key={i} style={{ color: i === 0 ? CK.green : CK.textMain, borderTop: `1px solid ${alpha(CK.borderSoft, 0.5)}` }}>
                      <td style={{ padding: '4px 6px', ...mono }}>{r.fitness.toFixed(2)}</td>
                      <td style={{ padding: '4px 6px', ...mono }}>{r.recall.toFixed(2)}</td>
                      <td style={{ padding: '4px 6px', ...mono }}>{r.fp_rate.toFixed(2)}</td>
                      <td style={{ padding: '4px 6px', ...mono }}>{r.latency.toFixed(0)}ms</td>
                      <td style={{ padding: '4px 6px', ...mono }}>{['confSmoke', 'confFire', 'iou'].map(k => `${k}=${r[k]}`).join(' ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {msg && <div style={{ fontSize: 11, color: CK.amber, marginBottom: 8 }}>{msg}</div>}
        </>
      )}

      {/* 历史 */}
      <div style={card}>
        <div style={{ fontSize: 12, color: CK.textDim, marginBottom: 8 }}>调参历史</div>
        {history.length === 0 ? (
          <div style={{ fontSize: 11, color: CK.textFaint }}>暂无调参记录</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
            <thead><tr style={{ color: CK.textDim }}>
              <th style={{ textAlign: 'left', padding: '4px 6px' }}>时间</th>
              <th style={{ textAlign: 'left', padding: '4px 6px' }}>算法</th>
              <th style={{ textAlign: 'left', padding: '4px 6px' }}>方法</th>
              <th style={{ textAlign: 'left', padding: '4px 6px' }}>最优</th>
              <th style={{ textAlign: 'left', padding: '4px 6px' }}>状态</th>
            </tr></thead>
            <tbody>
              {history.map((h, i) => (
                <tr key={i} style={{ borderTop: `1px solid ${alpha(CK.borderSoft, 0.5)}`, color: CK.textMain }}>
                  <td style={{ padding: '4px 6px', ...mono, color: CK.textDim }}>{h.startedAt ? new Date(h.startedAt).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(' ', ' ') : ''}</td>
                  <td style={{ padding: '4px 6px' }}>{h.algId}</td>
                  <td style={{ padding: '4px 6px' }}>{h.method}</td>
                  <td style={{ padding: '4px 6px', ...mono }}>
                    {h.out?.best ? Object.entries(h.out.best).map(([k, v]) => `${k}=${v}`).join(' ') : (h.out?.bestScore?.fitness != null ? `f=${h.out.bestScore.fitness}` : '-')}
                  </td>
                  <td style={{ padding: '4px 6px', color: h.status === 'done' ? CK.green : h.status === 'failed' ? CK.red : CK.amber }}>{h.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
