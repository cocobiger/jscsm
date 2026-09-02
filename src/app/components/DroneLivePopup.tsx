import { useCallback, useEffect, useRef, useState } from 'react'
import { SinglePlayer } from './VideoPlayerModal'
import { getToken, apiFetch } from '../lib/apiFetch'
import {
  type DroneLiveEvt, shortSn, fetchDroneInfo,
  playAlertChime, unlockAudioOnGesture, loadSoundPref, saveSoundPref,
  DRONE_AUTO_HIDE_MS, DRONE_MAX_WINDOWS, DRONE_MAX_QUEUE,
  DRONE_RESOLVE_WAIT_MS, DRONE_RESOLVE_RETRY_MS,
} from '../lib/droneLive'

/**
 * 驾驶舱·无人机回传自动弹窗（弹窗需求 T2 · 决策 2/3/4 前端落点）
 *
 * 行为（与 V3 排期验收一致）：
 *   起飞广播(LIVE_ON) → 右下角自动弹窗播放无人机回传画面（非机场，sikong_<droneSn> mirror）
 *   决策2：同屏 ≤2 路，第 3 台起进「缩略图队列」（snap 缩略 + SN + 已飞时长），点击拉起/替换
 *   决策3：手动 × / 30s 自动收起 → 收进队列（非销毁），队列常驻角标；声音提示开关（默认开）
 *   白名单过滤在后端 T1 完成（未命中不广播），此处仅消费 SSE 广播
 *
 * 取流：/api/sikong/live-streams 按 deviceSn 匹配 role=drone → play.hls → 相对路径 /jsc/<sid>/hls.m3u8
 * 等待镜像是 zlm-watcher 15s 轮询拉取，起飞瞬间可能未在线 → 解析轮询最长 DRONE_RESOLVE_WAIT_MS
 */

// ── 弹窗条目 ──
export interface DronePopupEntry {
  key: string           // deviceSn
  deviceSn: string
  dockSn: string
  streamId: string      // sikong_<deviceSn>
  title: string         // 机场名（dock 设备名）
  sub: string           // 无人机 SN 标签
  startedAt: number     // 起飞(广播)时间 ms
  url: string           // 相对 HLS 播放地址（''=尚未解析到）
  phase: 'resolving' | 'ready' | 'timeout'
  waitingUntil: number  // 解析超时时刻
  zlmOnline: boolean
  promote: number       // 晋升次数（强制窗口重挂载重启计时）
}

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60
  const mm = String(m).padStart(2, '0')
  return h > 0
    ? `${h}:${mm}:${String(ss).padStart(2, '0')}`
    : `${mm}:${String(ss).padStart(2, '0')}`
}

/** 每秒 tick 的 now（各卡片独立计时，避免整树重渲染） */
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

const CYAN = '#00aaff'
const RED = '#ff4444'
const AMBER = '#ffd740'

