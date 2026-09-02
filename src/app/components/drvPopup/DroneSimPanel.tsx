import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../lib/apiFetch'

/**
 * 无人机起飞模拟测试面板（T4 回归工具 · 仅 admin 可见，由 App.tsx 按角色渲染）
 *
 * 目标：无需真机即可在浏览器复现「一组真机起飞」，事件走后端 /api/drone-events/simulate
 * （与真实 dji-openapi webhook 完全相同的 ingestEvent 链路：幂等/白名单/落库/SSE 广播），
 * 因此弹窗调度 / 提示音 / 刷新回灌（缺陷①）/ SSE 断线重连（缺陷②）全部可测。
 *
 * 防污染约定（与后端一致）：
 *  - 模拟 SN 统一 SIM_ 前缀（SIM_T4_A_1…），后端拒绝非 SIM_ 前缀；
 *  - 场景剧本强制 ON/OFF 成对（OFF 结尾 → 刷新不回灌残留）；
 *  - 「一键停止全部」调 off-all：补发残留 ON 的 OFF 广播 + 删除 SIM_ 历史行。
 *
 * 局限：伪 SN 无 ZLM mirror → zlm_online 恒 0 → 弹窗 resolving 后 ≤60s 自动收起
 * （恰为缺陷①修复后的活体路径）；真实画面播放仍需真机。
 */
interface SimStep { action: 'on' | 'off'; sn: string; waitMs: number }
interface Scenario { key: string; name: string; desc: string; steps: SimStep[]; guide?: string }

const BUILTIN_DOCKS: { sn: string; name: string }[] = [
  { sn: '8UUXN8N00A0LS7', name: '三峡科技' },
  { sn: '8UUXN7G00A0FDP', name: '环保局' },
  { sn: '8UUXN8P00A0LZ4', name: '职教中心' },
  { sn: '8UUXN5500A07D1', name: '经开区' },
]

