import { useCallback, useEffect, useRef, useState } from 'react'
import { getToken, apiFetch } from '../../lib/apiFetch'
import {
  type DroneLiveEvt,
  fetchDroneStreamStatus,
  playAlertChime, unlockAudioOnGesture, loadSoundPref, saveSoundPref,
} from '../../lib/droneLive'
import {
  emptyState, liveOn, liveOff, foldWindow, clickQueue, patchEntry, findEntry, allEntries,
  DRONE_WINDOW_MAX, DRONE_QUEUE_MAX, DRONE_RESOLVE_RETRY_MS, DRONE_RESOLVE_WAIT_MS,
  type PopupState, type LiveEntry,
} from './dronePopupModel'
import { DronePopupWindow } from './DronePopupWindow'
import { QueueStrip } from './QueueStrip'

/**
 * v2 无人机回传弹窗宿主 —— 与相机 role 列表解耦的调度装配层
 *
 * 接线（全部调度决策收敛到 dronePopupModel 纯状态机，此处仅翻译事件与副作用）：
 *   SSE LIVE_ON  → liveOn()（满窗折叠最新打开/队满挤最旧均由模型完成）；仅真正上窗才响提示音
 *   SSE LIVE_OFF → liveOff()（全局移除销毁）
 *   ✕ / 30s / 120s 兜底 → foldWindow()（入队非销毁，不自动补位）
 *   队列缩略图点击 → clickQueue()（满窗折叠最新打开并打开所点项）
 *   解析轮询 4s：窗口+队列中 phase=resolving 条目 → GET /api/drone-events/stream-status
 *     （直查 ZLM mirror，与 /satellite/camera role 列表无关），hls 就绪写回 / 超时标 timeout
 *
 * 运维开关：localStorage 'jsc:drone-popup-off' === '1' → 整机停用（return null）
 * 声音：默认开，持久化 'jsc:drone-popup-sound'；回灌/挂载恢复静默不响
 */

const AMBER = '#ffd740'

