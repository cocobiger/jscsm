import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
import mqtt from 'mqtt'
import type { MqttClient } from 'mqtt'
import type { AlertItem } from '../components/AlertPanel'
import { apiFetch, getApiKey, authFetch } from '../lib/apiFetch'

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export interface GB28181Config {
  sipServer: string      // SIP服务器地址（IP或域名）
  sipPort: number        // SIP服务器端口，默认5060
  sipServerId: string    // SIP服务器国标编码（20位）
  sipDomain: string      // SIP域（通常与服务器ID相同或填IP）
  deviceId: string       // 设备国标编码（20位）
  channelId: string      // 通道国标编码（20位）
  username: string       // 认证用户名
  password: string       // 认证密码
  transport: 'UDP' | 'TCP'
}

export interface DJIWebRTCConfig {
  shareUrl: string      // 大疆司空 share/live/ 分享页完整 URL
  airportName: string   // 设备名称（顶层模式）或子相机名称（嵌套模式）
  parentName?: string   // 嵌套子相机模式的父设备名称（如 "M4TD | 4TD-三峡科技大学"），顶层模式留空
  airportIndex?: number // 机场索引（仅当名称匹配失败时使用，一般无需填写）
  autoFullscreen?: boolean // 推流后自动点击全屏按钮（默认 true）
  keepAlive?: boolean   // 是否持续保持浏览器推流（默认 true）
  width?: number        // 浏览器窗口宽度（默认 1280）
  height?: number       // 浏览器窗口高度（默认 720）
  bitrate?: number      // 推流码率 kbps（默认 2000）
}

export interface VideoStream {
  id: string
  name: string
  location: string
  lat: number | ''         // 纬度（可选）
  lon: number | ''         // 经度（可选）
  url: string              // RTSP / HLS / WebRTC / ONVIF URL；GB28181 / DJI WebRTC 时留空
  group: VideoGroup
  offline: boolean
  protocol: 'rtsp' | 'hls' | 'webrtc' | 'onvif' | 'gb28281' | 'dji_webrtc'
  category?: '气环境' | '水环境'   // 驾驶舱视图分类：气环境/水环境；未设置则仅全域态势可见
  thumbnail?: string       // 视频流显示图片（URL 或 base64 data URI），作为卡片底图
  gb28181Config?: GB28181Config
  djiWebRTCConfig?: DJIWebRTCConfig
}

export type VideoGroup = '无人机视频' | '港口堆场' | '道路监控' | '水体监控' | '重点企业'
export const VIDEO_GROUPS: VideoGroup[] = ['无人机视频', '港口堆场', '道路监控', '水体监控', '重点企业']

// 视频流驾驶舱分类（气环境 / 水环境）。用于前端「气环境驾驶舱 / 水环境驾驶舱」视图过滤
export type StreamCategory = '气环境' | '水环境'
export const STREAM_CATEGORIES: StreamCategory[] = ['气环境', '水环境']

// ────────────────────────────────────────────────────────────
// AI 分析推送规则（降噪）：AI 类型默认枚举 + 规则/聚合数据类型
// 注：AI 类型已改为后台可管理（/api/ai-types），前端启动后会动态拉取；
//     AI_ANALYSIS_TYPES 仅作为离线兜底（未登录 / 接口失败时）。
// ────────────────────────────────────────────────────────────

// AI 分析类型默认枚举（兜底，与后端 warnings.data_json.aiType 精确相等，Y2 方案）
export const AI_ANALYSIS_TYPES = [
  '堆头未覆盖', '道路扬尘', '秸秆燃烧', '违规排污',
  '固废与危废违规倾倒', '固废运输违规', '侵占岸线与水面漂浮物',
] as const
export type AiAnalysisType = typeof AI_ANALYSIS_TYPES[number]

// 一条推送规则（后台「AI分析存档 → 推送规则」配置）
export interface PushRule {
  id: string
  name: string
  channelSipId: string | null   // null = 全部通道（通配）
  aiTypes: string[]             // V2：多 AI 类型共用一套时间窗/阈值
  timeWindowHours: number       // 滚动窗口（小时）
  threshold: number             // 窗口内命中阈值（条）
  enabled: boolean
  channelName?: string          // 展示用映射名（前端按 channelSipId 解析）
}

// 告警列表中的聚合告警（命中规则后由后端折叠为 1 条）
export interface AggregateWarning {
  isAggregate: true
  ruleId: string
  channelSipId: string | null
  aiType: string
  channelName: string
  windowHours: number           // 命中的规则时间窗（前端展示用）
  count: number                 // 窗口内命中条数
  maxLevel: number              // 组内最高等级
  latestTime: string            // 组内最新记录时间
  memberIds: string[]           // 组内全部原始记录 id（标记处理时传后端）
  members: Array<{
    id: string
    picUrl?: string
    createdAt?: string
    level?: number
    aiConfidence?: number
    channelName?: string
  }>
}

