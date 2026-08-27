import { useState, useEffect } from 'react'
import { authFetch } from '../../lib/apiFetch'
import type { LucideIcon } from 'lucide-react'
import { Radio, Brain, CheckCircle2, Siren, Send } from 'lucide-react'

// ── 秸秆焚烧运行链路全景 + 实时检测过程可视化 ──

const CYAN = '#00aaff'
const GREEN = '#4ade80'
const RED = '#ff4444'
const AMBER = '#ffb74d'
const ORANGE = '#ff7043'
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

interface EngStatus { ok?: boolean; workers?: Record<string, any>; resource?: any }
interface SnapStream {
  running: boolean; stream_ok: boolean; frame_age_s: number | null
  detects: number; alerts: number; last_label: string; last_conf: number
  infer_ms: number; cfm: { hits: number; need: number; status: string; age_s: number | null }
  boxes: any[]; snap: string
}

// ════════════════ S0 · 运行链路全景 ════════════════
export function RunPipeline() {
  const [eng, setEng] = useState<EngStatus | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try { const r = await authFetch('/api/straw-engine/status'); if (r.ok) { const data = await r.json(); if (alive) setEng(data) } } catch { /* 静默 */ }
    }
    load()
    const t = setInterval(load, 10000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const workers = eng?.workers || {}
  const nWorkers = Object.keys(workers).length
  const okCount = Object.values(workers).filter((w: any) => w.running).length
  const nAlerts = eng?.engine?.total_alerts ?? Object.values(workers).reduce((s: number, w: any) => s + (w.alerts || 0), 0)

  const nodes: { icon: LucideIcon; name: string; desc: string; color: string; stat: string }[] = [
    { icon: Radio, name: '视频流接入', desc: '司空 RTMP 直推我方 ZLM(1936)；dji-bridge 抓屏转推（兜底）', color: CYAN,
      stat: `${nWorkers} 路流配置` },
    { icon: Brain, name: '视觉检测', desc: 'RT-DETR 3 类（smoke/fire/house），分类别置信度阈值', color: AMBER,
      stat: `引擎 ${eng?.ok === false ? '离线' : '在线'}` },
    { icon: CheckCircle2, name: '多帧确认', desc: 'Confirmer：连续 3 帧命中才告警；house 类过滤不告警', color: GREEN,
      stat: '3 帧确认制' },
    { icon: Siren, name: '告警生成', desc: '目标定位（GPS+云台+测距）+ 证据留存 + 附近人员检测', color: RED,
      stat: `累计 ${nAlerts} 条` },
    { icon: Send, name: '推送处置', desc: '乡镇反查 → 责任单位 webhook → 企业微信群卡片', color: ORANGE,
      stat: '责任映射推送' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 状态汇总条 */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {[
          ['引擎', eng?.ok === false ? '离线' : '在线', eng?.ok === false ? RED : GREEN],
          ['Worker', `${okCount}/${nWorkers} 运行`, CYAN],
          ['推理帧', `${Object.values(workers).reduce((s: number, w: any) => s + (w.detects || 0), 0)}`, DIM],
          ['告警', `${nAlerts}`, RED],
          ['CPU', eng?.resource ? `${eng.resource.cpu_pct ?? '-'}%` : '-', DIM],
          ['内存', eng?.resource ? `${eng.resource.mem_gb ?? '-'}G` : '-', DIM],
        ].map(([k, v, c]) => (
          <div key={k as string} style={{ ...card, padding: '8px 18px', display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 84 }}>
            <span style={{ fontSize: 18, fontWeight: 700, color: c as string, ...mono }}>{v as string}</span>
            <span style={{ fontSize: 11, color: DIM }}>{k as string}</span>
          </div>
        ))}
      </div>

      {/* 链路图 */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'stretch' }}>
        {nodes.map((n, i) => (
          <div key={n.name} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 150px', minWidth: 150 }}>
            <div style={{ ...card, flex: 1, borderColor: `${n.color}44`, background: `rgba(4,20,45,0.8)` }}>
              <n.icon size={22} strokeWidth={1.75} color={n.color} />
              <div style={{ fontSize: 13, fontWeight: 700, color: n.color, margin: '4px 0 2px' }}>{n.name}</div>
              <div style={{ fontSize: 11, color: '#9ab4d0', lineHeight: 1.5 }}>{n.desc}</div>
              <div style={{ fontSize: 11, color: n.color, marginTop: 6, ...mono }}>{n.stat}</div>
            </div>
            {i < nodes.length - 1 && <div style={{ color: DIM, fontSize: 18 }}>→</div>}
          </div>
        ))}
      </div>

      {/* 各环节角色说明 */}
      <div style={{ ...card, fontSize: 12, color: '#9ab4d0', lineHeight: 1.9 }}>
        <b style={{ color: CYAN }}>怎么运行（一目了然）：</b>
        无人机视频流接入 → 引擎按 interval 抽帧 → RT-DETR 检出 smoke/fire（house 过滤）→ Confirmer 连续 3 帧命中确认 → 命中则生成告警（自动定位目标 GPS + 留存证据图 + 检测附近人员）→ 后端反查乡镇责任单位 → 企业微信群推送带地图卡片。
      </div>
    </div>
  )
}

