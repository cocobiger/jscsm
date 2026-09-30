/**
 * 前端侧后端接口类型「单一出处」（P2 · 2026-09-14）
 *
 * 为什么有这个文件：
 *   2026-09-14 类型门禁诊断发现 15 个类型错误中 11 个来自「后端已改字段、前端类型没跟」
 *   （典型：`flv/bboxFlv`、`lat/lng`、`evalSet`、straw-engine status 的嵌套结构）。
 *   同一个接口的类型还曾在多个组件里各写一份（如 EngineStatus 在 StrawLivePage / StrawEnginePage 各一份，
 *   一份对一份错 → 直接造成 S0 面板数据全错）。
 *
 * 约定（重要）：
 *   1. 后端接口新增/改名字段时，**先改本文件**，再改调用方；不要在各组件里重复声明接口类型。
 *   2. 关键接口在开发期调用 checkShape() 做运行时字段体检，字段漂移会在 console 直接点名（生产环境静默）。
 *   3. 本文件只放「契约类型」，不放业务逻辑。
 */

// ─────────────────────────────────────────────────────────────
// 开发期字段体检（dev-only，生产静默；不抛错、不阻断）
// ─────────────────────────────────────────────────────────────
const DEV = (() => { try { return !!import.meta.env?.DEV } catch { return false } })()

/** 检查接口返回里是否缺少约定字段 / 是否多了未知字段（仅 dev 期 console 提示） */
export function checkShape(data: unknown, required: string[], label: string): void {
  if (!DEV || !data || typeof data !== 'object') return
  const keys = Object.keys(data as Record<string, unknown>)
  const missing = required.filter(k => !(k in (data as Record<string, unknown>)))
  if (missing.length) {
    console.warn(`[api-shape] ${label} 缺少约定字段: ${missing.join(', ')}（实际字段: ${keys.join(', ')}）`,
      '→ 若后端确实改了契约，请同步 src/app/lib/api-types.ts')
  }
}

// ─────────────────────────────────────────────────────────────
// ① 单机镜像状态 / OSD
//    后端：server/drone-events.js（stream-status 返回 hls/hls_rtc/flv/...）
// ─────────────────────────────────────────────────────────────
export interface DroneStreamStatus {
  ok: boolean
  deviceSn: string
  dockSn: string
  streamId: string
  online: boolean       // ZLM mirror（sikong_<SN>）是否在线
  hls: string           // 相对 HLS 播放地址（''=尚未接入）
  flv: string           // 相对 FLV 播放地址（2026-09-11 起**优先播放**：ZLM HLS/TS 转发会挂起，FLV 正常且延迟更低）
  bboxHls: string       // 带框流 HLS（straw_bbox_<SN>，实时标框；''=无带框流）
  bboxFlv: string       // 带框流 FLV（作 fallback；带框流 2s 抽帧 + 长 GOP，优先播会卡住弹窗）
  dockName: string      // 机场设备名（按 dockSn/deviceSn 匹配）
  width: number | null  // 视频分辨率宽（无视频 track 时 null）
  height: number | null // 视频分辨率高
  error?: string
}
export const DRONE_STREAM_REQUIRED = ['ok', 'deviceSn', 'streamId', 'online', 'hls', 'flv', 'bboxHls', 'bboxFlv']

/** SSE /api/drone-events/stream 广播载荷（drone-events.js 推送的 drone-live 事件） */
export interface DroneLiveEvent {
  type: 'drone-live'
  id: number
  on: number            // 1=LIVE_ON / 0=LIVE_OFF
  eventId: string
  deviceSn: string      // 无人机 SN（回传画面源）
  dockSn: string        // 机场 SN（dock）
  streamId: string      // sikong_<deviceSn>（我方 ZLM mirror）
  status: string        // LIVE_ON / LIVE_OFF
  changeReason?: string
  eventTime: string
  ts: number            // 服务器入库时间戳（ms）
  zlm_online: number    // 我方 ZLM mirror 是否已在线
  whitelisted: number   // 1=白名单命中已广播
}