export function DronePopupHost() {
  const [enabled] = useState<boolean>(() => {
    try { return localStorage.getItem('jsc:drone-popup-off') !== '1' } catch { return true }
  })
  const [state, setState] = useState<PopupState>(emptyState)
  const [queueOpen, setQueueOpen] = useState(false)
  const [soundOn, setSoundOn] = useState<boolean>(loadSoundPref)

  const stateRef = useRef(state); stateRef.current = state
  const soundRef = useRef(soundOn); soundRef.current = soundOn
  const inFlight = useRef(new Set<string>())
  const aliveRef = useRef(true)

  // ── 状态提交（ref 即时同步，SSE 串行消息读改写无竞态）──
  const commit = useCallback((next: PopupState) => {
    stateRef.current = next
    setState(next)
  }, [])

  const applyPatch = useCallback((key: string, fn: (cur: LiveEntry) => Partial<LiveEntry>) => {
    const cur = findEntry(stateRef.current, key)
    if (!cur) return
    const next = patchEntry(stateRef.current, key, fn(cur))
    if (next !== stateRef.current) commit(next)
  }, [commit])

  // ── 解析轮询（4s）：仅 resolving 且无 url 的条目，inFlight 去重 ──
  const scanResolve = useCallback(() => {
    if (!aliveRef.current) return
    const targets = allEntries(stateRef.current).filter(e =>
      e.phase === 'resolving' && !e.url && !inFlight.current.has(e.key))
    if (!targets.length) return
    for (const entry of targets) {
      inFlight.current.add(entry.key)
      fetchDroneStreamStatus(entry.deviceSn, entry.dockSn)
        .then(info => {
          if (!aliveRef.current || !inFlight.current.has(entry.key)) return
          const cur = findEntry(stateRef.current, entry.key)
          if (!cur) { inFlight.current.delete(entry.key); return }   // LIVE_OFF 已移除
          if (info && info.hls) {
            applyPatch(entry.key, c => {
              const p: Partial<LiveEntry> = { url: info.hls, phase: 'ready', zlmOnline: info.online }
              if (info.dockName && c.title.startsWith('机场')) p.title = info.dockName
              return p
            })
          } else if (Date.now() >= cur.waitingUntil) {
            applyPatch(entry.key, () => ({ phase: 'timeout' }))
          }
          inFlight.current.delete(entry.key)
        })
        .catch(() => {
          if (!aliveRef.current) return
          const cur = findEntry(stateRef.current, entry.key)
          // 网络异常不阻塞：已过等待窗则判超时，否则下轮再试
          if (cur && Date.now() >= cur.waitingUntil) applyPatch(entry.key, () => ({ phase: 'timeout' }))
          inFlight.current.delete(entry.key)
        })
    }
  }, [applyPatch])

  // ── 事件处理 ──
  /** LIVE_ON：模型调度；仅 placed=window（新增上窗）且非静默才响提示音 */
  const handleLiveOn = useCallback((evt: DroneLiveEvt, silent = false) => {
    const r = liveOn(stateRef.current, evt)
    if (r.state === stateRef.current) return                    // dup / invalid no-op
    commit(r.state)
    if (r.placed === 'window' && !silent && soundRef.current) playAlertChime()
  }, [commit])

  /** LIVE_OFF：全局移除销毁 */
  const handleLiveOff = useCallback((deviceSn: string) => {
    const next = liveOff(stateRef.current, String(deviceSn))
    if (next !== stateRef.current) commit(next)
  }, [commit])

  /** ✕ / 30s 自动收起 / 120s 兜底 → 入队非销毁 */
  const handleFold = useCallback((key: string) => {
    const r = foldWindow(stateRef.current, key)
    if (r.state !== stateRef.current) commit(r.state)
  }, [commit])

  /** 队列缩略图点击 → 拉起播放（满窗时模型折叠最新打开腾位） */
  const handleOpenQueue = useCallback((key: string) => {
    const r = clickQueue(stateRef.current, key)
    if (r.state !== stateRef.current) commit(r.state)
  }, [commit])

  /** 超时重试：复位 resolving 并立即触发一轮解析 */
  const retryResolve = useCallback((key: string) => {
    if (!findEntry(stateRef.current, key)) return
    applyPatch(key, () => ({ phase: 'resolving', url: '', waitingUntil: Date.now() + DRONE_RESOLVE_WAIT_MS }))
    void scanResolve()
  }, [applyPatch, scanResolve])

  const toggleSound = useCallback(() => {
    setSoundOn(v => {
      const next = !v
      saveSoundPref(next)
      if (next) playAlertChime()
      return next
    })
  }, [])

  // ── 挂载：音频手势解锁 + 回灌在飞（silent；limit=80 取每机最新 LIVE_ON&zlm_online=1）──
  useEffect(() => {
    if (!enabled) return
    unlockAudioOnGesture()
    let cancelled = false
    apiFetch<any>('/api/drone-events?limit=80')
      .then((d) => {
        if (cancelled || !Array.isArray(d?.items)) return
        const latest = new Map<string, any>()
        for (const r of d.items) if (r?.device_sn && !latest.has(r.device_sn)) latest.set(r.device_sn, r)
        const rows = [...latest.values()]
          .filter(r => String(r.whitelisted) === '1' && String(r.status).startsWith('LIVE_ON') && Number(r.zlm_online) === 1)
          .sort((a, b) => (Date.parse(a.event_time || '') || 0) - (Date.parse(b.event_time || '') || 0))
          .slice(-(DRONE_WINDOW_MAX + DRONE_QUEUE_MAX))
        for (const row of rows) {
          const t = Date.parse(row.event_time || '')
          const r2 = liveOn(stateRef.current, {
            deviceSn: String(row.device_sn),
            dockSn: String(row.dock_sn || ''),
            streamId: row.stream_id || `sikong_${row.device_sn}`,
            ts: isNaN(t) ? Date.now() : t,
            zlm_online: 1,
          })
          if (r2.state !== stateRef.current) commit(r2.state)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [enabled, commit])

  // ── 解析轮询定时器（4s）+ 卸载防护 ──
  useEffect(() => {
    if (!enabled) return
    aliveRef.current = true
    const iv = window.setInterval(() => { void scanResolve() }, DRONE_RESOLVE_RETRY_MS)
    const first = window.setTimeout(() => { void scanResolve() }, 300)
    return () => {
      clearInterval(iv)
      clearTimeout(first)
      aliveRef.current = false
    }
  }, [enabled, scanResolve])

  // ── SSE 订阅（?token= 鉴权；断线 8s 手动重建）──
  useEffect(() => {
    if (!enabled) return
    const token = getToken()
    if (!token) return
    let es: EventSource | null = null
    let retryTimer: number | null = null
    const connect = () => {
      try { es?.close() } catch {}
      es = new EventSource(`/api/drone-events/stream?token=${encodeURIComponent(token)}`)
      es.onmessage = (m) => {
        try {
          const evt = JSON.parse(m.data) as DroneLiveEvt
          if (!evt || evt.type !== 'drone-live' || !evt.deviceSn) return
          if (Number(evt.on) === 1) handleLiveOn(evt, false)
          else handleLiveOff(String(evt.deviceSn))
        } catch { /* 心跳/注释行等忽略 */ }
      }
      es.onerror = () => {
        // readyState CLOSED（如 401）后浏览器不再自动重连 → 稍后手动重建
        if (es && es.readyState === EventSource.CLOSED) {
          try { es.close() } catch {}
          es = null
          retryTimer = window.setTimeout(connect, 8000)
        }
      }
    }
    connect()
    return () => {
      try { es?.close() } catch {}
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [enabled, handleLiveOn, handleLiveOff])

  // 运维开关：整机停用
  if (!enabled) return null

  const token = getToken()
  const queueCount = state.queue.length

  return (
    <div style={{ position: 'absolute', right: 14, bottom: 12, zIndex: 1500, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, pointerEvents: 'none' }}>
      {/* 弹窗窗口（≤2；openSeq 变化强制重挂载重启 30s 计时） */}
      {state.windows.map(w => (
        <DronePopupWindow
          key={`w-${w.key}-${w.openSeq}`}
          entry={w}
          onFold={handleFold}
          onRetry={retryResolve}
        />
      ))}

      {/* 队列缩略图条（展开态） */}
      {queueOpen && state.queue.length > 0 && (
        <QueueStrip entries={state.queue} token={token} onOpen={handleOpenQueue} />
      )}

      {/* 角标区：声音开关 + 队列计数 */}
      <div style={{ display: 'flex', gap: 6, pointerEvents: 'auto', alignItems: 'center' }}>
        <button
          onClick={toggleSound} title={soundOn ? '声音提示：开（点击关闭）' : '声音提示：关（点击开启）'}
          style={{
            display: 'flex', alignItems: 'center', gap: 4, height: 26, padding: '0 9px', borderRadius: 13,
            border: `1px solid ${soundOn ? 'rgba(0,229,255,0.45)' : 'rgba(120,140,170,0.3)'}`,
            background: soundOn ? 'rgba(0,150,220,0.14)' : 'rgba(255,255,255,0.04)',
            color: soundOn ? '#7fd0ff' : '#667', fontSize: 11, cursor: 'pointer',
          }}
        >{soundOn ? '🔊 提示音' : '🔇 静音'}</button>

        {queueCount > 0 && (
          <button
            onClick={() => setQueueOpen(o => !o)} title={queueOpen ? '收起队列' : `展开队列（${queueCount} 台排队）`}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, height: 26, padding: '0 11px', borderRadius: 13,
              border: queueOpen ? '1px solid rgba(0,229,255,0.5)' : '1px solid rgba(255,215,64,0.45)',
              background: queueOpen ? 'rgba(0,150,220,0.16)' : 'rgba(255,190,40,0.10)',
              color: queueOpen ? '#7fd0ff' : AMBER, fontSize: 11, cursor: 'pointer', fontWeight: 600,
            }}
          >⏸ 排队 {queueCount} {queueOpen ? '▾' : '▸'}</button>
        )}
      </div>

      <style>{`@keyframes dpl-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
