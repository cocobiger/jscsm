import { useState, useEffect, useCallback } from 'react'
import { authFetch } from '../../lib/apiFetch'
import { Activity, Zap, RefreshCw } from 'lucide-react'

// ── 弹窗链路自检诊断面板（T4）：四段状态灯（SSE/事件源/拉流/司空链路）+ 最近事件流水 ──

const CYAN = '#00aaff'
const GREEN = '#4ade80'
const RED = '#ff4444'
const AMBER = '#ffb74d'
const PURPLE = '#ab47bc'
const GRAY = '#5a6b7a'

const card: React.CSSProperties = {
  background: 'rgba(4,14,35,0.7)',
  border: '1px solid rgba(0,80,150,0.25)',
  borderRadius: 8,
  padding: '14px 16px',
}

interface DiagData {
  ok: boolean
  ts: number
  sse: { clients: number }
  recent: { device_sn: string; dock_sn: string; status: string; change_reason: string; event_time: string; whitelisted: number; zlm_online: number; created_at: string; source: string }[]
  zlm: { sikongOnline: number }
  sikong: { up: boolean; wsOsd?: number | null; devices?: number }
}

function light(state: 'green' | 'amber' | 'red' | 'gray', label: string, detail: string) {
  const color = state === 'green' ? GREEN : state === 'amber' ? AMBER : state === 'red' ? RED : GRAY
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: 'rgba(4,14,35,0.6)', border: `1px solid ${color}30`, borderRadius: 6, flex: 1, minWidth: 200 }}>
      <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, boxShadow: `0 0 8px ${color}`, flexShrink: 0 }} />
      <div style={{ flex: 1 }}>
        <div style={{ color: '#c8e6ff', fontSize: 12, fontWeight: 700 }}>{label}</div>
        <div style={{ color: '#5a8aaa', fontSize: 11, marginTop: 2 }}>{detail}</div>
      </div>
    </div>
  )
}

const sourceColor = (src: string) => src === 'OSD兜底' ? AMBER : src === '模拟' ? PURPLE : CYAN

export function DroneDiagPanel() {
  const [data, setData] = useState<DiagData | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const load = useCallback(() => {
    authFetch('/api/drone-events/diag')
      .then(r => r.json())
      .then((d: DiagData) => { setData(d); setErr(''); setLoading(false) })
      .catch(() => { setErr('诊断数据获取失败'); setLoading(false) })
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 10000)
    return () => clearInterval(t)
  }, [load])

  const sseOk = (data?.sse?.clients ?? 0) > 0
  const sikongUp = data?.sikong?.up === true
  const zlmHasFlow = (data?.zlm?.sikongOnline ?? 0) > 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Activity size={18} color={CYAN} strokeWidth={1.75} />
        <span style={{ color: '#c8e6ff', fontSize: 15, fontWeight: 700 }}>弹窗链路自检</span>
        <span style={{ fontSize: 12, color: '#5a8aaa' }}>四段状态（SSE / 事件源 / 拉流 / 司空链路）· 10s 刷新</span>
        <button onClick={load} style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 14px', fontSize: 12, borderRadius: 3, cursor: 'pointer', border: '1px solid rgba(0,150,220,0.3)', background: 'rgba(0,80,180,0.12)', color: '#7ab8e0' }}>
          <RefreshCw size={12} /> 刷新
        </button>
      </div>

      {loading && !data ? (
        <div style={{ color: '#5a8aaa', fontSize: 13 }}>加载中…</div>
      ) : err ? (
        <div style={{ color: RED, fontSize: 13 }}>{err}</div>
      ) : (
        <>
          {/* 四段状态灯 */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {light(sseOk ? 'green' : 'amber', '① SSE 长连接', sseOk ? `${data!.sse.clients} 个客户端在线` : '无客户端（弹窗可能未打开）')}
            {light(sikongUp ? 'green' : 'red', '② 司空链路（dji-openapi）', sikongUp ? `OSD 在线 · ${data!.sikong.devices ?? 0} 台设备` : 'dji-openapi 不可达')}
            {light(zlmHasFlow ? 'green' : 'gray', '③ 拉流状态（我方 ZLM）', zlmHasFlow ? `${data!.zlm.sikongOnline} 路 sikong_ 流在线` : '无 sikong_ 流（无人机未起飞）')}
            {light('green', '④ 弹窗播放', '前端渲染层（详见弹窗）')}
          </div>

          {/* 最近事件流水 */}
          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <Zap size={14} color={CYAN} strokeWidth={1.75} />
              <span style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 700 }}>最近事件流水（10 条）</span>
              <span style={{ fontSize: 11, color: '#5a8aaa', marginLeft: 'auto' }}>事件源：webhook 青 / OSD兜底 黄 / 模拟 紫</span>
            </div>
            {(data?.recent?.length ?? 0) === 0 ? (
              <div style={{ color: GRAY, fontSize: 12 }}>暂无事件（无人机起飞后自动记录）</div>
            ) : (
              <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                {data!.recent.map((e, i) => (
                  <div key={i} style={{ display: 'flex', gap: 10, padding: '6px 0', borderBottom: '1px solid rgba(0,80,150,0.12)', fontSize: 12, alignItems: 'center' }}>
                    <span style={{ color: GRAY, fontFamily: 'JetBrains Mono, monospace', flexShrink: 0, width: 105, fontSize: 11 }}>{e.created_at?.slice(5, 16) || '—'}</span>
                    <span style={{ flexShrink: 0, fontSize: 10, padding: '1px 7px', borderRadius: 8, background: `${sourceColor(e.source)}18`, color: sourceColor(e.source), border: `1px solid ${sourceColor(e.source)}40` }}>{e.source}</span>
                    <span style={{ flexShrink: 0, fontSize: 10, padding: '1px 7px', borderRadius: 8, background: e.status === 'LIVE_ON' ? 'rgba(74,222,128,0.15)' : 'rgba(255,68,68,0.15)', color: e.status === 'LIVE_ON' ? GREEN : RED }}>{e.status || '—'}</span>
                    <span style={{ color: '#9ad6f0', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'JetBrains Mono, monospace' }}>
                      {e.device_sn} @ {e.dock_sn}
                    </span>
                    <span style={{ flexShrink: 0, fontSize: 10, color: e.whitelisted === 1 ? GREEN : GRAY }}>{e.whitelisted === 1 ? '白名单✓' : '审计'}</span>
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
