import { useState, useEffect, useCallback } from 'react'
import type { AlertItem } from './AlertPanel'
import { authFetch } from '../lib/apiFetch'
import { EvidenceGrid } from './EvidenceGrid'

interface MemberWarning {
  id: string
  picUrl: string
  createdAt: string
  level: number
  aiConfidence: number
  channelName: string
  aiType: string
  status?: string     // pending / handled
}

interface Props {
  alert: AlertItem
  onClose: () => void
}

const LEVEL_LABELS: Record<number, string> = { 1: '注意', 2: '轻度', 3: '中度', 4: '重度' }
const LEVEL_COLORS: Record<number, string> = { 1: '#64b5f6', 2: '#ffd740', 3: '#ff7043', 4: '#ff4444' }

// 聚合事件最多展示的图片数（其余仅以数字统计，降低前端图片加载负担）
const MAX_AGG_IMAGES = 10

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

  // ── 处置：有效转处置 / 误报（带归因）──
  const handleGroup = async (kind: 'valid' | 'false') => {
    if (!alert.memberIds || alert.memberIds.length === 0) return
    setHandling(true)
    setHandleMsg('')
    try {
      const reason = kind === 'false' ? (window.prompt('误报归因（可选）：晨雾 / 白云 / 烟囱 / 扬尘 / 反光 / 乡村土路 / 其他', '晨雾') || '误报') : '有效告警·转处置'
      const res = await authFetch('/api/warnings/handle-group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberIds: alert.memberIds, handledBy: '值守人员' }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) { setHandleMsg('处置失败：' + (data.error || res.status)); return }
      setHandleMsg(kind === 'valid' ? `✓ 已标记处置（${data.handled || 0} 条，归因：${reason}）` : `✓ 已标记误报（${data.handled || 0} 条，归因：${reason}）`)
      // 刷新成员状态
      await load()
      // 通知父组件刷新（若提供回调）
      window.dispatchEvent(new CustomEvent('alerts:reload'))
    } catch (e: any) {
      setHandleMsg('处置失败：' + (e?.message || e))
    } finally {
      setHandling(false)
    }
  }

  // 组内已处置计数
  const handledCount = members.filter(m => m.status === 'handled').length
  const allHandled = totalMembers > 0 && handledCount >= totalMembers

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
            {allHandled ? (
              <span style={{ color: '#4ade80', fontSize: 13, fontWeight: 700 }}>✓ 已处置（{handledCount}/{totalMembers}）</span>
            ) : (
              <>
                <button
                  type="button"
                  disabled={handling}
                  onClick={() => handleGroup('valid')}
                  style={{
                    padding: '6px 16px', fontSize: 12, fontWeight: 700, cursor: handling ? 'wait' : 'pointer',
                    border: 'none', borderRadius: 4, color: '#fff',
                    background: handling ? '#3a5a70' : 'linear-gradient(90deg, #0e8f4a, #1fb96a)',
                    boxShadow: '0 2px 8px rgba(31,185,106,0.3)',
                  }}
                >✅ 有效 · 转处置</button>
                <button
                  type="button"
                  disabled={handling}
                  onClick={() => handleGroup('false')}
                  style={{
                    padding: '6px 16px', fontSize: 12, fontWeight: 700, cursor: handling ? 'wait' : 'pointer',
                    border: '1px solid rgba(255,170,60,0.4)', borderRadius: 4,
                    background: 'rgba(255,170,60,0.12)', color: '#ffb74d',
                  }}
                >❌ 误报 · 标记</button>
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
