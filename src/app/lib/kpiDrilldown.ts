/**
 * 统计条 KPI 下钻的「口径描述符」库（2026-09-16）
 *
 * 设计意图：
 *   统计条 5 个 KPI 的下钻弹窗共用一套骨架（components/KpiDrilldownModal.tsx），
 *   每个 KPI 只在这里描述「列定义 + 分组 + 口径脚注」，不在组件里各写一份表格。
 *   ⟹ 新增 KPI 只需在此加一个 spec 构造函数。
 *
 * 三条硬约束（评估阶段实测得出，勿退化）：
 *   1. **口径混装必须分组**：水质点位 5 = 流域监测站 4 + 水质监测点 1，两类异类相加，平铺无法解释。
 *   2. **口径随视图变化必须写进脚注**：摄像头 27 是"全域"口径，气环境视图为 24、水环境为 3。
 *   3. **URL 必须脱敏**：22/27 路 url 含明文 RTSP 凭据 → 一律走 maskStreamUrl()。
 */
import { maskStreamUrl, relTime } from './maskUrl'

export interface KpiColumn {
  key: string
  label: string
  mono?: boolean
  color?: string
  width?: number
}

/**
 * 名称归一化（用于跨表联动匹配）
 *
 * 为什么需要：实测两处台帐的同一实体名称**差在空白**，精确匹配会静默漏配：
 *   map-points：`彼迪正天生化 (重庆) 有限公司`   enterprises：`彼迪正天生化(重庆)有限公司`
 *   map-points：`三峡国际健康城施工工地 - 开挖区` enterprises：`三峡国际健康城施工工地-开挖区`
 * 去掉所有半角/全角空白即可对齐；**匹配不上仍然显示"无监控"并保留原名**，不猜。
 */
export function normName(s: unknown): string {
  return String(s ?? '').replace(/[\s\u3000]+/g, '')
}
export type KpiCell = string | number | boolean | null | undefined
export interface KpiRow { [k: string]: KpiCell }
export interface KpiGroup {
  name: string
  note?: string
  color?: string
  rows: KpiRow[]
}
export interface KpiSpec {
  title: string
  subtitle?: string
  columns: KpiColumn[]
  groups: KpiGroup[]
  footnote: string
  /** 行内该字段为 true 视为「离线/异常」→ 自动置顶 + 开启「只看异常」筛选 */
  offlineKey?: string
  /** 行内该字段(true) = 该行可地图定位（需同时存在 lat/lon） */
  locateKeys?: { lat: string; lon: string; name: string }
}

// ═══════════════════════════════════════════════════════════
// ① 监测站（/api/stations）+ 实时空气质量（map-points type='air'）
// ═══════════════════════════════════════════════════════════
export interface StationLike { id: string; name?: string; stationName?: string; lon: number; lat: number; enabled?: boolean | number }
/** 点位侧字段声明为 unknown：源数据是 MapPoint（带 [key:string]: unknown 索引签名），
 *  由本文件内的 num() 统一收敛，避免调用方做类型断言。 */
export interface AirPointLike { name?: unknown; aqi?: unknown; pm25?: unknown; pm10?: unknown; so2?: unknown; no2?: unknown }

export function specMonitorStations(stations: StationLike[], airPoints: AirPointLike[]): KpiSpec {
  const rows: KpiRow[] = stations.map(s => {
    const key = String(s.stationName || '').trim()
    // 两表名称不同：stations.stationName="周家坝" vs mapPoints.name="周家坝监测站" → 归一化后前缀匹配
    // 匹配失败显示 '—'（不猜），脚注已说明联动规则
    const air = key ? airPoints.find(a => normName(a.name).startsWith(normName(key))) : undefined
    const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : '—')
    return {
      station: key || '—',
      fullName: s.name || '—',
      coord: `${s.lon.toFixed(5)}, ${s.lat.toFixed(5)}`,
      aqi: num(air?.aqi),
      pm25: num(air?.pm25),
      pm10: num(air?.pm10),
      so2: num(air?.so2),
      no2: num(air?.no2),
      status: s.enabled === false || s.enabled === 0 ? '停用' : '已启用',
      __lat: s.lat, __lon: s.lon,
    }
  })
  return {
    title: '空气质量监测站清单',
    subtitle: `${stations.length} 座`,
    columns: [
      { key: 'station', label: '站名', width: 96 },
      { key: 'fullName', label: '全名', width: 190 },
      { key: 'aqi', label: 'AQI', mono: true, width: 56 },
      { key: 'pm25', label: 'PM2.5', mono: true, width: 60 },
      { key: 'pm10', label: 'PM10', mono: true, width: 60 },
      { key: 'so2', label: 'SO₂', mono: true, width: 52 },
      { key: 'no2', label: 'NO₂', mono: true, width: 52 },
      { key: 'status', label: '状态', width: 64 },
      { key: 'coord', label: '坐标(WGS-84)', mono: true },
    ],
    groups: [{ name: '监测站', rows }],
    footnote: '数据源：<b>/api/stations</b>（站位台帐）+ <b>/api/map-points</b>（type=air 的实时值）。'
      + '两表名称口径不同（台帐用「周家坝」，点位用「周家坝监测站」），此处按<b>前缀匹配</b>联动；'
      + '匹配不上显示「—」，表示实时值缺失而非为 0。',
    locateKeys: { lat: '__lat', lon: '__lon', name: 'station' },
  }
}

