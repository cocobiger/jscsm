import { useEffect, useRef, useState, useCallback } from 'react'
import { authFetch } from '../../lib/apiFetch'

/**
 * 机场网络流量监控条（弹窗底部）
 * 显示当前机场上行带宽占用：实时码率 + 占用百分比进度条 + 拥堵预警。
 * 数据：/api/drone-events/network-status?dockSn=&deviceSn=（2s 轮询）
 * 拥堵等级：safe(<60%) 绿 / warn(60-90%) 黄 / danger(>90%) 红
 */

interface NetworkStatus {
  ok: boolean
  dockName: string
  flying: boolean
  liveKbps: number
  liveMBps: number
  recording: boolean
  recordMBps: number
  totalMBps: number
  uplinkMBps: number
  usagePct: number
  level: 'safe' | 'warn' | 'danger'
}

const GREEN = '#4ade80'
const AMBER = '#ffb74d'
const RED = '#ff4444'
const GRAY = '#5a6b7a'
const CYAN = '#00aaff'

const LEVEL_COLOR = { safe: GREEN, warn: AMBER, danger: RED }
const LEVEL_LABEL = { safe: '正常', warn: '偏高', danger: '拥堵' }

export function NetworkStatusBar({ dockSn, deviceSn, enabled }: { dockSn: string; deviceSn: string; enabled: boolean }) {
  const [st, setSt] = useState<NetworkStatus | null>(null)
  const inFlightRef = useRef(false)

  const load = useCallback(() => {
    if (!dockSn && !deviceSn) return
    if (inFlightRef.current) return
    inFlightRef.current = true
    const qs = new URLSearchParams()
    if (dockSn) qs.set('dockSn', dockSn)
    if (deviceSn) qs.set('deviceSn', deviceSn)
    authFetch(`/api/drone-events/network-status?${qs.toString()}`)
      .then(r => r.json())
      .then(d => { if (d && d.ok) setSt(d) })
      .catch(() => { })
      .finally(() => { inFlightRef.current = false })
  }, [dockSn, deviceSn])

  useEffect(() => {
    if (!enabled) return
    load()
    const t = setInterval(load, 2000)
    return () => clearInterval(t)
  }, [enabled, load])

  if (!st) return null
  const color = LEVEL_COLOR[st.level] || GRAY
  const pct = Math.min(st.usagePct, 100)

  return (
    <div style={{ padding: '4px 8px', background: 'rgba(4,14,30,0.9)', borderTop: '1px solid rgba(0,80,150,0.2)', display: 'flex', alignItems: 'center', gap: 8 }}>
      {/* 状态点 + 标签 */}
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: color, boxShadow: `0 0 5px ${color}`, flexShrink: 0 }} />
      <span style={{ color: '#5a8aaa', fontSize: 9, fontFamily: "'JetBrains Mono',monospace", flexShrink: 0 }}>上行</span>

      {/* 进度条 */}
      <div style={{ flex: 1, height: 3, background: 'rgba(0,150,220,0.12)', borderRadius: 2, overflow: 'hidden', minWidth: 40 }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, transition: 'width 0.5s linear, background 0.3s' }} />
      </div>

      {/* 码率 + 百分比 + 等级 */}
      <span style={{ color, fontSize: 9, fontFamily: "'JetBrains Mono',monospace", fontWeight: 700, flexShrink: 0 }}>
        {st.totalMBps.toFixed(2)}MB/s
      </span>
      <span style={{ color: GRAY, fontSize: 9, fontFamily: "'JetBrains Mono',monospace", flexShrink: 0 }}>
        {st.usagePct}%
      </span>
      <span style={{ fontSize: 8, padding: '0 5px', borderRadius: 6, background: `${color}18`, border: `1px solid ${color}40`, color, flexShrink: 0 }}>
        {LEVEL_LABEL[st.level]}
      </span>
      {st.recording && (
        <span title="dock_media 录像上传中" style={{ fontSize: 8, color: CYAN, flexShrink: 0, fontFamily: "'JetBrains Mono',monospace" }}>
          ⏺录像+{st.recordMBps}
        </span>
      )}
    </div>
  )
}