const GROUP_COLORS: Record<VideoGroup, string> = {
  '无人机视频': '#ab47bc',
  '港口堆场':  '#00e676',
  '道路监控':  '#ffd740',
  '水体监控':  '#00bcd4',
  '重点企业':  '#ff7043',
}
export { GROUP_COLORS }

export type MapPointType = 'air' | 'water' | 'camera' | 'alert' | 'uav' | 'watermon'
export interface MapPoint {
  id: string
  type: MapPointType
  name: string
  lon: number
  lat: number
  [key: string]: unknown  // extra fields (aqi, pm25, ph, level, type, ...)
}

export interface MqttConfig {
  enabled: boolean
  mode: 'real' | 'mock'      // real=连接真实 broker；mock=本地模拟数据
  brokerUrl: string          // e.g. ws://192.168.1.100:8083/mqtt
  clientId: string
  username: string
  password: string
  topics: MqttTopic[]
}

export interface MqttTopic {
  id: string
  topic: string
  dataType: 'air_quality' | 'water_quality' | 'device_status' | 'alert' | 'custom'
  description: string
  enabled: boolean
}

export interface AlertFormatConfig {
  enabled: boolean
  // JSON field name mapping → AlertItem field
  fieldMap: {
    type: string         // e.g. "alarm_type"
    level: string        // e.g. "severity"  value 1-4
    location: string     // e.g. "site_name"
    deviceName: string   // e.g. "device_name"
    value: string        // e.g. "measured_value"
    standard: string     // e.g. "threshold"
    time: string         // e.g. "timestamp"
    lat: string
    lon: string
    licensePlate: string // e.g. "plate_no" — 仅道路扬尘事件携带，有值才显示
  }
  levelMap: Record<string, 1 | 2 | 3 | 4>  // e.g. { "info": 1, "warning": 2, "error": 3, "critical": 4 }
  typeMap: Record<string, string>           // raw value → 气体污染 / 水体污染 / 秸秆燃烧 / 道路扬尘 / 堆头未覆盖
  samplePayload: string
}

export interface ConnectionStatus {
  mqtt: 'connected' | 'disconnected' | 'connecting' | 'error'
  mqttLastMessage: string | null
  mqttMessageCount: number
  pushedAlerts: number
  streamCount: number
  onlineStreams: number
}

export interface AirQualityRecord {
  id: string
  station: string   // '周家坝' | '百安坝'
  date: string      // 'YYYY-MM-DD'
  hour: number      // 0-23
  aqi: number
  pm25: number
  pm10: number
  so2: number
  no2: number
  o3: number
  co: number
  pushedAt: string  // ISO timestamp
}

function seedAirQualityData(): AirQualityRecord[] {
  const records: AirQualityRecord[] = []
  const now = new Date()
  const bases: Record<string, { aqi: number; pm25: number; pm10: number; so2: number; no2: number; o3: number; co: number }> = {
    '周家坝': { aqi: 78, pm25: 22, pm10: 48, so2: 14, no2: 31, o3: 126, co: 0.9 },
    '百安坝': { aqi: 55, pm25: 15, pm10: 38, so2: 9,  no2: 22, o3: 88,  co: 0.7 },
  }
  const trafficPattern = [0.6, 0.55, 0.5, 0.52, 0.58, 0.72, 0.95, 1.18, 1.22, 1.08, 0.98, 0.92,
    0.88, 0.9, 0.95, 1.05, 1.12, 1.2, 1.15, 1.05, 0.95, 0.85, 0.75, 0.65]
  const o3Pattern = [0.45, 0.42, 0.40, 0.42, 0.50, 0.62, 0.75, 0.88, 1.0, 1.10, 1.18, 1.22,
    1.28, 1.30, 1.28, 1.22, 1.10, 0.95, 0.80, 0.68, 0.60, 0.55, 0.52, 0.48]
  for (const station of ['周家坝', '百安坝']) {
    const base = bases[station]
    for (let i = 23; i >= 0; i--) {
      const dt = new Date(now.getTime() - i * 3600000)
      const hour = dt.getHours()
      const date = dt.toISOString().slice(0, 10)
      const m = trafficPattern[hour]
      const mo3 = o3Pattern[hour]
      const jitter = () => 1 + (Math.random() - 0.5) * 0.12
      const pm25 = Math.round(base.pm25 * m * jitter())
      const pm10 = Math.round(base.pm10 * m * jitter())
      const so2 = Math.round(base.so2 * m * jitter())
      const no2 = Math.round(base.no2 * m * jitter())
      const o3 = Math.round(base.o3 * mo3 * jitter())
      const co = parseFloat((base.co * m * jitter()).toFixed(1))
      let aqi: number
      if (pm25 <= 35) aqi = Math.round(pm25 * 50 / 35)
      else if (pm25 <= 75) aqi = Math.round(50 + (pm25 - 35) * 50 / 40)
      else if (pm25 <= 115) aqi = Math.round(100 + (pm25 - 75) * 50 / 40)
      else aqi = Math.round(150 + (pm25 - 115) * 50 / 65)
      const pushedAt = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), hour, 5).toISOString()
      records.push({ id: `aq-seed-${station}-${date}-${hour}`, station, date, hour, aqi, pm25, pm10, so2, no2, o3, co, pushedAt })
    }
  }
  return records
}