// ═══════════════════════════════════════════════════════════
// ② 水质点位（map-points：watermon 流域站 + water 水质点）
// ═══════════════════════════════════════════════════════════
export interface WaterPointLike {
  id: string; type: string; name?: string; lon: number; lat: number
  ph?: unknown; do_?: unknown; nh3?: unknown; tp?: unknown
}

export function specWaterPoints(points: WaterPointLike[]): KpiSpec {
  const mk = (p: WaterPointLike): KpiRow => {
    const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : '—')
    return {
      name: p.name || '—', id: p.id,
      ph: num(p.ph), dox: num(p.do_), nh3: num(p.nh3), tp: num(p.tp),
      coord: `${p.lon.toFixed(5)}, ${p.lat.toFixed(5)}`,
      __lat: p.lat, __lon: p.lon,
    }
  }
  const wm = points.filter(p => p.type === 'watermon').map(mk)
  const w = points.filter(p => p.type === 'water').map(mk)
  return {
    title: '水质点位清单',
    subtitle: `${points.length} 个（流域监测站 ${wm.length} + 水质监测点 ${w.length}）`,
    columns: [
      { key: 'name', label: '名称', width: 132 },
      { key: 'ph', label: 'pH', mono: true, width: 56 },
      { key: 'dox', label: '溶解氧', mono: true, width: 62 },
      { key: 'nh3', label: '氨氮', mono: true, width: 58 },
      { key: 'tp', label: '总磷', mono: true, width: 58 },
      { key: 'id', label: '点位 ID', mono: true, width: 76 },
      { key: 'coord', label: '坐标(WGS-84)', mono: true },
    ],
    groups: [
      { name: `流域监测站 · ${wm.length} 个`, note: '当前仅有点位台帐，未接入断面水质监测数据（参数列显示「—」）', color: '#00bcd4', rows: wm },
      { name: `水质监测点 · ${w.length} 个`, note: '已接入 pH / 溶解氧 / 氨氮 / 总磷', color: '#00e676', rows: w },
    ],
    footnote: '数据源：<b>/api/map-points</b>。统计条的「水质点位 N 个」= '
      + '<b>流域监测站（watermon）+ 水质监测点（water）两类相加</b>，故此处分组展示以说明构成；'
      + '参数为「—」表示该点位无对应监测项，不等于 0。',
    locateKeys: { lat: '__lat', lon: '__lon', name: 'name' },
  }
}

// ═══════════════════════════════════════════════════════════
// ③ 摄像头（/api/streams）— 离线置顶 + 只看离线 + URL 脱敏
// ═══════════════════════════════════════════════════════════
export interface CameraLike {
  id: string; name?: string; location?: string; group?: string; category?: string
  url?: string; offline?: boolean; autoOffline?: boolean
  /** VideoStream.protocol 是字面量联合，统一放宽为 string 便于直接传参 */
  protocol?: string
  lastCheckedAt?: string
  /** VideoStream 里经纬度是 `number | ''`（可选），故放宽 */
  lon?: number | ''
  lat?: number | ''
}