// ════════════════ S2 · 实时检测过程 ════════════════
export function LiveDetection() {
  const [snap, setSnap] = useState<any>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await authFetch('/api/straw-engine/snapshot')
        if (!r.ok) {
          if (alive) setErr(r.status === 401 ? '登录已过期，请重新登录' : `快照接口 HTTP ${r.status}`)
          return
        }
        const data = await r.json()
        if (alive) { setSnap(data); setErr('') }
      } catch (e: any) { if (alive) setErr('引擎快照不可用：' + (e?.message || '')) }
    }
    load()
    const t = setInterval(load, 3000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const streams: Record<string, SnapStream> = snap?.streams || {}
  const eng = snap?.engine || {}

  const cfmColor = (status: string) =>
    status === 'alert' ? RED : status === 'suppressed' ? AMBER : DIM

  const cfmText = (s: SnapStream) => {
    const { hits, need, status } = s.cfm
    if (status === 'alert') return '已确认 → 告警'
    if (status === 'suppressed') return `命中 ${hits}/${need} · 抑制重复上报`
    return hits >= need ? '命中已达标' : `命中 ${hits}/${need} · 还差 ${Math.max(0, need - hits)} 帧告警`
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 引擎资源 */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: DIM }}>引擎资源</span>
        <span style={{ fontSize: 12, color: CYAN, ...mono }}>CPU {eng.cpu_pct ?? '-'}%</span>
        <span style={{ fontSize: 12, color: GREEN, ...mono }}>内存 {eng.mem_gb ?? '-'}G / {eng.mem_pct ?? '-'}%</span>
        <span style={{ fontSize: 12, color: DIM }}>· 3s 自动刷新</span>
        {err && <span style={{ fontSize: 12, color: RED }}>{err}</span>}
      </div>

      {Object.keys(streams).length === 0 && (
        <div style={{ ...card, color: DIM, fontSize: 13 }}>暂无推理流（straw-engine 未配置 stream）</div>
      )}

      {/* 每路流实时卡片 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
        {Object.entries(streams).map(([sid, s]) => (
          <div key={sid} style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {/* 流头 */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: CYAN, ...mono }}>{sid}</span>
              <span style={{ fontSize: 11, color: s.stream_ok ? GREEN : RED, ...mono }}>
                {s.stream_ok ? `● 在线${s.frame_age_s != null ? ` · ${s.frame_age_s}s前帧` : ''}` : '○ 断流/重连中'}
              </span>
            </div>
            {/* 实时画面（框已由引擎叠加绘制） */}
            <div style={{ position: 'relative', background: 'rgba(0,0,0,0.5)', borderRadius: 6, overflow: 'hidden', minHeight: 120, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {s.snap ? (
                <img src={s.snap} alt="" style={{ width: '100%', display: 'block' }} />
              ) : (
                <span style={{ fontSize: 12, color: DIM, padding: 24 }}>{s.last_boxes?.length ? '画面渲染中…' : '当前无检测目标（引擎在监控中）'}</span>
              )}
            </div>
            {/* 确认进度 */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
                <span style={{ color: DIM }}>多帧确认</span>
                <span style={{ color: cfmColor(s.cfm.status), ...mono }}>{cfmText(s)}</span>
              </div>
              <div style={{ height: 6, background: 'rgba(0,80,150,0.2)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{
                  height: '100%', width: `${Math.min(100, (s.cfm.hits / Math.max(1, s.cfm.need)) * 100)}%`,
                  background: cfmColor(s.cfm.status), transition: 'width 0.6s',
                }} />
              </div>
            </div>
            {/* 统计 */}
            <div style={{ display: 'flex', gap: 10, fontSize: 11, color: '#9ab4d0', flexWrap: 'wrap' }}>
              <span>检测 <b style={{ color: CYAN, ...mono }}>{s.detects}</b></span>
              <span>告警 <b style={{ color: RED, ...mono }}>{s.alerts}</b></span>
              <span>推理 <b style={{ color: DIM, ...mono }}>{s.infer_ms}ms</b></span>
              {s.last_label && <span>最近 <b style={{ color: AMBER }}>{s.last_label}</b> <b style={{ ...mono, color: AMBER }}>{s.last_conf.toFixed(2)}</b></span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
