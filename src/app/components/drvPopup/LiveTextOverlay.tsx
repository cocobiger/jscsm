import { useEffect, useRef, useState } from 'react'
import { authFetch } from '../../lib/apiFetch'
import { useOsdPolling, type OsdResponse } from './useOsdPolling'

/**
 * LiveTextOverlay —— 无人机直播画面常显文字播报层（坐标 / 镇街 / 时间）
 *
 * 用途：算法漏检时，值班员对着直播截图即可向处置人员准确传达位置信息
 * （截图即证据：文字与画面同帧可见）。独立于检测状态常显，不受 BboxOverlay 开关影响。
 *
 * 数据：
 *  - 坐标：useOsdPolling（模块级单例 2s 轮询，与 MiniDroneMap 共享）
 *  - 镇街：GET /api/straw/reverse-geocode（本地点在多边形判定），节流策略：
 *          坐标缓存键 = 3 位小数（≈110m 格网），移动未跨格不重查 + LRU 上限
 *  - 时间：本地渲染时刻（浏览器 new Date()），保证"截图时间 = 看到的时间"；
 *          OSD 断流/过期 → 保留最后有效值 + 「遥测中断」红标（数据不新鲜必须可见）
 *  - GCJ-02：前端 WGS-84→GCJ-02 标准7参数近似变换（高德/百度落点用），带一键复制
 */

const WHITE = '#f2f8ff'
const DIM = '#8fb8d4'
const RED = '#ff5252'
const CYAN = '#00e5ff'
const MONO = "'JetBrains Mono','Courier New',monospace"

/** 遥测新鲜度阈值：超过视为断流（OSD 服务端 2s 推送，取 10s 宽限） */
const STALE_MS = 10_000

// ── WGS-84 → GCJ-02（火星坐标）标准近似变换 ─────────────────────────
const GCJ_A = 6378245.0
const GCJ_EE = 0.00669342162296594323

function transformLat(x: number, y: number): number {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0
  ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0
  ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0
  return ret
}
function transformLng(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0
  ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0
  ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0
  return ret
}
function outOfChina(lat: number, lng: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}
/** WGS-84 → GCJ-02（中国境外原样返回） */
export function wgs84ToGcj02(lat: number, lng: number): [number, number] {
  if (outOfChina(lat, lng)) return [lat, lng]
  const radLat = lat / 180.0 * Math.PI
  let magic = Math.sin(radLat); magic = 1 - GCJ_EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  let dLat = transformLat(lng - 105.0, lat - 35.0)
  let dLng = transformLng(lng - 105.0, lat - 35.0)
  dLat = (dLat * 180.0) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * Math.PI)
  dLng = (dLng * 180.0) / (GCJ_A / sqrtMagic * Math.cos(radLat) * Math.PI)
  return [lat + dLat, lng + dLng]
}

// ── 镇街逆地理：3 位小数格网 LRU 缓存（跨弹窗/全屏层共享） ──────────
const townCache = new Map<string, string | null>()   // 'lng3,lat3' -> 镇街名 | null（null=已查无覆盖，不再重复查）
const TOWN_CACHE_MAX = 200

async function fetchTown(lng: number, lat: number): Promise<string | null> {
  const key = `${lng.toFixed(3)},${lat.toFixed(3)}`
  if (townCache.has(key)) return townCache.get(key) ?? null
  try {
    const r = await authFetch(`/api/straw/reverse-geocode?lng=${lng}&lat=${lat}`)
    const d = await r.json()
    const name: string | null = (d && d.ok && d.town && d.town.name) ? d.town.name : null
    // LRU 控制
    if (townCache.size >= TOWN_CACHE_MAX) {
      const first = townCache.keys().next().value
      if (first !== undefined) townCache.delete(first)
    }
    townCache.set(key, name)
    return name
  } catch {
    return null   // 查询失败不缓存，下次移动再试
  }
}

function fmtTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
function fmtLngLat(lat: number | null, lng: number | null): string {
  if (lat == null || lng == null) return '—'
  return `${lng.toFixed(6)}, ${lat.toFixed(6)}`
}

