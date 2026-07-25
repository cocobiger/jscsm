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

        {/* 底部说明 */}
        <div style={{ padding: '8px 20px', borderTop: '1px solid rgba(0,80,150,0.15)', color: '#3a5a70', fontSize: 11 }}>
          以上为「{alert.ruleName || '推送规则'}」在 {alert.windowHours || 24}h 内命中的全部原始记录，作为本次聚合告警的研判依据。
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