// ══════════════════════════════════════════════════════════
// 单个弹窗窗口（≤2 路之一）
// ══════════════════════════════════════════════════════════
function DronePopupWindow({
  entry, onFold, onRetry,
}: {
  entry: DronePopupEntry
  onFold: (key: string) => void
  onRetry: (key: string) => void
}) {
  const now = useNow(1000)
  const [playStatus, setPlayStatus] = useState<string>('')
  const [leftMs, setLeftMs] = useState<number | null>(null)
  const startedRef = useRef(false)
  const tickerRef = useRef<number | null>(null)

  const stopTicker = () => {
    if (tickerRef.current) { clearInterval(tickerRef.current); tickerRef.current = null }
  }
  useEffect(() => stopTicker, [])

  // 视频首次播放 → 启动 30s 自动收起倒计时（决策3）
  const startAutoHide = () => {
    if (startedRef.current) return
    startedRef.current = true
    const deadline = Date.now() + DRONE_AUTO_HIDE_MS
    const tick = () => {
      const left = deadline - Date.now()
      if (left <= 0) { stopTicker(); onFold(entry.key); return }
      setLeftMs(left)
    }
    tick()
    tickerRef.current = window.setInterval(tick, 500)
  }
  const handleStatus = (s: string) => {
    setPlayStatus(s)
    if (s === 'playing') startAutoHide()
  }

  // 兜底：始终未能播放（镜像一直未接入）时，120s 后也收起，避免窗口常驻阻塞画面
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (!startedRef.current) onFold(entry.key)
    }, 120_000)
    return () => clearTimeout(t)
  }, [entry.key, onFold])

  const live = playStatus === 'playing'
  const leftSec = leftMs == null ? null : Math.ceil(leftMs / 1000)

  return (
    <div
      style={{
        width: 400, background: 'rgba(4,14,30,0.96)', border: live ? '1px solid rgba(0,229,255,0.45)' : '1px solid rgba(0,150,220,0.3)',
        borderRadius: 6, boxShadow: '0 6px 28px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,0,0,0.4)', overflow: 'hidden',
        pointerEvents: 'auto', flexShrink: 0,
      }}
    >
      {/* 头部 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', background: 'linear-gradient(90deg, rgba(0,120,200,0.18), transparent)', borderBottom: '1px solid rgba(0,80,150,0.25)' }}>
        <div style={{ width: 6, height: 6, borderRadius: '50%', background: live ? RED : AMBER, boxShadow: live ? `0 0 6px ${RED}` : 'none', flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: '#e3f2ff', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {entry.title || '无人机'}
            <span style={{ color: '#5a8aaa', fontWeight: 400, marginLeft: 6, fontSize: 10 }}>{entry.sub}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 9, color: '#5a8aaa', fontFamily: "'JetBrains Mono',monospace" }}>
            <span>起飞 {fmtDur(now - entry.startedAt)}</span>
            {leftSec != null && (
              <span style={{ color: AMBER, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <span style={{ width: 40, height: 2, background: 'rgba(255,215,64,0.18)', borderRadius: 1, overflow: 'hidden', display: 'inline-block', verticalAlign: 'middle' }}>
                  <span style={{ display: 'block', height: '100%', width: `${(leftSec / (DRONE_AUTO_HIDE_MS / 1000)) * 100}%`, background: AMBER, transition: 'width 0.5s linear' }} />
                </span>
                {leftSec}s 收起
              </span>
            )}
          </div>
        </div>
        <button
          onClick={() => onFold(entry.key)} title="收起至队列（30s 自动收起；点队列缩略图可拉回）"
          style={{ width: 22, height: 22, borderRadius: 3, border: '1px solid rgba(0,150,220,0.3)', background: 'rgba(0,80,150,0.18)', color: '#7fc9ff', cursor: 'pointer', fontSize: 11, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
        >✕</button>
      </div>

      {/* 画面区 16:9 */}
      <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9', background: '#000' }}>
        {entry.url ? (
          <SinglePlayer url={entry.url} protocol="hls" primary={false} onStatus={handleStatus} />
        ) : entry.phase === 'timeout' ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, background: 'rgba(0,0,0,0.85)' }}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={AMBER} strokeWidth="1.5"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
            <span style={{ color: AMBER, fontSize: 11 }}>视频流接入超时</span>
            <button onClick={() => onRetry(entry.key)} style={{ padding: '3px 14px', fontSize: 11, borderRadius: 3, border: `1px solid ${CYAN}50`, background: `${CYAN}18`, color: CYAN, cursor: 'pointer' }}>重新尝试</button>
          </div>
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, background: 'radial-gradient(ellipse at 50% 40%, rgba(0,60,120,0.25), rgba(0,10,25,0.95))' }}>
            <div style={{ width: 26, height: 26, border: `2px solid ${CYAN}25`, borderTop: `2px solid ${CYAN}`, borderRadius: '50%', animation: 'dpl-spin 1s linear infinite' }} />
            <div style={{ color: '#5a8aaa', fontSize: 11 }}>等待视频流接入…</div>
            <div style={{ color: '#2a4a60', fontSize: 9, fontFamily: "'JetBrains Mono',monospace" }}>
              {entry.streamId} · {fmtDur(now - entry.startedAt)}
            </div>
          </div>
        )}
        {/* 顶部叠加：等待提示音开/关仅队列角标处提供 */}
        <div style={{ position: 'absolute', top: 5, right: 6, display: 'flex', alignItems: 'center', gap: 4, background: 'rgba(0,0,0,0.55)', borderRadius: 2, padding: '1px 5px' }}>
          <span style={{ color: live ? RED : '#5a8aaa', fontSize: 9, fontFamily: "'JetBrains Mono',monospace", fontWeight: 700 }}>{live ? '● LIVE' : entry.url ? '连接中' : '待接入'}</span>
        </div>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════