export function LiveTextOverlay({
  deviceSn, deviceLabel, enabled, size = 'sm',
}: {
  deviceSn: string
  deviceLabel?: string
  enabled: boolean
  size?: 'sm' | 'lg'
}) {
  const osd = useOsdPolling(deviceSn, enabled)
  const [now, setNow] = useState(() => Date.now())
  const [town, setTown] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // 每秒 tick（渲染本地时间；tick 频率 1s，注意与 OSD 轮询互不影响）
  useEffect(() => {
    if (!enabled) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [enabled])

  // 镇街查询：跟随 OSD 坐标，格网缓存去抖（批1-3 节流策略）
  const frame = osd?.osd ?? null
  const lat = frame?.latitude ?? null
  const lng = frame?.longitude ?? null
  const lastQueriedRef = useRef('')
  useEffect(() => {
    if (!enabled || lat == null || lng == null) return
    const key = `${lng.toFixed(3)},${lat.toFixed(3)}`
    if (key === lastQueriedRef.current) return
    lastQueriedRef.current = key
    void fetchTown(lng, lat).then(name => { if (name !== null) setTown(name) })
  }, [enabled, lat, lng])

  // 遥测新鲜度判定
  const osdTs = frame?.ts ?? null
  const stale = !osd || !osd.online || lat == null || lng == null ||
    (osdTs != null && now - osdTs > STALE_MS)

  const copyGcj = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (lat == null || lng == null) return
    const [glat, glng] = wgs84ToGcj02(lat, lng)
    const text = `${glng.toFixed(6)},${glat.toFixed(6)}`
    const done = () => { setCopied(true); window.setTimeout(() => setCopied(false), 1500) }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(done)
    } else {
      const ta = document.createElement('textarea')
      ta.value = text; document.body.appendChild(ta); ta.select()
      try { document.execCommand('copy'); done() } catch { /* 忽略 */ }
      document.body.removeChild(ta)
    }
  }

  // 渲染时刻（本地时间 = 截图者所见时间）；断流时本地时间照常走，红标说明遥测断了
  const renderAt = new Date(now)

  // GCJ-02 变换（仅有效坐标时）
  const gcj: [number, number] | null = lat != null && lng != null ? wgs84ToGcj02(lat, lng) : null
  const aimLat = frame?.measureTargetLatitude ?? null
  const aimLng = frame?.measureTargetLongitude ?? null
  const aimGcj: [number, number] | null = aimLat != null && aimLng != null ? wgs84ToGcj02(aimLat, aimLng) : null

  const f = size === 'lg' ? 15 : 10
  const f2 = size === 'lg' ? 14 : 9
  const pad = size === 'lg' ? '6px 12px' : '3px 8px'
  const lineHeight = size === 'lg' ? 1.6 : 1.45

  return (
    <div
      style={{
        position: 'absolute', top: size === 'lg' ? 12 : 5, left: size === 'lg' ? 12 : 6,
        zIndex: 25, pointerEvents: 'none', lineHeight,
      }}
      data-testid="live-text-overlay"
      data-town={town ?? ''}
      data-stale={stale ? '1' : '0'}
    >
      <div style={{
        background: 'rgba(0,0,0,0.62)', backdropFilter: 'blur(2px)',
        borderRadius: 4, padding: pad, border: '1px solid rgba(0,170,255,0.28)',
        boxShadow: '0 2px 10px rgba(0,0,0,0.45)',
      }}>
        {/* 行1：时间（本地渲染时刻） + 遥测状态 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: WHITE, fontSize: f, fontFamily: MONO, fontWeight: 700, letterSpacing: 0.5 }}>
            {fmtTime(renderAt)}
          </span>
          {stale
            ? <span style={{ color: RED, fontSize: f2, fontFamily: MONO, fontWeight: 700 }}>● 遥测中断{frame ? '（显示最后位置）' : ''}</span>
            : <span style={{ color: '#6fe3a1', fontSize: f2, fontFamily: MONO }}>● 遥测正常</span>}
        </div>
        {/* 行2：WGS-84（天地图/驾驶舱） */}
        <div style={{ color: WHITE, fontSize: f, fontFamily: MONO }}>
          <span style={{ color: DIM, fontSize: f2 }}>WGS-84</span>
          {' '}{lat != null ? fmtLngLat(lat, lng) : '—'}
          {frame?.height != null && <span style={{ color: DIM, fontSize: f2, marginLeft: 6 }}>H {frame.height.toFixed(0)}m</span>}
        </div>
        {/* 行3：GCJ-02（高德/百度）+ 复制 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: WHITE, fontSize: f, fontFamily: MONO }}>
            <span style={{ color: DIM, fontSize: f2 }}>GCJ-02</span>
            {' '}{gcj ? `${gcj[1].toFixed(6)}, ${gcj[0].toFixed(6)}` : '—'}
          </span>
          {gcj && (
            <span
              onClick={copyGcj}
              title="复制 GCJ-02 坐标（可直接粘贴到高德/百度地图）"
              style={{
                pointerEvents: 'auto', cursor: 'pointer', fontSize: f2, fontFamily: MONO, fontWeight: 700,
                color: copied ? '#6fe3a1' : CYAN, background: copied ? 'rgba(20,120,70,0.35)' : 'rgba(0,80,140,0.45)',
                border: `1px solid ${copied ? 'rgba(30,180,110,0.6)' : 'rgba(0,170,255,0.45)'}`,
                borderRadius: 3, padding: '0 6px', lineHeight: size === 'lg' ? '22px' : '14px', whiteSpace: 'nowrap',
              }}
            >{copied ? '✓ 已复制' : '复制'}</span>
          )}
        </div>
        {/* 行4：镇街 + 设备标识 */}
        <div style={{ color: WHITE, fontSize: f, fontFamily: MONO, fontWeight: 600 }}>
          <span style={{ color: DIM, fontSize: f2 }}>镇街</span>
          {' '}{town ?? (lat != null ? '查询中…' : '—')}
          {deviceLabel && <span style={{ color: DIM, fontSize: f2, marginLeft: 8 }}>{deviceLabel}</span>}
        </div>
        {/* 行5（有值才显示）：云台准星目标点 */}
        {aimGcj && (
          <div style={{ color: WHITE, fontSize: f2, fontFamily: MONO }}>
            <span style={{ color: CYAN, fontSize: f2 }}>准星</span>
            {' '}{aimGcj[1].toFixed(6)}, {aimGcj[0].toFixed(6)}
            <span style={{ color: DIM, marginLeft: 4 }}>(画面中心目标)</span>
          </div>
        )}
      </div>
    </div>
  )
}

/** 供测试/外部读取缓存的工具（不影响生产逻辑） */
export function _townCacheSize(): number { return townCache.size }
export type { OsdResponse }