// ─────────────────────────────────────────────────────────────
// ② 推理引擎状态 /api/straw-engine/status
//    后端：server/index.js（聚合 straw-engine /health + /metrics + 本地样本统计）
//    ⚠️ 结构是**嵌套**的：{ engine, metrics, sampleStats }，不是平铺
// ─────────────────────────────────────────────────────────────
export interface EngineWorker {
  running?: boolean
  detects?: number
  alerts?: number
  last_label?: string
  last_conf?: number
  last_ms?: number
}
/** straw-engine /health */
export interface EngineHealth {
  ok?: boolean
  model_version?: string
  model_path?: string
  model_nc?: number
  model_classes?: string[]
  model_input_size?: number
  model_format?: string
  resource?: { cpu_pct?: number; mem_pct?: number; mem_gb?: number }
  workers?: Record<string, EngineWorker>
  osd?: unknown
}
export interface EnginePerStream {
  running?: boolean
  detects?: number
  alerts?: number
  last_label?: string
  last_conf?: number
  infer_ms?: number
  report_latency_ms?: number
  last_report_ok?: boolean
}
/** straw-engine /metrics */
export interface EngineMetrics {
  version?: string
  workers?: number
  total_detects?: number
  total_alerts?: number
  models?: { day?: string; night?: string }
  per_stream?: Record<string, EnginePerStream>
}
export interface StrawEngineStatus {
  engine?: EngineHealth
  metrics?: EngineMetrics
  sampleStats?: { true?: number; false?: number; miss?: number }
}
export const STRAW_ENGINE_STATUS_REQUIRED = ['engine', 'metrics']

// ─────────────────────────────────────────────────────────────
// ③ 实时推理快照 /api/straw-engine/snapshot（straw-engine /debug/snapshot）
//    ⚠️ 流字段是 boxes（**没有** last_boxes）
// ─────────────────────────────────────────────────────────────
export interface SnapStream {
  running: boolean
  stream_ok: boolean
  frame_age_s: number | null
  detects: number
  alerts: number
  last_label: string
  last_conf: number
  infer_ms: number
  cfm: { hits: number; need: number; status: string; age_s: number | null }
  boxes: any[]          // 引擎侧检出框（历史代码误用 last_boxes，导致提示语恒错）
  snap: string          // 已叠加框的 JPEG data URL / 路径（''=尚未渲染）
}
export interface EngineSnapshot {
  ts?: number
  engine?: { cpu_pct?: number; mem_pct?: number; mem_gb?: number }
  streams?: Record<string, SnapStream>
}
export const ENGINE_SNAPSHOT_REQUIRED = ['streams']

// ─────────────────────────────────────────────────────────────
// ④ 复检 / 检测结果（straw_detections 表）
//    后端：server/review.js（/api/review/list、/api/straw/results，均 SELECT *）
// ─────────────────────────────────────────────────────────────
export interface DetBox { cls: number; conf: number; x1: number; y1: number; x2: number; y2: number }

export interface DetectionRow {
  id: number
  stream_id?: string
  ts?: string
  frame_path?: string
  boxes?: DetBox[]
  label?: string
  source?: string          // alert 检出告警 / low 检出低分 / picall 截图 / picall_random 随机·无检出
  max_conf?: number
  review_status?: string   // pending / true 真烟 / false 误报 / uncertain 稍后处理
  reviewer?: string
  reviewed_at?: string
  note?: string
  scene?: string           // dock 机场期 / sim 模拟流 / night 夜间 / day 白天 / urban 城区
  exclude?: number         // 1=人工「不纳入判例」（导出重训默认剔除）
  lat?: number             // DB 列 REAL，提交复检时可回填；当前多为空
  lng?: number
}

export interface StrawResultsStats {
  total?: number
  pending?: number
  trueCount?: number
  falseCount?: number
  push?: Record<string, number>
  streams?: string[]
  scenes?: { scene: string | null; c: number }[]
}
export interface StrawResultsResp {
  ok: boolean
  total?: number
  rows?: DetectionRow[]
  stats?: StrawResultsStats
  error?: string
}
export interface ReviewListResp {
  ok: boolean
  rows?: DetectionRow[]
  total?: number
  error?: string
}
export const DETECTION_LIST_REQUIRED = ['ok', 'rows']

