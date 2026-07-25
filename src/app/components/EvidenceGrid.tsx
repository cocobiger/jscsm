import { useState, useEffect } from 'react'

// 单条关联证据（来自 warnings 表经 memberIds 反查）
export interface EvidenceItem {
  id: string
  picUrl: string
  time: string
  confidence: number | null
  level: number
  channelName: string
  aiType: string
}

// 分态标识：决定空态文案与样式
export type EvidenceType = 'evidence' | 'expired' | 'sensor' | 'no_events'

interface Props {
  evidences: EvidenceItem[]
  evidenceType: EvidenceType
  message: string | null
  loading?: boolean
  // compact=true 时只渲染网格/空态（不含内置计数标题），用于嵌入已有标题的详情弹窗
  compact?: boolean
  // 真实总数（当仅展示前 N 条时传入，用于「前 X / 共 Y」与省略提示）
  totalCount?: number
}

const LEVEL_LABELS: Record<number, string> = { 1: '注意', 2: '轻度', 3: '中度', 4: '重度' }
const LEVEL_COLORS: Record<number, string> = { 1: '#64b5f6', 2: '#ffd740', 3: '#ff7043', 4: '#ff4444' }

function fmtTime(s: string): string {
  if (!s) return '—'
  // 兼容 "2026-07-10 10:51:53" 和 ISO
  const d = new Date(s.replace(' ', 'T'))
  if (isNaN(d.getTime())) return s.slice(5, 19) || s
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${mm}-${dd} ${d.toTimeString().slice(0, 8)}`
}

function confColor(c: number): string {
  if (c >= 0.7) return '#ff7043'
  if (c >= 0.5) return '#ffd740'
  return '#64b5f6'
}

export function EvidenceGrid({ evidences, evidenceType, message, loading, compact, totalCount }: Props) {
  // 真实总数：未传 totalCount 时回退为当前已加载条数
  const total = totalCount != null ? totalCount : evidences.length
  const hiddenCount = Math.max(total - evidences.length, 0)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  // 切换证据时关闭预览
  useEffect(() => { setPreviewUrl(null) }, [evidenceType, evidences])

  const grid = (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 10 }}>
      {evidences.map((m, idx) => {
        const mLevel = m.level || 1
        const mColor = LEVEL_COLORS[mLevel] || '#64b6f6'
        const imgUrl = m.picUrl ? `/api/iot-image?url=${encodeURIComponent(m.picUrl)}` : null
        return (
          <div
            key={m.id || idx}
            onClick={() => imgUrl && setPreviewUrl(imgUrl)}
            style={{
              borderRadius: 4, overflow: 'hidden', cursor: imgUrl ? 'pointer' : 'default',
              border: `1px solid ${mColor}30`, background: 'rgba(0,20,60,0.4)',
            }}
          >
            {/* 缩略图 */}
            <div style={{ width: '100%', height: 80, position: 'relative', background: 'rgba(0,20,60,0.6)' }}>
              {imgUrl ? (
                <img
                  src={imgUrl} alt={m.aiType} loading="lazy"
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                />
              ) : (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3a5a70', fontSize: 10 }}>暂无图片</div>
              )}
              {/* 等级角标 */}
              <span style={{
                position: 'absolute', top: 4, left: 4,
                padding: '1px 5px', borderRadius: 2, fontSize: 9, fontWeight: 700,
                background: `${mColor}30`, color: mColor, border: `1px solid ${mColor}60`,
              }}>{LEVEL_LABELS[mLevel] || '注意'}</span>
            </div>
            {/* 信息条：时间 + 置信度 + 通道 + AI类型 */}
            <div style={{ padding: '5px 7px' }}>
              <div style={{ color: '#9ad6f0', fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}>{fmtTime(m.time)}</div>
              {m.confidence != null && (
                <div style={{ color: confColor(m.confidence), fontSize: 10, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>
                  置信度 {Math.round(m.confidence * 100)}%
                </div>
              )}
              {m.channelName && (
                <div style={{ color: '#7ab8e0', fontSize: 10, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  📍 {m.channelName}
                </div>
              )}
              {m.aiType && (
                <div style={{ color: '#5a8aaa', fontSize: 10, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {m.aiType}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )

  return (
    <div>
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40, color: '#5a8aaa', fontSize: 13, gap: 8 }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#5a8aaa" strokeWidth="2" style={{ animation: 'spin 1s linear infinite' }}>
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
          正在加载证据…
        </div>
      ) : evidenceType === 'evidence' && evidences.length > 0 ? (
        <>
          {!compact && (
            <div style={{ color: '#5a8aaa', fontSize: 12, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5a8aaa" strokeWidth="2">
                <path d="M21 19V5a2 0 0 0-2-2H5a2 0 0 0-2 2v14a2 0 0 0 2 2h14a2 0 0 0 2-2z" /><path d="M3 9h18M9 3v18" />
              </svg>
              {hiddenCount > 0
                ? `关联证据（前 ${evidences.length} / 共 ${total} 条）`
                : `关联证据（${evidences.length} 条）`}
            </div>
          )}
          {grid}
          {hiddenCount > 0 && (
            <div style={{
              marginTop: 10, padding: '8px 12px', borderRadius: 4,
              background: 'rgba(0,20,60,0.4)', border: '1px dashed rgba(0,150,220,0.3)',
              color: '#5a8aaa', fontSize: 11, display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#5a8aaa" strokeWidth="2">
                <circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" />
              </svg>
              另有 <b style={{ color: '#9ad6f0', fontFamily: "'JetBrains Mono', monospace" }}>{hiddenCount}</b> 张图片未渲染，仅以数字统计（已省略图片加载以降低前端负载）。
            </div>
          )}
        </>
      ) : (
        <div style={{
          color: evidenceType === 'expired' ? '#ff7043' : '#3a5a70',
          fontSize: 13, padding: 20, textAlign: 'center',
          background: evidenceType === 'expired' ? 'rgba(255,112,67,0.06)' : 'transparent',
          borderRadius: 4,
        }}>{message || '暂无关联证据'}</div>
      )}

      {/* 图片放大预览 */}
      {previewUrl && (
        <div
          onClick={() => setPreviewUrl(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 2100, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out' }}
        >
          <img src={previewUrl} alt="" style={{ maxWidth: '90%', maxHeight: '90%', borderRadius: 4, boxShadow: '0 8px 32px rgba(0,0,0,0.6)' }} />
        </div>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