export function specCameras(streams: CameraLike[], scopeLabel: string, now = Date.now()): KpiSpec {
  const rows: KpiRow[] = streams.map(s => ({
    name: s.name || '—',
    group: s.group || '—',
    location: s.location || '—',
    protocol: (s.protocol || '—').toUpperCase(),
    status: s.offline ? '离线' : '在线',
    lastChecked: relTime(s.lastCheckedAt, now),
    url: maskStreamUrl(s.url),
    offline: !!s.offline,     // 供骨架置顶/筛选
    __lat: typeof s.lat === 'number' ? s.lat : undefined,
    __lon: typeof s.lon === 'number' ? s.lon : undefined,
  }))
  // 离线置顶（组内稳定排序）
  rows.sort((a, b) => Number(!!b.offline) - Number(!!a.offline))
  const off = rows.filter(r => r.offline).length
  return {
    title: '摄像头清单',
    subtitle: `${streams.length} 路${off > 0 ? ` · 其中 ${off} 路离线` : ''}`,
    columns: [
      { key: 'name', label: '名称', width: 168 },
      { key: 'status', label: '状态', width: 60 },
      { key: 'group', label: '分组', width: 86 },
      { key: 'location', label: '安装位置', width: 180 },
      { key: 'protocol', label: '协议', mono: true, width: 62 },
      { key: 'lastChecked', label: '最后检测', mono: true, width: 92 },
      { key: 'url', label: '播放地址（已脱敏）', mono: true },
    ],
    groups: [{ name: `摄像头 · ${streams.length} 路`, rows }],
    footnote: `数据源：<b>/api/streams</b>。本列表口径 = 统计条当前视图（<b>${scopeLabel}</b>）；`
      + '切换驾驶舱视图（全域/气环境/水环境）后数量会随之变化。'
      + '「离线」由后端 autoOffline 巡检写入。<b>播放地址中的账号口令已脱敏为 ***:***@</b>。',
    offlineKey: 'offline',
    locateKeys: { lat: '__lat', lon: '__lon', name: 'name' },
  }
}

// ═══════════════════════════════════════════════════════════
// ④ 重点企业（/api/enterprises）+ 视频监控联动
//   ⚠️ 联动数据源用 **/api/streams**（与「摄像头」KPI 同源），**不用 map-points 的 camera 点位**：
//      实测两者对同一批摄像头给出的离线状态不一致（streams 报 7 路离线 / camera 点位报 8 家），
//      同页面出现两个口径会互相打脸——改为同源即可自洽。
//   ⚠️ 名称必须归一化后匹配（两表差在空白，精确匹配会漏配 2 家）。
// ═══════════════════════════════════════════════════════════
export interface EnterpriseLike { id: number | string; name?: string; industry_type?: string | null; location?: string | null; contact?: string | null }

export function specEnterprises(list: EnterpriseLike[], streams: CameraLike[]): KpiSpec {
  // 归一化名称 → 该企业名下摄像头集合
  const byName = new Map<string, CameraLike[]>()
  for (const s of streams) {
    const k = normName(s.name)
    if (!k) continue
    const arr = byName.get(k)
    if (arr) arr.push(s); else byName.set(k, [s])
  }
  /** 匹配某企业名下的摄像头
   *  ① 优先**精确**（归一化后全等）
   *  ② 退化到**前缀**：`摄像头名.startsWith(企业名)` —— 覆盖"同一企业多台摄像头"的常见命名
   *     （如「重庆市九龙万博新材料科技有限公司（通道102）」← 企业全称前缀）。
   *     企业全称较长且具体，前缀误配风险极低；且加最短长度护栏。 */
  const matchCams = (entNorm: string): CameraLike[] => {
    const exact = byName.get(entNorm)
    if (exact) return exact
    if (entNorm.length < 6) return []
    const out: CameraLike[] = []
    for (const [k, arr] of byName) if (k.startsWith(entNorm)) out.push(...arr)
    return out
  }
  const rows: KpiRow[] = list.map(e => {
    const nm = String(e.name || '').trim()
    const cams = matchCams(normName(nm))
    const off = cams.filter(c => c.offline).length
    return {
      name: nm || '—',
      industry: e.industry_type || '未分类',
      monitor: cams.length === 0 ? '无监控'
        : off > 0 ? `${cams.length} 路 · 离线 ${off}` : `${cams.length} 路 · 在线`,
      offline: off > 0,
      addr: e.location || '—',
      contact: e.contact || '—',
    }
  })
  const withCam = rows.filter(r => r.monitor !== '无监控').length
  const offCount = rows.filter(r => r.offline).length
  return {
    title: '重点企业清单',
    subtitle: `${list.length} 家${withCam ? ` · 其中 ${withCam} 家有视频监控${offCount ? `（${offCount} 家有离线）` : ''}` : ''}`,
    columns: [
      { key: 'name', label: '企业名称', width: 268 },
      { key: 'industry', label: '行业', width: 96 },
      { key: 'monitor', label: '视频监控', width: 116 },
      { key: 'addr', label: '地址', width: 180 },
      { key: 'contact', label: '联系人' },
    ],
    groups: [{ name: `重点企业 · ${list.length} 家`, rows }],
    footnote: '数据源：<b>/api/enterprises</b>（企业台账）+ <b>/api/streams</b>（摄像头清单，'
      + '<b>与统计条「摄像头」同一数据源，故两处离线数自洽</b>）。匹配规则：企业名与摄像头名'
      + '<b>去空白归一化后先精确匹配，再退化为前缀匹配</b>（覆盖"同一企业多台摄像头"，'
      + '如「重庆市九龙万博新材料科技有限公司（通道102）」）。'
      + '<b>「无监控」的排查</b>：若某企业实际有摄像头却显示「无监控」，说明两台帐命名既不全等、'
      + '也非"企业名+后缀"关系 —— 请在<b>视频流管理</b>把摄像头名改为「企业全称」或「企业全称+后缀」。'
      + '此处不做模糊猜测，避免把摄像头错挂到别的企业。'
      + '地址/联系人为空属台帐未补录（不影响统计）。',
    offlineKey: 'offline',
  }
}

