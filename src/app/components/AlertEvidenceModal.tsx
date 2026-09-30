import { useState, useEffect, useCallback } from 'react'
import type { AlertItem } from './AlertPanel'
import { authFetch } from '../lib/apiFetch'
import { fetchMe, roleAtLeast } from '../lib/auth'
import { EvidenceGrid } from './EvidenceGrid'
import { reviewBadgeOf, reviewBadgeStyle } from './warningReview'
import { StrawLiveModal } from './StrawLiveModal'

interface MemberWarning {
  id: string
  picUrl: string
  createdAt: string
  firstSeenAt?: string  // G4': 完整首见时间（取证帧时间对齐）
  level: number
  aiConfidence: number
  channelName: string
  aiType: string
  status?: string     // pending / handled
  review?: { verdict?: 'valid' | 'false'; note?: string; by?: string; at?: string }  // T18: 归因（组内已处置成员携带）
}

interface Props {
  alert: AlertItem
  onClose: () => void
}

const LEVEL_LABELS: Record<number, string> = { 1: '注意', 2: '轻度', 3: '中度', 4: '重度' }
const LEVEL_COLORS: Record<number, string> = { 1: '#64b5f6', 2: '#ffd740', 3: '#ff7043', 4: '#ff4444' }

// 聚合事件最多展示的图片数（其余仅以数字统计，降低前端图片加载负担）
const MAX_AGG_IMAGES = 10

// T18: 误报归因候选（沿用既有 prompt 候选词，去掉原生 prompt 改自定义弹层）
const FALSE_REASONS: Array<{ key: string; label: string }> = [
  { key: '晨雾', label: '晨雾' },
  { key: '白云', label: '白云' },
  { key: '烟囱', label: '烟囱蒸汽' },
  { key: '扬尘', label: '扬尘' },
  { key: '反光', label: '反光/水汽' },
  { key: '乡村土路', label: '乡村土路' },
  { key: '其他', label: '其他（自定义）' },
]