// ────────────────────────────────────────────────────────────
// 视频流默认种子已移除：流配置统一由后端 /api/streams 从数据库(coll_streams)下发，
// 首启若无数据则由后端 DEFAULT_STREAMS 种子写入（不含任何明文密钥）。
// 早期前端硬编码的 DEFAULT_STREAMS（含明文 GB28181 secret）已删除，避免密钥进入源码。
// ────────────────────────────────────────────────────────────

const DEFAULT_MQTT: MqttConfig = {
  enabled: false,
  mode: 'mock',
  brokerUrl: 'ws://192.168.1.200:8083/mqtt',
  clientId: 'wanzhou-dashboard-' + Math.random().toString(36).slice(2, 8),
  username: 'admin',
  password: '',
  topics: [
    { id: 't1', topic: 'env/air_quality/+', dataType: 'air_quality', description: '大气质量数据', enabled: true },
    { id: 't2', topic: 'env/water_quality/+', dataType: 'water_quality', description: '水质数据', enabled: true },
    { id: 't3', topic: 'env/device_status', dataType: 'device_status', description: '设备在线状态', enabled: true },
    { id: 't4', topic: 'env/alerts/#', dataType: 'alert', description: '告警信息', enabled: true },
  ],
}

const DEFAULT_ALERT_FORMAT: AlertFormatConfig = {
  enabled: true,
  fieldMap: {
    type: 'alarm_type',
    level: 'severity',
    location: 'site_name',
    deviceName: 'device_name',
    value: 'measured_value',
    standard: 'threshold',
    time: 'timestamp',
    lat: 'latitude',
    lon: 'longitude',
    licensePlate: 'plate_no',
  },
  levelMap: { 'info': 1, 'warning': 2, 'moderate': 3, 'critical': 4, '1': 1, '2': 2, '3': 3, '4': 4 },
  typeMap: {
    'gas_pollution': '气体污染',
    'water_pollution': '水体污染',
    'straw_burning': '秸秆燃烧',
    'road_dust': '道路扬尘',
    'uncovered_stockpile': '堆头未覆盖',
  },
  samplePayload: JSON.stringify({
    alarm_type: "PM2.5超标",
    severity: "warning",
    site_name: "周家坝监测站",
    device_name: "大气监测仪-01",
    measured_value: "82 μg/m³",
    threshold: "75 μg/m³",
    timestamp: new Date().toTimeString().slice(0, 8),
    latitude: 30.857213,
    longitude: 108.380078,
  }, null, 2),
}

// ────────────────────────────────────────────────────────────
// Context
// ────────────────────────────────────────────────────────────

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : fallback
  } catch { return fallback }
}
function save<T>(key: string, v: T) {
  try { localStorage.setItem(key, JSON.stringify(v)) } catch {}
}

interface DashboardCtx {
  // Video streams
  videoStreams: VideoStream[]
  setVideoStreams: (streams: VideoStream[]) => void
  addStream: (s: Omit<VideoStream, 'id'>) => void
  updateStream: (id: string, patch: Partial<VideoStream>) => void
  deleteStream: (id: string) => void

  // Map points (大气站/水质站/污染源/告警/无人机/流域)
  mapPoints: MapPoint[]

  // MQTT
  mqttConfig: MqttConfig
  setMqttConfig: (cfg: MqttConfig) => void
  mqttStatus: ConnectionStatus['mqtt']
  simulateMqttConnect: () => void
  simulateMqttDisconnect: () => void

  // Alert format
  alertFormatConfig: AlertFormatConfig
  setAlertFormatConfig: (cfg: AlertFormatConfig) => void

  // Push alerts from admin or MQTT
  externalAlerts: AlertItem[]
  pushAlert: (raw: Record<string, unknown>) => void
  pushAlertDirect: (alert: Omit<AlertItem, 'id'>) => void
  clearExternalAlerts: () => void

  // IoT 视频分析通道实时触发状态（驱动地图摄像头图标告警）
  iotChannelStatus: { channels: Array<{ spid: string; name: string; streamId: string; lat: number | null; lon: number | null; alerting: boolean; lastEventAt: string; lastEventType: string }>; ttlMinutes: number }
  iotAlertingStreamIds: string[]   // 当前处于告警状态的视频流 id 列表

