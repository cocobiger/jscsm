import { useEffect, useState } from 'react'
import { authFetch } from '../../lib/apiFetch'

/**
 * 无人机 OSD 共用轮询 hook（批1-1 从 MiniDroneMap 抽取）
 *
 * 设计要点：模块级单例 poller —— 同一 deviceSn 无论多少组件订阅
 * （LiveTextOverlay 弹窗层 / LiveTextOverlay 全屏层 / MiniDroneMap），
 * 全局只保持一路 2s 轮询，向下广播，避免双倍请求。
 * 数据源：GET /api/drone-events/osd?deviceSn=（司空 Redis osd_dock_drone）
 */

export interface DroneOsdFrame {
  latitude: number | null
  longitude: number | null
  height: number | null
  elevation: number | null
  attitudeHead: number | null
  gimbalPitch: number | null
  gimbalYaw: number | null
  horizontalSpeed: number | null
  verticalSpeed: number | null
  batteryPercent: number | null
  remainFlightTime: number | null
  gpsNumber: number | null
  rtkNumber: number | null
  windSpeed: number | null
  /** 云台十字准星目标点（有值时比机体坐标更贴近画面中心） */
  measureTargetLatitude: number | null
  measureTargetLongitude: number | null
  modeCode: number | null
  /** 服务端 OSD 时间戳 ms（用于判遥测新鲜度） */
  ts: number | null
}

export interface OsdResponse {
  ok: boolean
  deviceSn: string
  online: boolean
  osd?: DroneOsdFrame | null
}

type Listener = (d: OsdResponse | null) => void

interface PollerState {
  listeners: Set<Listener>
  timer: number | null
  inFlight: boolean
  data: OsdResponse | null
}

const pollers = new Map<string, PollerState>()
const POLL_MS = 2000

async function fetchOsd(sn: string) {
  const st = pollers.get(sn)
  if (!st || st.inFlight) return
  st.inFlight = true
  try {
    const r = await authFetch(`/api/drone-events/osd?deviceSn=${encodeURIComponent(sn)}`)
    const d: OsdResponse | null = await r.json().catch(() => null)
    const cur = pollers.get(sn)
    if (!cur) return
    if (d && d.ok) cur.data = d
    cur.listeners.forEach(l => { try { l(cur.data) } catch { /* 单订阅者异常不影响其它 */ } })
  } catch {
    // 网络异常：保留旧 data，不触发回调（UI 按断流红标处理）
  } finally {
    const cur = pollers.get(sn)
    if (cur) cur.inFlight = false
  }
}

function subscribe(sn: string, cb: Listener): () => void {
  let st = pollers.get(sn)
  if (!st) {
    st = { listeners: new Set(), timer: null, inFlight: false, data: null }
    pollers.set(sn, st)
  }
  st.listeners.add(cb)
  // 已有数据立即推给新订阅者（避免全屏层切换时白等 2s）
  if (st.data) cb(st.data)
  if (st.timer == null) {
    st.timer = window.setInterval(() => fetchOsd(sn), POLL_MS)
    void fetchOsd(sn)
  }
  return () => {
    const cur = pollers.get(sn)
    if (!cur) return
    cur.listeners.delete(cb)
    if (cur.listeners.size === 0 && cur.timer != null) {
      window.clearInterval(cur.timer)
      cur.timer = null
      pollers.delete(sn)
    }
  }
}

/**
 * 订阅某无人机的 OSD（enabled=false 时不发起请求；恢复 true 时重连）
 */
export function useOsdPolling(deviceSn: string, enabled: boolean): OsdResponse | null {
  const [osd, setOsd] = useState<OsdResponse | null>(null)
  useEffect(() => {
    if (!enabled || !deviceSn) return
    return subscribe(deviceSn, setOsd)
  }, [deviceSn, enabled])
  return osd
}
