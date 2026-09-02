import { useState, useEffect, useCallback, useRef } from 'react'
import type { AlertItem } from './AlertPanel'
import { apiFetch, authFetch } from '../lib/apiFetch'
import type { AggregateWarning } from '../context/DashboardContext'
import { AlertEvidenceModal } from './AlertEvidenceModal'
import { reviewBadgeOf, reviewBadgeStyle } from './warningReview'
import { playAlertChime, unlockAudioOnGesture } from '../lib/droneLive'

// T23: 新告警提示音持久化 key（与无人机弹窗 jsc:drone-popup-sound 解耦，独立开关）
const ALERT_SOUND_KEY = 'jsc:alert-sound'
function loadAlertSoundPref(): boolean {
  try { return localStorage.getItem(ALERT_SOUND_KEY) !== 'off' } catch { return true }
}
function saveAlertSoundPref(on: boolean) {
  try { localStorage.setItem(ALERT_SOUND_KEY, on ? 'on' : 'off') } catch {}
}

// T24: 弹窗主筛选/视图态会话保持（tab/等级/关键词/展开行）
//   独立 key jsc:alert-history-sess，避开 T15 导出筛选面板的 localStorage
//   sessionStorage（关闭浏览器即清空，不污染下次开机的初始视图）
//   容错：JSON.parse 失败 / 版本不兼容 → 丢弃旧值，落回默认
const ALERT_SESS_KEY = 'jsc:alert-history-sess'
const ALERT_SESS_VER = 1
type AlertSess = {
  v: number
  tab?: 'pending' | 'handled'
  levelFilter?: number
  keyword?: string
  expanded?: string[]   // Set → 序列化为数组
}
function loadAlertSess(): AlertSess {
  try {
    const raw = sessionStorage.getItem(ALERT_SESS_KEY)
    if (!raw) return { v: ALERT_SESS_VER }
    const p = JSON.parse(raw) as AlertSess
    if (!p || p.v !== ALERT_SESS_VER) return { v: ALERT_SESS_VER }
    return p
  } catch { return { v: ALERT_SESS_VER } }
}
function saveAlertSess(s: AlertSess) {
  try { sessionStorage.setItem(ALERT_SESS_KEY, JSON.stringify(s)) } catch {}
}

const LEVEL_COLORS: Record<number, { bg: string; border: string; text: string; label: string }> = {
  1: { bg: 'rgba(33,150,243,0.1)', border: 'rgba(33,150,243,0.4)', text: '#64b5f6', label: '注意' },
  2: { bg: 'rgba(255,215,64,0.1)', border: 'rgba(255,215,64,0.4)', text: '#ffd740', label: '轻度' },
  3: { bg: 'rgba(255,112,67,0.1)', border: 'rgba(255,112,67,0.4)', text: '#ff7043', label: '中度' },
  4: { bg: 'rgba(244,67,54,0.12)', border: 'rgba(244,67,54,0.5)', text: '#ff4444', label: '重度' },
}

const CYAN = '#00aaff'
const GREEN = '#00e676'

// 聚合事件展开后最多展示的图片数（其余仅以数字统计，降低前端图片加载负担）
const MAX_AGG_IMAGES = 10

interface Props {
  alerts: AlertItem[]  // 内存中的告警（含 AI识别等非采集类），作为补充
  onClose: () => void
}

const PLATE_TYPES = ['道路扬尘 AI识别', '违规车辆 AI识别']
const DUST_AI_TYPES = ['扬尘超标 AI识别']
function isPlateType(type: string) { return PLATE_TYPES.includes(type) }
function isDustAiType(type: string) { return DUST_AI_TYPES.includes(type) }

// 预警类型 → 等级
const levelOf = (wt: string): 1 | 2 | 3 | 4 => wt === 'cross' ? 3 : wt === 'growth5h' ? 2 : wt === 'fixed' ? 2 : 1

// 后端预警记录（含持久化的处理状态）
interface WarnRecord {
  id: string; createdAt: string; monitorTime?: string; pointName?: string
  code?: string; name?: string; value?: number; unit?: string; standardValue?: number
  warningType: string; warningLabel?: string; reason?: string
  status?: string; handledAt?: string; handledBy?: string
  lat?: number; lon?: number
  // T1/T2/T3: AI 视频/城运/秸秆类告警字段（后端 data_json 全量展开，历史无 source 时前端按特征推断）
  source?: string
  type?: string            // 展示类型（AI 类如 'AI视频分析 · 堆头未覆盖'）
  channelName?: string
  deviceName?: string
  standard?: string        // 限值/阈值描述字符串（AI 类 '阈值 ≥50%'）
  aiType?: string
  aiConfidence?: number
  channelSipId?: string
  picUrl?: string
  // T18: 误报归因（后端 data_json.review 平铺；兼容旧秸秆复检字符串语义；旧记录无此字段）
  review?: { verdict?: 'valid' | 'false' | 'miss'; note?: string; by?: string; at?: string } | string
}

// 统一的展示行结构
interface Row {
  kind: 'row'
  id: string; fullTime: string; sortKey: string
  level: 1 | 2 | 3 | 4; type: string; location: string
  value: string; standard: string; isPlate: boolean
  sourceKey: string | null  // T3: 来源标识键（SOURCE_META）
  handled: boolean; handledAt?: string; handledBy?: string
  backend: boolean  // 是否后端记录（可持久化处理）
  // T17: AI 视频单行证据大图查看（带图记录透传）
  picUrl?: string; aiType?: string; aiConfidence?: number
  // T18: 误报归因徽标（对象或秸秆复检字符串语义）
  review?: { verdict?: 'valid' | 'false' | 'miss'; note?: string; by?: string; at?: string } | string
}

// 聚合告警行（命中推送规则后折叠为 1 条）
interface AggRow {
  kind: 'aggregate'
  id: string; fullTime: string; sortKey: string
  level: number; handled: boolean; backend: boolean
  agg: AggregateWarning
}

function fmtFull(iso?: string, monitorTime?: string): string {
  if (iso) {
    const d = new Date(iso)
    if (!isNaN(d.getTime())) {
      const mm = String(d.getMonth() + 1).padStart(2, '0')
      const dd = String(d.getDate()).padStart(2, '0')
      return `${mm}-${dd} ${d.toTimeString().slice(0, 8)}`
    }
  }
  return (monitorTime || '').slice(5) || '—'
}

