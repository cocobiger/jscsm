import { useState, useEffect, useCallback, useMemo } from 'react'
import { apiFetch, authFetch } from '../../lib/apiFetch'
import { roleAtLeast, type CurrentUser } from '../../lib/auth'
// P0-1：统一时间格式化（上海时，兼容 ISO 串 / 本地串 / 时间戳）—— 全站唯一出处
import { fmtShanghai, fmtShanghaiDate } from '../../lib/time'
import { IotChannelManage } from './IotChannelManage'
import { AiTypeHealthPanel } from './AiTypeHealthPanel'
import { RoiEditor } from './RoiEditor'
// 批次4（2026-09-20）：堆头未覆盖链的「定时抓图 / 生效时段 / 帧来源 / 保留策略 / 逐路开关 / 门限」后台可调
import { StackChainPanel } from './StackChainPanel'
import { PrecapPanel } from './PrecapPanel'
import { ImgViewer } from './ImgViewer'   // P0-2：缩略图点开放大（复用项目现成查看器）
// 图片 URL 统一解析：只对绝对 http(s) 走 /api/iot-image 代理，/api/evidence/… 直连
// （后端旧版对相对路径也无条件套代理 → 必然 400 → 空蓝块；2026-09-20 修复归档页「看不到图」）
import { evidenceImgUrl } from '../../lib/evidenceImage'
import { AI_ANALYSIS_TYPES as DEFAULT_AI_TYPES, type PushRule } from '../../context/DashboardContext'

const CYAN = '#00aaff'
const GREEN = '#00e676'
const AMBER = '#ffd740'
const RED = '#ff4444'
const PURPLE = '#b388ff'

// 通用按钮样式（模块级，供 IotArchivePage 与 PushRulePanel 共用）
const btn = (color: string): React.CSSProperties => ({
  padding: '5px 12px', fontSize: 12, borderRadius: 3, border: `1px solid ${color}55`,
  background: `${color}15`, color, cursor: 'pointer',
})

interface IotRecord {
  id: string
  createdAt: string
  time: string
  fullTime: string
  aiType: string
  aiConfidence: number
  level: number
  imageUrl: string | null
  channelName: string
  deviceName: string
  // P0-4：通道名为空时（无人机记录）的可读兜底名 + 原始 streamId
  displayName?: string
  streamId?: string
  // P0-4 研判留痕（'admitted' 准入进前台 / 'blocked' 拦下仅存档 / 'legacy' 改造前存量 / '' 未知）
  judgeStatus?: string
  judgeReason?: string
  judgeRuleId?: string
  // 🔴 2026-09-26：车牌（「渣土车冒装/帽盖」判罚证据必备字段）。
  //   空串 = 该帧没抓到车牌（页面显示「车牌未获取」）；堆头未覆盖等链路不跑车牌，恒为空串。
  licensePlate?: string
  plateConfidence?: number | null
}

interface IotChannel {
  channelName: string
  spid: string
  deviceId: string
  streamId: string
  lat: number | null
  lon: number | null
  total: number
  latestAt: string
  records: IotRecord[]
}

interface StatusChannel {
  spid: string
  name: string
  streamId: string
  alerting: boolean
  lastEventAt: string
  lastEventType: string
}

const inputStyle: React.CSSProperties = {
  padding: '6px 10px', background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.25)',
  borderRadius: 3, color: '#c8e6ff', fontSize: 13, outline: 'none',
}

const LEVEL_LABEL = ['', '注意', '轻度', '中度', '重度']
// P0-4：研判结论徽标（存档页展示"这条到底进没进前台"）
const JUDGE_META: Record<string, { text: string; color: string }> = {
  admitted: { text: '准入', color: '#00e676' },
  blocked: { text: '拦下', color: '#ff9800' },
  legacy: { text: '历史', color: '#5a8aaa' },
}
// P0-4 存档表列宽（新增「车牌」列）：缩略图 | 通道 | AI类型 | 车牌 | 置信度 | 等级 | 研判 | 时间 | 坐标
const COLS = '64px 1.15fr 1.05fr 104px 68px 54px 58px 1.2fr 1.1fr'
// P1 研判列表列宽：名称|通道|AI类型|时间窗|阈值|门槛·动作|近7天|启用|操作
const RULE_COLS = '1.3fr 1fr 0.95fr 70px 70px 1.5fr 108px 58px 1fr'
/** P1：把规则的门槛与动作拼成一行紧凑文本（列表展示用） */
function gatesText(r: PushRule): string {
  const parts: string[] = []
  if (Number(r.minConfidence) > 0) parts.push(`置信度≥${r.minConfidence}%`)
  if (Number(r.minLevel) > 0) parts.push(`等级≥${r.minLevel}`)
  if (Number(r.minPlateConfidence) > 0) parts.push(`车牌置信度≥${r.minPlateConfidence}%`)
  if (r.activeHours) parts.push(`时段${r.activeHours}`)
  parts.push(r.action === 'archive_only' ? '仅存档' : (r.action === 'front_and_push' ? '进前台+推城运' : '进前台'))
  // 🆕 S5：把 ②③④ 三项开关也并进这一列（悬停看全）—— 让"谁配了什么"一眼可见
  const extra: string[] = []
  if (r.recordMinConfidence !== null && r.recordMinConfidence !== undefined) extra.push(`展示门槛≥${r.recordMinConfidence}%`)
  if (Number(r.exempt) === 1) extra.push('作业区豁免')
  if (r.reportEnabled === 1) extra.push('强制上报')
  else if (r.reportEnabled === 0) extra.push('不上报')
  return [parts.join(' · '), extra.join(' · ')].filter(Boolean).join(' ｜ ')
}
function confColor(c: number) { return c >= 0.7 ? RED : c >= 0.5 ? AMBER : c >= 0.3 ? '#ffd740' : '#64b5f6' }
function levelColor(l: number) { return ['', '#64b5f6', AMBER, '#ff7043', RED][l] || '#64b5f6' }

// 🔴 2026-09-26：「渣土车冒装/帽盖」＝直接判罚证据，**必须有车牌才算完整事件**。
//   业务口语叫「渣土车帽盖」，库里/网关叫「渣土车冒装」（同一条链 cover_det）。
//   两条命名都认，避免任一版本改名后车牌列静默失效。
const MUCK_COVER_NAMES = ['渣土车冒装', '渣土车帽盖']
function isMuckCoverType(aiType?: string): boolean {
  const s = aiType || ''
  return MUCK_COVER_NAMES.some(n => s.includes(n))
}
/** 车牌单元格 —— 有牌显示橙牌(+置信度)，渣土车冒装/帽盖无牌显示灰虚线「车牌未获取」，其余类型留「—」 */
function PlateCell({ rec }: { rec: IotRecord }) {
  if (isMuckCoverType(rec.aiType)) {
    if (rec.licensePlate) {
      return (
        <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5, minWidth: 0 }}>
          <span style={{
            padding: '1px 6px', borderRadius: 2, background: 'rgba(255,112,67,0.12)',
            border: '1px solid rgba(255,112,67,0.4)', color: '#ff7043',
            fontSize: 11, fontFamily: "'JetBrains Mono', monospace",
            letterSpacing: '0.06em', fontWeight: 700, whiteSpace: 'nowrap',
          }}>{rec.licensePlate}</span>
          {typeof rec.plateConfidence === 'number' && (
            <span style={{ color: '#4a6a80', fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}
              title="车牌识别置信度">{(rec.plateConfidence * 100).toFixed(0)}%</span>
          )}
        </span>
      )
    }
    return (
      <span style={{
        padding: '1px 6px', borderRadius: 2, background: 'rgba(120,140,160,0.10)',
        border: '1px dashed rgba(120,140,160,0.45)', color: '#7f96a8',
        fontSize: 11, whiteSpace: 'nowrap',
      }} title="该帧未能识别出车牌（车距远 / 角度偏 / 模糊 / 夜间）">车牌未获取</span>
    )
  }
  return <span style={{ color: '#2a4a60', fontSize: 11 }}>—</span>
}

interface Props {
  user: CurrentUser
}