// 队列卡片（缩略图）
// ══════════════════════════════════════════════════════════
function QueueCard({ entry, token, onPromote }: { entry: DronePopupEntry; token: string; onPromote: (key: string) => void }) {
  const now = useNow(1000)
  const [imgNo, setImgNo] = useState(0)     // snap 缓存击穿计数
  const [imgOk, setImgOk] = useState(false)
  const [imgFailed, setImgFailed] = useState(false)

  // 每 5s 刷新缩略图（ZLM getSnap）
  useEffect(() => {
    setImgOk(false); setImgFailed(false)
    const t = window.setInterval(() => setImgNo(n => n + 1), 5000)
    return () => clearInterval(t)
  }, [entry.key])

  const live = entry.zlmOnline || !!entry.url
  return (
    <div
      onClick={() => onPromote(entry.key)}
      title="点击拉起播放（已满 2 路时替换最旧窗口）"
      style={{
        width: 196, flexShrink: 0, cursor: 'pointer', borderRadius: 5, overflow: 'hidden',
        border: live ? '1px solid rgba(0,229,255,0.4)' : '1px solid rgba(0,150,220,0.25)',
        background: 'rgba(4,14,30,0.95)', pointerEvents: 'auto', transition: 'border-color 0.15s, transform 0.15s',
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = live ? '#00e5ff' : 'rgba(0,150,220,0.6)'; (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = live ? 'rgba(0,229,255,0.4)' : 'rgba(0,150,220,0.25)'; (e.currentTarget as HTMLElement).style.transform = 'none' }}
    >
      <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9', background: '#04101f' }}>
        {imgOk && !imgFailed ? (
          <img
            key={`${entry.key}-${imgNo}`}
            src={`/api/streams/live/snap?id=${encodeURIComponent(entry.streamId)}&token=${encodeURIComponent(token)}&t=${Date.now()}`}
            alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            onLoad={() => setImgOk(true)}
            onError={() => { setImgFailed(true); setImgOk(false) }}
          />
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'repeating-linear-gradient(0deg, rgba(0,40,80,0.15) 0 1px, transparent 1px 3px)' }}>
            <div style={{ width: 14, height: 14, border: `1.5px solid ${CYAN}25`, borderTop: `1.5px solid ${CYAN}`, borderRadius: '50%', animation: 'dpl-spin 1s linear infinite' }} />
          </div>
        )}
        <div style={{ position: 'absolute', top: 3, left: 3, display: 'flex', alignItems: 'center', gap: 3, padding: '0 4px', background: 'rgba(0,0,0,0.65)', borderRadius: 2 }}>
          <div style={{ width: 4, height: 4, borderRadius: '50%', background: live ? RED : '#666', boxShadow: live ? `0 0 4px ${RED}` : 'none' }} />
          <span style={{ color: live ? '#fff' : '#8aa', fontSize: 8, fontFamily: "'JetBrains Mono',monospace", fontWeight: 700 }}>{live ? 'LIVE' : '待接入'}</span>
        </div>
      </div>
      <div style={{ padding: '4px 6px', borderTop: '1px solid rgba(0,80,150,0.2)' }}>
        <div style={{ color: '#cfe8ff', fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.title}</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', color: '#5a8aaa', fontSize: 9, fontFamily: "'JetBrains Mono',monospace", marginTop: 2 }}>
          <span>{shortSn(entry.deviceSn)}</span>
          <span>{fmtDur(now - entry.startedAt)}</span>
        </div>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════
// 宿主：SSE 订阅 + 弹窗/队列管理
// ══════════════════════════════════════════════════════════
export function DroneLivePopupHost() {
  const [windows, setWindows] = useState<DronePopupEntry[]>([])
  const [queue, setQueue] = useState<DronePopupEntry[]>([])
  const [queueOpen, setQueueOpen] = useState(false)
  const [soundOn, setSoundOn] = useState<boolean>(loadSoundPref)

  const winRef = useRef(windows); winRef.current = windows
  const queRef = useRef(queue); queRef.current = queue
  const soundRef = useRef(soundOn); soundRef.current = soundOn
  const resolveJobs = useRef(new Map<string, number>())

  // ── 工具 ──
  const patchEntry = useCallback((key: string, patch: Partial<DronePopupEntry>) => {
    setWindows(ws => ws.map(e => e.key === key ? { ...e, ...patch } : e))
    setQueue(qs => qs.map(e => e.key === key ? { ...e, ...patch } : e))
  }, [])

  const findEntry = useCallback((key: string) =>
    [...winRef.current, ...queRef.current].find(e => e.key === key), [])

  /** 解析播放地址（异步轮询直至有流/超时）。initial 为快照，避免 ref 未刷新竞态 */
  const resolveEntry = useCallback((initial: DronePopupEntry) => {
    const key = initial.key
    if (resolveJobs.current.has(key)) return
    resolveJobs.current.set(key, 0)
    const tick = async () => {
      if (!resolveJobs.current.has(key)) return
      const cur = findEntry(key) || initial
      if (cur.url || cur.phase === 'timeout') { resolveJobs.current.delete(key); return }
      const info = await fetchDroneInfo(cur.deviceSn, cur.dockSn)
      if (!resolveJobs.current.has(key)) return
      const cur2 = findEntry(key)
      if (!cur2) { resolveJobs.current.delete(key); return }
      if (info && info.hls) {
        patchEntry(key, {
          url: info.hls, phase: 'ready', zlmOnline: info.zlmOnline,
          title: cur2.title && !cur2.title.startsWith('机场') ? cur2.title : (info.name || cur2.title),
        })
        resolveJobs.current.delete(key)
      } else if (Date.now() >= cur2.waitingUntil) {
        patchEntry(key, { phase: 'timeout' })
        resolveJobs.current.delete(key)
      } else {
        const t = window.setTimeout(() => { void tick() }, DRONE_RESOLVE_RETRY_MS)
        resolveJobs.current.set(key, t)
      }
    }
    void tick()
  }, [patchEntry, findEntry])

  // ── 事件处理 ──
  const addLive = useCallback((evt: DroneLiveEvt, silent = false) => {
    const key = String(evt.deviceSn)
    if (!key || findEntry(key)) return
    const nowT = Date.now()
    const entry: DronePopupEntry = {
      key, deviceSn: key, dockSn: String(evt.dockSn || ''),
      streamId: evt.streamId || `sikong_${key}`,
      title: `机场 ${shortSn(evt.dockSn)}`, sub: `无人机 ${shortSn(key)}`,
      startedAt: Number(evt.ts) || nowT,
      url: '', phase: 'resolving', waitingUntil: nowT + DRONE_RESOLVE_WAIT_MS,
      zlmOnline: !!Number(evt.zlm_online), promote: 0,
    }
    if (winRef.current.length < DRONE_MAX_WINDOWS) {
      setWindows(ws => [...ws, entry])
      if (!silent && soundRef.current) playAlertChime()   // 决策3：声音提示（默认开）
    } else {
      setQueue(qs => [...qs, entry].slice(-DRONE_MAX_QUEUE))
    }
    resolveEntry(entry)
  }, [findEntry, resolveEntry])

  const removeLive = useCallback((deviceSn: string) => {
    const key = String(deviceSn)
    setWindows(ws => ws.filter(e => e.key !== key))
    setQueue(qs => qs.filter(e => e.key !== key))
    const t = resolveJobs.current.get(key)
    if (t) { clearTimeout(t) }
    resolveJobs.current.delete(key)
  }, [])

  /** × / 30s 自动收起 → 进队列（非销毁） */
  const foldToQueue = useCallback((key: string) => {
    const entry = findEntry(key)
    if (!entry) return
    setWindows(ws => ws.filter(e => e.key !== key))
    setQueue(qs => [...qs, entry].slice(-DRONE_MAX_QUEUE))
  }, [findEntry])

  /** 队列点击拉起：<2 直接补位；=2 替换最旧窗口（被替换者回队列） */
  const promote = useCallback((key: string) => {
    const qEntry = queRef.current.find(e => e.key === key)
    if (!qEntry) return
    const promoted = { ...qEntry, promote: qEntry.promote + 1 }
    if (winRef.current.length < DRONE_MAX_WINDOWS) {
      setQueue(qs => qs.filter(e => e.key !== key))
      setWindows(ws => [...ws, promoted])
    } else {
      const replaced = winRef.current[0]
      setWindows(ws => ws.length > 0 ? [...ws.slice(1), promoted] : [promoted])
      setQueue(qs => [...qs.filter(e => e.key !== key), replaced].slice(-DRONE_MAX_QUEUE))
    }
  }, [])

  /** 超时重试：重置为解析中 */
  const retryResolve = useCallback((key: string) => {
    const entry = findEntry(key)
    if (!entry) return
    const fresh: DronePopupEntry = { ...entry, phase: 'resolving', url: '', waitingUntil: Date.now() + DRONE_RESOLVE_WAIT_MS }
    patchEntry(key, { phase: 'resolving', url: '', waitingUntil: fresh.waitingUntil })
    resolveEntry(fresh)
  }, [findEntry, patchEntry, resolveEntry])

  const toggleSound = useCallback(() => {
    setSoundOn(v => {
      const next = !v
      saveSoundPref(next)
      if (next) playAlertChime()
      return next
    })
  }, [])

  // ── 挂载：解锁音频手势 + 回灌当前在飞（避免页面关闭期间漏事件）──
  useEffect(() => {
    unlockAudioOnGesture()
    let cancelled = false
    apiFetch<any>('/api/drone-events?limit=80')
      .then((d) => {
        if (cancelled || !Array.isArray(d?.items)) return
        const latest = new Map<string, any>()
        for (const r of d.items) if (r?.device_sn && !latest.has(r.device_sn)) latest.set(r.device_sn, r)
        const liveRows = [...latest.values()]
          .filter(r => String(r.whitelisted) === '1' && String(r.status).startsWith('LIVE_ON') && Number(r.zlm_online) === 1)
          .slice(0, DRONE_MAX_WINDOWS + DRONE_MAX_QUEUE)
        if (liveRows.length === 0) return
        // 恢复路径按「当前剩余窗口槽位」直接分配，规避 ref 未刷新的竞态
        const room = Math.max(0, DRONE_MAX_WINDOWS - winRef.current.length)
        const entries: DronePopupEntry[] = liveRows.map(r => {
          const ts = Date.parse(r.event_time || '')
          const t = isNaN(ts) ? Date.now() : ts
          return {
            key: String(r.device_sn), deviceSn: String(r.device_sn), dockSn: String(r.dock_sn || ''),
            streamId: r.stream_id || `sikong_${r.device_sn}`,
            title: `机场 ${shortSn(r.dock_sn)}`, sub: `无人机 ${shortSn(r.device_sn)}`,
            startedAt: t, url: '', phase: 'resolving' as const,
            waitingUntil: Date.now() + DRONE_RESOLVE_WAIT_MS,
            zlmOnline: true, promote: 0,
          }
        })
        const wsAdd = entries.slice(0, room)
        const qAdd = entries.slice(room)
        if (wsAdd.length) setWindows(prev => [...prev, ...wsAdd])
        if (qAdd.length) setQueue(prev => [...prev, ...qAdd].slice(-DRONE_MAX_QUEUE))
        for (const e of [...wsAdd, ...qAdd]) resolveEntry(e)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [resolveEntry])

  // ── SSE 订阅（EventSource ?token= 鉴权；断线自动重连）──
  useEffect(() => {
    const token = getToken()
    if (!token) return
    let es: EventSource | null = null
    const connect = () => {
      try { es?.close() } catch {}
      es = new EventSource(`/api/drone-events/stream?token=${encodeURIComponent(token)}`)
      es.onmessage = (m) => {
        try {
          const evt = JSON.parse(m.data) as DroneLiveEvt
          if (!evt || evt.type !== 'drone-live' || !evt.deviceSn) return
          if (Number(evt.on) === 1) addLive(evt, false)
          else removeLive(String(evt.deviceSn))
        } catch { /* 心跳注释行等忽略 */ }
      }
      es.onerror = () => {
        // 若已彻底关闭（如 401 后浏览器不再自动重连），稍后手动重建
        if (es && es.readyState === EventSource.CLOSED) {
          try { es.close() } catch {}
          es = null
          reconnectTimer.current = window.setTimeout(connect, 8000)
        }
      }
    }
    const reconnectTimer: { current: number | null } = { current: null }
    connect()
    return () => {
      try { es?.close() } catch {}
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
    }
  }, [addLive, removeLive])

  // 卸载清理解析任务
  useEffect(() => () => {
    for (const t of resolveJobs.current.values()) if (t) clearTimeout(t)
    resolveJobs.current.clear()
  }, [])

  const token = getToken()
  const queueCount = queue.length

  return (
    <div style={{ position: 'absolute', right: 14, bottom: 12, zIndex: 1500, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, pointerEvents: 'none' }}>
      {/* 弹窗窗口（≤2） */}
      {windows.map(w => (
        <DronePopupWindow key={`w-${w.key}-${w.promote}`} entry={w} onFold={foldToQueue} onRetry={retryResolve} />
      ))}

      {/* 队列缩略图条 */}
      {queueOpen && queue.length > 0 && (
        <div style={{ pointerEvents: 'auto', maxWidth: 900, display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 2, scrollbarWidth: 'none' }}>
          {queue.map(q => (
            <QueueCard key={`q-${q.key}-${q.promote}`} entry={q} token={token} onPromote={promote} />
          ))}
        </div>
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