function fmtTime(s: string): string {
  if (!s) return '—'
  // 兼容 "2026-07-10 10:51:53" 和 ISO
  const d = new Date(s.replace(' ', 'T'))
  if (isNaN(d.getTime())) return s.slice(5, 19) || s
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${mm}-${dd} ${d.toTimeString().slice(0, 8)}`
}

export function AlertEvidenceModal({ alert, onClose }: Props) {
  const [members, setMembers] = useState<MemberWarning[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [handling, setHandling] = useState(false)
  const [handleMsg, setHandleMsg] = useState('')
  // P1（2026-09-14）：处置权限——operator 及以上可处置；viewer 只读（防大屏误操作污染样本库）
  const [canDispose, setCanDispose] = useState(true)
  // P2（2026-09-14）：带框直播弹窗（straw 告警现场复核）
  const [liveOpen, setLiveOpen] = useState(false)
  // T18: 误报归因自定义弹层状态
  const [falseOpen, setFalseOpen] = useState(false)
  const [falseCategory, setFalseCategory] = useState('晨雾')
  const [falseNote, setFalseNote] = useState('')
  // G4': 高清取证帧（dock_media 1080p/4K 自动取证 → /api/forensics/nearest）
  const [forensics, setForensics] = useState<null | { url: string; ts: string; deltaSec: number; tier: string }>(null)
  const [, setForensicsLoading] = useState(false)
  // 真实总数（用于「前 X / 共 Y」与省略提示；取 memberIds 长度，与后端命中数一致）
  const totalMembers = alert.memberIds?.length || 0

  const load = useCallback(async () => {
    if (!alert.memberIds || alert.memberIds.length === 0) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const res = await authFetch('/api/warnings/by-ids', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: alert.memberIds }),
      })
      if (!res.ok) { setError('加载失败（' + res.status + '）'); setLoading(false); return }
      const data = await res.json()
      const arr = Array.isArray(data) ? data : []
      // 按时间倒序
      arr.sort((a: MemberWarning, b: MemberWarning) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      // 仅取前 MAX_AGG_IMAGES 张用于渲染；其余以数字统计（降低前端图片加载负担）
      setMembers(arr.slice(0, MAX_AGG_IMAGES))
    } catch (e: any) {
      setError('加载失败：' + (e?.message || e))
    } finally {
      setLoading(false)
    }
  }, [alert.memberIds])

  useEffect(() => { load() }, [load])

  // P1：加载当前用户角色，operator 以下禁用处置按钮
  useEffect(() => {
    let cancelled = false
    fetchMe().then(u => { if (!cancelled) setCanDispose(roleAtLeast(u?.role, 'operator')) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  // G4': 高清取证帧加载（秸秆源告警才有取证意义；取组内最新成员时间对齐取证帧）
  useEffect(() => {
    const straw = members.find(m => (m.aiType || '').includes('秸秆') || (m.aiType || '').includes('straw'))
    const latest = members[0]
    const ts = latest?.firstSeenAt || latest?.createdAt
    if (!straw || !ts) { setForensics(null); return }
    let cancelled = false
    setForensicsLoading(true)
    authFetch(`/api/forensics/nearest?ts=${encodeURIComponent(ts)}&win=900`)
      .then(res => res.json())
      .then(data => {
        if (cancelled) return
        if (data?.ok && data.nearest) {
          setForensics({
            url: data.nearest.url,
            ts: data.nearest.ts,
            deltaSec: data.nearest.deltaSec,
            tier: data.nearest.obj.includes('_V.') ? '4K' : '1080P',
          })
        } else setForensics(null)
      })
      .catch(() => { if (!cancelled) setForensics(null) })
      .finally(() => { if (!cancelled) setForensicsLoading(false) })
    return () => { cancelled = true }
  }, [members])

  // ── 处置：有效转处置 / 误报（带归因）──
  // T18: verdict/note 透传后端写 data_json.review；归因走自定义弹层
  const submitHandle = async (verdict: string, note: string) => {
    if (!alert.memberIds || alert.memberIds.length === 0) return
    setHandling(true)
    setHandleMsg('')
    try {
      const res = await authFetch('/api/warnings/handle-group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberIds: alert.memberIds, handledBy: '值守人员', verdict, note }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) { setHandleMsg('处置失败：' + (data.error || res.status)); return }
      const desc = verdict === 'valid' ? '有效告警' : (note ? `误报·${note}` : '误报')
      setHandleMsg(`✓ 已标记处置（${data.handled || 0} 条，归因：${desc}）`)
      // 刷新成员状态
      await load()
      // T16/T18: 派发 refresh 事件（替代原 alerts:reload 整页刷新）—— 跨组件同步状态
      window.dispatchEvent(new CustomEvent('alerts:refresh', {
        detail: { kind: 'group', memberIds: alert.memberIds, verdict, note },
      }))
    } catch (e: any) {
      setHandleMsg('处置失败：' + (e?.message || e))
    } finally {
      setHandling(false)
    }
  }
  // 有效：直接提交（verdict=valid 无归因）
  const handleGroupValid = () => submitHandle('valid', '')
  // 误报：打开归因弹层（弹层内确认才提交）
  const openFalsePanel = () => {
    setFalseCategory('晨雾'); setFalseNote(''); setFalseOpen(true)
  }
  const confirmFalse = () => {
    const note = falseCategory === '其他' ? (falseNote.trim() || '其他') : falseCategory
    setFalseOpen(false)
    submitHandle('false', note)
  }

  // 组内已处置计数
  const handledCount = members.filter(m => m.status === 'handled').length
  const allHandled = totalMembers > 0 && handledCount >= totalMembers
  // T18: 组归因徽标（handle-group 一次写入全体成员同值 review，取首条有值者展示）
  const groupReview = members.find(m => m.review)?.review

  const level = alert.level || alert.maxLevel || 1
  const levelColor = LEVEL_COLORS[level] || '#64b6f6'
  const levelLabel = LEVEL_LABELS[level] || '注意'

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 2000,
        background: 'rgba(0,0,0,0.7)', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '90%', maxWidth: 800, maxHeight: '85vh',
          background: 'linear-gradient(180deg, #0a1929, #0d2137)',
          border: `1px solid ${levelColor}40`, borderRadius: 8,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          boxShadow: `0 8px 32px rgba(0,0,0,0.6), 0 0 1px ${levelColor}30`,
        }}
      >
        {/* 标题栏 */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 20px', borderBottom: '1px solid rgba(124,58,237,0.2)',
          background: 'rgba(124,58,237,0.08)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{
              padding: '3px 10px', background: '#7c3aed30', border: '1px solid #7c3aed60',
              color: '#a78bfa', fontSize: 11, borderRadius: 3, fontWeight: 700,
            }}>研判依据</span>
            <span style={{ color: '#c8e6ff', fontSize: 15, fontWeight: 600 }}>
              {alert.ruleName || '事件研判逻辑'} · {alert.aggregateAiType || alert.aiType || 'AI分析'}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              border: 'none', background: 'transparent', color: '#5a8aaa',
              fontSize: 20, cursor: 'pointer', lineHeight: 1, padding: 0,
            }}
          >×</button>
        </div>

        {/* 摘要区 */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
          gap: 1, padding: '14px 20px', borderBottom: '1px solid rgba(0,80,150,0.15)',
          background: 'rgba(0,20,50,0.3)',
        }}>
          <SummaryItem label="通道" value={alert.location} />
          <SummaryItem label="AI类型" value={alert.aggregateAiType || alert.aiType || '—'} />
          <SummaryItem label="时间窗" value={`${alert.windowHours || 24}h`} />
          <SummaryItem label="阈值" value={`${alert.threshold || 0} 条`} />
          <SummaryItem label="命中" value={`${alert.count || 0} 条`} valueColor="#a78bfa" />
          <SummaryItem label="最高等级" value={levelLabel} valueColor={levelColor} />
          <SummaryItem label="最新时间" value={fmtTime(alert.latestTime || alert.fullTime || '')} />
        </div>

        {/* 成员证据网格（复用共享 EvidenceGrid 组件） */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 20px' }}>
          {/* G4': 高清取证帧卡片（dock_media 1080p/4K 自动取证） */}
          {forensics && (
            <div style={{
              marginBottom: 14, border: '1px solid rgba(31,185,106,0.35)', borderRadius: 6,
              background: 'rgba(14,143,74,0.10)', overflow: 'hidden',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '8px 12px', borderBottom: '1px solid rgba(31,185,106,0.2)',
                background: 'rgba(14,143,74,0.14)',
              }}>
                <span style={{ color: '#4ade80', fontSize: 12, fontWeight: 700 }}>
                  🎯 高清取证帧 <span style={{ color: '#7ab8e0', fontWeight: 500 }}>（{forensics.tier} · 时间差 {forensics.deltaSec}s · {forensics.ts}）</span>
                </span>
                <a href={forensics.url} target="_blank" rel="noreferrer"
                   style={{ color: '#7ab8e0', fontSize: 11, textDecoration: 'none' }}>新窗口打开 ↗</a>
              </div>
              <img src={forensics.url} alt="高清取证"
                   style={{ width: '100%', maxHeight: 360, objectFit: 'contain', background: '#000', display: 'block' }} />
            </div>
          )}
          <EvidenceGrid
            evidences={members.map(m => ({
              id: m.id,
              picUrl: m.picUrl || '',
              time: m.createdAt || '',
              confidence: m.aiConfidence != null ? Number(m.aiConfidence) : null,
              level: m.level || 1,
              channelName: m.channelName || '',
              aiType: m.aiType || '',
            }))}
            evidenceType={loading ? 'no_events' : (members.length ? 'evidence' : 'no_events')}
            message={error || '暂无关联证据'}
            loading={loading}
            totalCount={totalMembers}
          />
        </div>

        {/* 处置操作区 */}
        <div style={{
          padding: '12px 20px', borderTop: '1px solid rgba(0,150,220,0.2)',
          background: 'rgba(0,40,90,0.35)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ color: '#7ab8e0', fontSize: 12, fontWeight: 700 }}>处置操作</span>
            {/* P2：straw 告警 → 带框直播（现场复核） */}
            {(alert.source === 'straw-engine' || (alert.aggregateAiType || alert.aiType || '').includes('秸秆')) && alert.aggregateChannelSipId && (
              <button
                type="button"
                onClick={() => setLiveOpen(true)}
                style={{
                  padding: '6px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                  border: '1px solid rgba(255,60,60,0.45)', borderRadius: 4,
                  background: 'rgba(255,60,60,0.12)', color: '#ff9b9b',
                }}
              >📺 带框直播</button>
            )}
            {allHandled ? (
              <>
                <span style={{ color: '#4ade80', fontSize: 13, fontWeight: 700 }}>✓ 已处置（{handledCount}/{totalMembers}）</span>
                {/* T18: 归因徽标（成员 review 判空兼容旧记录/秸秆复检字符串） */}
                {(() => {
                  const badge = reviewBadgeOf(groupReview)
                  if (!badge) return null
                  const s = reviewBadgeStyle(badge.kind)
                  return (
                    <span title={badge.title} style={{
                      padding: '2px 8px', fontSize: 11, borderRadius: 3,
                      border: `1px solid ${s.border}`, background: s.bg, color: s.color,
                    }}>{badge.text}</span>
                  )
                })()}
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={!canDispose || handling}
                  onClick={() => { if (!canDispose) return; if (window.confirm('确认将该组标记为有效告警并转处置？')) handleGroupValid() }}
                  style={{
                    padding: '6px 16px', fontSize: 12, fontWeight: 700, cursor: (!canDispose || handling) ? 'not-allowed' : 'pointer',
                    border: 'none', borderRadius: 4, color: '#fff',
                    background: (!canDispose || handling) ? '#3a5a70' : 'linear-gradient(90deg, #0e8f4a, #1fb96a)',
                    boxShadow: canDispose ? '0 2px 8px rgba(31,185,106,0.3)' : 'none',
                  }}
                >✅ 有效 · 转处置</button>
                <button
                  type="button"
                  disabled={!canDispose || handling}
                  onClick={() => { if (!canDispose) return; openFalsePanel() }}
                  style={{
                    padding: '6px 16px', fontSize: 12, fontWeight: 700, cursor: (!canDispose || handling) ? 'not-allowed' : 'pointer',
                    border: '1px solid rgba(255,170,60,0.4)', borderRadius: 4,
                    background: 'rgba(255,170,60,0.12)', color: '#ffb74d',
                    opacity: canDispose ? 1 : 0.5,
                  }}
                >❌ 误报 · 标记</button>
                {!canDispose && <span style={{ color: '#5a8aaa', fontSize: 11 }}>当前账号无处置权限（需 operator）</span>}
              </>
            )}
            {handleMsg && <span style={{ color: handleMsg.startsWith('✓') ? '#4ade80' : '#ff7043', fontSize: 12 }}>{handleMsg}</span>}
          </div>
          {handledCount > 0 && !allHandled && (
            <div style={{ marginTop: 6, fontSize: 11, color: '#5a8aaa' }}>
              已处置 {handledCount}/{totalMembers} 条（剩余待处理）
            </div>
          )}
        </div>

        {/* 底部说明 */}
        <div style={{ padding: '8px 20px', borderTop: '1px solid rgba(0,80,150,0.15)', color: '#3a5a70', fontSize: 11 }}>
          以上为「{alert.ruleName || '推送规则'}」在 {alert.windowHours || 24}h 内命中的全部原始记录，作为本次聚合告警的研判依据。处置操作在驾驶舱内完成，无需跳转外部系统。
        </div>
      </div>

      {/* T18: 误报归因自定义弹层（替代原 window.prompt，更顺滑的交互） */}
      {falseOpen && (
        <div
          onClick={e => { if (e.target === e.currentTarget) setFalseOpen(false) }}
          style={{ position: 'fixed', inset: 0, zIndex: 2100, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 420, maxWidth: '90vw', background: 'linear-gradient(180deg,#1a1428,#0d0a18)', border: '1px solid rgba(255,170,60,0.5)', borderRadius: 8, padding: '18px 20px 14px', boxShadow: '0 0 30px rgba(255,170,60,0.2)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <span style={{ fontSize: 16 }}>❌</span>
              <span style={{ color: '#ffb74d', fontSize: 14, fontWeight: 700 }}>误报归因</span>
              <span style={{ color: '#5a8aaa', fontSize: 11, marginLeft: 'auto' }}>{alert.memberIds?.length || 0} 条将标记误报</span>
            </div>
            <div style={{ color: '#7ab8e0', fontSize: 11, marginBottom: 8 }}>选择误报类型（用于反哺模型调优与统计）</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 10 }}>
              {FALSE_REASONS.map(r => (
                <button key={r.key} type="button" onClick={() => setFalseCategory(r.key)} style={{
                  padding: '6px 8px', fontSize: 12, borderRadius: 4, cursor: 'pointer', textAlign: 'center',
                  border: `1px solid ${falseCategory === r.key ? 'rgba(255,170,60,0.7)' : 'rgba(0,100,180,0.3)'}`,
                  background: falseCategory === r.key ? 'rgba(255,170,60,0.2)' : 'rgba(0,40,90,0.4)',
                  color: falseCategory === r.key ? '#ffb74d' : '#9ad6f0',
                  fontWeight: falseCategory === r.key ? 700 : 500,
                }}>{r.label}</button>
              ))}
            </div>
            {falseCategory === '其他' && (
              <input value={falseNote} onChange={e => setFalseNote(e.target.value)} placeholder="请输入具体归因（可选）" maxLength={50} style={{
                width: '100%', padding: '6px 10px', background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.3)',
                borderRadius: 3, color: '#c8e6ff', fontSize: 12, outline: 'none', boxSizing: 'border-box', marginBottom: 10,
              }} />
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" onClick={() => setFalseOpen(false)} style={{
                padding: '5px 16px', fontSize: 12, borderRadius: 3, cursor: 'pointer',
                border: '1px solid rgba(0,150,220,0.3)', background: 'rgba(0,100,180,0.12)', color: '#7ab8e0',
              }}>取消</button>
              <button type="button" onClick={confirmFalse} style={{
                padding: '5px 18px', fontSize: 12, fontWeight: 600, borderRadius: 3, cursor: 'pointer',
                border: '1px solid rgba(255,170,60,0.6)', background: 'rgba(255,170,60,0.2)', color: '#ffd6a3',
              }}>确认误报</button>
            </div>
          </div>
        </div>
      )}
      {/* P2：带框直播弹窗（straw 告警现场复核；zIndex 2400 盖过本弹窗 2000） */}
      {liveOpen && alert.aggregateChannelSipId && (
        <StrawLiveModal
          deviceSn={alert.aggregateChannelSipId.replace(/^sikong_/, '')}
          title={alert.location}
          sub={alert.aggregateAiType || alert.aiType || undefined}
          onClose={() => setLiveOpen(false)}
        />
      )}
    </div>
  )
}

function SummaryItem({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div>
      <div style={{ color: '#3a5a70', fontSize: 10, marginBottom: 2 }}>{label}</div>
      <div style={{ color: valueColor || '#c8e6ff', fontSize: 13, fontWeight: 600 }}>{value}</div>
    </div>
  )
}