export function IotArchivePage({ user }: Props) {
  const [channels, setChannels] = useState<IotChannel[]>([])
  const [statusMap, setStatusMap] = useState<Record<string, StatusChannel>>({})
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState('')
  const [channelFilter, setChannelFilter] = useState<string>('')   // '' = 全部
  const [typeFilter, setTypeFilter] = useState<string>('')         // '' = 全部
  // P0-4：按研判结论筛选（默认「全部」，管理排查时"只看被拦下的"最常用）
  const [judgeFilter, setJudgeFilter] = useState<string>('')       // '' | 'admitted' | 'blocked' | 'legacy'
  // P0-3：时间范围（**服务端过滤**，避免前端对 2.9 万条做本地过滤导致"卡片数与列表数不一致"）
  // 2026-09-20 需求：默认「近 7 天」（原为「全部时间」）—— 默认收窄可显著减少首屏服务端过滤量；
  //   用户仍可手动切到「全部时间/今天/近30天/自定义」，选项与语义均未变。
  const [rangeKey, setRangeKey] = useState<'all' | 'today' | '7d' | '30d' | 'custom'>('7d')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  // 日期一律按**上海时**计算（fmtShanghaiDate 内部 +8h 取 UTC 分量）
  const rangeParams = useMemo(() => {
    const today = fmtShanghaiDate(Date.now())
    const back = (n: number) => fmtShanghaiDate(Date.now() - n * 86400000)
    if (rangeKey === 'today') return { from: today, to: today }
    if (rangeKey === '7d') return { from: back(6), to: today }     // 含今天共 7 天
    if (rangeKey === '30d') return { from: back(29), to: today }
    if (rangeKey === 'custom') return { from: customFrom, to: customTo }
    return { from: '', to: '' }
  }, [rangeKey, customFrom, customTo])
  const rangeLabel = { all: '全部时间', today: '今天', '7d': '近 7 天', '30d': '近 30 天', custom: '自定义' }[rangeKey]

  // P0-2：大图查看器当前索引（指向 filtered 全量筛选结果，便于跨页翻看）
  const [viewerIdx, setViewerIdx] = useState<number | null>(null)
  const [keyword, setKeyword] = useState('')
  const [busy, setBusy] = useState(false)
  const [page, setPage] = useState(1)
  const PAGE_SIZE = 10
  const [jump, setJump] = useState('')
  const [tab, setTab] = useState<'archive' | 'channels' | 'rules'  | 'retention' | 'health' | 'roi' | 'stack' | 'precap' >('archive')
  const isAdmin = roleAtLeast(user.role, 'admin')

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3000) }

  const load = useCallback(() => {
    const qs = new URLSearchParams()
    if (rangeParams.from) qs.set('from', rangeParams.from)
    if (rangeParams.to) qs.set('to', rangeParams.to)
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    setLoading(true)
    Promise.all([
      apiFetch<{ channels: IotChannel[] }>(`/api/iot-analysis/archive${suffix}`).catch(() => ({ channels: [] })),
      apiFetch<{ channels: StatusChannel[] }>('/api/iot-analysis/status').catch(() => ({ channels: [] })),
    ]).then(([arc, st]) => {
      setChannels(Array.isArray(arc?.channels) ? arc.channels : [])
      const m: Record<string, StatusChannel> = {}
      for (const c of (st?.channels || [])) m[c.spid] = c
      setStatusMap(m)
      setLoading(false)
    }).catch(() => { setLoading(false); flash('加载失败') })
  }, [rangeParams.from, rangeParams.to])

  useEffect(() => {
    load()
    // 2026-09-20：15s → 60s。存档是**历史留档**、不是实时视图；且修复「SQL 预截断」后
    //   响应体从 70KB 涨到 ~3.6MB（接口带 weak ETag，未变化时走 304/0 字节，但服务端仍要
    //   扫表聚合 ~0.6s）。放宽到 60s 把服务端负载降到原来的 1/4。
    const t = setInterval(load, 60000)
    return () => clearInterval(t)
  }, [load])

  // 扁平化记录（带上通道坐标），按通道名→时间倒序排列（满足「按通道分类排列」）
  const allRows = useMemo(() => {
    const rows: Array<IotRecord & { lat: number | null; lon: number | null; spid: string }> = []
    for (const ch of channels) {
      for (const rec of ch.records) {
        // 图片地址归一（幂等）：后端只对绝对 http(s) 套代理；此处再兜一层，
        // 确保 /api/evidence/… 直连、旧式「代理包相对路径」被解回直链。
        rows.push({ ...rec, imageUrl: evidenceImgUrl(rec.imageUrl), lat: ch.lat, lon: ch.lon, spid: ch.spid })
      }
    }
    rows.sort((a, b) => {
      // 先按通道名分组，再按时间倒序
      if (a.channelName !== b.channelName) return a.channelName.localeCompare(b.channelName)
      return (b.createdAt || '').localeCompare(a.createdAt || '')
    })
    return rows
  }, [channels])

  const aiTypes = useMemo(() => Array.from(new Set(allRows.map(r => r.aiType).filter(Boolean))), [allRows])

  const filtered = useMemo(() => {
    let r = allRows
    if (channelFilter) r = r.filter(x => x.spid === channelFilter)
    if (typeFilter) r = r.filter(x => x.aiType === typeFilter)
    if (judgeFilter) r = r.filter(x => (x.judgeStatus || 'legacy') === judgeFilter)
    if (keyword.trim()) {
      const k = keyword.trim().toLowerCase()
      // 2026-09-26：关键字并入车牌 —— 拿到车牌后可"按车查档"（如搜「渝D99803」看该车全部记录）
      r = r.filter(x => `${x.channelName} ${x.displayName || ''} ${x.streamId || ''} ${x.aiType} ${x.deviceName} ${x.licensePlate || ''}`.toLowerCase().includes(k))
    }
    return r
  }, [allRows, channelFilter, typeFilter, judgeFilter, keyword])

  // 前端分页：每页 10 条
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(Math.max(1, page), totalPages)
  const pagedRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
  useEffect(() => { setPage(1); setViewerIdx(null) }, [channelFilter, typeFilter, judgeFilter, keyword])

  // P0-2：当前正在大图查看的记录（索引指向 filtered 全量筛选结果，可跨页翻看）
  const viewerRec = viewerIdx !== null ? (filtered[viewerIdx] || null) : null

  const alertingCount = channels.filter(c => statusMap[c.spid]?.alerting).length

  // 导出 CSV
  const exportCsv = () => {
    const head = ['通道', 'AI类型', '车牌', '置信度(%)', '等级', '研判结论', '研判原因', '时间', '坐标', '图片地址']
    const rows = filtered.map(r => [
      r.channelName, r.aiType,
      // 渣土车冒装/帽盖：有牌写牌、无牌写「车牌未获取」；其余类型留空（不产生误导）
      isMuckCoverType(r.aiType) ? (r.licensePlate || '车牌未获取') : '',
      String(Math.round(r.aiConfidence * 100)),
      LEVEL_LABEL[r.level] || '',
      (JUDGE_META[r.judgeStatus || 'legacy'] || JUDGE_META.legacy).text,
      r.judgeReason || '',
      fmtShanghai(r.fullTime) || r.time || '',
      (typeof r.lat === 'number' && typeof r.lon === 'number') ? `${r.lat},${r.lon}` : '',
      r.imageUrl || '',
    ])
    const csv = [head, ...rows].map(cols => cols.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `AI分析存档_${new Date().toISOString().slice(0, 10)}.csv`
    a.click(); URL.revokeObjectURL(url)
    flash('已导出 CSV')
  }

  // 模拟触发（演示：注入当前时间记录，使对应摄像头红闪；仅管理员）
  const simulate = async () => {
    const spid = channelFilter || channels[0]?.spid
    if (!spid) { flash('暂无通道'); return }
    setBusy(true)
    try {
      await apiFetch('/api/iot-analysis/simulate', { method: 'POST', body: JSON.stringify({ spid }) })
      flash('已模拟触发，驾驶舱对应摄像头将红闪 30 分钟')
      load()
    } catch (e: any) { flash('触发失败：' + (e?.error || e)) }
    finally { setBusy(false) }
  }

  // 模拟走完结案流程（验证 AI 置信度范围/均值变量）：注入 N 张 AI 图 → 聚合事件 → 推送 → 回执 → 结案 → 出 PDF
  const simulateClosure = async () => {
    const spid = channelFilter || channels[0]?.spid
    if (!spid) { flash('暂无通道'); return }
    setBusy(true)
    try {
      const data = await apiFetch('/api/iot-analysis/simulate-closure', { method: 'POST', body: JSON.stringify({ spid }) })
      const c = data.conf || {}
      const range = (c.min || c.max) ? `置信度 ${c.min}~${c.max}，均值 ${c.avg}（${c.count} 张）` : '置信度数据为空'
      flash(`已模拟结案流程：${data.imageCount} 张 AI 分析图，${range}，结案报告已生成`)
      if (data.reportUrl) {
        try {
          // 报告下载接口需鉴权；直接 window.open 不带 token 会被判未登录，
          // 故用 authFetch 带 token 取 blob 后本地打开
          const resp = await authFetch(data.reportUrl)
          if (resp.ok) {
            const blob = await resp.blob()
            const url = URL.createObjectURL(blob)
            window.open(url, '_blank')
            setTimeout(() => URL.revokeObjectURL(url), 60000)
          } else {
            flash('报告已生成，但打开失败（鉴权），可在对应 history 处重新下载')
          }
        } catch { flash('报告已生成，但打开失败，可在对应 history 处重新下载') }
      }
      load()
    } catch (e: any) { flash('模拟结案失败：' + (e?.error || e)) }
    finally { setBusy(false) }
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: 20, overflow: 'hidden' }}>
      {/* 子标签：存档记录 / 通道接入（仅 admin） */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexShrink: 0 }}>
        {([['archive', '存档记录'], ...(isAdmin ? [['health', '算法健康度'], ['channels', '通道接入'], ['rules', '事件研判逻辑'], ['retention', '保留策略'], ['roi', '电子围栏'], ['stack', '堆头链'], ['precap', '视频缓存']] : [])] as const).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key as 'archive' | 'channels' | 'rules'  | 'retention' | 'health' | 'roi' | 'stack' | 'precap' )} style={{
            padding: '6px 18px', fontSize: 13, borderRadius: 3,
            border: `1px solid ${tab === key ? 'rgba(0,170,255,0.35)' : 'rgba(0,120,200,0.2)'}`,
            background: tab === key ? 'rgba(0,170,255,0.1)' : 'transparent',
            color: tab === key ? CYAN : '#5a8aaa', cursor: 'pointer', fontWeight: tab === key ? 600 : 400,
          }}>{label}</button>
        ))}
        <div style={{ flex: 1 }} />
        <span style={{ color: '#3a5a70', fontSize: 11, alignSelf: 'center' }}>IoTCloud 视频分析 · 与驾驶舱摄像头地理坐标触发对应</span>
      </div>

      {tab === 'archive' ? (
      <>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <div style={{ color: '#c8e6ff', fontSize: 16, fontWeight: 600 }}>AI分析存档</div>
          <div style={{ color: '#3a5a70', fontSize: 12, marginTop: 3 }}>IoTCloud 视频分析记录 · 按通道分类归档 · 与驾驶舱摄像头地理坐标触发对应</div>
          <div style={{ color: '#2e5a80', fontSize: 11, marginTop: 3 }}>本页为外部 IoTCloud 通道分析记录；自研算法推理记录见「AI 检测复检」「算法调参」</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} style={btn(CYAN)}>刷新</button>
          <button onClick={exportCsv} style={btn(GREEN)}>导出CSV</button>
          {roleAtLeast(user.role, 'admin') && (
            <>
              <button disabled={busy} onClick={simulate} style={btn(AMBER)}>{busy ? '触发中…' : '模拟触发'}</button>
              <button disabled={busy} onClick={simulateClosure} style={btn(PURPLE)} title="注入多张 AI 分析图并模拟走完 推送→回执→结案→出PDF 全流程，验证 AI 置信度范围/均值变量">模拟走完结案流程</button>
            </>
          )}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', top: 80, right: 40, zIndex: 3000, background: 'rgba(0,40,80,0.95)', border: '1px solid rgba(0,150,220,0.3)', borderRadius: 6, padding: '10px 20px', color: CYAN, fontSize: 13 }}>
          {toast}
        </div>
      )}

      {/* 通道概览卡片 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10, marginBottom: 14, flexShrink: 0 }}>
        {channels.map(ch => {
          const st = statusMap[ch.spid]
          const alerting = !!st?.alerting
          const active = channelFilter === ch.spid
          return (
            <div
              key={ch.spid}
              onClick={() => setChannelFilter(active ? '' : ch.spid)}
              style={{
                cursor: 'pointer', borderRadius: 5, padding: '10px 12px',
                border: `1px solid ${active ? CYAN + '88' : alerting ? 'rgba(255,68,68,0.4)' : 'rgba(0,120,200,0.22)'}`,
                background: active ? 'rgba(0,170,255,0.1)' : alerting ? 'rgba(255,68,68,0.05)' : 'rgba(0,20,60,0.35)',
                transition: 'all 0.15s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: alerting ? RED : '#00bcd4', boxShadow: alerting ? `0 0 8px ${RED}` : 'none' }} />
                <span style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ch.channelName}</span>
                {alerting && <span style={{ fontSize: 10, color: '#ff8080' }}>告警中</span>}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#5a8aaa', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
                <span>记录 <span style={{ color: '#c8e6ff' }}>{ch.total}</span></span>
                <span>{ch.latestAt ? fmtShanghai(ch.latestAt, 'short') : '—'}</span>
              </div>
              <div style={{ color: '#3a5a70', fontSize: 10, marginTop: 3, fontFamily: "'JetBrains Mono', monospace" }}>
                {typeof ch.lat === 'number' ? `${ch.lat.toFixed(4)}, ${ch.lon?.toFixed(4)}` : '无坐标'}
              </div>
            </div>
          )
        })}
      </div>

      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexShrink: 0 }}>
        <select value={channelFilter} onChange={e => setChannelFilter(e.target.value)} style={inputStyle}>
          <option value="">全部通道</option>
          {channels.map(c => <option key={c.spid} value={c.spid}>{c.channelName}</option>)}
        </select>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={inputStyle}>
          <option value="">全部类型</option>
          {aiTypes.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <input value={keyword} onChange={e => setKeyword(e.target.value)} placeholder="搜索通道/类型/车牌/设备" style={{ ...inputStyle, width: 200 }} />
        {/* P0-4：研判结论筛选（"只看被拦下的"是排查降噪是否过头的主要入口） */}
        <select value={judgeFilter} onChange={e => setJudgeFilter(e.target.value)} style={inputStyle} title="研判结论：准入=进前台；拦下=仅存档">
          <option value="">全部研判结论</option>
          <option value="admitted">准入（进前台）</option>
          <option value="blocked">拦下（仅存档）</option>
          <option value="legacy">历史（改造前）</option>
        </select>
        {/* P0-3：时间范围（服务端过滤，按上海日计算） */}
        <select value={rangeKey} onChange={e => setRangeKey(e.target.value as typeof rangeKey)} style={inputStyle}
          title="时间范围（服务端过滤，按上海时间）">
          <option value="all">全部时间</option>
          <option value="today">今天</option>
          <option value="7d">近 7 天</option>
          <option value="30d">近 30 天</option>
          <option value="custom">自定义…</option>
        </select>
        {rangeKey === 'custom' && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} style={{ ...inputStyle, width: 148 }} title="开始日期（含，上海时）" />
            <span style={{ color: '#3a5a70', fontSize: 12 }}>→</span>
            <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} style={{ ...inputStyle, width: 148 }} title="结束日期（含，上海时）" />
          </span>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ color: '#3a5a70', fontSize: 12 }}>
          共 <span style={{ color: '#c8e6ff', fontFamily: "'JetBrains Mono', monospace" }}>{filtered.length}</span> 条
          　通道 <span style={{ color: CYAN, fontFamily: "'JetBrains Mono', monospace" }}>{channels.length}</span>
          　<span style={{ color: alertingCount ? RED : '#3a5a70' }}>告警中 {alertingCount}</span>
          　<span style={{ color: rangeKey === 'all' ? '#3a5a70' : CYAN }}>时间：{rangeLabel}</span>
          {rangeKey === 'custom' && rangeParams.from && rangeParams.to && (
            <span style={{ color: '#3a5a70' }}>（{rangeParams.from} ~ {rangeParams.to}）</span>
          )}
        </span>
      </div>

      {/* 记录表格 */}
      <div style={{ flex: 1, overflow: 'auto', border: '1px solid rgba(0,150,220,0.15)', borderRadius: 6 }}>
        <div style={{ display: 'grid', gridTemplateColumns: COLS, background: 'rgba(0,30,70,0.5)', padding: '8px 12px', fontSize: 11, color: '#3a5a70', fontWeight: 600, borderBottom: '1px solid rgba(0,150,220,0.15)', position: 'sticky', top: 0, zIndex: 2 }}>
          <span>缩略图</span><span>通道</span><span>AI类型</span>
          <span title="渣土车冒装/帽盖的判罚证据车牌；识别不到时显示「车牌未获取」">车牌</span>
          <span>置信度</span><span>等级</span>
          <span title="准入=研判通过·进驾驶舱前台实时告警；拦下=被研判拦下·仅存档">研判</span>
          <span>时间</span><span>坐标</span>
        </div>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, color: '#3a5a70', fontSize: 13 }}>加载中…</div>
        ) : filtered.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, color: '#3a5a70', fontSize: 13 }}>暂无 AI 分析记录</div>
        ) : (
          pagedRows.map((r, i) => (
            <div key={r.id} style={{
              display: 'grid', gridTemplateColumns: COLS,
              padding: '6px 12px', borderBottom: '1px solid rgba(0,80,150,0.12)',
              alignItems: 'center', fontSize: 12,
            }}>
              {/* P0-2：点缩略图开大图（放大复核）；有图才可点 */}
              <div
                onClick={r.imageUrl ? () => setViewerIdx((safePage - 1) * PAGE_SIZE + i) : undefined}
                title={r.imageUrl ? '点击放大查看（可 ←/→ 翻页）' : '无图片'}
                style={{
                  width: 52, height: 38, background: '#020a18', borderRadius: 3, overflow: 'hidden',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: r.imageUrl ? 'zoom-in' : 'default',
                  outline: r.imageUrl ? '1px solid rgba(0,170,255,0.25)' : 'none',
                }}>
                {r.imageUrl ? (
                  <img src={r.imageUrl} alt={r.aiType} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                ) : <span style={{ color: '#2a4a60', fontSize: 9 }}>无图</span>}
              </div>
              {/* P0-4：无人机记录没有通道名 → 回落到 机场名 / (模拟·测试流)；悬停显示原始 streamId
                  2026-09-20：服务端已不再返回「(模拟·测试流)」那张卡片（联调产物，业务无价值）；
                  需要复核它们时调 /api/iot-analysis/archive?includeSim=1 即可临时放回。 */}
              <span
                title={r.channelName || r.streamId || ''}
                style={{ color: r.channelName ? '#c8e6ff' : '#7f96a8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >{r.channelName || r.displayName || '—'}</span>
              <span style={{ color: '#9ad6f0' }}>{r.aiType || '—'}</span>
              {/* 车牌（2026-09-26）：渣土车冒装/帽盖的判罚证据；抓不到时显式提示「车牌未获取」 */}
              <PlateCell rec={r} />
              <span style={{ color: confColor(r.aiConfidence), fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>{Math.round(r.aiConfidence * 100)}%</span>
              <span style={{ padding: '1px 6px', borderRadius: 2, background: levelColor(r.level) + '22', color: levelColor(r.level), fontSize: 11, width: 'fit-content' }}>{LEVEL_LABEL[r.level] || '—'}</span>
              {/* P0-4：研判结论徽标（悬停显示判定原因，一眼看清"这条为什么没进前台"） */}
              {(() => {
                const jm = JUDGE_META[r.judgeStatus || 'legacy'] || JUDGE_META.legacy
                return (
                  <span
                    title={r.judgeReason || '无判定记录（改造前存量数据，视同准入）'}
                    style={{ padding: '1px 6px', borderRadius: 2, background: jm.color + '22', color: jm.color, fontSize: 11, width: 'fit-content', cursor: 'help' }}
                  >{jm.text}</span>
                )
              })()}
              <span title={fmtShanghai(r.fullTime)} style={{ color: '#5a8aaa', fontFamily: "'JetBrains Mono', monospace" }}>{fmtShanghai(r.fullTime, 'short') || r.time || '—'}</span>
              <span style={{ color: '#3a5a70', fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
                {typeof r.lat === 'number' && typeof r.lon === 'number' ? `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}` : '—'}
              </span>
            </div>
          ))
        )}
      </div>

      {/* 分页栏 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, flexShrink: 0 }}>
        <span style={{ color: '#3a5a70', fontSize: 12 }}>
          第 <span style={{ color: '#c8e6ff', fontFamily: "'JetBrains Mono', monospace" }}>{safePage}</span> / {totalPages} 页 · 每页 {PAGE_SIZE} 条 · 共 {filtered.length} 条
        </span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} style={btn(CYAN)}>上一页</button>
          <input
            value={jump}
            onChange={e => setJump(e.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const n = parseInt(jump)
                if (n >= 1 && n <= totalPages) setPage(n)
                setJump('')
              }
            }}
            placeholder="跳页"
            style={{ ...inputStyle, width: 56, fontSize: 12 }}
          />
          <button
            disabled={!jump}
            onClick={() => {
              const n = parseInt(jump)
              if (n >= 1 && n <= totalPages) setPage(n)
              setJump('')
            }}
            style={btn(CYAN)}
          >跳转</button>
          <button disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)} style={btn(CYAN)}>下一页</button>
        </div>
      </div>

      {/* Footer hint */}
      <div style={{ marginTop: 10, color: '#3a5a70', fontSize: 11, flexShrink: 0 }}>
        通道产生 AI 分析推送时，驾驶舱对应摄像头图标将红闪告警（30 分钟内有效）；点击上方通道卡片可筛选该通道记录。
      </div>

      {/* P0-2：大图查看器 —— 点缩略图打开，←/→ 沿当前筛选结果逐条翻看（复用项目现成 ImgViewer） */}
      {viewerRec && viewerRec.imageUrl && (
        <ImgViewer
          src={viewerRec.imageUrl}
          title={viewerRec.channelName || viewerRec.displayName || 'AI 分析记录'}
          subtitle={`${viewerRec.aiType || '—'} · 置信度 ${Math.round((viewerRec.aiConfidence || 0) * 100)}%` +
            (isMuckCoverType(viewerRec.aiType) ? ` · 车牌 ${viewerRec.licensePlate || '车牌未获取'}` : '') +
            ` · ${LEVEL_LABEL[viewerRec.level] || '—'}` +
            ` · 研判${(JUDGE_META[viewerRec.judgeStatus || 'legacy'] || JUDGE_META.legacy).text}` +
            ` · ${fmtShanghai(viewerRec.fullTime)}`}
          index={viewerIdx !== null ? viewerIdx + 1 : undefined}
          total={filtered.length}
          onPrev={viewerIdx !== null && viewerIdx > 0 ? () => setViewerIdx(v => Math.max(0, (v ?? 0) - 1)) : undefined}
          onNext={viewerIdx !== null && viewerIdx < filtered.length - 1 ? () => setViewerIdx(v => Math.min(filtered.length - 1, (v ?? 0) + 1)) : undefined}
          onClose={() => setViewerIdx(null)}
        />
      )}
      </>
      ) : (
        tab === 'health' ? <AiTypeHealthPanel />
          : tab === 'roi' ? <RoiEditor user={user} />
          : tab === 'stack' ? <StackChainPanel user={user} />
          : tab === 'precap' ? <PrecapPanel user={user} />
          : tab === 'channels' ? <IotChannelManage user={user} />
          : tab === 'retention' ? <AlgoRetentionPanel />
          : <PushRulePanel user={user} />
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────
// AI 分析事件研判逻辑管理（降噪配置面板）
// ────────────────────────────────────────────────────────────
function PushRulePanel({ user }: { user: CurrentUser }) {
  const isAdmin = roleAtLeast(user.role, 'admin')
  const [rules, setRules] = useState<PushRule[]>([])
  const [channels, setChannels] = useState<Array<{ channelSipId: string; channelName: string; aiTypes?: string[] }>>([])
  const [aiTypes, setAiTypes] = useState<string[]>([...DEFAULT_AI_TYPES])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState('')
  const [editing, setEditing] = useState<string | null>(null)   // 正在编辑的研判 id；null = 新建
  const [formOpen, setFormOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<{
    name: string; channelSipId: string; aiTypes: string[]; timeWindowHours: number; threshold: number; enabled: boolean
    // P1-1 / P1-2
    minConfidence: number; minLevel: number; minPlateConfidence: number; activeHours: string; action: 'admit_front' | 'front_and_push' | 'archive_only'
    // 🆕 S1：3 个可空字段（null＝未设置＝现行为）
    recordMinConfidence: number | null; exempt: number | null; reportEnabled: number | null
  }>({
    name: '', channelSipId: '', aiTypes: [DEFAULT_AI_TYPES[0]], timeWindowHours: 24, threshold: 20, enabled: true,
    minConfidence: 0, minLevel: 0, minPlateConfidence: 0, activeHours: '', action: 'admit_front',
    recordMinConfidence: null, exempt: null, reportEnabled: null,
  })
  const [newType, setNewType] = useState('')
  // P0-3：研判默认策略（未命中任何规则时 放行/拦截）+ 覆盖面（近 7 天实际发生但未被规则覆盖的组合）
  const [policy, setPolicy] = useState<'admit' | 'block'>('admit')
  const [coverage, setCoverage] = useState<{ days: number; comboCount: number; coveredCount: number; uncovered: Array<{ channelName: string; aiType: string; count: number }> } | null>(null)
  const [showUncovered, setShowUncovered] = useState(false)
  // P1-4：试跑结果（规则草案的历史回放预演）
  const [dryRun, setDryRun] = useState<{ matched: number; admitted: number; blocked: number; admitRate: number; topReasons: Array<{ reason: string; count: number }> } | null>(null)
  // P1-3：命中统计（阈值调优依据）
  const [stats, setStats] = useState<{ days: number; total: number; admitted: number; blocked: number; admitRate: number; noRule: { total: number }; rules: Array<{ ruleId: string; ruleName: string; admitted: number; blocked: number; total: number; admitRate: number }> } | null>(null)
  const [showStats, setShowStats] = useState(false)
  // P2：规则冲突（同一「通道×算法」被多条同层规则覆盖 → 后者静默失效）
  const [conflicts, setConflicts] = useState<{ count: number; conflicts: Array<{ channelName: string; aiType: string; layer: string; winner: { name: string }; shadowed: Array<{ name: string }> }> } | null>(null)
  const [showConflicts, setShowConflicts] = useState(false)

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3000) }

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([
      apiFetch<PushRule[]>('/api/push-rules').catch(() => []),
      apiFetch<Array<{ channelSipId: string; channelName: string }>>('/api/iot-channels').catch(() => []),
      apiFetch<Array<{ name: string }>>('/api/ai-types').catch(() => []),
      apiFetch<{ policy: 'admit' | 'block'; coverage: any }>('/api/judge-policy?days=7').catch(() => null),
      apiFetch<any>('/api/judge-stats?days=7').catch(() => null),
      apiFetch<any>('/api/judge-conflicts').catch(() => null),
    ]).then(([rs, chs, ats, pol, st, cf]) => {
      setRules(Array.isArray(rs) ? rs : [])
      setChannels(Array.isArray(chs) ? chs : [])
      if (Array.isArray(ats) && ats.length > 0) setAiTypes(ats.map(x => x.name))
      if (pol) { setPolicy(pol.policy === 'block' ? 'block' : 'admit'); setCoverage(pol.coverage || null) }
      if (st && typeof st.total === 'number') setStats(st)
      if (cf) setConflicts(cf)
      setLoading(false)
    }).catch(() => { setLoading(false); flash('加载失败') })
  }, [])

  useEffect(() => { load() }, [load])

  // spid → 映射名
  const chNameMap = useMemo(() => {
    const m: Record<string, string> = {}
    for (const c of channels) m[c.channelSipId] = c.channelName
    return m
  }, [channels])

  // P1-3：规则 id → 近 7 天命中统计（列表里直接显示每条规则拦了多少）
  // P2：当前表单所选通道**已接入的算法**（用于一致性校验：选了通道没配的算法 = 永不命中）
  const selectedChannelAiTypes = useMemo(() => {
    if (!form.channelSipId) return null            // 通配通道 → 不做校验
    const ch = channels.find(c => c.channelSipId === form.channelSipId)
    return ch ? (ch.aiTypes || []) : null
  }, [channels, form.channelSipId])

  const statsByRule = useMemo(() => {
    const m: Record<string, { admitted: number; blocked: number; total: number; admitRate: number }> = {}
    for (const s of (stats?.rules || [])) m[s.ruleId] = s
    return m
  }, [stats])

  const openCreate = () => {
    setEditing(null)
    setForm({
      name: '', channelSipId: '', aiTypes: aiTypes.slice(0, 1), timeWindowHours: 24, threshold: 20, enabled: true,
      minConfidence: 0, minLevel: 0, minPlateConfidence: 0, activeHours: '', action: 'admit_front',
      recordMinConfidence: null, exempt: null, reportEnabled: null,
    })
    setDryRun(null)
    setFormOpen(true)
  }
  const openEdit = (r: PushRule) => {
    setEditing(r.id)
    setForm({
      name: r.name,
      channelSipId: r.channelSipId || '',
      aiTypes: r.aiTypes?.length ? r.aiTypes : aiTypes.slice(0, 1),
      timeWindowHours: r.timeWindowHours,
      threshold: r.threshold,
      enabled: r.enabled,
      minConfidence: Number(r.minConfidence) || 0,
      minLevel: Number(r.minLevel) || 0,
      minPlateConfidence: Number(r.minPlateConfidence) || 0,
      activeHours: r.activeHours || '',
      action: r.action === 'archive_only' ? 'archive_only' : (r.action === 'front_and_push' ? 'front_and_push' : 'admit_front'),
      recordMinConfidence: r.recordMinConfidence ?? null,
      exempt: r.exempt ?? null,
      reportEnabled: r.reportEnabled ?? null,
    })
    setDryRun(null)
    setFormOpen(true)
  }
  const closeForm = () => { setFormOpen(false); setEditing(null); setDryRun(null) }

  const save = async () => {
    console.log('[PushRule] save clicked', { form, editing })
    if (!form.name.trim()) { flash('请填写研判名称'); return }
    if (!Array.isArray(form.aiTypes) || form.aiTypes.length === 0) { flash('请至少选择一种 AI 类型'); return }
    setBusy(true)
    try {
      const body = {
        name: form.name.trim(),
        channelSipId: form.channelSipId || null,
        aiTypes: form.aiTypes,
        timeWindowHours: Number(form.timeWindowHours) || 24,
        threshold: Number(form.threshold) || 20,
        enabled: form.enabled,
        // P1-1 / P1-2
        minConfidence: Number(form.minConfidence) || 0,
        minLevel: Number(form.minLevel) || 0,
        minPlateConfidence: Number(form.minPlateConfidence) || 0,
        activeHours: form.activeHours.trim(),
        action: form.action,
        // 🆕 S1：3 个可空字段（null ⇒ 后端写 NULL ＝未设置）
        recordMinConfidence: form.recordMinConfidence,
        exempt: form.exempt,
        reportEnabled: form.reportEnabled,
      }
      console.log('[PushRule] sending body', body)
      if (editing) {
        const res = await apiFetch(`/api/push-rules/${editing}`, { method: 'PATCH', body: JSON.stringify(body) })
        console.log('[PushRule] PATCH response', res)
        flash('已更新研判')
      } else {
        const res = await apiFetch('/api/push-rules', { method: 'POST', body: JSON.stringify(body) })
        console.log('[PushRule] POST response', res)
        flash('已新增研判')
      }
      closeForm()
      load()
    } catch (e: any) { console.error('[PushRule] save error', e); flash('保存失败：' + (e?.error || e)) }
    finally { setBusy(false) }
  }

  // P1-4：规则试跑（用近 7 天历史数据回放，不改库、不发告警）
  const runDryRun = async () => {
    setBusy(true)
    try {
      const d = await apiFetch<{ matched: number; admitted: number; blocked: number; admitRate: number; topReasons: Array<{ reason: string; count: number }> }>(
        '/api/judge-dry-run',
        { method: 'POST', body: JSON.stringify({ days: 7, rule: { ...form } }) },
      )
      setDryRun(d)
    } catch (e: any) { flash('试跑失败：' + (e?.error || e)) }
    finally { setBusy(false) }
  }
  const remove = async (id: string) => {
    if (!confirm('确定删除该事件研判逻辑？')) return
    setBusy(true)
    try {
      await apiFetch(`/api/push-rules/${id}`, { method: 'DELETE' })
      flash('已删除研判')
      load()
    } catch (e: any) { flash('删除失败：' + (e?.error || e)) }
    finally { setBusy(false) }
  }
  const toggleEnabled = async (r: PushRule) => {
    try {
      await apiFetch(`/api/push-rules/${r.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !r.enabled }) })
      load()
    } catch { flash('操作失败') }
  }

  // P2-F：按「通道 × 算法」批量建规则（先 dry-run 出计划 → 确认 → 落库）
  const bulkGenerate = async () => {
    setBusy(true)
    try {
      const plan = await apiFetch<any>('/api/push-rules/bulk-generate', {
        method: 'POST', body: JSON.stringify({ threshold: 5, timeWindowHours: 24 }),
      })
      if (!plan.total) { flash('当前没有「已启用通道 × 已接入算法」的组合可生成'); return }
      const sample = plan.plan.slice(0, 12)
        .map((p: any) => `· ${p.channelName} × ${p.aiType}${p.existingRuleName ? '（已存在，跳过）' : ''}`).join('\n')
      const more = plan.plan.length > 12 ? `\n… 其余 ${plan.plan.length - 12} 个` : ''
      const okGo = confirm(
        `将为「启用通道 × 已接入算法」批量生成研判规则：\n\n` +
        `共 ${plan.total} 个组合 → 新建 ${plan.toCreate} 条，跳过 ${plan.skipped} 条\n` +
        `默认参数：时间窗 24h / 阈值 5 条 / 动作「进前台」\n\n${sample}${more}\n\n确认创建？`,
      )
      if (!okGo) return
      const out = await apiFetch<any>('/api/push-rules/bulk-generate', {
        method: 'POST', body: JSON.stringify({ threshold: 5, timeWindowHours: 24, confirm: true }),
      })
      flash(`已生成 ${out.created.length} 条专属研判规则`)
      load()
    } catch (e: any) { flash('批量生成失败：' + (e?.error || e)) }
    finally { setBusy(false) }
  }

  // P0-3：切换研判默认策略（未命中任何规则时的处置）
  //   切「拦截」是有破坏性的（会让未覆盖组合一次性静音）→ 必须带影响面确认
  const savePolicy = async (v: 'admit' | 'block') => {
    if (v === policy) return
    const un = coverage?.uncovered?.length || 0
    if (v === 'block' && un > 0) {
      if (!confirm(`切换为「拦截」后：未被任何研判规则覆盖的 ${un} 个「通道×算法」组合将不再进驾驶舱前台（仅保留存档）。\n\n确认切换？`)) return
    }
    setBusy(true)
    try {
      const d = await apiFetch<{ policy: 'admit' | 'block'; coverage: any }>('/api/judge-policy', {
        method: 'PUT', body: JSON.stringify({ policy: v }),
      })
      setPolicy(d.policy === 'block' ? 'block' : 'admit')
      setCoverage(d.coverage || null)
      flash(v === 'block' ? '已切换为「拦截」：未覆盖组合将仅存档' : '已切换为「放行」')
    } catch (e: any) { flash('切换失败：' + (e?.error || e)) }
    finally { setBusy(false) }
  }

  // AI 类型管理
  const refreshAiTypes = async () => {
    try {
      const d = await apiFetch<Array<{ name: string }>>('/api/ai-types').catch(() => [])
      if (Array.isArray(d) && d.length > 0) setAiTypes(d.map(x => x.name))
    } catch {}
  }
  const addAiType = async () => {
    const n = newType.trim()
    if (!n) return
    setBusy(true)
    try {
      await apiFetch('/api/ai-types', { method: 'POST', body: JSON.stringify({ name: n }) })
      setNewType('')
      await refreshAiTypes()
      flash('已新增 AI 类型')
    } catch (e: any) { flash('新增失败：' + (e?.error || e)) }
    finally { setBusy(false) }
  }
  const delAiType = async (name: string) => {
    if (!confirm(`确定删除 AI 类型「${name}」？\n若该类型仍被启用研判或未处理告警引用，将无法删除。`)) return
    setBusy(true)
    try {
      await apiFetch(`/api/ai-types/${encodeURIComponent(name)}`, { method: 'DELETE' })
      await refreshAiTypes()
      // 若当前 form 选中了被删类型，也同步剔除
      setForm(f => ({ ...f, aiTypes: f.aiTypes.filter(x => x !== name) }))
      flash('已删除 AI 类型')
    } catch (e: any) { flash(e?.error || '删除失败') }
    finally { setBusy(false) }
  }

  // 🆕 S2.5（2026-10-12）：把「当前保留期」显示在研判页（前台列表会按算法软归档超期记录）。
  const [rInfo, setRInfo] = useState<{ defaultDays: number | null; byType: Record<string, number | null>; gasDays?: number | null } | null>(null)
  useEffect(() => {
    let alive = true
    apiFetch<any>('/api/retention-info')
      .then(r => { if (alive && r && r.ok !== false) setRInfo(r) })
      .catch(() => { /* 拉不到就不显示 */ })
    return () => { alive = false }
  }, [])
  const ruleCount = rules.length
  const enabledCount = rules.filter(r => r.enabled).length

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexShrink: 0 }}>
        <div>
          <div style={{ color: '#c8e6ff', fontSize: 16, fontWeight: 600 }}>AI分析事件研判逻辑</div>
          <div style={{ color: '#3a5a70', fontSize: 12, marginTop: 3 }}>
            <b style={{ color: '#7fb3d5' }}>入库闸门</b>：命中的告警需同时满足「置信度 / 等级 / 生效时段 / 频率」全部条件才<b style={{ color: GREEN }}>进驾驶舱前台实时告警</b>；
            不满足则<b style={{ color: AMBER }}>仅存档</b>（留存可查，前台不显示、不推送）。未命中任何规则的组合按上方「默认策略」处理。
            {/* 🆕 S2.5：保留期显式标注 —— 说明「为什么前台看到的条数比库里少」 */}
            <div style={{ marginTop: 4, color: '#7a5c2e' }}>
              ⏳ <b style={{ color: '#c79a3a' }}>保留期</b>（独立于研判，见「保留策略」页）：超期记录
              <b style={{ color: '#c79a3a' }}>不进前台列表</b>（软归档，数据一行未删，可在「AI分析存档」查）。
              当前：默认 <b>{rInfo ? (rInfo.defaultDays ?? '不限') : '…'}</b> 天
              {rInfo && Object.entries(rInfo.byType || {}).length > 0 && (
                <> ｜ {Object.entries(rInfo.byType || {}).map(([k, v]) => `${k} ${v ?? '不限'}天`).join(' / ')}</>
              )}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} style={btn(CYAN)}>刷新</button>
          {isAdmin && <button disabled={busy} onClick={bulkGenerate} title="按「启用通道 × 已接入算法」批量生成专属研判规则（先预览计划再确认）" style={btn('#7fb3d5')}>{busy ? '处理中…' : '批量建规则'}</button>}
          {isAdmin && <button disabled={busy} onClick={openCreate} style={btn(GREEN)}>{busy ? '处理中…' : '新增研判'}</button>}
        </div>
      </div>

      {toast && (
        <div style={{ position: 'fixed', top: 80, right: 40, zIndex: 3000, background: 'rgba(0,40,80,0.95)', border: '1px solid rgba(0,150,220,0.3)', borderRadius: 6, padding: '10px 20px', color: CYAN, fontSize: 13 }}>
          {toast}
        </div>
      )}

      {/* 🆕 S5：页面级总览 —— 本页到底管什么（4 类语义 + 边界） */}
      <div style={{ background: 'rgba(0,30,70,0.35)', border: '1px solid rgba(0,150,220,0.25)', borderLeft: `3px solid ${CYAN}`, borderRadius: 4, padding: '10px 14px', marginBottom: 12, flexShrink: 0 }}>
        <div style={{ color: CYAN, fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>
          本页管 4 件事（粒度都是「这个<b>点位</b> × 这个<b>算法</b>」）—— 算法过滤只在这里配
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: '3px 10px', fontSize: 11.5, lineHeight: 1.75, color: '#9ad6f0' }}>
          <b style={{ color: '#c8e6ff' }}>① 准入条件</b>
          <span>窗口 / 阈值 / 置信度 / 等级 / 生效时段</span>
          <span style={{ color: GREEN }}>→ 决定「进不进驾驶舱前台」</span>
          <b style={{ color: '#c8e6ff' }}>② 单条展示门槛</b>
          <span>低于门槛的<b>单条记录</b>不进前台列表（仍计入①的聚合计数）</span>
          <span style={{ color: GREEN }}>→ 决定「列表里显不显示这一条」</span>
          <b style={{ color: '#c8e6ff' }}>③ 作业区豁免</b>
          <span>该点位检出不计违规</span>
          <span style={{ color: GREEN }}>→ 同时驱动 <b>11 机堆头链</b>的前置过滤</span>
          <b style={{ color: '#c8e6ff' }}>④ 上报开关</b>
          <span>不上报 / 强制上报 / 跟随送达规则</span>
          <span style={{ color: GREEN }}>→ 覆盖「智治推送 → 送达规则」</span>
        </div>
        <div style={{ marginTop: 6, fontSize: 11, color: '#3a5a70', lineHeight: 1.6 }}>
          <b style={{ color: '#7a5c2e' }}>不在本页的另外两件</b>：
          ⏳ <b>保留期</b>（超期不进前台）见「<b>保留策略</b>」页；
          📤 <b>对外节流窗口</b>（48h / 累计次数）见「<b>智治推送 → 送达规则</b>」页（它只管"发不发、发多密"，<b>不判定是否违规</b>）。
        </div>
      </div>

      {/* P0-3：研判默认策略 + 覆盖面（切「拦截」前必须看清会波及哪些组合） */}
      {isAdmin && (
        <div style={{ flexShrink: 0, marginBottom: 12, padding: 10, border: '1px solid rgba(0,120,200,0.15)', borderRadius: 6, background: 'rgba(0,20,60,0.35)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: '#5a8aaa', fontSize: 12 }}>未命中任何研判规则时：</span>
            <button disabled={busy} onClick={() => savePolicy('admit')}
              style={{ ...btn(policy === 'admit' ? GREEN : '#3a5a70'), padding: '4px 12px', fontWeight: policy === 'admit' ? 700 : 400 }}>放行（保守）</button>
            <button disabled={busy} onClick={() => savePolicy('block')}
              style={{ ...btn(policy === 'block' ? RED : '#3a5a70'), padding: '4px 12px', fontWeight: policy === 'block' ? 700 : 400 }}>拦截（仅存档）</button>
            {coverage && (
              <span style={{ color: '#5a8aaa', fontSize: 12 }}>
                近 {coverage.days} 天实际出现 <b style={{ color: '#c8e6ff' }}>{coverage.comboCount}</b> 个「通道×算法」组合，
                已覆盖 <b style={{ color: GREEN }}>{coverage.coveredCount}</b>，
                未覆盖 <b style={{ color: coverage.uncovered.length ? AMBER : '#5a8aaa' }}>{coverage.uncovered.length}</b>
              </span>
            )}
            {coverage && coverage.uncovered.length > 0 && (
              <button onClick={() => setShowUncovered(v => !v)} style={{ ...btn(CYAN), padding: '3px 10px' }}>
                {showUncovered ? '收起未覆盖清单' : '查看未覆盖清单'}
              </button>
            )}
          </div>
          {policy === 'block' && !!coverage?.uncovered?.length && (
            <div style={{ marginTop: 8, color: AMBER, fontSize: 12 }}>
              ⚠ 当前为「拦截」：上述 {coverage.uncovered.length} 个未覆盖组合若持续不达阈值，将不进前台（仅存档）。
            </div>
          )}
          {showUncovered && coverage && (
            <div style={{ marginTop: 8, maxHeight: 150, overflow: 'auto', border: '1px solid rgba(0,150,220,0.15)', borderRadius: 4 }}>
              {coverage.uncovered.map((u, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.4fr 1.4fr 80px', padding: '4px 10px', fontSize: 12, borderBottom: '1px solid rgba(0,80,150,0.12)' }}>
                  <span style={{ color: '#c8e6ff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.channelName}</span>
                  <span style={{ color: '#9ad6f0' }}>{u.aiType}</span>
                  <span style={{ color: '#5a8aaa', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace" }}>{u.count} 条</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* P1-3：研判命中统计（阈值该调多少的依据） */}
      {stats && (
        <div style={{ flexShrink: 0, marginBottom: 12, padding: 10, border: '1px solid rgba(0,120,200,0.15)', borderRadius: 6, background: 'rgba(0,20,60,0.35)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ color: '#5a8aaa', fontSize: 12 }}>近 {stats.days} 天研判结果：</span>
            <span style={{ fontSize: 12, color: '#5a8aaa' }}>
              原始识别 <b style={{ color: '#c8e6ff' }}>{stats.total}</b> 条 ·
              准入 <b style={{ color: GREEN }}>{stats.admitted}</b> ·
              拦下 <b style={{ color: AMBER }}>{stats.blocked}</b> ·
              准入率 <b style={{ color: '#c8e6ff' }}>{(stats.admitRate * 100).toFixed(1)}%</b>
              {stats.noRule?.total ? <> · 未命中规则 <b style={{ color: '#c8e6ff' }}>{stats.noRule.total}</b></> : null}
            </span>
            {!!stats.rules?.length && (
              <button onClick={() => setShowStats(v => !v)} style={{ ...btn(CYAN), padding: '3px 10px' }}>
                {showStats ? '收起按规则明细' : '按规则明细'}
              </button>
            )}
          </div>
          {showStats && !!stats.rules?.length && (
            <div style={{ marginTop: 8, border: '1px solid rgba(0,150,220,0.15)', borderRadius: 4 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 90px 90px 110px', padding: '5px 10px', fontSize: 11, color: '#3a5a70', fontWeight: 600, background: 'rgba(0,30,70,0.5)' }}>
                <span>规则</span><span style={{ textAlign: 'right' }}>准入</span><span style={{ textAlign: 'right' }}>拦下</span><span style={{ textAlign: 'right' }}>准入率</span>
              </div>
              {stats.rules.map(s => (
                <div key={s.ruleId} style={{ display: 'grid', gridTemplateColumns: '1.6fr 90px 90px 110px', padding: '4px 10px', fontSize: 12, borderTop: '1px solid rgba(0,80,150,0.12)' }}>
                  <span style={{ color: '#c8e6ff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.ruleName}</span>
                  <span style={{ textAlign: 'right', color: GREEN, fontFamily: "'JetBrains Mono', monospace" }}>{s.admitted}</span>
                  <span style={{ textAlign: 'right', color: AMBER, fontFamily: "'JetBrains Mono', monospace" }}>{s.blocked}</span>
                  <span style={{ textAlign: 'right', color: '#5a8aaa', fontFamily: "'JetBrains Mono', monospace" }}>{(s.admitRate * 100).toFixed(1)}%</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* P2：规则冲突告警（同一「通道×算法」被多条同层规则覆盖 → 后者静默失效） */}
      {conflicts && conflicts.count > 0 && (
        <div style={{ flexShrink: 0, marginBottom: 12, padding: 10, border: '1px solid rgba(255,183,77,0.35)', borderRadius: 6, background: 'rgba(120,80,0,0.12)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ color: AMBER, fontSize: 12 }}>
              ⚠ 检测到 <b>{conflicts.count}</b> 处规则冲突：同一「通道×算法」被多条同层规则覆盖，<b>实际只有最新的那条生效</b>，其余规则不会命中。
            </span>
            <button onClick={() => setShowConflicts(v => !v)} style={{ ...btn(AMBER), padding: '3px 10px' }}>
              {showConflicts ? '收起冲突明细' : '查看冲突明细'}
            </button>
          </div>
          {showConflicts && (
            <div style={{ marginTop: 8, maxHeight: 170, overflow: 'auto', border: '1px solid rgba(255,183,77,0.2)', borderRadius: 4 }}>
              {conflicts.conflicts.map((c, i) => (
                <div key={i} style={{ padding: '5px 10px', fontSize: 12, borderBottom: '1px solid rgba(0,80,150,0.12)', color: '#b8c6d4' }}>
                  <span style={{ color: '#c8e6ff' }}>{c.channelName}</span>
                  <span style={{ color: '#9ad6f0' }}> × {c.aiType}</span>
                  {c.layer === 'wildcard' ? <span style={{ color: '#5a8aaa' }}>（通配层冲突）</span> : null}
                  <span style={{ color: GREEN }}> → 生效：{c.winner.name}</span>
                  <span style={{ color: AMBER }}> ；被遮蔽：{c.shadowed.map(s => s.name).join('、')}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* AI 类型管理（仅 admin） */}
      {isAdmin && (
        <div style={{ flexShrink: 0, marginBottom: 12, padding: 10, border: '1px solid rgba(0,120,200,0.15)', borderRadius: 6, background: 'rgba(0,20,60,0.35)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ color: '#5a8aaa', fontSize: 12 }}>AI 类型管理（可自由增删）</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            {aiTypes.map(t => (
              <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 3, background: 'rgba(0,170,255,0.1)', border: '1px solid rgba(0,170,255,0.25)', color: '#c8e6ff', fontSize: 12 }}>
                {t}
                <button type="button" disabled={busy} onClick={() => delAiType(t)} style={{ padding: 0, border: 'none', background: 'transparent', color: '#ff8080', cursor: busy ? 'wait' : 'pointer', fontSize: 13, lineHeight: 1 }}>×</button>
              </span>
            ))}
            <input value={newType} onChange={e => setNewType(e.target.value)} onKeyDown={e => e.key === 'Enter' && addAiType()} placeholder="新增 AI 类型…" style={{ ...inputStyle, width: 140, marginLeft: 4 }} />
            <button type="button" disabled={busy} onClick={addAiType} style={{ ...btn(GREEN), padding: '4px 10px' }}>添加</button>
          </div>
        </div>
      )}

      <span style={{ color: '#3a5a70', fontSize: 12, marginBottom: 8, flexShrink: 0 }}>
        共 <span style={{ color: CYAN, fontFamily: "'JetBrains Mono', monospace" }}>{ruleCount}</span> 条研判 · 启用 <span style={{ color: GREEN, fontFamily: "'JetBrains Mono', monospace" }}>{enabledCount}</span> 条
      </span>

      {/* 研判列表 */}
      <div style={{ flex: 1, overflow: 'auto', border: '1px solid rgba(0,150,220,0.15)', borderRadius: 6 }}>
        <div style={{ display: 'grid', gridTemplateColumns: RULE_COLS, background: 'rgba(0,30,70,0.5)', padding: '8px 12px', fontSize: 11, color: '#3a5a70', fontWeight: 600, borderBottom: '1px solid rgba(0,150,220,0.15)', position: 'sticky', top: 0, zIndex: 2 }}>
          <span>研判名称</span><span>通道</span><span>AI类型</span><span>时间窗(h)</span><span>阈值(条)</span>
          <span title="准入需同时满足的门槛（置信度/等级/时段）与规则动作">门槛 / 动作</span>
          <span title="近 7 天该规则的准入 / 拦下条数">近7天(准入/拦下)</span>
          <span>启用</span><span>操作</span>
        </div>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, color: '#3a5a70', fontSize: 13 }}>加载中…</div>
        ) : rules.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, color: '#3a5a70', fontSize: 13 }}>暂无事件研判逻辑</div>
        ) : (
          rules.map(r => (
            <div key={r.id} style={{
              display: 'grid', gridTemplateColumns: RULE_COLS,
              padding: '8px 12px', borderBottom: '1px solid rgba(0,80,150,0.12)', alignItems: 'center', fontSize: 12,
            }}>
              <span style={{ color: '#c8e6ff', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
              <span style={{ color: '#9ad6f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.channelSipId ? (chNameMap[r.channelSipId] || r.channelSipId) : '全部通道'}</span>
              <span style={{ color: '#9ad6f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.aiTypes.length ? r.aiTypes.join('、') : '全部算法'}</span>
              <span style={{ color: '#5a8aaa', fontFamily: "'JetBrains Mono', monospace" }}>{r.timeWindowHours}</span>
              <span style={{ color: '#5a8aaa', fontFamily: "'JetBrains Mono', monospace" }}>{r.threshold}</span>
              {/* P1-1/P1-2：门槛与动作（悬停看全） */}
              <span title={gatesText(r)} style={{
                color: r.action === 'archive_only' ? AMBER : '#7fb3d5', fontSize: 11,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'help',
              }}>{gatesText(r)}</span>
              {/* P1-3：近 7 天命中（准入/拦下） */}
              {(() => {
                const s = statsByRule[r.id]
                return (
                  <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }} title={s ? `近 7 天：准入 ${s.admitted} 条 / 拦下 ${s.blocked} 条（准入率 ${(s.admitRate * 100).toFixed(1)}%）` : '近 7 天无命中'}>
                    {s && s.total > 0
                      ? <><span style={{ color: GREEN }}>{s.admitted}</span><span style={{ color: '#3a5a70' }}> / </span><span style={{ color: AMBER }}>{s.blocked}</span></>
                      : <span style={{ color: '#3a5a70' }}>—</span>}
                  </span>
                )
              })()}
              <span>
                <button onClick={() => toggleEnabled(r)} disabled={!isAdmin} style={{
                  padding: '2px 8px', borderRadius: 10, fontSize: 11, cursor: isAdmin ? 'pointer' : 'default',
                  border: `1px solid ${r.enabled ? 'rgba(0,230,118,0.4)' : 'rgba(120,120,120,0.3)'}`,
                  background: r.enabled ? 'rgba(0,230,118,0.12)' : 'rgba(80,80,80,0.12)',
                  color: r.enabled ? GREEN : '#7a8a99',
                }}>{r.enabled ? '启用' : '禁用'}</button>
              </span>
              <span style={{ display: 'flex', gap: 6 }}>
                {isAdmin && <button onClick={() => openEdit(r)} style={{ ...btn(CYAN), padding: '3px 10px' }}>编辑</button>}
                {isAdmin && <button onClick={() => remove(r.id)} style={{ ...btn(RED), padding: '3px 10px' }}>删除</button>}
              </span>
            </div>
          ))
        )}
      </div>

      {/* 新增/编辑表单 */}
      {formOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(2,8,20,0.8)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={e => { if (e.target === e.currentTarget) closeForm() }}>
          <div style={{ width: 520, maxWidth: '92vw', background: 'linear-gradient(180deg,#040e25,#030c1e)', border: '1px solid rgba(0,150,220,0.3)', borderRadius: 6, padding: 20, boxShadow: '0 0 40px rgba(0,120,255,0.12)' }}>
            <div style={{ color: '#c8e6ff', fontSize: 15, fontWeight: 600, marginBottom: 16 }}>{editing ? '编辑事件研判逻辑' : '新增事件研判逻辑'}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Field label="研判名称">
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="如：龙泗路堆头未覆盖降噪" style={inputStyle} />
              </Field>
              <Field label="通道">
                <select value={form.channelSipId} onChange={e => setForm(f => ({ ...f, channelSipId: e.target.value }))} style={inputStyle}>
                  <option value="">全部通道（通配）</option>
                  {channels.map(c => <option key={c.channelSipId} value={c.channelSipId}>{c.channelName}</option>)}
                </select>
              </Field>
              <Field label="AI类型（多选）">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, maxHeight: 140, overflowY: 'auto', padding: 8, border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3, background: 'rgba(0,20,60,0.4)' }}>
                  {aiTypes.map(t => {
                    const checked = form.aiTypes.includes(t)
                    // P2 一致性校验：所选通道「通道接入」里没配这个算法 → 该组合永远不会产生记录，规则永不命中
                    const notOnChannel = selectedChannelAiTypes !== null && !selectedChannelAiTypes.includes(t)
                    return (
                      <label key={t} title={notOnChannel ? '该通道的「通道接入」里未配置此算法，选中后本规则永远不会命中' : undefined} style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        color: notOnChannel ? '#8a7a5a' : '#c8e6ff', fontSize: 12, cursor: 'pointer',
                        padding: '3px 8px', borderRadius: 3,
                        background: checked ? (notOnChannel ? 'rgba(255,183,77,0.12)' : 'rgba(0,170,255,0.15)') : 'transparent',
                        border: `1px solid ${checked ? (notOnChannel ? 'rgba(255,183,77,0.45)' : 'rgba(0,170,255,0.4)') : 'rgba(0,120,200,0.2)'}`,
                      }}>
                        <input type="checkbox" checked={checked} onChange={() => setForm(f => {
                          const arr = f.aiTypes.includes(t) ? f.aiTypes.filter(x => x !== t) : [...f.aiTypes, t]
                          return { ...f, aiTypes: arr }
                        })} style={{ cursor: 'pointer' }} />
                        {notOnChannel ? '⚠ ' : ''}{t}
                      </label>
                    )
                  })}
                </div>
                {/* P2：一致性提示 —— 选了通道未接入的算法，等于配了条永不命中的死规则 */}
                {selectedChannelAiTypes !== null && form.aiTypes.some(t => !selectedChannelAiTypes.includes(t)) && (
                  <div style={{ marginTop: 6, color: AMBER, fontSize: 11, lineHeight: 1.6 }}>
                    ⚠ 选中的算法里有「该通道未接入」的项（标 ⚠）。这类组合不会产生 AI 记录，规则**永远不会命中**。
                    请先在「通道接入」里为该通道勾选算法，或改选其它算法 / 用「全部通道（通配）」。
                  </div>
                )}
              </Field>
              {/* 🆕 S5：分区 ① 准入条件 */}
              <div style={{ color: GREEN, fontSize: 11.5, fontWeight: 600, marginTop: 2 }}>
                ① 准入条件 —— 决定「进不进驾驶舱前台」（下面两项 + 门槛 + 动作共同生效）
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <Field label="时间窗（小时）">
                  <input type="number" min={1} value={form.timeWindowHours} onChange={e => setForm(f => ({ ...f, timeWindowHours: Number(e.target.value) || 24 }))} style={inputStyle} />
                </Field>
                <Field label="阈值（条）">
                  <input type="number" min={1} value={form.threshold} onChange={e => setForm(f => ({ ...f, threshold: Number(e.target.value) || 20 }))} style={inputStyle} />
                </Field>
              </div>
              {/* P1-1：准入维度（0/空 = 不限）*/}{/* 2026-10-11：新增「最低车牌置信度」；2×2 网格（短标题+hint 下置）防窄弹窗错位 */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <Field label="最低置信度（%）" hint="0 = 不限（冒装模型置信度，0-100）">
                  <input type="number" min={0} max={100} value={form.minConfidence} onChange={e => setForm(f => ({ ...f, minConfidence: Number(e.target.value) || 0 }))} style={inputStyle} />
                </Field>
                <Field label="最低车牌置信度（%）" hint="0 = 不限；>0 时须已识别到车牌且牌置信度达标（近 7 天冒装类有牌率约 44%）">
                  <input type="number" min={0} max={100} value={form.minPlateConfidence} onChange={e => setForm(f => ({ ...f, minPlateConfidence: Number(e.target.value) || 0 }))} style={inputStyle} />
                </Field>
                <Field label="最低等级" hint="0 = 不限">
                  <select value={form.minLevel} onChange={e => setForm(f => ({ ...f, minLevel: Number(e.target.value) || 0 }))} style={inputStyle}>
                    <option value={0}>不限</option>
                    <option value={1}>≥1 注意</option>
                    <option value={2}>≥2 轻度</option>
                    <option value={3}>≥3 中度</option>
                    <option value={4}>=4 重度</option>
                  </select>
                </Field>
                <Field label="生效时段（上海时）" hint="空 = 全天；如 8-18 或 20-6（跨夜请拆两段）">
                  <input value={form.activeHours} onChange={e => setForm(f => ({ ...f, activeHours: e.target.value }))} placeholder="如 8-18 或 20-6" style={inputStyle} />
                </Field>
              </div>
              {/* 🆕 S5：分区 ②③④ —— 三项"点位的额外开关"，与①的准入条件分离 */}
              <div style={{ border: `1px dashed ${GREEN}66`, borderRadius: 4, padding: '10px 12px', background: `${GREEN}0d` }}>
                <div style={{ fontSize: 11.5, color: '#7fb3d5', marginBottom: 8, lineHeight: 1.7 }}>
                  <b style={{ color: GREEN }}>②③④ 该点位的额外开关</b>（与上面的准入条件<b>互不影响</b>）：
                  ② 管「列表显不显示单条」、③ 管「算不算违规 + 驱动 11 机链」、④ 管「要不要对外报」。
                  <b>空 = 未设置</b>（＝不做门槛 / 不豁免 / 跟随送达规则）。
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                  <Field label="② 单条展示门槛（%）" hint="空 = 不做门槛。✅已生效（S2）：低于门槛的记录不进前台列表 —— 原「告警过滤」页的能力已并入此处">
                    <input type="number" min={0} max={100} placeholder="空=不启用"
                      value={form.recordMinConfidence ?? ''}
                      onChange={e => setForm(f => ({ ...f, recordMinConfidence: e.target.value === '' ? null : Number(e.target.value) }))} style={inputStyle} />
                  </Field>
                  <Field label="③ 作业区豁免" hint="✅已生效（S3）：该点位检出不计违规，并驱动 11 机堆头链（靠近江边作业区不受 40% 规则）">
                    <select value={form.exempt ?? 0}
                      onChange={e => setForm(f => ({ ...f, exempt: Number(e.target.value) || 0 }))} style={inputStyle}>
                      <option value={0}>不豁免</option>
                      <option value={1}>豁免（作业区）</option>
                    </select>
                  </Field>
                  <Field label="④ 上报开关" hint="NULL＝跟随②送达规则（默认）；1＝强制上报（忽略②的节流阈值）；0＝不上报。②页规则只管「发不发、发多密」，不判定是否违规">
                    <select value={form.reportEnabled === null ? 'inherit' : String(form.reportEnabled)}
                      onChange={e => setForm(f => ({ ...f, reportEnabled: e.target.value === 'inherit' ? null : Number(e.target.value) }))} style={inputStyle}>
                      <option value="inherit">跟随送达规则（默认）</option>
                      <option value="1">强制上报</option>
                      <option value="0">不上报</option>
                    </select>
                  </Field>
                </div>
              </div>
              {/* P1-2：规则动作 */}
              <Field label="规则动作">
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={() => setForm(f => ({ ...f, action: 'admit_front' }))}
                    style={{ ...btn(form.action === 'admit_front' ? GREEN : '#3a5a70'), padding: '5px 14px' }}>进前台（实时告警）</button>
                  <button type="button" onClick={() => setForm(f => ({ ...f, action: 'archive_only' }))}
                    style={{ ...btn(form.action === 'archive_only' ? AMBER : '#3a5a70'), padding: '5px 14px' }}>仅存档（不报警）</button>
                  <button type="button" onClick={() => setForm(f => ({ ...f, action: 'front_and_push' }))}
                    title="研判准入后，额外把该事件接入智治推送链路（可推送至城运中心）"
                    style={{ ...btn(form.action === 'front_and_push' ? CYAN : '#3a5a70'), padding: '5px 14px' }}>进前台 + 推城运</button>
                </div>
                {form.action === 'front_and_push' && (
                  <div style={{ marginTop: 6, color: '#7fb3d5', fontSize: 11, lineHeight: 1.6 }}>
                    提示：该动作会让**研判准入的 AI 告警真的进入智治推送链路**（写入 smart_push_events → 由「智治推送」规则决定是否推给城运中心）。
                    请先在「智治推送」里确认事件类型 / 触发条数 / 推送预案已配好，否则不会真正外发。
                  </div>
                )}
              </Field>
              <Field label="启用">
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: '#5a8aaa', fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} />
                  {form.enabled ? '启用（参与研判准入 + 前台折叠）' : '禁用（不生效）'}
                </label>
              </Field>

              {/* P1-4：试跑（历史回放预演，不写库、不产生告警） */}
              <div style={{ padding: 10, border: '1px solid rgba(0,150,220,0.2)', borderRadius: 5, background: 'rgba(0,20,60,0.3)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ color: '#5a8aaa', fontSize: 12 }}>试跑（按近 7 天历史数据预演，不写库）</span>
                  <button type="button" disabled={busy} onClick={runDryRun} style={{ ...btn(CYAN), padding: '4px 12px' }}>{busy ? '试跑中…' : '开始试跑'}</button>
                </div>
                {dryRun && (
                  <div style={{ marginTop: 8, fontSize: 12, color: '#5a8aaa', lineHeight: 1.7 }}>
                    命中本规则的记录 <b style={{ color: '#c8e6ff' }}>{dryRun.matched}</b> 条 →
                    会准入 <b style={{ color: GREEN }}>{dryRun.admitted}</b> 条 ·
                    会拦下 <b style={{ color: AMBER }}>{dryRun.blocked}</b> 条
                    （准入率 <b style={{ color: '#c8e6ff' }}>{(dryRun.admitRate * 100).toFixed(1)}%</b>）
                    {!!dryRun.topReasons?.length && (
                      <div style={{ marginTop: 6 }}>
                        主要拦下原因：
                        {dryRun.topReasons.map((t, i) => (
                          <div key={i} style={{ color: '#7fb3d5' }}>· {t.reason}（{t.count} 条）</div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
              <button type="button" onClick={closeForm} style={btn('#5a8aaa')}>取消</button>
              <button type="button" disabled={busy} onClick={save} style={btn(GREEN)}>{busy ? '保存中…' : '保存'}</button>
            </div>
            <div style={{ marginTop: 12, color: '#3a5a70', fontSize: 11, lineHeight: 1.6 }}>
              说明：该通道 + 选中任一 AI 类型产生的记录，需<b>同时满足</b>「置信度 ≥ 门槛」「等级 ≥ 门槛」「在生效时段内」「时间窗内累计条数 ≥ 阈值」四项，才会<b>进驾驶舱前台实时告警</b>（同类自动折叠为 1 条聚合）；任一项不满足即<b>仅存档</b>——存档页仍能查到全部原始记录与判定原因。每个 AI 类型独立计数；标记聚合告警会把组内全部原始记录标记为已处理。「仅存档」动作则完全不进前台。
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{ color: '#5a8aaa', fontSize: 12 }}>{label}</span>
      {children}
      {hint && <span style={{ color: '#3a5a70', fontSize: 11, lineHeight: 1.5 }}>{hint}</span>}
    </label>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// 按算法保留期（软归档）· 2026-09-24
// 一句话规则：**超过保留天数的记录不再进前台实时告警**（数据不删，调大天数即可找回）
// ══════════════════════════════════════════════════════════════════════════
interface RetentionItem {
  aiType: string
  label: string
  reserved: boolean
  configured: boolean
  keepDays: number | null
  enabled: boolean
  remark: string
  updatedAt: string
  totalRecords: number
}
interface RetentionDryItem {
  aiType: string; label: string; keepDays: number | null
  visibleBefore: number; willArchive: number; remain: number
  oldestAt: string; newestAt: string
}
interface RetentionDry {
  at: string; scanned: number; truncated: boolean
  totalBefore: number; totalArchive: number; totalRemain: number; archiveRate: number
  items: RetentionDryItem[]
}
const KEEP_OPTIONS = [0, 1, 2, 3, 5, 7, 14, 30]   // 0 = 不限

function AlgoRetentionPanel() {
  const [items, setItems] = useState<RetentionItem[]>([])
  const [dry, setDry] = useState<RetentionDry | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3000) }

  const load = useCallback(() => {
    setLoading(true)
    apiFetch<{ items: RetentionItem[] }>('/api/algo-retention')
      .then(d => setItems(Array.isArray(d?.items) ? d.items : []))
      .catch(() => flash('加载失败'))
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => { load() }, [load])

  const save = async (it: RetentionItem, keepDays: number, enabled: boolean) => {
    setBusy(true)
    try {
      const d = await apiFetch<{ items: RetentionItem[] }>('/api/algo-retention', {
        method: 'PUT', body: JSON.stringify({ aiType: it.aiType, keepDays, enabled, remark: it.remark }),
      })
      if (Array.isArray(d?.items)) setItems(d.items)
      flash(enabled ? `「${it.label}」保留 ${keepDays === 0 ? '不限' : keepDays + ' 天'}，已生效` : `「${it.label}」已关闭（不限制）`)
    } catch (e: any) { flash('保存失败：' + (e?.error || e)) }
    finally { setBusy(false) }
  }
  const runDry = async () => {
    setBusy(true)
    try { setDry(await apiFetch<RetentionDry>('/api/algo-retention/dry-run', { method: 'POST', body: JSON.stringify({}) })) }
    catch (e: any) { flash('试运行失败：' + (e?.error || e)) }
    finally { setBusy(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, overflow: 'auto', flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ color: '#c8e6ff', fontSize: 15, fontWeight: 600 }}>保留策略（按算法）</div>
          <div style={{ color: '#3a5a70', fontSize: 12, marginTop: 3 }}>
            超过保留天数的记录<b style={{ color: CYAN }}>不再进前台实时告警</b>；数据一条不删，存档与导出照常可见，把天数调大即可找回。关闭开关或选「不限」＝永不归档。
          </div>
        </div>
        <button onClick={load} style={btn(CYAN)}>刷新</button>
        <button disabled={busy} onClick={runDry} style={btn(AMBER)}>{busy ? '运行中…' : '试运行'}</button>
      </div>

      {toast && (
        <div style={{ background: 'rgba(0,40,80,0.9)', border: '1px solid rgba(0,150,220,0.3)', borderRadius: 4, padding: '7px 12px', color: CYAN, fontSize: 12 }}>{toast}</div>
      )}

      {/* 配置表 */}
      <div style={{ border: '1px solid rgba(0,120,200,0.22)', borderRadius: 5, overflow: 'hidden', flexShrink: 0 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 110px 70px 100px 1.4fr', padding: '8px 12px', background: 'rgba(0,40,80,0.5)', color: '#5a8aaa', fontSize: 12 }}>
          <span>算法 / 来源</span><span>保留天数</span><span>启用</span><span>库内记录</span><span>备注</span>
        </div>
        {loading ? (
          <div style={{ padding: 20, color: '#3a5a70', fontSize: 12 }}>加载中…</div>
        ) : items.length === 0 ? (
          <div style={{ padding: 20, color: '#3a5a70', fontSize: 12 }}>暂无配置项</div>
        ) : items.map(it => {
          // 未配置行的下拉显示**实际生效值**（兜底天数），而不是「不限」——
          //   否则会误导管理员以为该算法不归档，且点一下开关就会误写成 keepDays=0。
          const defaultItem = items.find(x => x.aiType === '__default__')
          const effKd = it.keepDays !== null ? it.keepDays : Math.max(0, defaultItem?.keepDays ?? 3)
          const kd = effKd
          const on = it.configured ? (it.enabled && kd > 0) : true   // 未配置 = 走兜底（按启用显示）
          const toggleLabel = it.configured ? (on ? '已启用' : '已关闭') : '走兜底'
          return (
            <div key={it.aiType} style={{
              display: 'grid', gridTemplateColumns: '1.6fr 110px 70px 100px 1.4fr', padding: '7px 12px',
              borderTop: '1px solid rgba(0,120,200,0.12)', alignItems: 'center', fontSize: 13,
              background: it.reserved ? 'rgba(0,170,255,0.05)' : 'transparent',
              opacity: it.configured ? 1 : 0.75,
            }}>
              <span style={{ color: it.configured ? '#c8e6ff' : '#5a8aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={it.aiType}>
                {it.label}
                {it.reserved && <span style={{ color: PURPLE, fontSize: 11, marginLeft: 6 }}>兜底</span>}
                {!it.configured && <span style={{ color: '#3a5a70', fontSize: 11, marginLeft: 6 }}>未配置（走兜底）</span>}
              </span>
              <select
                value={KEEP_OPTIONS.includes(kd) ? kd : 0}
                disabled={busy}
                onChange={e => save(it, Number(e.target.value), true)}
                style={{ ...inputStyle, padding: '4px 6px', fontSize: 12, ...(it.configured ? {} : { color: '#8ab4d8' }) }}>
                {KEEP_OPTIONS.map(v => <option key={v} value={v}>{v === 0 ? '不限' : v + ' 天'}</option>)}
                {!KEEP_OPTIONS.includes(kd) && <option value={kd}>{kd} 天</option>}
              </select>
              <button disabled={busy} onClick={() => save(it, kd, it.configured ? !it.enabled : true)} style={{
                ...btn(on ? GREEN : '#5a8aaa'), padding: '3px 8px', fontSize: 11,
              }}>{toggleLabel}</button>
              <span style={{ color: '#8ab4d8', fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }}>{it.totalRecords}</span>
              <span style={{ color: '#3a5a70', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={it.remark}>{it.remark || '—'}</span>
            </div>
          )
        })}
      </div>

      {/* 试运行 */}
      {dry && (
        <div style={{ border: '1px solid rgba(255,180,0,0.3)', borderRadius: 5, overflow: 'hidden', flexShrink: 0 }}>
          <div style={{ padding: '8px 12px', background: 'rgba(60,40,0,0.4)', color: AMBER, fontSize: 12 }}>
            试运行（只读，不改数据）：当前前台可见 <b>{dry.totalBefore}</b> 条 → 按现在配置会退出前台 <b style={{ color: RED }}>{dry.totalArchive}</b> 条，
            剩 <b style={{ color: GREEN }}>{dry.totalRemain}</b> 条（{dry.archiveRate}%）{dry.truncated && ' · ⚠ 已达扫描上限，实际更多'}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 100px 100px 100px 1fr', padding: '7px 12px', background: 'rgba(0,40,80,0.4)', color: '#5a8aaa', fontSize: 12 }}>
            <span>算法 / 来源</span><span>当前可见</span><span>将退出前台</span><span>保留</span><span>时间跨度（上海时）</span>
          </div>
          {dry.items.map(d => (
            <div key={d.aiType} style={{
              display: 'grid', gridTemplateColumns: '1.6fr 100px 100px 100px 1fr', padding: '6px 12px',
              borderTop: '1px solid rgba(0,120,200,0.12)', fontSize: 12, alignItems: 'center',
            }}>
              <span style={{ color: '#c8e6ff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.label}</span>
              <span style={{ color: '#8ab4d8', fontFamily: "'JetBrains Mono', monospace" }}>{d.visibleBefore}</span>
              <span style={{ color: d.willArchive > 0 ? RED : '#3a5a70', fontFamily: "'JetBrains Mono', monospace" }}>{d.willArchive}</span>
              <span style={{ color: GREEN, fontFamily: "'JetBrains Mono', monospace" }}>{d.remain}</span>
              <span style={{ color: '#3a5a70', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
                {d.oldestAt ? `${d.oldestAt.slice(5, 16)} → ${d.newestAt.slice(5, 16)}` : '—'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