const SCENARIOS: Scenario[] = [
  {
    key: 'A', name: 'A · 单机起降', desc: '1 台起飞 → 弹窗+提示音 → 6s 后降落收起',
    steps: [
      { action: 'on', sn: 'SIM_T4_A_1', waitMs: 6000 },
      { action: 'off', sn: 'SIM_T4_A_1', waitMs: 0 },
    ],
  },
  {
    key: 'B', name: 'B · 双窗共存', desc: '2 台先后起飞同屏双窗，乱序降落验证全局移除',
    steps: [
      { action: 'on', sn: 'SIM_T4_B_1', waitMs: 3000 },
      { action: 'on', sn: 'SIM_T4_B_2', waitMs: 6000 },
      { action: 'off', sn: 'SIM_T4_B_2', waitMs: 2000 },
      { action: 'off', sn: 'SIM_T4_B_1', waitMs: 0 },
    ],
  },
  {
    key: 'C', name: 'C · 满窗风暴', desc: '5 台连发（2s/台）→ 满窗折叠最新腾位 + 队满挤最旧',
    steps: [
      { action: 'on', sn: 'SIM_T4_C_1', waitMs: 2000 },
      { action: 'on', sn: 'SIM_T4_C_2', waitMs: 2000 },
      { action: 'on', sn: 'SIM_T4_C_3', waitMs: 2000 },
      { action: 'on', sn: 'SIM_T4_C_4', waitMs: 2000 },
      { action: 'on', sn: 'SIM_T4_C_5', waitMs: 8000 },
      { action: 'off', sn: 'SIM_T4_C_5', waitMs: 800 },
      { action: 'off', sn: 'SIM_T4_C_4', waitMs: 800 },
      { action: 'off', sn: 'SIM_T4_C_3', waitMs: 800 },
      { action: 'off', sn: 'SIM_T4_C_2', waitMs: 800 },
      { action: 'off', sn: 'SIM_T4_C_1', waitMs: 0 },
    ],
  },
  {
    key: 'D', name: 'D · 回灌专项', desc: '缺陷①回归：注入在飞(zlm=0) → 刷新页面应回灌弹窗',
    guide: '✅ 已注入 1 台「在飞（zlm=0）」。现在：① 刷新本页面 → 应看到回灌弹窗（resolving）；② 等 ~60s 无 mirror 自动收起（timeout 路径）；③ 点下方「一键停止全部」清理。',
    steps: [{ action: 'on', sn: 'SIM_T4_D_1', waitMs: 0 }],
  },
  {
    key: 'E', name: 'E · 断线自愈', desc: '缺陷②回归：注入后重启后端 → 看门狗自动重连',
    guide: '✅ 已注入 2 台在飞。现在：① 到服务器执行 systemctl restart jsc-backend；② 回到本页应 ≤45s 自动重连（无需刷新）；③ 用下方单条注入器发一条 OFF(SIM_T4_E_1) → 弹窗应收起，证明重连后广播生效；④ 一键停止全部清理。',
    steps: [
      { action: 'on', sn: 'SIM_T4_E_1', waitMs: 4000 },
      { action: 'on', sn: 'SIM_T4_E_2', waitMs: 0 },
    ],
  },
]

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export function DroneSimPanel() {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [docks, setDocks] = useState<{ sn: string; name: string }[]>(BUILTIN_DOCKS)
  const [dockSn, setDockSn] = useState(BUILTIN_DOCKS[0].sn)
  const [manualSn, setManualSn] = useState('SIM_M_1')
  const [guide, setGuide] = useState('')
  const [log, setLog] = useState<string[]>([])
  const [active, setActive] = useState<{ sn: string; dock: string; on: boolean }[]>([])
  const manualSeq = useRef(1)
  const cancelRef = useRef(false)

  const logLine = useCallback((s: string) => {
    const t = new Date().toTimeString().slice(0, 8)
    setLog(prev => [`${t} ${s}`, ...prev].slice(0, 5))
  }, [])

  // 白名单机场（空=全放行兜底，用内置 4 白名单机场列表）
  useEffect(() => {
    apiFetch<any>('/api/drone-events/whitelist')
      .then(d => {
        if (d && Array.isArray(d.whitelist) && d.whitelist.length) {
          const list = d.whitelist.map((sn: string) => {
            const hit = BUILTIN_DOCKS.find(b => b.sn === sn)
            return { sn: String(sn), name: hit ? hit.name : String(sn).slice(0, 8) }
          })
          setDocks(list)
          setDockSn(list[0].sn)
        }
      })
      .catch(() => {})
  }, [])

  const setActiveFlag = useCallback((sn: string, dock: string, on: boolean) => {
    setActive(prev => {
      const rest = prev.filter(x => x.sn !== sn)
      if (!on) return rest
      return [...rest, { sn, dock, on: true }]
    })
  }, [])

  const sendSim = useCallback(async (sn: string, dock: string, on: boolean): Promise<boolean> => {
    try {
      const r = await apiFetch<any>('/api/drone-events/simulate', {
        method: 'POST',
        body: JSON.stringify({ deviceSn: sn, dockSn: dock, on: on ? 1 : 0 }),
      })
      if (r.duplicated) { logLine(`↺ ${sn} 已存在（dup 忽略）`); return true }
      if (!r.broadcast) { logLine(`⚠ ${sn} 白名单外未广播（仅审计）`); return false }
      logLine(`✓ ${on ? 'LIVE_ON' : 'LIVE_OFF'} ${sn}（dock ${dock}）已广播`)
      setActiveFlag(sn, dock, on)
      return true
    } catch (e: any) {
      logLine(`✗ ${on ? 'ON' : 'OFF'} ${sn}：${e?.error || '失败'}`)
      return false
    }
  }, [logLine, setActiveFlag])

  const stopAll = useCallback(async () => {
    cancelRef.current = true
    setBusy(true)
    try {
      const r = await apiFetch<any>('/api/drone-events/simulate/off-all', { method: 'POST', body: '{}' })
      logLine(`🧹 off-all: 补 OFF ${r.offCount} 台 / 清理 ${r.deleted} 行`)
      setActive([])
      setGuide('')
    } catch (e: any) { logLine(`✗ off-all：${e?.error || '失败'}`) }
    setBusy(false)
  }, [logLine])

  const playScenario = useCallback(async (sc: Scenario) => {
    if (busy) return
    cancelRef.current = false
    setBusy(true)
    setGuide('')
    logLine(`▶ 场景 ${sc.name} 开始（dock ${dockSn}）`)
    let ok = true
    for (const st of sc.steps) {
      if (cancelRef.current) break
      const done = await sendSim(st.sn, dockSn, st.action === 'on')
      if (!done && st.action === 'on') ok = false
      if (cancelRef.current) break
      if (st.waitMs > 0) await sleep(st.waitMs)
    }
    logLine(ok ? `■ 场景 ${sc.name} 播放完（残留可点「一键停止全部」）` : `■ 场景 ${sc.name} 提前中断`)
    if (sc.guide) setGuide(sc.guide)
    setBusy(false)
  }, [busy, dockSn, logLine, sendSim])

  const manualSend = useCallback(async (on: boolean) => {
    const sn = manualSn.trim() || `SIM_M_${manualSeq.current}`
    if (await sendSim(sn, dockSn, on)) setManualSn(`SIM_M_${++manualSeq.current}`)
  }, [dockSn, manualSn, sendSim])

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} title="T4 回归：模拟无人机起飞测试（仅管理员）"
        style={{ position: 'absolute', left: 14, bottom: 12, zIndex: 1300, height: 26, padding: '0 10px', borderRadius: 13,
          border: '1px solid #cfd8e3', background: 'rgba(255,255,255,0.92)', color: '#667', fontSize: 11, cursor: 'pointer', boxShadow: '0 1px 4px rgba(30,60,110,.12)' }}>
        🧪 模拟测试
      </button>
    )
  }

  return (
    <div style={{ position: 'absolute', left: 14, bottom: 12, zIndex: 1300, width: 336, maxHeight: 'calc(100% - 40px)', overflowY: 'auto',
      background: 'rgba(255,255,255,0.97)', border: '1px solid #d5dfea', borderRadius: 12, padding: '10px 12px',
      boxShadow: '0 6px 22px rgba(30,60,110,.18)', fontSize: 12, color: '#22314a' }}>
      {/* 顶栏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <b style={{ fontSize: 12.5 }}>🧪 模拟起飞测试</b>
        {busy && <span style={{ color: '#dc2626', fontWeight: 700 }}>● 运行中</span>}
        <span style={{ marginLeft: 'auto', cursor: 'pointer', color: '#8aa0b8' }} onClick={() => setOpen(false)} title="收起">✕</span>
      </div>

      {/* 场景剧本 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 6 }}>
        {SCENARIOS.map(sc => (
          <button key={sc.key} disabled={busy} title={sc.desc} onClick={() => { void playScenario(sc) }}
            style={{ padding: '3px 9px', borderRadius: 7, fontSize: 11, cursor: busy ? 'not-allowed' : 'pointer',
              border: '1px solid #bcd0e8', background: '#eef5fd', color: '#1d5fae' }}>{sc.name}</button>
        ))}
      </div>

      {/* 单条注入 */}
      <div style={{ display: 'flex', gap: 5, alignItems: 'center', margin: '6px 0' }}>
        <select value={dockSn} onChange={e => setDockSn(e.target.value)} title="机场（白名单）"
          style={{ width: 96, fontSize: 11, padding: '3px 4px', borderRadius: 6, border: '1px solid #d0d9e4', background: '#fff', color: '#22314a' }}>
          {docks.map(d => <option key={d.sn} value={d.sn}>{d.name}</option>)}
        </select>
        <input value={manualSn} onChange={e => setManualSn(e.target.value)} spellCheck={false} title="模拟 SN（SIM_ 开头）"
          style={{ flex: 1, minWidth: 0, fontSize: 11, padding: '3px 6px', borderRadius: 6, border: '1px solid #d0d9e4', color: '#22314a' }} />
        <button disabled={busy} onClick={() => void manualSend(true)} title="注入 LIVE_ON（起飞）"
          style={{ padding: '3px 9px', borderRadius: 6, fontSize: 11, border: '1px solid #b7dcc9', background: '#e8f7ef', color: '#0e7a4c', cursor: 'pointer' }}>ON 起飞</button>
        <button disabled={busy} onClick={() => void manualSend(false)} title="注入 LIVE_OFF（降落）"
          style={{ padding: '3px 9px', borderRadius: 6, fontSize: 11, border: '1px solid #e2ccd0', background: '#f9eeee', color: '#a13a46', cursor: 'pointer' }}>OFF 降落</button>
      </div>

      {/* 当前注入 + 清理 */}
      {active.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', margin: '4px 0' }}>
          <span style={{ color: '#8aa0b8' }}>在飞 {active.length}:</span>
          {active.map(a => (
            <span key={a.sn} style={{ padding: '1px 7px', borderRadius: 9, fontSize: 10.5, background: '#fdeaea', color: '#b3313d', border: '1px solid #f3cdd2' }}>{a.sn}</span>
          ))}
          <button onClick={() => { void stopAll() }} disabled={busy} title="补发全部 OFF 广播并清理 SIM_ 历史"
            style={{ marginLeft: 'auto', padding: '3px 9px', borderRadius: 6, fontSize: 11, border: '1px solid #e3c2c2', background: '#fdeeee', color: '#c53030', cursor: 'pointer' }}>⏹ 一键停止全部</button>
        </div>
      )}

      {/* 指引（场景 D/E） */}
      {guide && (
        <div style={{ margin: '6px 0', padding: '7px 9px', borderRadius: 8, background: '#fff8e6', border: '1px solid #f0e0b8', color: '#7a5c10', fontSize: 11.5, lineHeight: 1.6 }}>{guide}</div>
      )}

      {/* 日志 */}
      {log.length > 0 && (
        <div style={{ marginTop: 4, fontSize: 10.5, color: '#6b7f96', lineHeight: 1.7, fontFamily: 'Consolas, monospace' }}>
          {log.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
    </div>
  )
}