// ─────────────────────────────────────────────────────────────
// ⑤ 算法调参注册表 /api/tune/algorithms（straw-engine/config/algorithms.json）
// ─────────────────────────────────────────────────────────────
export interface TuneParamDef {
  type: string
  range?: [number, number]
  step?: number
  options?: number[]
  default: number
  label: string
  group: string
  desc?: string
}
export interface TuneAlgorithm {
  name: string
  aiType: string
  desc?: string
  params: Record<string, TuneParamDef>
  fitness?: Record<string, number>
  evalSet?: string                  // 独立评估图集，如 evalsets/straw_fire/
  model?: string
  format?: string
  inputSize?: number
  useGpu?: boolean
  classes?: string[]
}
export const TUNE_ALGORITHMS_REQUIRED = ['ok', 'algorithms']

// ─────────────────────────────────────────────────────────────
// ⑥ 司空2 设备台账 /api/sikong/devices
//    后端：server/sikong.js fetchMergedDevices()（聚合 dji-openapi:17810 设备 + OSD 遥测）
//    ⚠️ 结构陷阱：items 每项是「机场(dock)」，**无人机在它的 drone 字段里**（不是无人机列表）。
//       统计无人机数必须 filter(i => i.drone?.droneSn)，不能 items.length。
//    口径（2026-09-16 后端统一）：KPI「无人机 N 架」= droneCount；「无人机机场 N 座」= dockCount。
// ─────────────────────────────────────────────────────────────
export interface SikongDrone {
  id?: string
  droneSn: string
  droneName?: string
  firmwareVersion?: string
  latitude?: number | null
  longitude?: number | null
  height?: number | null
  attitudeHead?: number | null
  osdTs?: string | null
}
export interface SikongDevice {
  id: string
  deviceSn: string            // 机场 SN（8UUXN 开头）
  deviceName: string
  latitude: number
  longitude: number
  height?: number | null
  drone?: SikongDrone | null  // 配对的无人机（含 droneSn/droneName）
  osd?: Record<string, unknown> | null  // 机场 OSD 实时遥测（droneInDock / droneCapacityPercent / windspeed …）
}
export interface SikongDevicesResp {
  ok: boolean
  upstreamOk?: boolean        // dji-openapi(17810) 是否正常应答；false = 链路降级（不等于"司空没有无人机"）
  degraded?: boolean          // = !upstreamOk，便于前端直读
  syncedAt: string | null
  count: number               // = dockCount（保留向后兼容）
  dockCount?: number          // 机场数（座）
  droneCount?: number         // 配对无人机数（架）—— KPI「无人机」取此值
  droneUnpaired?: number      // 有机场无无人机（异常，正常为 0）
  flyingCount?: number        // 在飞无人机数（osd.droneInDock===0）—— 副指标，会随飞行跳变
  dockedCount?: number        // 机场内待命（===1）
  osdMissingCount?: number    // 遥测未推送（osd 缺失或 droneInDock 非 0/1）—— 不得计入待命
  items: SikongDevice[]
  error?: string
}
export const SIKONG_DEVICES_REQUIRED = ['ok', 'upstreamOk', 'dockCount', 'droneCount', 'flyingCount', 'items']

// ─────────────────────────────────────────────────────────────
// ⑦ 监测站 /api/stations（后端：server/index.js）
//    统计条「监测站 N 座」= 本表行数；下钻用 stationName 与 map-points(type='air').name 前缀匹配
// ─────────────────────────────────────────────────────────────
export interface StationRow {
  id: string
  name?: string          // 全名，如「重庆市空气质量-周家坝」
  stationName?: string   // 短名，如「周家坝」
  lon: number
  lat: number
  enabled?: boolean | number
}

// ─────────────────────────────────────────────────────────────
// ⑧ 重点企业 /api/enterprises（后端：server/index.js）
//    统计条「重点企业 N 家」= 本表行数；location/contact 目前多为 null（台帐待补）
// ─────────────────────────────────────────────────────────────
export interface EnterpriseRow {
  id: number | string
  name?: string
  industry_type?: string | null
  location?: string | null
  contact?: string | null
  created_at?: string
  updated_at?: string
}
