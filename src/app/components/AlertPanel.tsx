import { useState, useEffect } from 'react'
import { AlertHistoryModal } from './AlertHistoryModal'
import { AlertEvidenceModal } from './AlertEvidenceModal'
import { AlertThumbnail } from './AlertThumbnail'
import { useDashboard } from '../context/DashboardContext'

export interface AlertItem {
  id: string
  time: string
  fullTime?: string      // 完整时间戳 MM-DD HH:mm:ss（历史记录区分跨天用）
  location: string
  type: string
  value: string
  standard: string
  level: 1 | 2 | 3 | 4
  lat: number
  lon: number
  licensePlate?: string  // 仅道路扬尘事件携带，有值才显示
  imageUrl?: string     // AI视频分析缩略图（通过 /api/iot-image 代理）
  aiType?: string       // AI 分析类型（如 "堆头未覆盖"）
  aiConfidence?: number // AI 置信度 (0~1)
  // 聚合告警字段（命中推送规则后由后端折叠为 1 条）
  isAggregate?: boolean
  ruleId?: string
  ruleName?: string
  aggregateChannelSipId?: string | null
  aggregateAiType?: string
  windowHours?: number
  threshold?: number
  count?: number
  maxLevel?: number
  latestTime?: string
  memberIds?: string[]
  previewPicUrl?: string  // 聚合告警的预览图（后端 lightweight 输出，取组内首条 picUrl）
  status?: string        // 聚合告警组处理状态 pending / partial / handled（后端输出）
}

// 秸秆燃烧告警识别（AI 类型主数据为中文"秸秆燃烧"）
function isStrawAlert(alert: AlertItem): boolean {
  return (alert.aiType || alert.aggregateAiType || alert.type || '').includes('秸秆燃烧')
}

// 机场人员入侵告警识别（dock-guard 服务上报，aiType=机场人员入侵）
// 安全类告警：最高优先级 + 红色警示样式
function isDockGuardAlert(alert: AlertItem): boolean {
  return (alert.aiType || alert.aggregateAiType || alert.type || '').includes('机场人员入侵')
}

// Alert types that show plate + violation instead of value + limit
const PLATE_TYPES = ['道路扬尘 AI识别', '违规车辆 AI识别']
const DUST_AI_TYPES = ['扬尘超标 AI识别']

function isPlateType(type: string) { return PLATE_TYPES.includes(type) }
function isDustAiType(type: string) { return DUST_AI_TYPES.includes(type) }

// AI视频分析类告警（IoTCloud 推入）
const IOT_VIDEO_PREFIX = 'AI视频分析'
function isIotVideo(alert: AlertItem): boolean {
  return !!alert.type?.startsWith(IOT_VIDEO_PREFIX) || !!alert.imageUrl
}

// 时间显示：当天的告警显示「今日 HH:mm:ss」，跨天显示「MM-DD HH:mm:ss」
function displayAlertTime(alert: AlertItem): string {
  const full = alert.fullTime || alert.time
  const parts = full.split(' ')
  if (parts.length !== 2) return full  // 纯时间兜底
  const now = new Date()
  const todayKey = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return parts[0] === todayKey ? `今日 ${parts[1]}` : full
}

/** 是否今日告警（用于"实时/历史"分区） */
function isTodayAlert(alert: AlertItem): boolean {
  const full = alert.fullTime || alert.time
  const parts = full.split(' ')
  if (parts.length !== 2) return true  // 纯时间兜底 → 视为今日
  const now = new Date()
  const todayKey = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return parts[0] === todayKey
}

const INITIAL_ALERTS: AlertItem[] = []