const LEVEL_FILTERS = [
  { key: 0, label: '全部等级' },
  { key: 4, label: '重度' },
  { key: 3, label: '中度' },
  { key: 2, label: '轻度' },
  { key: 1, label: '注意' },
]

// ── T3: 告警来源标识（data_json.source 枚举）──
const SOURCE_META: Record<string, { icon: string; label: string }> = {
  cq_api: { icon: '📊', label: '气体监测' },
  iotcloud: { icon: '📹', label: 'AI 视频分析' },
  'straw-engine': { icon: '🔥', label: '秸秆检测' },
  'chengyun-platform': { icon: '🏛️', label: '城运中心' },
}

// 后端记录无 source（历史气体告警）时按字段特征推断来源
function resolveSource(w: WarnRecord): string | null {
  if (w.source && SOURCE_META[w.source]) return w.source
  // 旧数据推断：带点位名/污染物代码/数值限值 → 气体监测（cq_api）
  if (w.pointName || w.code || w.standardValue != null) return 'cq_api'
  // 带 AI 通道/类型/图 → AI 视频分析（iotcloud）
  if (w.aiType || w.channelSipId || w.picUrl) return 'iotcloud'
  return null
}

export function AlertHistoryModal({ alerts, onClose }: Props) {
  // T24: 主筛选/视图态从 sessionStorage 恢复（tab/等级/关键词/展开行）
  const [tab, setTab] = useState<'pending' | 'handled'>(() => {
    const s = loadAlertSess()
    return s.tab === 'handled' ? 'handled' : 'pending'
  })
  const [records, setRecords] = useState<WarnRecord[]>([])
  const [aggregates, setAggregates] = useState<AggregateWarning[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = loadAlertSess()
    return new Set(Array.isArray(s.expanded) ? s.expanded : [])
  })
  const [loading, setLoading] = useState(true)
  const [levelFilter, setLevelFilter] = useState<number>(() => {
    const s = loadAlertSess()
    const n = Number(s.levelFilter)
    return Number.isFinite(n) && n >= 0 ? n : 0
  })
  const [keyword, setKeyword] = useState<string>(() => loadAlertSess().keyword || '')
  const [busy, setBusy] = useState(false)
  // T10/T11/T12: 轮询竞态守卫 / 操作结果 toast / 「全部标记处理」二次确认
  const seqRef = useRef(0)
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)
  // T15: 导出面板（时间范围/来源/状态/等级 多条件 → 服务端 /api/warnings/export）
  const [showExport, setShowExport] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [expRange, setExpRange] = useState<'all' | '7d' | '30d' | 'custom'>('all')
  const [expFrom, setExpFrom] = useState('')
  const [expTo, setExpTo] = useState('')
  const [expSources, setExpSources] = useState<string[]>([])
  const [expStatus, setExpStatus] = useState<'all' | 'pending' | 'handled'>('all')
  const [expLevels, setExpLevels] = useState<number[]>([])
  // T17: 聚合行「研判依据」弹窗（agg → AlertItem 适配后复用 AlertEvidenceModal）
  const [evidence, setEvidence] = useState<AlertItem | null>(null)
  // T17: 单行 AI 视频证据大图查看（轻量 viewer）
  const [viewImg, setViewImg] = useState<{ picUrl: string; time: string; type: string; location: string; confidence: number | null } | null>(null)
  // T23: 新告警提醒（弹窗内轮询 diff + WebAudio 提示音，开关持久化 jsc:alert-sound）
  const [soundOn, setSoundOn] = useState(loadAlertSoundPref)
  // T23: 上次轮询拉取的告警 id 集合，用于 diff 新告警；首轮 size=0 不触发（避免初始化误报）
  const prevIdsRef = useRef<Set<string>>(new Set())
  // T23: 解锁 AudioContext（首次用户手势后无需再调）；mount 时执行一次
  useEffect(() => { unlockAudioOnGesture() }, [])

  // ── T17: AggregateWarning → AlertItem 适配（聚合行「研判依据」入口复用 AlertEvidenceModal）──
  const aggToAlertItem = (a: AggregateWarning): AlertItem => ({
    id: `${a.ruleId}:${a.channelSipId ?? ''}:${a.aiType}`,
    time: a.latestTime,
    fullTime: fmtFull(a.latestTime),
    location: a.channelName || '未命名点位',
    type: `${a.aiType} 频发聚合`,
    value: `${a.count}+ 条`,
    standard: `${a.windowHours}h 时间窗`,
    level: (a.maxLevel as 1 | 2 | 3 | 4) || 1,
    lat: 0, lon: 0,
    isAggregate: true,
    ruleId: a.ruleId,
    ruleName: `${a.channelName || ''} ${a.aiType} 推送规则`.trim() || '聚合推送规则',
    aggregateAiType: a.aiType,
    windowHours: a.windowHours,
    count: a.count,
    maxLevel: a.maxLevel,
    latestTime: a.latestTime,
    memberIds: a.memberIds,
    status: 'pending',
  })

  // 拉取后端告警（聚合 + 平铺双请求合并）：
  //  - aggregate=1：命中推送规则的 pending 高频组折叠为聚合行（降噪）
  //  - 平铺全量：含已处理与气体等非聚合来源；剔除被折叠的成员记录，防与聚合行重复
  //  - isPolling: true 表示本次为 10s 轮询触发（与 alerts:refresh 触发的 silent load 区分，仅轮询做新告警 diff）
  const load = useCallback((silent = false, isPolling = false) => {
    const seq = ++seqRef.current
    if (!silent) setLoading(true)
    Promise.all([
      authFetch('/api/warnings?limit=500&aggregate=1').then(r => (r.ok ? r.json() : [])),
      authFetch('/api/warnings?limit=500').then(r => (r.ok ? r.json() : [])),
    ])
      .then(([aggList, flatList]: [any[], any[]]) => {
        if (seq !== seqRef.current) return  // 已有更新的请求在途，丢弃过期结果
        const aggs: AggregateWarning[] = Array.isArray(aggList) ? aggList.filter((x: any): x is AggregateWarning => x.isAggregate) : []
        const flat: any[] = Array.isArray(flatList) ? flatList : []
        const memberIds = new Set(aggs.flatMap(a => a.memberIds || []))
        setAggregates(aggs)
        setRecords(flat.filter(w => !memberIds.has(w.id)))
        setLoading(false)

        const curIds = new Set<string>()
        for (const a of aggs) curIds.add(`${a.ruleId}:${a.channelSipId ?? ''}:${a.aiType}`)
        for (const w of flat) if (w.status !== 'handled') curIds.add(w.id)
        if (isPolling) {
          const prev = prevIdsRef.current
          // prev.size > 0 守卫：避免首次轮询把全部存量当新告警
          if (prev.size > 0) {
            const newIds = [...curIds].filter(id => !prev.has(id))
            if (newIds.length > 0) {
              const firstAgg = aggs.find(a => newIds.includes(`${a.ruleId}:${a.channelSipId ?? ''}:${a.aiType}`))
              const firstFlat = flat.find(w => newIds.includes(w.id) && w.status !== 'handled')
              const summary = firstAgg
                ? `${firstAgg.channelName || '未命名'} · ${firstAgg.aiType || 'AI'} 频发 +${firstAgg.count}`
                : firstFlat
                  ? `${firstFlat.pointName || firstFlat.channelName || firstFlat.deviceName || '新告警'} · ${firstFlat.warningLabel || firstFlat.type || ''}`
                  : `${newIds.length} 条新告警到达`
              setToast({ msg: `🔔 ${summary}${newIds.length > 1 ? ` 等 ${newIds.length} 条` : ''}` })
              if (soundOn) playAlertChime()
            }
          }
        }
        prevIdsRef.current = curIds  // 每次拉取都更新 prev（首次 mount 也设，后续轮询才有 diff 基线）
      })
      .catch(() => { if (seq === seqRef.current) setLoading(false) })
  }, [soundOn])
  useEffect(() => { load() }, [load])

  // ── T16/T17: 订阅 alerts:refresh —— 处置后仅静默重拉自身列表（弹窗不关闭、无整页刷新）──
  useEffect(() => {
    const onRefresh = () => load(true)
    window.addEventListener('alerts:refresh', onRefresh as EventListener)
    return () => window.removeEventListener('alerts:refresh', onRefresh as EventListener)
  }, [load])

  // T10: 弹窗打开且停在「未处理」tab 时每 10s 静默轮询 → 新告警自动出现、处理状态自愈
  useEffect(() => {
    if (tab !== 'pending') return
    const timer = setInterval(() => load(true, true), 10000)  // T23: 第二参数 isPolling=true 启用新告警 diff
    return () => clearInterval(timer)
  }, [load, tab])

  // T24: 4 个主筛选/视图态变化即时写入 sessionStorage（关闭弹窗也保留，再开恢复）
  //   firstRun ref：跳过 mount 首次执行（避免无变化覆盖初始读到的有效会话）
  const sessFirstRun = useRef(true)
  useEffect(() => {
    if (sessFirstRun.current) { sessFirstRun.current = false; return }
    saveAlertSess({
      v: ALERT_SESS_VER,
      tab,
      levelFilter,
      keyword,
      expanded: [...expanded],
    })
  }, [tab, levelFilter, keyword, expanded])

  // toast 自动消失
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2800)
    return () => clearTimeout(t)
  }, [toast])

  // 后端预警 → Row
  const backendRows: Row[] = records.map(w => {
    const src = resolveSource(w)
    const isGas = src === 'cq_api'
    return {
      kind: 'row',
      id: w.id,
      fullTime: fmtFull(w.createdAt, w.monitorTime),
      sortKey: w.createdAt || w.monitorTime || '',
      level: levelOf(w.warningType),
      // T1: 类型兼容 AI 视频类（data_json.type 如 'AI视频分析 · 堆头未覆盖'）
      type: w.type || `${w.name || w.code || ''} ${w.warningLabel || ''}`.trim(),
      // T1: location 兼容 pointName（气体）/ channelName（AI 视频）；不再统一回退"市监测站"
      location: w.pointName || w.channelName || w.deviceName || (isGas ? '市监测站' : '未命名点位'),
      value: `${w.value ?? ''}${w.unit ? ' ' + w.unit : ''}`,
      // T2: standard 兼容数值 standardValue（气体）与字符串 standard（AI 类 '阈值 ≥50%'）
      standard: w.standardValue != null ? `${w.standardValue}${w.unit ? ' ' + w.unit : ''}` : (w.standard || w.reason || '—'),
      isPlate: false,
      sourceKey: src,
      handled: w.status === 'handled',
      handledAt: w.handledAt ? fmtFull(w.handledAt) : undefined,
      handledBy: w.handledBy,
      backend: true,
      // T17/T18: AI 视频证据图 + 误报归因（平铺透传，判空兼容旧记录）
      picUrl: w.picUrl,
      aiType: w.aiType,
      aiConfidence: w.aiConfidence,
      review: w.review || undefined,
    }
  })

  // 内存中的非后端告警（AI识别等），用 warn- 前缀去重，避免和后端重复
  const backendIdSet = new Set(records.map(w => `warn-${w.id}`))
  const memRows: Row[] = alerts
    .filter(a => !backendIdSet.has(a.id) && !a.id.startsWith('warn-'))
    .map(a => ({
      kind: 'row',
      id: a.id,
      fullTime: a.fullTime || a.time,
      sortKey: a.fullTime || a.time,
      level: a.level,
      type: a.type,
      location: a.location,
      value: a.value,
      standard: a.standard,
      isPlate: isPlateType(a.type) || isDustAiType(a.type),
      sourceKey: null,   // 内存告警无 source 字段，不显示来源图标
      handled: false,
      backend: false,
    }))

  // 聚合告警 → AggRow（命中推送规则后折叠为 1 条）
  const aggRows: AggRow[] = aggregates.map(a => ({
    kind: 'aggregate' as const,
    id: `${a.ruleId}:${a.channelSipId ?? ''}:${a.aiType}`,
    fullTime: fmtFull(a.latestTime),
    sortKey: a.latestTime || '',
    level: (a.maxLevel as 1 | 2 | 3 | 4) || 1,
    handled: false,
    backend: true,
    agg: a,
  }))

  let allRows = [...backendRows, ...memRows, ...aggRows].sort((a, b) => b.sortKey.localeCompare(a.sortKey))
  // 过滤前未处理总数（「全部标记处理」确认文案用，避免受等级/关键词筛选影响）
  const rawPending = allRows.filter(r => !r.handled).length
  // 筛选
  if (levelFilter) allRows = allRows.filter(r => r.level === levelFilter)
  if (keyword.trim()) {
    const k = keyword.trim().toLowerCase()
    allRows = allRows.filter(r => {
      if (r.kind === 'aggregate') return `${r.agg.channelName} ${r.agg.aiType}`.toLowerCase().includes(k)
      return `${r.type} ${r.location} ${r.value}`.toLowerCase().includes(k)
    })
  }
  const pending = allRows.filter(r => !r.handled)
  const handledList = allRows.filter(r => r.handled)
  const displayList = tab === 'pending' ? pending : handledList

  // 展开/收起聚合行的 drill-down
  const toggleExpand = (id: string) => setExpanded(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  // 聚合告警「标记处理」：组内全部原始记录置为已处理（T11: 成功后本地移除聚合行，不回拉全量）
  const handleGroup = async (row: AggRow) => {
    setBusy(true)
    try {
      const res = await apiFetch<{ ok?: boolean; handled?: number }>('/api/warnings/handle-group', {
        method: 'POST',
        body: JSON.stringify({ memberIds: row.agg.memberIds, handledBy: '值守人员' }),
      })
      // 成员记录本就被折叠、不在 records 中；移除聚合行即可（下一轮轮询后端已置 handled、不再折叠）
      setAggregates(prev => prev.filter(a => `${a.ruleId}:${a.channelSipId ?? ''}:${a.aiType}` !== row.id))
      const n = res?.handled ?? row.agg.memberIds.length
      setToast({ msg: `已处理 ${n} 条聚合告警` })
    } catch (e: any) {
      setToast({ msg: `操作失败：${e?.error || '网络错误'}`, err: true })
    } finally { setBusy(false) }
  }

  // 标记处理 / 撤销（T11 乐观更新：后端成功后本地翻转 status，行在未处理/已处理列表间即时迁移）
  // T16: 派发 refresh（single）让驾驶舱单条卡片同步；撤销传 status:'pending' 恢复
  const setStatus = async (row: Row, handled: boolean) => {
    if (!row.backend) return  // 内存告警（AI识别）无后端记录，跳过
    setBusy(true)
    try {
      await apiFetch(`/api/warnings/${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: handled ? 'handled' : 'pending', handledBy: '值守人员' }),
      })
      const nowIso = new Date().toISOString()
      setRecords(prev => prev.map(w => (w.id === row.id ? {
        ...w,
        status: handled ? 'handled' : 'pending',
        handledAt: handled ? nowIso : undefined,
        handledBy: handled ? '值守人员' : undefined,
      } : w)))
      setToast({ msg: handled ? '已标记处理' : '已撤销处理' })
      window.dispatchEvent(new CustomEvent('alerts:refresh', {
        detail: { kind: 'single', id: row.id, status: handled ? 'handled' : 'pending' },
      }))
    } catch (e: any) {
      setToast({ msg: `操作失败：${e?.error || '网络错误'}`, err: true })
    } finally { setBusy(false) }
  }

  // 「全部标记处理」确认后执行（T12 前置 confirm 弹层）
  const doHandleAll = async () => {
    setConfirmAll(false)
    setBusy(true)
    try {
      const res = await apiFetch<{ ok?: boolean; handled?: number }>('/api/warnings/handle-all', {
        method: 'POST',
        body: JSON.stringify({ handledBy: '值守人员' }),
      })
      const nowIso = new Date().toISOString()
      // 本地乐观更新：pending 全部置 handled + 聚合行清空（后端已全表置 handled）
      setRecords(prev => prev.map(w => (w.status === 'handled' ? w : { ...w, status: 'handled', handledAt: nowIso, handledBy: '值守人员' })))
      setAggregates([])
      const n = res?.handled
      setToast({ msg: typeof n === 'number' && n > 0 ? `已全部标记处理 ${n} 条` : '已全部标记处理' })
      window.dispatchEvent(new CustomEvent('alerts:refresh', { detail: { kind: 'all', status: 'handled' } }))
    } catch (e: any) {
      setToast({ msg: `操作失败：${e?.error || '网络错误'}`, err: true })
    } finally { setBusy(false) }
  }

  // T15: 导出 CSV（改调服务端 /api/warnings/export：可全量、按时间/来源/状态/等级过滤）
  const doExport = async () => {
    setExporting(true)
    try {
      const params = new URLSearchParams()
      if (expStatus !== 'all') params.set('status', expStatus)
      if (expSources.length) params.set('source', expSources.join(','))
      if (expLevels.length) params.set('level', expLevels.join(','))
      // 时间范围：全部 / 近7天 / 近30天 / 自定义（from 为空不传，服务端 to 可单边）
      if (expRange === '7d') params.set('from', new Date(Date.now() - 7 * 864e5).toISOString())
      else if (expRange === '30d') params.set('from', new Date(Date.now() - 30 * 864e5).toISOString())
      else if (expRange === 'custom') {
        if (expFrom) params.set('from', new Date(expFrom).toISOString())
        if (expTo) params.set('to', new Date(expTo).toISOString())
      }
      if (keyword.trim()) params.set('q', keyword.trim())
      const resp = await authFetch(`/api/warnings/export?${params.toString()}`)
      if (!resp.ok) {
        let msg = `导出失败 (HTTP ${resp.status})`
        try { const j = await resp.json(); if (j?.error) msg = j.error } catch {}
        setToast({ msg, err: true })
        return
      }
      const total = Number(resp.headers.get('X-Warnings-Total') || '0')
      const truncated = resp.headers.get('X-Warnings-Truncated') === '1'
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `告警记录_${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
      setShowExport(false)
      setToast({ msg: truncated ? `已导出前 ${total} 条（结果超 5 万，已截断，请缩小时间范围）` : `已导出 ${total} 条告警明细` })
    } catch (e: any) {
      setToast({ msg: `导出失败：${e?.error || '网络错误'}`, err: true })
    } finally {
      setExporting(false)
    }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(2,8,20,0.85)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        width: 920, maxWidth: '95vw', maxHeight: '88vh',
        background: 'linear-gradient(180deg, #040e25 0%, #030c1e 100%)',
        border: '1px solid rgba(255,68,68,0.25)', borderRadius: 6,
        boxShadow: '0 0 60px rgba(255,50,50,0.12), 0 0 20px rgba(0,120,255,0.1)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          height: 52, padding: '0 20px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderBottom: '1px solid rgba(255,68,68,0.2)',
          background: 'linear-gradient(90deg, rgba(255,68,68,0.07), transparent)', flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 3, height: 16, background: '#ff4444', borderRadius: 1 }} />
            <span style={{ color: '#c8e6ff', fontSize: 15, fontWeight: 600, letterSpacing: '0.05em' }}>告警记录</span>
            <span style={{ color: '#3a5a70', fontSize: 12 }}>（按时间倒序 · 实时同步后端）</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ color: '#3a5a70', fontSize: 12 }}>
              未处理 <span style={{ color: '#ff7043', fontFamily: "'JetBrains Mono', monospace" }}>{pending.length}</span>
              　已处理 <span style={{ color: GREEN, fontFamily: "'JetBrains Mono', monospace" }}>{handledList.length}</span>
            </span>
            {/* T23: 新告警提示音开关（localStorage jsc:alert-sound，默认开） */}
            <button
              onClick={() => { const next = !soundOn; setSoundOn(next); saveAlertSoundPref(next); if (next) playAlertChime() }}
              title={soundOn ? '关闭新告警提示音' : '开启新告警提示音'}
              style={{
                width: 28, height: 28, borderRadius: 4,
                border: `1px solid ${soundOn ? 'rgba(0,230,118,0.3)' : 'rgba(120,140,160,0.3)'}`,
                background: soundOn ? 'rgba(0,230,118,0.1)' : 'rgba(80,100,120,0.1)',
                color: soundOn ? GREEN : '#8aa0b0', cursor: 'pointer', fontSize: 14,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >{soundOn ? '🔔' : '🔕'}</button>
            <button onClick={onClose} style={{
              width: 28, height: 28, borderRadius: 4,
              border: '1px solid rgba(255,68,68,0.25)', background: 'rgba(255,68,68,0.1)',
              color: '#ff8080', cursor: 'pointer', fontSize: 14,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>✕</button>
          </div>
        </div>

        {/* Toolbar: tabs + filters */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px 0', borderBottom: '1px solid rgba(0,80,150,0.2)', flexShrink: 0, flexWrap: 'wrap' }}>
          {([['pending', '未处理'], ['handled', '已处理']] as const).map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)} style={{
              padding: '6px 18px', fontSize: 13, borderRadius: '3px 3px 0 0',
              border: `1px solid ${tab === key ? 'rgba(0,170,255,0.3)' : 'transparent'}`,
              borderBottom: tab === key ? '1px solid #030c1e' : '1px solid transparent',
              background: tab === key ? 'rgba(0,170,255,0.08)' : 'transparent',
              color: tab === key ? CYAN : '#5a8aaa', cursor: 'pointer',
              fontWeight: tab === key ? 600 : 400, marginBottom: -1,
            }}>
              {label}
              <span style={{ marginLeft: 6, fontSize: 11, color: tab === key ? (key === 'pending' ? '#ff7043' : GREEN) : '#3a5a70', fontFamily: "'JetBrains Mono', monospace" }}>
                {key === 'pending' ? pending.length : handledList.length}
              </span>
            </button>
          ))}
          <div style={{ flex: 1 }} />
          {/* 等级筛选 */}
          <select value={levelFilter} onChange={e => setLevelFilter(Number(e.target.value))} style={{
            padding: '5px 8px', background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.25)',
            borderRadius: 3, color: '#c8e6ff', fontSize: 12, outline: 'none', marginBottom: 6,
          }}>
            {LEVEL_FILTERS.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
          {/* 搜索 */}
          <input value={keyword} onChange={e => setKeyword(e.target.value)} placeholder="搜索类型/点位/数值" style={{
            padding: '5px 10px', width: 160, background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.25)',
            borderRadius: 3, color: '#c8e6ff', fontSize: 12, outline: 'none', marginBottom: 6,
          }} />
          <button onClick={() => setShowExport(true)} title="按时间范围/来源/状态/等级导出明细 CSV（可全量）" style={{
            padding: '5px 12px', fontSize: 12, borderRadius: 3, marginBottom: 6,
            border: '1px solid rgba(0,170,255,0.3)', background: 'rgba(0,170,255,0.08)', color: CYAN, cursor: 'pointer',
          }}>导出CSV</button>
        </div>

        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none', padding: '8px 16px 12px' }}>
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, color: '#3a5a70', fontSize: 13 }}>加载中…</div>
          ) : displayList.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, color: '#3a5a70', fontSize: 13 }}>
              暂无{tab === 'pending' ? '未处理' : '已处理'}告警
            </div>
          ) : (
            displayList.map((row, idx) => {
              // ── 聚合告警行（命中推送规则）──
              if (row.kind === 'aggregate') {
                const a = row.agg
                const style = LEVEL_COLORS[row.level] || LEVEL_COLORS[1]
                const isOpen = expanded.has(row.id)
                // 仅展示前 MAX_AGG_IMAGES 张图片；其余以数字统计（降低前端图片加载负担）
                const shownMembers = [...(a.members || [])]
                  .sort((x, y) => (y.createdAt || '').localeCompare(x.createdAt || ''))
                  .slice(0, MAX_AGG_IMAGES)
                const hiddenCount = (a.members?.length || 0) - shownMembers.length
                return (
                  <div key={row.id} style={{
                    margin: '4px 0', borderRadius: 4,
                    background: 'rgba(0,40,90,0.18)',
                    border: `1px solid ${style.border}`,
                    overflow: 'hidden',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 12px' }}>
                      <span style={{ width: 22, height: 22, borderRadius: 3, flexShrink: 0, background: 'rgba(0,50,100,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3a5a70', fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}>{idx + 1}</span>
                      <span style={{ padding: '2px 7px', borderRadius: 2, flexShrink: 0, background: style.border, color: style.text, fontSize: 11, fontWeight: 600 }}>{style.label}</span>
                      <span style={{ padding: '1px 6px', borderRadius: 2, flexShrink: 0, border: '1px solid rgba(0,170,255,0.3)', color: CYAN, fontSize: 10 }}>聚合</span>
                      <span style={{ color: '#5a8aaa', fontSize: 11, flexShrink: 0, fontFamily: "'JetBrains Mono', monospace", minWidth: 96 }}>{row.fullTime}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 600 }}>{a.channelName} 检测到 {a.aiType} 频发</div>
                        <div style={{ color: '#3a5a70', fontSize: 11 }}>{a.windowHours}h 内 {a.count}+ 条 · 共 {a.memberIds.length} 条命中</div>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        <button disabled={busy} onClick={() => handleGroup(row)} style={{
                          padding: '4px 12px', fontSize: 11, borderRadius: 3,
                          border: '1px solid rgba(0,230,118,0.35)', background: 'rgba(0,230,118,0.1)', color: GREEN,
                          cursor: busy ? 'wait' : 'pointer', whiteSpace: 'nowrap',
                        }}>标记处理</button>
                        {/* T17: 聚合行「研判依据」→ 复用 AlertEvidenceModal（可查看成员证据并有效/误报处置） */}
                        <button onClick={() => setEvidence(aggToAlertItem(a))} title="查看窗口内全部原始记录，支持有效/误报归因处置" style={{
                          padding: '4px 12px', fontSize: 11, borderRadius: 3,
                          border: '1px solid rgba(167,139,250,0.45)', background: 'rgba(124,58,237,0.14)', color: '#a78bfa',
                          cursor: 'pointer', whiteSpace: 'nowrap',
                        }}>🔍 研判依据</button>
                        <button onClick={() => toggleExpand(row.id)} style={{
                          padding: '4px 10px', fontSize: 11, borderRadius: 3,
                          border: '1px solid rgba(0,150,220,0.25)', background: 'rgba(0,100,180,0.1)', color: '#5a8aaa',
                          cursor: 'pointer', whiteSpace: 'nowrap',
                        }}>{isOpen ? '收起' : `展开(${a.memberIds.length})`}</button>
                      </div>
                    </div>
                    {isOpen && (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 8, padding: '10px 12px', borderTop: `1px solid ${style.border}`, background: 'rgba(0,15,40,0.35)' }}>
                        {shownMembers.map(m => (
                          <div key={m.id} style={{ borderRadius: 3, overflow: 'hidden', border: '1px solid rgba(0,120,200,0.2)', background: '#020a18' }}>
                            <div style={{ width: '100%', height: 64, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              {m.picUrl ? (
                                <img src={`/api/iot-image?url=${encodeURIComponent(m.picUrl)}`} alt={a.aiType} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                              ) : <span style={{ color: '#2a4a60', fontSize: 9 }}>无图</span>}
                            </div>
                            <div style={{ padding: '3px 5px', fontSize: 9, color: '#5a8aaa', fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {m.createdAt ? fmtFull(m.createdAt).slice(5) : '—'}
                            </div>
                          </div>
                        ))}
                        {hiddenCount > 0 && (
                          <div style={{ borderRadius: 3, overflow: 'hidden', border: '1px dashed rgba(0,150,220,0.3)', background: 'rgba(0,20,60,0.3)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 64, gap: 2 }}>
                            <span style={{ color: '#9ad6f0', fontSize: 16, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>+{hiddenCount}</span>
                            <span style={{ color: '#5a8aaa', fontSize: 9 }}>张以数字统计</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              }
              // ── 普通单行告警 ──
              const style = LEVEL_COLORS[row.level]
              return (
                <div key={row.id} style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '9px 12px', margin: '4px 0',
                  background: row.handled ? 'rgba(0,230,118,0.04)' : style.bg,
                  border: `1px solid ${row.handled ? 'rgba(0,230,118,0.15)' : style.border}`,
                  borderRadius: 3, opacity: row.handled ? 0.78 : 1, transition: 'all 0.2s',
                }}>
                  <span style={{ width: 22, height: 22, borderRadius: 3, flexShrink: 0, background: 'rgba(0,50,100,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3a5a70', fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}>{idx + 1}</span>
                  {row.sourceKey && SOURCE_META[row.sourceKey] && (
                    <span title={`来源：${SOURCE_META[row.sourceKey].label}`} style={{
                      width: 24, height: 22, borderRadius: 3, flexShrink: 0,
                      background: 'rgba(0,80,160,0.18)', border: '1px solid rgba(0,150,220,0.18)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12,
                    }}>{SOURCE_META[row.sourceKey].icon}</span>
                  )}
                  <span style={{ padding: '2px 7px', borderRadius: 2, flexShrink: 0, background: row.handled ? 'rgba(0,230,118,0.15)' : style.border, color: row.handled ? GREEN : style.text, fontSize: 11, fontWeight: 600 }}>{row.handled ? '已处理' : style.label}</span>
                  <span style={{ color: '#5a8aaa', fontSize: 11, flexShrink: 0, fontFamily: "'JetBrains Mono', monospace", minWidth: 96 }}>{row.fullTime}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      {row.type}
                      {!row.backend && <span style={{ color: '#3a5a70', fontSize: 10 }}>AI</span>}
                      {/* T18: 误报归因徽标（仅已处理行；对象 {verdict,note} 与秸秆复检字符串 'true'/'false'/'miss' 均兼容） */}
                      {row.handled && (() => {
                        const badge = reviewBadgeOf(row.review)
                        if (!badge) return null
                        const s = reviewBadgeStyle(badge.kind)
                        return (
                          <span title={badge.title} style={{
                            padding: '0 5px', fontSize: 10, borderRadius: 2, whiteSpace: 'nowrap',
                            border: `1px solid ${s.border}`, background: s.bg, color: s.color,
                          }}>{badge.text}</span>
                        )
                      })()}
                    </div>
                    <div style={{ color: '#5a8aaa', fontSize: 11 }}>{row.location}</div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0, minWidth: 120 }}>
                    <div style={{ color: row.handled ? GREEN : style.text, fontSize: 12, fontWeight: 600, fontFamily: row.isPlate ? "'JetBrains Mono', monospace" : 'inherit' }}>{row.value}</div>
                    <div style={{ color: '#3a5a70', fontSize: 11 }}>{row.isPlate ? row.standard : (/^(阈值|限值)\s/.test(row.standard) ? row.standard : `限值 ${row.standard}`)}</div>
                  </div>
                  {row.handled && row.handledAt && (
                    <div style={{ textAlign: 'right', flexShrink: 0, minWidth: 90 }}>
                      <div style={{ color: '#3a5a70', fontSize: 10 }}>处理时间</div>
                      <div style={{ color: GREEN, fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}>{row.handledAt}</div>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    {/* T17: AI 视频/秸秆类带图记录（含已处理）支持证据大图查看 */}
                    {row.picUrl && (
                      <button onClick={() => setViewImg({
                        picUrl: row.picUrl!, time: row.fullTime, type: row.type,
                        location: row.location, confidence: row.aiConfidence ?? null,
                      })} title="查看该条告警的现场证据大图" style={{
                        padding: '4px 10px', fontSize: 11, borderRadius: 3,
                        border: '1px solid rgba(0,170,255,0.3)', background: 'rgba(0,170,255,0.1)', color: CYAN,
                        cursor: 'pointer', whiteSpace: 'nowrap',
                      }}>证据</button>
                    )}
                    {row.backend ? (
                      <button disabled={busy} onClick={() => setStatus(row, !row.handled)} style={{
                        padding: '4px 12px', fontSize: 11, borderRadius: 3, flexShrink: 0,
                        border: `1px solid ${row.handled ? 'rgba(0,150,220,0.25)' : 'rgba(0,230,118,0.35)'}`,
                        background: row.handled ? 'rgba(0,100,180,0.1)' : 'rgba(0,230,118,0.1)',
                        color: row.handled ? '#5a8aaa' : GREEN, cursor: busy ? 'wait' : 'pointer', whiteSpace: 'nowrap',
                      }}>{row.handled ? '撤销处理' : '标记处理'}</button>
                    ) : (
                      <span style={{ flexShrink: 0, fontSize: 10, color: '#3a5a70', minWidth: 64, textAlign: 'center' }}>非采集类</span>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Footer */}
        <div style={{
          height: 44, padding: '0 20px', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderTop: '1px solid rgba(0,80,150,0.2)', background: 'rgba(0,20,50,0.3)',
        }}>
          <span style={{ color: '#3a5a70', fontSize: 11 }}>
            共 {allRows.length} 条　·　处理状态已同步后端，刷新/多端可见
          </span>
          {tab === 'pending' && pending.some(r => r.backend) && (
            <button disabled={busy} title="将后端全部未处理告警标记为已处理（需二次确认）" onClick={() => setConfirmAll(true)} style={{
              padding: '4px 14px', fontSize: 11, borderRadius: 3,
              border: '1px solid rgba(255,112,67,0.35)', background: 'rgba(255,112,67,0.08)',
              color: '#ffb27a', cursor: busy ? 'wait' : 'pointer',
            }}>全部标记处理</button>
          )}
        </div>
      </div>

      {/* T15: 导出设置面板（服务端流式导出：时间范围 / 来源 / 状态 / 等级） */}
      {showExport && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget && !exporting) setShowExport(false) }}>
          <div style={{ width: 460, maxWidth: '90vw', background: 'linear-gradient(180deg,#081a36,#050f24)', border: '1px solid rgba(0,170,255,0.35)', borderRadius: 6, padding: '16px 20px 14px', boxShadow: '0 0 40px rgba(0,120,255,0.15)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 15 }}>📤</span>
                <span style={{ color: '#c8e6ff', fontSize: 14, fontWeight: 600 }}>导出告警明细 CSV</span>
              </div>
              <button disabled={exporting} onClick={() => setShowExport(false)} style={{ width: 24, height: 24, borderRadius: 4, border: '1px solid rgba(120,160,200,0.25)', background: 'transparent', color: '#5a7a90', cursor: exporting ? 'wait' : 'pointer', fontSize: 12 }}>✕</button>
            </div>
            <div style={{ color: '#5a7a90', fontSize: 11, marginBottom: 12 }}>服务端全量导出（上限 5 万行）· 聚合组自动展开为成员明细 · 不受展示过滤规则影响</div>

            {/* 时间范围 */}
            <div style={{ marginBottom: 10 }}>
              <div style={{ color: '#7ab8e0', fontSize: 11, marginBottom: 4 }}>时间范围</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {([['all', '全部'], ['7d', '近7天'], ['30d', '近30天'], ['custom', '自定义']] as const).map(([key, label]) => (
                  <button key={key} onClick={() => setExpRange(key)} style={{
                    padding: '3px 12px', fontSize: 11, borderRadius: 3, cursor: 'pointer',
                    border: `1px solid ${expRange === key ? 'rgba(0,170,255,0.55)' : 'rgba(0,100,180,0.25)'}`,
                    background: expRange === key ? 'rgba(0,170,255,0.16)' : 'rgba(0,80,160,0.08)',
                    color: expRange === key ? CYAN : '#5a8aaa',
                  }}>{label}</button>
                ))}
              </div>
              {expRange === 'custom' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                  <input type="datetime-local" value={expFrom} onChange={e => setExpFrom(e.target.value)} style={{ padding: '4px 6px', background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3, color: '#c8e6ff', fontSize: 11, outline: 'none', colorScheme: 'dark' }} />
                  <span style={{ color: '#3a5a70', fontSize: 11 }}>至</span>
                  <input type="datetime-local" value={expTo} onChange={e => setExpTo(e.target.value)} style={{ padding: '4px 6px', background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3, color: '#c8e6ff', fontSize: 11, outline: 'none', colorScheme: 'dark' }} />
                </div>
              )}
            </div>

            {/* 来源 */}
            <div style={{ marginBottom: 10 }}>
              <div style={{ color: '#7ab8e0', fontSize: 11, marginBottom: 4 }}>
                来源 <span style={{ color: '#3a5a70', fontSize: 10 }}>（不选 = 全部）</span>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {Object.entries(SOURCE_META).map(([key, meta]) => {
                  const on = expSources.includes(key)
                  return (
                    <button key={key} onClick={() => setExpSources(prev => on ? prev.filter(s => s !== key) : [...prev, key])} style={{
                      padding: '3px 10px', fontSize: 11, borderRadius: 3, cursor: 'pointer',
                      border: `1px solid ${on ? 'rgba(0,230,118,0.5)' : 'rgba(0,100,180,0.25)'}`,
                      background: on ? 'rgba(0,230,118,0.12)' : 'rgba(0,80,160,0.08)',
                      color: on ? GREEN : '#5a8aaa',
                    }}>{meta.icon} {meta.label}</button>
                  )
                })}
              </div>
            </div>

            {/* 状态 + 等级 */}
            <div style={{ display: 'flex', gap: 18, marginBottom: 14 }}>
              <div>
                <div style={{ color: '#7ab8e0', fontSize: 11, marginBottom: 4 }}>处理状态</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {([['all', '全部'], ['pending', '未处理'], ['handled', '已处理']] as const).map(([key, label]) => (
                    <button key={key} onClick={() => setExpStatus(key)} style={{
                      padding: '3px 10px', fontSize: 11, borderRadius: 3, cursor: 'pointer',
                      border: `1px solid ${expStatus === key ? 'rgba(0,170,255,0.55)' : 'rgba(0,100,180,0.25)'}`,
                      background: expStatus === key ? 'rgba(0,170,255,0.16)' : 'rgba(0,80,160,0.08)',
                      color: expStatus === key ? CYAN : '#5a8aaa',
                    }}>{label}</button>
                  ))}
                </div>
              </div>
              <div>
                <div style={{ color: '#7ab8e0', fontSize: 11, marginBottom: 4 }}>
                  等级 <span style={{ color: '#3a5a70', fontSize: 10 }}>（不选 = 全部）</span>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {LEVEL_FILTERS.slice(1).map(f => {
                    const on = expLevels.includes(f.key)
                    return (
                      <button key={f.key} onClick={() => setExpLevels(prev => on ? prev.filter(l => l !== f.key) : [...prev, f.key])} style={{
                        padding: '3px 10px', fontSize: 11, borderRadius: 3, cursor: 'pointer',
                        border: `1px solid ${on ? 'rgba(255,180,90,0.55)' : 'rgba(0,100,180,0.25)'}`,
                        background: on ? 'rgba(255,170,60,0.14)' : 'rgba(0,80,160,0.08)',
                        color: on ? '#ffb27a' : '#5a8aaa',
                      }}>{f.label}</button>
                    )
                  })}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button disabled={exporting} onClick={() => setShowExport(false)} style={{
                padding: '5px 16px', fontSize: 12, borderRadius: 3, cursor: exporting ? 'wait' : 'pointer',
                border: '1px solid rgba(0,150,220,0.3)', background: 'rgba(0,100,180,0.12)', color: '#7ab8e0',
              }}>取消</button>
              <button disabled={exporting} onClick={doExport} style={{
                padding: '5px 18px', fontSize: 12, borderRadius: 3, cursor: exporting ? 'wait' : 'pointer',
                border: '1px solid rgba(0,170,255,0.6)', background: 'rgba(0,170,255,0.2)', color: '#b8e6ff', fontWeight: 600,
              }}>{exporting ? '导出中…' : '开始导出'}</button>
            </div>
          </div>
        </div>
      )}

      {/* T12: 「全部标记处理」二次确认弹层（误触保护） */}
      {confirmAll && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget) setConfirmAll(false) }}>
          <div style={{ width: 380, maxWidth: '88vw', background: 'linear-gradient(180deg,#081a36,#050f24)', border: '1px solid rgba(255,112,67,0.45)', borderRadius: 6, padding: '18px 20px 14px', boxShadow: '0 0 40px rgba(255,112,67,0.15)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 15 }}>⚠️</span>
              <span style={{ color: '#ffd740', fontSize: 14, fontWeight: 600 }}>全部标记处理</span>
            </div>
            <div style={{ color: '#9ec8e6', fontSize: 12, lineHeight: 1.8, margin: '12px 0 4px' }}>
              将把后端<b style={{ color: '#ff7043' }}>全部未处理告警</b>（含聚合组与列表外的历史记录）标记为「已处理」并同步各端。
            </div>
            <div style={{ color: '#5a7a90', fontSize: 11, marginBottom: 14 }}>
              当前列表未处理 <span style={{ color: '#ff7043', fontFamily: "'JetBrains Mono', monospace" }}>{rawPending}</span> 条 · 此操作不可批量撤销
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button disabled={busy} onClick={() => setConfirmAll(false)} style={{
                padding: '5px 16px', fontSize: 12, borderRadius: 3, cursor: busy ? 'wait' : 'pointer',
                border: '1px solid rgba(0,150,220,0.3)', background: 'rgba(0,100,180,0.12)', color: '#7ab8e0',
              }}>取消</button>
              <button disabled={busy} onClick={doHandleAll} style={{
                padding: '5px 16px', fontSize: 12, borderRadius: 3, cursor: busy ? 'wait' : 'pointer',
                border: '1px solid rgba(255,112,67,0.55)', background: 'rgba(255,112,67,0.18)', color: '#ffb27a', fontWeight: 600,
              }}>确认全部处理</button>
            </div>
          </div>
        </div>
      )}

      {/* T11: 操作结果轻量 toast（成功绿 / 失败红） */}
      {toast && (
        <div style={{
          position: 'fixed', left: '50%', bottom: 44, transform: 'translateX(-50%)', zIndex: 1200,
          padding: '7px 16px', borderRadius: 4, fontSize: 12, whiteSpace: 'nowrap',
          color: toast.err ? '#ffb0b0' : '#8dffce',
          background: toast.err ? 'rgba(90,15,15,0.92)' : 'rgba(0,55,30,0.92)',
          border: `1px solid ${toast.err ? 'rgba(255,90,90,0.5)' : 'rgba(0,230,118,0.4)'}`,
          boxShadow: '0 4px 20px rgba(0,0,0,0.45)',
        }}>
          {toast.err ? '⚠️ ' : '✅ '}{toast.msg}
        </div>
      )}

      {/* T17: 聚合行「研判依据」→ AlertEvidenceModal（zIndex 2000 天然盖过本弹窗 1000；处置后不关闭、经 alerts:refresh 同步） */}
      {evidence && (
        <AlertEvidenceModal
          alert={evidence}
          onClose={() => setEvidence(null)}
        />
      )}

      {/* T17: 单行 AI 视频证据大图查看（轻量 viewer，替代外链新窗口） */}
      {viewImg && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1500, background: 'rgba(2,6,16,0.9)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setViewImg(null)}>
          <div style={{ width: 720, maxWidth: '92vw', background: 'linear-gradient(180deg,#081a36,#050f24)', border: '1px solid rgba(0,170,255,0.3)', borderRadius: 6, overflow: 'hidden', boxShadow: '0 0 50px rgba(0,120,255,0.18)' }}
            onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid rgba(0,150,220,0.2)', background: 'rgba(0,170,255,0.06)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  📷 {viewImg.type} · {viewImg.location}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                {viewImg.confidence != null && (
                  <span style={{ color: '#ffd740', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
                    置信度 {(viewImg.confidence * 100).toFixed(0)}%
                  </span>
                )}
                <span style={{ color: '#5a8aaa', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>{viewImg.time}</span>
                <button onClick={() => setViewImg(null)} style={{
                  width: 26, height: 26, borderRadius: 4, cursor: 'pointer', fontSize: 13,
                  border: '1px solid rgba(120,160,200,0.25)', background: 'transparent', color: '#5a7a90',
                }}>✕</button>
              </div>
            </div>
            <div style={{ background: '#020a18', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 320, maxHeight: '72vh' }}>
              <img
                src={`/api/iot-image?url=${encodeURIComponent(viewImg.picUrl)}`}
                alt={viewImg.type}
                style={{ maxWidth: '100%', maxHeight: '72vh', objectFit: 'contain' }}
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).onerror = null
                  e.currentTarget.src = ''
                  e.currentTarget.style.display = 'none'
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