  // Air quality data
  airQualityData: AirQualityRecord[]
  pushAirQualityRecord: (rec: Omit<AirQualityRecord, 'id' | 'pushedAt'>) => void
  deleteAirQualityRecord: (id: string) => void
  clearAirQualityData: () => void

  // Connection status
  status: ConnectionStatus
  dataLog: DataLogEntry[]
  clearLog: () => void
}

export interface DataLogEntry {
  id: string
  time: string
  source: 'mqtt' | 'http' | 'manual'
  topic: string
  dataType: string
  payload: string
  status: 'ok' | 'error'
}

const Ctx = createContext<DashboardCtx | null>(null)

export function useDashboard() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useDashboard must be used within DashboardProvider')
  return c
}

export function DashboardProvider({ children }: { children: React.ReactNode }) {
  const [videoStreams, setVideoStreamsRaw] = useState<VideoStream[]>([])
  const [mapPoints, setMapPointsRaw] = useState<MapPoint[]>([])
  const [mqttConfig, setMqttConfigRaw] = useState<MqttConfig>(() => load('dsh:mqtt', DEFAULT_MQTT))
  const [alertFormatConfig, setAlertFormatConfigRaw] = useState<AlertFormatConfig>(() => load('dsh:alertfmt', DEFAULT_ALERT_FORMAT))
  const [airQualityData, setAirQualityDataRaw] = useState<AirQualityRecord[]>(() => {
    const stored = load<AirQualityRecord[]>('dsh:aqdata', [])
    return stored.length > 0 ? stored : seedAirQualityData()
  })
  const [externalAlerts, setExternalAlerts] = useState<AlertItem[]>([])
  const [iotChannelStatus, setIotChannelStatus] = useState<{ channels: Array<{ spid: string; name: string; streamId: string; lat: number | null; lon: number | null; alerting: boolean; lastEventAt: string; lastEventType: string }>; ttlMinutes: number }>({ channels: [], ttlMinutes: 30 })
  const [iotAlertingStreamIds, setIotAlertingStreamIds] = useState<string[]>([])
  const [mqttStatus, setMqttStatus] = useState<ConnectionStatus['mqtt']>('disconnected')
  const [mqttMsgCount, setMqttMsgCount] = useState(0)
  const [mqttLastMsg, setMqttLastMsg] = useState<string | null>(null)
  const [pushedCount, setPushedCount] = useState(0)
  const [dataLog, setDataLog] = useState<DataLogEntry[]>([])
  const simulTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mqttClientRef = useRef<MqttClient | null>(null)

  const setVideoStreams = useCallback((s: VideoStream[]) => {
    setVideoStreamsRaw(s)
  }, [])

  // Poll backend every 10s so all clients stay in sync
  useEffect(() => {
    const sync = () => authFetch('/api/streams')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (Array.isArray(data)) setVideoStreamsRaw(data) })
      .catch(() => {})
    sync()
    const t = setInterval(sync, 10000)
    return () => clearInterval(t)
  }, [])

  // Poll map points every 10s
  useEffect(() => {
    const sync = () => authFetch('/api/map-points')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (Array.isArray(data)) setMapPointsRaw(data) })
      .catch(() => {})
    sync()
    const t = setInterval(sync, 10000)
    return () => clearInterval(t)
  }, [])

  // 轮询后端预警，把市监测站采集触发的预警推送到前端实时告警
  const seenWarningIds = useRef<Set<string>>(new Set())
  const warningsInitialized = useRef(false)
  useEffect(() => {
    // 预警类型 → 告警等级（cross 跨阈值最重，growth5h 增长次之，fixed 固定值）
    const levelOf = (wt: string): 1 | 2 | 3 | 4 =>
      wt === 'cross' ? 3 : wt === 'growth5h' ? 2 : wt === 'fixed' ? 2 : 1
    const fmtTime = (iso: string) => {
      const d = new Date(iso)
      return isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 8)
    }
    const fmtFull = (iso: string, monitorTime: string) => {
      const d = new Date(iso)
      if (!isNaN(d.getTime())) {
        const mm = String(d.getMonth() + 1).padStart(2, '0')
        const dd = String(d.getDate()).padStart(2, '0')
        return `${mm}-${dd} ${d.toTimeString().slice(0, 8)}`
      }
      return (monitorTime || '').slice(5)  // 退回 monitorTime 的 MM-DD HH:mm:ss
    }
    const toAlert = (w: any): AlertItem => {
      // 聚合告警（命中推送规则后由后端折叠为 1 条）
      if (w.isAggregate) {
        const aggId = `agg-${w.ruleId}-${w.channelSipId || 'all'}-${w.aiType}`
        const lt = w.latestTime || ''
        return {
          id: aggId,
          time: lt.slice(11, 19),
          fullTime: lt.slice(5, 19) || lt,
          location: w.channelName || '全部通道',
          type: `AI视频分析 · ${w.aiType || '未知'}`,
          value: `${w.count || 0} 条`,
          standard: `阈值 ${w.threshold || 0} 条`,
          level: (Math.min(Math.max(w.maxLevel || 1, 1), 4)) as 1 | 2 | 3 | 4,
          lat: 30.84,
          lon: 108.40,
          isAggregate: true,
          ruleId: w.ruleId,
          ruleName: w.ruleName,
          aggregateChannelSipId: w.channelSipId,
          aggregateAiType: w.aiType,
          windowHours: w.windowHours,
          threshold: w.threshold,
          count: w.count,
          maxLevel: w.maxLevel,
          latestTime: w.latestTime,
          memberIds: w.memberIds,
          // 聚合卡片预览图：后端 lightweight 输出中已附带 previewPicUrl
          imageUrl: w.previewPicUrl ? `/api/iot-image?url=${encodeURIComponent(w.previewPicUrl)}` : undefined,
        }
      }
      // IoT 视频分析类告警：透传图片和 AI 字段
      const isIotVideo = w.warning_type === 'iot-video-analysis' || w.source === 'iotcloud'
      const base: AlertItem = {
        id: isIotVideo ? `iot-${w.recordId || w.id}` : `warn-${w.id}`,
        time: fmtTime(w.createdAt) || (w.monitorTime || '').slice(11, 19),
        fullTime: fmtFull(w.createdAt, w.monitorTime),
        location: w.location || w.pointName || '市监测站',
        type: w.type || `${w.name || w.code} ${w.warningLabel || ''}`.trim(),
        value: w.value || `${w.value ?? ''}${w.unit ? ' ' + w.unit : ''}`,
        standard: w.standard || (w.standardValue != null ? `${w.standardValue}${w.unit ? ' ' + w.unit : ''}` : (w.reason || '—')),
        level: w.level || levelOf(w.warningType),
        lat: typeof w.lat === 'number' ? w.lat : 30.84,
        lon: typeof w.lon === 'number' ? w.lon : 108.40,
      }
      // IoT 视频分析扩展字段
      if (isIotVideo) {
        base.imageUrl = w.picUrl ? `/api/iot-image?url=${encodeURIComponent(w.picUrl)}` : undefined
        base.aiType = w.aiType
        base.aiConfidence = w.aiConfidence
        if (!base.type.startsWith('AI视频')) base.type = `AI视频分析 · ${w.aiType || '未知'}`
      }
      return base
    }
    const pushOne = (w: any) => {
      const item = toAlert(w)
      seenWarningIds.current.add(item.id)
      setExternalAlerts(prev => {
        // 聚合告警：若已存在同 id，更新内容（count/latestTime 可能变化）；单条：去重
        const idx = prev.findIndex(a => a.id === item.id)
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = item
          return next
        }
        return [item, ...prev].slice(0, 50)
      })
      setPushedCount(n => n + 1)
    }
    const sync = () => authFetch('/api/warnings?limit=100&aggregate=1&lightweight=1')
      .then(r => r.ok ? r.json() : null)
      .then((data: any[]) => {
        if (!Array.isArray(data)) return
        if (!warningsInitialized.current) {
          warningsInitialized.current = true
          // 首次加载：回灌最近 10 条历史预警（旧→新顺序推，保证最新的在最前）
          const recent = data.slice(0, 10).reverse()
          for (const w of recent) pushOne(w)
          // 比这 10 条更早的也标记为已见，避免后续被当成新增
          data.forEach(w => { const id = w.isAggregate ? `agg-${w.ruleId}-${w.channelSipId || 'all'}-${w.aiType}` : w.id; if (id) seenWarningIds.current.add(id) })
          return
        }
        // 后续轮询：推送新增预警（旧→新顺序）；聚合告警每次更新（count 可能变化）
        const fresh = data.filter(w => {
          const id = w.isAggregate ? `agg-${w.ruleId}-${w.channelSipId || 'all'}-${w.aiType}` : w.id
          return id && !seenWarningIds.current.has(id)
        })
        for (const w of fresh.reverse()) pushOne(w)
        // 聚合告警：即使不是"新增"也要更新（count/latestTime 可能增长）
        const updatedAggs = data.filter(w => w.isAggregate && !fresh.includes(w))
        for (const w of updatedAggs) pushOne(w)
      })
      .catch(() => {})
    sync()
    const t = setInterval(sync, 10000)
    return () => clearInterval(t)
  }, [])

  // 轮询 IoT 视频分析通道实时触发状态（每 10s），驱动地图摄像头图标告警
  useEffect(() => {
    const sync = () => authFetch('/api/iot-analysis/status')
      .then(r => r.ok ? r.json() : null)
      .then((d: any) => {
        if (!d || !Array.isArray(d.channels)) return
        setIotChannelStatus({ channels: d.channels, ttlMinutes: d.ttlMinutes || 30 })
        setIotAlertingStreamIds(d.channels.filter((c: any) => c.alerting && c.streamId).map((c: any) => c.streamId))
      })
      .catch(() => {})
    sync()
    const t = setInterval(sync, 10000)
    return () => clearInterval(t)
  }, [])

  const setMqttConfig = useCallback((c: MqttConfig) => {
    setMqttConfigRaw(c)
    save('dsh:mqtt', c)
  }, [])

  const setAlertFormatConfig = useCallback((c: AlertFormatConfig) => {
    setAlertFormatConfigRaw(c)
    save('dsh:alertfmt', c)
  }, [])

  const pushAirQualityRecord = useCallback((rec: Omit<AirQualityRecord, 'id' | 'pushedAt'>) => {
    const newRec: AirQualityRecord = { ...rec, id: `aq-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, pushedAt: new Date().toISOString() }
    setAirQualityDataRaw(prev => {
      const next = [newRec, ...prev].slice(0, 2000)
      save('dsh:aqdata', next)
      return next
    })
  }, [])

  const deleteAirQualityRecord = useCallback((id: string) => {
    setAirQualityDataRaw(prev => {
      const next = prev.filter(r => r.id !== id)
      save('dsh:aqdata', next)
      return next
    })
  }, [])

  const clearAirQualityData = useCallback(() => {
    setAirQualityDataRaw([])
    save('dsh:aqdata', [])
  }, [])

  const addStream = useCallback((s: Omit<VideoStream, 'id'>) => {
    apiFetch('/api/streams', { method: 'POST', body: JSON.stringify(s) })
      .then((created: any) => { if (created) setVideoStreamsRaw(prev => [...prev, created]) })
      .catch((e: any) => console.error('添加视频流失败:', e?.error || e))
  }, [])

  const updateStream = useCallback((id: string, patch: Partial<VideoStream>) => {
    setVideoStreamsRaw(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s))
    apiFetch(`/api/streams/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
      .then((updated: any) => { if (updated && updated.id) setVideoStreamsRaw(prev => prev.map(s => s.id === id ? updated : s)) })
      .catch((e: any) => console.error('更新视频流失败:', e?.error || e))
  }, [])

  const deleteStream = useCallback((id: string) => {
    setVideoStreamsRaw(prev => prev.filter(s => s.id !== id))
    apiFetch(`/api/streams/${id}`, { method: 'DELETE' }).catch((e: any) => console.error('删除视频流失败:', e?.error || e))
  }, [])

  const addLog = useCallback((entry: Omit<DataLogEntry, 'id'>) => {
    setDataLog(prev => [{ ...entry, id: `log-${Date.now()}-${Math.random()}` }, ...prev].slice(0, 200))
  }, [])

  const pushAlertDirect = useCallback((alert: Omit<AlertItem, 'id'>) => {
    const item: AlertItem = { ...alert, id: `ext-${Date.now()}` }
    setExternalAlerts(prev => [item, ...prev].slice(0, 50))
    setPushedCount(n => n + 1)
    // 同步到后端智治推送系统（检查推送规则 → 可能触发城运中心推送）
    apiFetch('/api/smart-push/events', {
      method: 'POST',
      body: JSON.stringify({
        event_type: alert.type,
        location: alert.location,
        lat: alert.lat,
        lon: alert.lon,
        level: alert.level,
        value: alert.value,
        standard: alert.standard,
        image_url: alert.imageUrl,
        source: 'mqtt',
        raw_json: alert,
      }),
    }).catch(() => {}) // 静默失败，不影响前端告警展示
  }, [])

  const pushAlert = useCallback((raw: Record<string, unknown>) => {
    const fm = alertFormatConfig.fieldMap
    const lm = alertFormatConfig.levelMap
    const rawLevel = String(raw[fm.level] ?? '2')
    const level = lm[rawLevel] ?? lm[rawLevel.toLowerCase()] ?? 2

    const rawPlate = fm.licensePlate ? String(raw[fm.licensePlate] ?? '') : ''
    const alert: Omit<AlertItem, 'id'> = {
      type: String(raw[fm.type] ?? '未知告警'),
      level: level as 1 | 2 | 3 | 4,
      location: String(raw[fm.location] ?? '未知位置'),
      value: String(raw[fm.value] ?? '-'),
      standard: String(raw[fm.standard] ?? '-'),
      time: String(raw[fm.time] ?? new Date().toTimeString().slice(0, 8)),
      lat: Number(raw[fm.lat] ?? 30.8),
      lon: Number(raw[fm.lon] ?? 108.4),
      ...(rawPlate ? { licensePlate: rawPlate } : {}),
    }
    pushAlertDirect(alert)
    addLog({
      time: new Date().toTimeString().slice(0, 8),
      source: 'http',
      topic: 'alert/push',
      dataType: 'alert',
      payload: JSON.stringify(raw),
      status: 'ok',
    })
  }, [alertFormatConfig, pushAlertDirect, addLog])

  const clearExternalAlerts = useCallback(() => setExternalAlerts([]), [])
  const clearLog = useCallback(() => setDataLog([]), [])

  // 连接 MQTT：根据 mqttConfig.mode 选择真实连接或本地模拟
  const simulateMqttConnect = useCallback(() => {
    if (mqttConfig.mode === 'real') {
      connectRealMqtt()
    } else {
      connectMockMqtt()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mqttConfig])

  // 真实 MQTT 连接（浏览器走 WebSocket，broker 需开启 ws/wss，如 EMQX 8083/8084）
  const connectRealMqtt = useCallback(() => {
    // 先清理旧连接
    if (mqttClientRef.current) { try { mqttClientRef.current.end(true) } catch {} mqttClientRef.current = null }
    setMqttStatus('connecting')
    addLog({ time: new Date().toTimeString().slice(0, 8), source: 'mqtt', topic: 'system', dataType: 'system', payload: `正在连接 ${mqttConfig.brokerUrl}`, status: 'ok' })

    let client: MqttClient
    try {
      client = mqtt.connect(mqttConfig.brokerUrl, {
        clientId: mqttConfig.clientId,
        username: mqttConfig.username || undefined,
        password: mqttConfig.password || undefined,
        reconnectPeriod: 5000,   // 断线 5 秒重连
        connectTimeout: 8000,
        clean: true,
      })
    } catch (e: any) {
      setMqttStatus('error')
      addLog({ time: new Date().toTimeString().slice(0, 8), source: 'mqtt', topic: 'system', dataType: 'system', payload: 'MQTT 连接失败: ' + (e?.message || e), status: 'error' })
      return
    }
    mqttClientRef.current = client

    client.on('connect', () => {
      setMqttStatus('connected')
      addLog({ time: new Date().toTimeString().slice(0, 8), source: 'mqtt', topic: 'system', dataType: 'system', payload: '已连接到 MQTT Broker', status: 'ok' })
      // 订阅启用的 topic
      for (const t of mqttConfig.topics.filter(t => t.enabled)) {
        client.subscribe(t.topic, { qos: 0 }, (err) => {
          if (err) addLog({ time: new Date().toTimeString().slice(0, 8), source: 'mqtt', topic: t.topic, dataType: 'system', payload: '订阅失败: ' + err.message, status: 'error' })
        })
      }
    })

    client.on('reconnect', () => setMqttStatus('connecting'))
    client.on('error', (err) => {
      setMqttStatus('error')
      addLog({ time: new Date().toTimeString().slice(0, 8), source: 'mqtt', topic: 'system', dataType: 'system', payload: 'MQTT 错误: ' + (err?.message || err), status: 'error' })
    })
    client.on('close', () => { if (mqttClientRef.current) setMqttStatus('disconnected') })

    client.on('message', (topic, payloadBuf) => {
      const raw = payloadBuf.toString()
      // 匹配 topic 对应的数据类型（支持 + / # 通配）
      const matched = mqttConfig.topics.find(t => t.enabled && topicMatch(t.topic, topic))
      const dataType = matched?.dataType || 'custom'
      setMqttLastMsg(raw.slice(0, 80) + (raw.length > 80 ? '…' : ''))
      setMqttMsgCount(n => n + 1)
      addLog({ time: new Date().toTimeString().slice(0, 8), source: 'mqtt', topic, dataType, payload: raw, status: 'ok' })
      // 告警类型 → 解析并推送
      if (dataType === 'alert') {
        try { pushAlertDirect(JSON.parse(raw) as Omit<AlertItem, 'id'>) } catch {}
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mqttConfig, addLog, pushAlertDirect])

  // 本地模拟连接（无 broker 时演示用，定期产生模拟数据）
  const connectMockMqtt = useCallback(() => {
    setMqttStatus('connecting')
    setTimeout(() => {
      setMqttStatus('connected')
      addLog({ time: new Date().toTimeString().slice(0, 8), source: 'mqtt', topic: 'system', dataType: 'system', payload: '已连接到 MQTT Broker（模拟模式）', status: 'ok' })

      const tick = () => {
        const topics = mqttConfig.topics.filter(t => t.enabled)
        if (topics.length === 0) return
        const t = topics[Math.floor(Math.random() * topics.length)]
        const payload = generateMqttPayload(t.dataType)
        const msg: string = JSON.stringify(payload)
        setMqttLastMsg(msg.slice(0, 80) + (msg.length > 80 ? '…' : ''))
        setMqttMsgCount(n => n + 1)
        addLog({
          time: new Date().toTimeString().slice(0, 8),
          source: 'mqtt',
          topic: t.topic.replace('+', 'station1').replace('#', 'all'),
          dataType: t.dataType,
          payload: msg,
          status: 'ok',
        })
        if (t.dataType === 'alert') {
          pushAlertDirect(payload as Omit<AlertItem, 'id'>)
        }
        simulTimer.current = setTimeout(tick, 8000 + Math.random() * 10000)
      }
      simulTimer.current = setTimeout(tick, 2000)
    }, 1200)
  }, [mqttConfig, addLog, pushAlertDirect])

  const simulateMqttDisconnect = useCallback(() => {
    if (simulTimer.current) { clearTimeout(simulTimer.current); simulTimer.current = null }
    if (mqttClientRef.current) { try { mqttClientRef.current.end(true) } catch {} mqttClientRef.current = null }
    setMqttStatus('disconnected')
    addLog({ time: new Date().toTimeString().slice(0, 8), source: 'mqtt', topic: 'system', dataType: 'system', payload: '已断开 MQTT 连接', status: 'error' })
  }, [addLog])

  useEffect(() => () => {
    if (simulTimer.current) clearTimeout(simulTimer.current)
    if (mqttClientRef.current) { try { mqttClientRef.current.end(true) } catch {} }
  }, [])

  const onlineStreams = videoStreams.filter(s => !s.offline).length

  const status: ConnectionStatus = {
    mqtt: mqttStatus,
    mqttLastMessage: mqttLastMsg,
    mqttMessageCount: mqttMsgCount,
    pushedAlerts: pushedCount,
    streamCount: videoStreams.length,
    onlineStreams,
  }

  return (
    <Ctx.Provider value={{
      videoStreams, setVideoStreams, addStream, updateStream, deleteStream,
      mapPoints,
      mqttConfig, setMqttConfig, mqttStatus, simulateMqttConnect, simulateMqttDisconnect,
      alertFormatConfig, setAlertFormatConfig,
      externalAlerts, pushAlert, pushAlertDirect, clearExternalAlerts,
      iotChannelStatus, iotAlertingStreamIds,
      airQualityData, pushAirQualityRecord, deleteAirQualityRecord, clearAirQualityData,
      status, dataLog, clearLog,
    }}>
      {children}
    </Ctx.Provider>
  )
}

// MQTT topic 通配匹配：sub 可含 + (单层) 和 # (多层)，pub 为实际 topic
function topicMatch(sub: string, pub: string): boolean {
  if (sub === pub) return true
  const s = sub.split('/'), p = pub.split('/')
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '#') return true            // # 匹配剩余所有层
    if (s[i] === '+') { if (p[i] === undefined) return false; continue } // + 匹配单层
    if (s[i] !== p[i]) return false
  }
  return s.length === p.length
}

function generateMqttPayload(dataType: string): Record<string, unknown> {
  const rand = (a: number, b: number, d = 0) => +((Math.random() * (b - a) + a).toFixed(d))
  switch (dataType) {
    case 'air_quality':
      return { station: ['周家坝', '百安坝'][Math.floor(Math.random() * 2)], pm25: rand(10, 90), pm10: rand(30, 160), so2: rand(5, 65), no2: rand(15, 50), o3: rand(60, 180), co: rand(0.5, 2, 1), aqi: rand(40, 160), ts: Date.now() }
    case 'water_quality':
      return { station: '长江入库断面', ph: rand(7.0, 8.5, 1), do: rand(6, 10, 1), nh3: rand(0.1, 0.8, 2), tp: rand(0.02, 0.12, 2), cod: rand(2, 5, 1), ts: Date.now() }
    case 'device_status':
      return { total: 162, online: rand(150, 162), offline: rand(0, 12), rate: rand(92, 100, 1), ts: Date.now() }
    case 'alert':
      const types = ['PM2.5超标', 'NO₂超标', '扬尘超标 AI识别', '违规车辆 AI识别', '氨氮超标']
      const locs = ['周家坝监测站', '百安坝监测站', '万州港北堆场', '高笋塘路口', '龙头化工厂']
      return {
        type: types[Math.floor(Math.random() * types.length)],
        level: ([1, 2, 2, 3] as const)[Math.floor(Math.random() * 4)],
        location: locs[Math.floor(Math.random() * locs.length)],
        value: `${rand(0.3, 1.2, 2)} mg/m³`,
        standard: '0.30 mg/m³',
        time: new Date().toTimeString().slice(0, 8),
        lat: rand(30.72, 30.87, 4),
        lon: rand(108.35, 108.45, 4),
      }
    default:
      return { raw: true, ts: Date.now() }
  }
}