const LEVEL_COLORS: Record<number, { bg: string; border: string; text: string; label: string }> = {
  1: { bg: 'rgba(33,150,243,0.1)', border: 'rgba(33,150,243,0.4)', text: '#64b5f6', label: '注意' },
  2: { bg: 'rgba(255,215,64,0.1)', border: 'rgba(255,215,64,0.4)', text: '#ffd740', label: '轻度' },
  3: { bg: 'rgba(255,112,67,0.1)', border: 'rgba(255,112,67,0.4)', text: '#ff7043', label: '中度' },
  4: { bg: 'rgba(244,67,54,0.12)', border: 'rgba(244,67,54,0.5)', text: '#ff4444', label: '重度' },
}

interface Props {
  onSelectAlert?: (alert: AlertItem) => void
  selectedAlertId?: string | null
}

export function AlertPanel({ onSelectAlert, selectedAlertId }: Props) {
  const [alerts, setAlerts] = useState<AlertItem[]>(INITIAL_ALERTS)
  const [flashId, setFlashId] = useState<string | null>(null)
  const [showModal, setShowModal] = useState(false)
  const [evidenceAlert, setEvidenceAlert] = useState<AlertItem | null>(null)
  const { externalAlerts, clearExternalAlerts } = useDashboard()

  // T16: 处置后轻刷新（alerts:refresh 事件总线）—— 替代原 alerts:reload 整页刷新
  //   payload: { kind: 'group'|'single'|'all', memberIds?: string[], id?: string,
  //              status?: 'handled'|'pending', verdict?: string, note?: string }
  //   局部更新 alerts 状态而非 location.reload，弹窗/选中态/轮询保留
  useEffect(() => {
    const onRefresh = (ev: Event) => {
      const e = ev as CustomEvent<{ kind?: string; memberIds?: string[]; id?: string; status?: 'handled' | 'pending'; verdict?: string; note?: string }>
      const detail = e.detail || {}
      const next = detail.status === 'pending' ? 'pending' : 'handled'  // 默认置 handled；撤销传 pending
      if (detail.kind === 'group' && Array.isArray(detail.memberIds)) {
        const set = new Set(detail.memberIds)
        setAlerts(prev => prev.map(a => {
          if (a.isAggregate && a.memberIds?.some(id => set.has(id))) {
            return { ...a, status: next }
          }
          // 单条记录若在 group 的 memberIds 中也视为已处置
          if (!a.isAggregate && set.has(a.id)) {
            return { ...a, status: next }
          }
          return a
        }))
        if (evidenceAlert && evidenceAlert.memberIds?.some(id => set.has(id))) {
          setEvidenceAlert(null)
        }
      } else if (detail.kind === 'single' && detail.id) {
        setAlerts(prev => prev.map(a => a.id === detail.id ? { ...a, status: next } : a))
        if (evidenceAlert?.id === detail.id) setEvidenceAlert(null)
      } else if (detail.kind === 'all') {
        setAlerts(prev => prev.map(a => ({ ...a, status: 'handled' })))
        setEvidenceAlert(null)
      }
    }
    window.addEventListener('alerts:refresh', onRefresh as EventListener)
    return () => window.removeEventListener('alerts:refresh', onRefresh as EventListener)
  }, [evidenceAlert])

  // Merge externally pushed alerts (from admin / MQTT / 采集预警) into the list
  useEffect(() => {
    if (externalAlerts.length === 0) return
    setAlerts(prev => {
      const next = [...prev]
      for (const item of externalAlerts) {
        const idx = next.findIndex(a => a.id === item.id)
        if (idx >= 0) next[idx] = item  // 聚合告警更新 / 单条覆盖
        else next.unshift(item)
      }
      return next.slice(0, 20)
    })
    const lastNew = externalAlerts[0]
    if (lastNew) {
      setFlashId(lastNew.id)
      setTimeout(() => setFlashId(null), 2000)
    }
  }, [externalAlerts])

  // 实时/历史分区（走查建议 #3）：今日 → 实时；跨天 → 历史（灰化置底）
  const todayAlerts = alerts.filter(isTodayAlert)
  const historyAlerts = alerts.filter(a => !isTodayAlert(a))
  // 排序：机场人员入侵 > 秸秆燃烧 > 其余；未处置优先（人员入侵=安全类，最高优先级置顶）
  const sortAlerts = (list: AlertItem[]) => {
    const weight = (a: AlertItem) =>
      (isDockGuardAlert(a) ? -2 : isStrawAlert(a) ? 0 : 2) + (a.status === 'handled' ? 1 : a.status === 'partial' ? 0.5 : 0)
    return [...list].sort((a, b) => weight(a) - weight(b))
  }
  const sortedToday = sortAlerts(todayAlerts)

  const renderAlertCard = (alert: AlertItem, historyDim = false) => {
          const style = LEVEL_COLORS[alert.level]
          const isSelected = selectedAlertId === alert.id
          const isFlashing = flashId === alert.id
          const iotVideo = isIotVideo(alert)
          const isStraw = isStrawAlert(alert)
          const isDockGuard = isDockGuardAlert(alert)
          const isHandled = alert.status === 'handled'
          const isPartial = alert.status === 'partial'

          return (
            <div
              key={alert.id}
              onClick={() => onSelectAlert?.(alert)}
              style={{
                margin: '4px 10px',
                padding: '6px 10px',
                background: isSelected ? 'rgba(0,170,255,0.15)' : (isDockGuard ? 'rgba(255,30,30,0.16)' : isHandled ? 'rgba(80,100,120,0.12)' : isPartial ? 'rgba(0,140,255,0.08)' : style.bg),
                border: `1px solid ${isSelected ? 'rgba(0,170,255,0.5)' : isStraw ? 'rgba(255,60,60,0.55)' : isHandled ? 'rgba(120,140,160,0.3)' : isPartial ? 'rgba(0,140,255,0.4)' : style.border}`,
                borderLeft: isDockGuard ? `3px solid #ff2222` : isStraw ? `3px solid #ff4444` : undefined,
                borderRadius: 3,
                cursor: 'pointer',
                animation: isFlashing ? 'alert-flash 0.5s ease 3' : 'none',
                transition: 'background 0.2s',
                ...(historyDim || isHandled ? { opacity: 0.6, filter: 'saturate(0.5)' } : {}),
              }}
            >
              {alert.isAggregate ? (
                // ── 聚合告警卡片（缩略图+计数徽章+紫色聚合标签+详情按钮）───
                <div className="flex items-start gap-3">
                  {/* 缩略图占位 + 计数徽章 */}
                  <div className="shrink-0" style={{ position: 'relative', width: 72, height: 48 }}>
                    <AlertThumbnail
                      src={alert.imageUrl}
                      borderColor="#7c3aed"
                      fallback={
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="1.5">
                          <path d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2z"/><path d="M3 9h18M9 3v18"/>
                        </svg>
                      }
                    />
                    {/* 计数徽章 */}
                    <span style={{
                      position: 'absolute', top: -6, right: -6,
                      background: '#7c3aed', color: '#fff', fontSize: 10, fontWeight: 700,
                      padding: '1px 6px', borderRadius: 8, minWidth: 18, textAlign: 'center',
                      fontFamily: "'JetBrains Mono', monospace", boxShadow: '0 0 6px rgba(124,58,237,0.6)',
                    }}>{alert.count}</span>
                  </div>

                  {/* 文字信息 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span style={{ padding: '2px 7px', background: '#7c3aed30', border: '1px solid #7c3aed60', color: '#a78bfa', fontSize: 10, borderRadius: 2, fontWeight: 600 }}>
                        聚合
                      </span>
                      {isDockGuard && <span style={{ padding: '2px 7px', background: 'rgba(255,30,30,0.22)', border: '1px solid rgba(255,60,60,0.8)', color: '#ff5252', fontSize: 10, borderRadius: 2, fontWeight: 800, animation: 'alert-flash 0.8s ease 3' }}>⚠️ 人员入侵</span>}
                      {isStraw && <span style={{ padding: '2px 7px', background: 'rgba(255,60,60,0.15)', border: '1px solid rgba(255,60,60,0.5)', color: '#ff6b6b', fontSize: 10, borderRadius: 2, fontWeight: 700 }}>🔥 秸秆</span>}
                      {isHandled && <span style={{ padding: '2px 7px', background: 'rgba(120,140,160,0.15)', border: '1px solid rgba(120,140,160,0.4)', color: '#8aa0b0', fontSize: 10, borderRadius: 2 }}>已处置</span>}
                      {isPartial && <span style={{ padding: '2px 7px', background: 'rgba(0,140,255,0.15)', border: '1px solid rgba(0,140,255,0.4)', color: '#64b5f6', fontSize: 10, borderRadius: 2 }}>部分处置</span>}
                      <span style={{ color: '#5a8aaa', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
                        {displayAlertTime(alert)}
                      </span>
                    </div>
                    <div style={{ color: '#c8e6ff', fontSize: 12.5, fontWeight: 500, marginBottom: 2 }}>
                      {alert.aggregateAiType || alert.aiType || alert.type}
                    </div>
                    <div style={{ color: '#5a8aaa', fontSize: 11 }}>
                      {alert.location} · <span style={{ color: style.text }}>{alert.windowHours}h内 {alert.count}+ 条 · 最高{style.label}</span>
                    </div>
                  </div>

                  {/* 详情按钮 */}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setEvidenceAlert(alert) }}
                    style={{
                      padding: '4px 12px', fontSize: 11, borderRadius: 3, flexShrink: 0,
                      border: '1px solid rgba(124,58,237,0.4)', background: 'rgba(124,58,237,0.12)',
                      color: '#a78bfa', cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: 600,
                    }}
                  >详情</button>
                </div>
              ) : iotVideo ? (
                // ── AI 视频分析卡片（带缩略图）───
                <div className="flex items-start gap-3">
                  {/* 缩略图（渐进加载） */}
                  <AlertThumbnail
                    src={alert.imageUrl}
                    borderColor={style.border}
                    onClick={alert.imageUrl ? () => window.open(alert.imageUrl, '_blank') : undefined}
                    fallback={
                      <>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3a5a70" strokeWidth="1.5">
                          <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>
                        </svg>
                        <span>暂无图片</span>
                      </>
                    }
                  />

                  {/* 文字信息 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span style={{ padding: '2px 7px', background: '#7c3aed30', border: '1px solid #7c3aed60', color: '#a78bfa', fontSize: 10, borderRadius: 2, fontWeight: 600 }}>
                        AI视频
                      </span>
                      {isDockGuard && <span style={{ padding: '2px 7px', background: 'rgba(255,30,30,0.22)', border: '1px solid rgba(255,60,60,0.8)', color: '#ff5252', fontSize: 10, borderRadius: 2, fontWeight: 800, animation: 'alert-flash 0.8s ease 3' }}>⚠️ 人员入侵</span>}
                      {isStraw && <span style={{ padding: '2px 7px', background: 'rgba(255,60,60,0.15)', border: '1px solid rgba(255,60,60,0.5)', color: '#ff6b6b', fontSize: 10, borderRadius: 2, fontWeight: 700 }}>🔥 秸秆</span>}
                      {isHandled && <span style={{ padding: '2px 7px', background: 'rgba(120,140,160,0.15)', border: '1px solid rgba(120,140,160,0.4)', color: '#8aa0b0', fontSize: 10, borderRadius: 2 }}>已处置</span>}
                      {isPartial && <span style={{ padding: '2px 7px', background: 'rgba(0,140,255,0.15)', border: '1px solid rgba(0,140,255,0.4)', color: '#64b5f6', fontSize: 10, borderRadius: 2 }}>部分处置</span>}
                      <span style={{ color: '#5a8aaa', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
                        {displayAlertTime(alert)}
                      </span>
                    </div>
                    <div style={{ color: '#c8e6ff', fontSize: 12.5, fontWeight: 500, marginBottom: 2 }}>
                      {alert.aiType || alert.type}
                    </div>
                    <div className="flex items-center gap-2">
                      <span style={{ color: '#5a8aaa', fontSize: 11 }}>{alert.location}</span>
                      {alert.aiConfidence != null && (
                        <span style={{
                          padding: '1px 6px', borderRadius: 3,
                          background: alert.aiConfidence >= 0.7 ? 'rgba(244,67,54,0.12)' : alert.aiConfidence >= 0.5 ? 'rgba(255,215,64,0.12)' : 'rgba(33,150,243,0.12)',
                          color: alert.aiConfidence >= 0.7 ? '#ff7043' : alert.aiConfidence >= 0.5 ? '#ffd740' : '#64b5f6',
                          fontSize: 10, fontWeight: 700,
                          fontFamily: "'JetBrains Mono', monospace",
                        }}>
                          {Math.round(alert.aiConfidence * 100)}%
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                // ── 普通告警卡片（原有布局）───
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span
                      style={{
                        padding: '2px 7px',
                        background: style.border,
                        color: style.text,
                        fontSize: 11,
                        borderRadius: 2,
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {style.label}
                    </span>
                    {isStraw && <span style={{ padding: '2px 7px', background: 'rgba(255,60,60,0.15)', border: '1px solid rgba(255,60,60,0.5)', color: '#ff6b6b', fontSize: 10, borderRadius: 2, fontWeight: 700 }}>🔥 秸秆</span>}
                    {isHandled && <span style={{ padding: '2px 7px', background: 'rgba(120,140,160,0.15)', border: '1px solid rgba(120,140,160,0.4)', color: '#8aa0b0', fontSize: 10, borderRadius: 2 }}>已处置</span>}
                    {isPartial && <span style={{ padding: '2px 7px', background: 'rgba(0,140,255,0.15)', border: '1px solid rgba(0,140,255,0.4)', color: '#64b5f6', fontSize: 10, borderRadius: 2 }}>部分处置</span>}
                    <span style={{ color: '#5a8aaa', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
                      {displayAlertTime(alert)}
                    </span>
                  </div>
                  <div style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 500, marginBottom: 3 }}>
                    {alert.type}
                  </div>
                  <div style={{ color: '#5a8aaa', fontSize: 12 }}>{alert.location}</div>
                  {alert.licensePlate && alert.type.includes('道路扬尘') && (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                      <span style={{
                        padding: '1px 7px',
                        borderRadius: 2,
                        background: 'rgba(255,112,67,0.12)',
                        border: '1px solid rgba(255,112,67,0.4)',
                        color: '#ff7043',
                        fontSize: 11,
                        fontFamily: "'JetBrains Mono', monospace",
                        letterSpacing: '0.06em',
                        fontWeight: 700,
                      }}>
                        {alert.licensePlate}
                      </span>
                    </div>
                  )}
                </div>
                <div className="text-right shrink-0" style={{ maxWidth: 130 }}>
                  {isPlateType(alert.type) || isDustAiType(alert.type) ? (
                    <>
                      <div style={{
                        color: style.text, fontSize: 13,
                        fontFamily: isPlateType(alert.type) ? "'JetBrains Mono', monospace" : "'Noto Sans SC', sans-serif",
                        fontWeight: 700, letterSpacing: isPlateType(alert.type) ? '0.05em' : 0,
                        whiteSpace: 'nowrap',
                      }}>
                        {alert.value}
                      </div>
                      <div style={{
                        color: '#5a8aaa', fontSize: 11,
                        marginTop: 2, whiteSpace: 'nowrap',
                      }}>
                        {alert.standard}
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ color: style.text, fontSize: 12, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>
                        {alert.value}
                      </div>
                      <div style={{ color: '#3a5a70', fontSize: 11 }}>限值 {alert.standard}</div>
                    </>
                  )}
                </div>
              </div>
              )}
            </div>
          )
  }

  return (
    <div className="flex flex-col h-full">
      <PanelHeader color="#ff4444" title="实时告警" count={todayAlerts.length} onMore={() => setShowModal(true)} />
      <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'none' }}>
        {alerts.length === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#3a5a70', gap: 8, padding: 20 }}>
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#2a4a60" strokeWidth="1.5">
              <path d="M12 2a7 7 0 0 0-7 7c0 3.5-1.5 5-2 6h18c-.5-1-2-2.5-2-6a7 7 0 0 0-7-7z" />
              <path d="M9 20a3 3 0 0 0 6 0" />
            </svg>
            <span style={{ fontSize: 13 }}>暂无告警</span>
            <span style={{ fontSize: 11, color: '#2a4a60' }}>监测数据超标时将实时推送</span>
          </div>
        )}

        {/* ── 实时告警（今日） ── */}
        {todayAlerts.length > 0 && (
          <div style={{ padding: '6px 12px 2px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#ff4444', boxShadow: '0 0 6px #ff4444' }} />
            <span style={{ color: '#ff9b9b', fontSize: 10, letterSpacing: '0.1em', fontWeight: 600 }}>实时告警（今日）</span>
            <span style={{ color: '#3a5a70', fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}>{todayAlerts.length}</span>
          </div>
        )}
        {sortedToday.map(alert => renderAlertCard(alert, false))}

        {/* ── 历史告警（跨天，灰化置底） ── */}
        {historyAlerts.length > 0 && (
          <div style={{ padding: '10px 12px 2px', display: 'flex', alignItems: 'center', gap: 6, borderTop: '1px dashed rgba(0,100,170,0.2)', marginTop: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#5a6b7a' }} />
            <span style={{ color: '#5a6b7a', fontSize: 10, letterSpacing: '0.1em', fontWeight: 600 }}>历史告警（跨天）</span>
            <span style={{ color: '#3a5a70', fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}>{historyAlerts.length}</span>
          </div>
        )}
        {historyAlerts.map(alert => renderAlertCard(alert, true))}
      </div>
      <style>{`
        @keyframes alert-flash {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>

      {showModal && <AlertHistoryModal alerts={alerts} onClose={() => setShowModal(false)} />}
      {evidenceAlert && <AlertEvidenceModal alert={evidenceAlert} onClose={() => setEvidenceAlert(null)} />}
    </div>
  )
}

function PanelHeader({ color, title, count, onMore }: { color: string; title: string; count?: number; onMore?: () => void }) {
  return (
    <div
      className="flex items-center justify-between px-3 shrink-0"
      style={{
        height: 40,
        borderBottom: `1px solid rgba(0,150,220,0.15)`,
        borderLeft: `3px solid ${color}`,
        background: `linear-gradient(90deg, ${color}18, transparent)`,
      }}
    >
      <span style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 600, fontFamily: "'Noto Sans SC', sans-serif" }}>
        {title}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {count !== undefined && (
          <span style={{
            background: `${color}30`, color,
            fontSize: 11, padding: '2px 8px',
            borderRadius: 10, fontFamily: "'JetBrains Mono', monospace",
          }}>
            {count}
          </span>
        )}
        {onMore && (
          <button
            onClick={onMore}
            style={{
              padding: '2px 10px', fontSize: 11, borderRadius: 3,
              border: '1px solid rgba(255,215,64,0.35)',
              background: 'rgba(255,215,64,0.08)',
              color: '#ffd740', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 3,
              transition: 'all 0.15s',
            }}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#ffd740" strokeWidth="2.5">
              <path d="M9 18l6-6-6-6" />
            </svg>
            更多
          </button>
        )}
      </div>
    </div>
  )
}