// ═══════════════════════════════════════════════════════════
// ⑤ 司空2 设备（原 SikongDeviceModal 的表格 → 迁到统一骨架）
// ═══════════════════════════════════════════════════════════
export interface SikongDeviceLike {
  deviceSn: string
  deviceName?: string
  latitude?: number
  longitude?: number
  height?: number | null
  drone?: { droneSn?: string; droneName?: string } | null
  osd?: Record<string, unknown> | null
}

/** 从机场 OSD 安全取数（字段可能缺失） */
function pick(osd: Record<string, unknown> | null | undefined, key: string): string {
  const v = osd ? osd[key] : undefined
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(1)
  return String(v)
}

export function specSikongDevices(devices: SikongDeviceLike[], stateLabel: (osd: Record<string, unknown> | null | undefined) => string): KpiSpec {
  const rows: KpiRow[] = devices
    .filter(d => d && d.deviceSn)
    .map(d => {
      const o = d.osd
      const cap = o ? o['droneCapacityPercent'] : undefined
      return {
        dockName: d.deviceName || '—',
        dockSn: d.deviceSn,
        state: stateLabel(o),
        droneName: d.drone && d.drone.droneSn ? (d.drone.droneName || '—') : '未配对',
        droneSn: d.drone?.droneSn || '—',
        capacity: cap === null || cap === undefined ? '—' : `${pick(o, 'droneCapacityPercent')}%`,
        windspeed: pick(o, 'windspeed'),
        temperature: pick(o, 'temperature'),
        height: d.height != null ? `${d.height.toFixed(0)} m` : '—',
        coord: (typeof d.latitude === 'number' && typeof d.longitude === 'number')
          ? `${d.latitude.toFixed(4)}, ${d.longitude.toFixed(4)}` : '—',
        __lat: typeof d.latitude === 'number' ? d.latitude : undefined,
        __lon: typeof d.longitude === 'number' ? d.longitude : undefined,
        unpaired: !(d.drone && d.drone.droneSn),
      }
    })
  const n = rows.length
  const drones = rows.filter(r => !r.unpaired).length
  return {
    title: '司空2 设备清单',
    subtitle: `机场 ${n} 座 · 无人机 ${drones} 架`,
    columns: [
      { key: 'dockName', label: '机场名称', width: 150 },
      { key: 'dockSn', label: '机场 SN', mono: true, width: 150 },
      { key: 'state', label: '状态', width: 92 },
      { key: 'droneName', label: '无人机', width: 124 },
      { key: 'droneSn', label: '无人机 SN', mono: true, width: 176 },
      { key: 'capacity', label: '电量', mono: true, width: 56 },
      { key: 'windspeed', label: '风速', mono: true, width: 52 },
      { key: 'temperature', label: '温度', mono: true, width: 52 },
      { key: 'height', label: '机场高度', mono: true, width: 76 },
      { key: 'coord', label: '坐标', mono: true },
    ],
    groups: [{ name: `司空2 机场 · ${n} 座`, rows }],
    footnote: '数据源：<b>/api/sikong/devices</b>（DashboardContext 全局单例，15s 刷新；'
      + 'dji-openapi 侧 60s 从司空 OpenAPI 同步）。统计条「无人机 N 架」取本表<b>已配对无人机数</b>；'
      + '「无人机机场 N 座」取<b>机场数</b>。司空登记中无人机与机场 1:1 配对，故两者通常相等。'
      + '「在飞 N 架」取机场 OSD 的 <code>droneInDock</code>（0=不在仓=飞行中），随飞行实时跳变，仅作副指标。',
    locateKeys: { lat: '__lat', lon: '__lon', name: 'dockName' },
  }
}
