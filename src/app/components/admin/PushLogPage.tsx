import { useState, useEffect, useCallback } from 'react'
import { authFetch } from '../../lib/apiFetch'
import { roleAtLeast, type CurrentUser } from '../../lib/auth'

// ── 秸秆微信推送记录（P3 T19）──
// 数据源 = 告警 data_json.wechatPush（strawWorkflow/strawCorrection 回写），90 天窗口只读
// 状态：pushed 推送成功 / held 复检把关待复核 / failed 推送失败（红标，可一键重推）/ none 未推送

const CYAN = '#00aaff'
const GREEN = '#00e676'
const AMBER = '#ffd740'
const RED = '#ff4444'
const GREY = '#5a8aaa'

interface PushLogRow {
  id: string
  createdAt: string
  label: string
  aiType: string
  aiConfidence: number | null
  level: number | null
  location: string
  picUrl: string
  town: string
  unit: string
  state: 'pushed' | 'held' | 'failed' | 'none'
  held: boolean
  pushed: boolean
  reason: string
  cardUrl: string
  webhook: string
  correctedAt: string
  correctionOk: boolean | null
  correctionNote: string
  correctedBy: string
}

const STATE_META: Record<PushLogRow['state'], { label: string; color: string }> = {
  pushed: { label: '✓ 已推送', color: GREEN },
  held: { label: '⏸ 待复核', color: AMBER },
  failed: { label: '✗ 推送失败', color: RED },
  none: { label: '· 未推送', color: GREY },
}

const inputStyle: React.CSSProperties = {
  padding: '6px 10px', background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.25)',
  borderRadius: 3, color: '#c8e6ff', fontSize: 13, outline: 'none',
}
const btn = (color: string, disabled = false): React.CSSProperties => ({
  padding: '5px 12px', fontSize: 12, borderRadius: 3, border: `1px solid ${color}55`,
  background: `${color}15`, color: disabled ? '#3a5a70' : color, cursor: disabled ? 'not-allowed' : 'pointer',
})

interface Props {
  user: CurrentUser
}

export function PushLogPage({ user }: Props) {
  const [rows, setRows] = useState<PushLogRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState('')
  const [status, setStatus] = useState('all')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [retryingId, setRetryingId] = useState('')
  const PAGE_SIZE = 20
  const isAdmin = roleAtLeast(user.role, 'admin')

  const flash = (m: string, ok = true) => { setToast((ok ? '✅ ' : '❌ ') + m); setTimeout(() => setToast(''), 3500) }

  const load = useCallback((pg = page) => {
    setLoading(true)
    const sp = new URLSearchParams({ status, q, page: String(pg), pageSize: String(PAGE_SIZE) })
    authFetch(`/api/straw/push-logs?${sp}`)
      .then(r => r.json())
      .then(d => {
        if (!d || !Array.isArray(d.rows)) { setRows([]); setTotal(0); return }
        setRows(d.rows); setTotal(d.total || 0)
      })
      .catch(() => { setRows([]); setTotal(0); flash('加载失败', false) })
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, q])

  useEffect(() => { load(1) }, [load])
  useEffect(() => { setPage(1) }, [status, q])

  // 一键重推（failed/held 可重推；仅 admin）
  const retry = async (row: PushLogRow) => {
    if (retryingId) return
    setRetryingId(row.id)
    try {
      const r = await authFetch(`/api/straw/push-logs/${encodeURIComponent(row.id)}/retry`, { method: 'POST' })
      const d = await r.json().catch(() => ({}))
      if (d && d.wechatPush) {
        const wp = d.wechatPush
        if (wp.pushed) flash(`重推成功 → ${row.town || row.id}`)
        else flash(`重推未成功：${wp.reason || '未知原因'}`, false)
      } else {
        flash((d && d.error) || '重推请求失败', false)
      }
      load(page)
    } catch (e: any) {
      flash(e?.message || '重推异常', false)
    } finally {
      setRetryingId('')
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%', minHeight: 0 }}>
      {/* 页头 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 3, height: 18, background: CYAN, borderRadius: 1 }} />
        <span style={{ color: '#c8e6ff', fontSize: 16, fontWeight: 700 }}>微信推送记录</span>
        <span style={{ fontSize: 12, color: '#5a8aaa' }}>
          秸秆告警 wechatPush 状态回看 · 90 天窗口 · 失败可人工重推（数据源 data_json.wechatPush）
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={() => load(page)} style={btn(CYAN)}>刷新</button>
      </div>

      {toast && (
        <div style={{ position: 'fixed', top: 80, right: 40, zIndex: 3000, background: 'rgba(0,40,80,0.95)', border: '1px solid rgba(0,150,220,0.3)', borderRadius: 6, padding: '10px 20px', color: '#c8e6ff', fontSize: 13 }}>
          {toast}
        </div>
      )}

      {/* 筛选工具栏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <select value={status} onChange={e => setStatus(e.target.value)} style={inputStyle}>
          <option value="all">全部状态</option>
          <option value="pushed">推送成功</option>
          <option value="held">待复核（held）</option>
          <option value="failed">推送失败</option>
        </select>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索 告警ID / 街道 / 责任单位 / 原因" style={{ ...inputStyle, width: 280 }} />
        <div style={{ flex: 1 }} />
        <span style={{ color: '#3a5a70', fontSize: 12 }}>
          共 <span style={{ color: '#c8e6ff', fontFamily: "'JetBrains Mono', monospace" }}>{total}</span> 条
          {total > 0 && <> · 第 <span style={{ color: CYAN, fontFamily: "'JetBrains Mono', monospace" }}>{page}/{totalPages}</span> 页</>}
        </span>
      </div>

      {/* 状态图例 */}
      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: '#3a5a70', flexShrink: 0 }}>
        {Object.entries(STATE_META).map(([k, m]) => (
          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: m.color, display: 'inline-block' }} />
            {m.label}
          </span>
        ))}
        <span style={{ color: '#2a4a60' }}>· 更正徽标 = 误报复核追发更正推送的结果</span>
      </div>

      {/* 记录表 */}
      <div style={{ flex: 1, overflow: 'auto', border: '1px solid rgba(0,150,220,0.15)', borderRadius: 6, minHeight: 0 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '130px 90px 100px 110px 74px 90px 1.4fr 110px 96px', background: 'rgba(0,30,70,0.5)', padding: '8px 12px', fontSize: 11, color: '#3a5a70', fontWeight: 600, borderBottom: '1px solid rgba(0,150,220,0.15)', position: 'sticky', top: 0, zIndex: 2 }}>
          <span>时间(上海)</span><span>AI类型</span><span>街道办</span><span>责任单位</span><span>置信度</span><span>状态</span><span>失败原因 / 备注</span><span>更正</span><span>操作</span>
        </div>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 140, color: '#3a5a70', fontSize: 13 }}>加载中…</div>
        ) : rows.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 140, color: '#3a5a70', fontSize: 13 }}>暂无推送记录（90 天内无秸秆告警推送）</div>
        ) : rows.map(row => {
          const sm = STATE_META[row.state]
          const canRetry = isAdmin && (row.state === 'failed' || row.state === 'held')
          return (
            <div key={row.id} style={{
              display: 'grid', gridTemplateColumns: '130px 90px 100px 110px 74px 90px 1.4fr 110px 96px',
              padding: '6px 12px', borderBottom: '1px solid rgba(0,80,150,0.12)',
              alignItems: 'center', fontSize: 12, gap: 4,
            }}>
              <span style={{ color: '#7ab8e0', fontFamily: "'JetBrains Mono', monospace" }}>{row.createdAt ? row.createdAt.slice(5) : '—'}</span>
              <span style={{ color: '#c8e6ff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.label}>{row.label || row.aiType || '—'}</span>
              <span style={{ color: '#7ab8e0' }}>{row.town || '—'}</span>
              <span style={{ color: row.unit ? '#c8e6ff' : '#3a5a70' }}>{row.unit || '未配置'}</span>
              <span style={{ color: row.aiConfidence != null ? (row.aiConfidence >= 0.7 ? RED : row.aiConfidence >= 0.5 ? AMBER : '#64b5f6') : '#3a5a70', fontFamily: "'JetBrains Mono', monospace" }}>
                {row.aiConfidence != null ? `${(row.aiConfidence * 100).toFixed(1)}%` : '—'}
              </span>
              <span>
                <span style={{ padding: '1px 7px', fontSize: 11, borderRadius: 2, border: `1px solid ${sm.color}55`, background: `${sm.color}14`, color: sm.color, whiteSpace: 'nowrap' }}>
                  {sm.label}
                </span>
              </span>
              <span style={{ color: row.state === 'failed' ? '#ff8080' : '#5a8aaa', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.reason}>
                {row.reason || (row.state === 'held' ? '低置信度待人工复核后释放' : '—')}
              </span>
              <span style={{ fontSize: 11 }}>
                {row.correctedAt ? (
                  <span style={{ color: row.correctionOk ? GREEN : RED }}>
                    {row.correctionOk ? '✓ 更正成功' : '✗ 更正失败'}
                    <span style={{ color: '#3a5a70' }}> {row.correctedBy || ''}</span>
                  </span>
                ) : <span style={{ color: '#2a4a60' }}>—</span>}
              </span>
              <span>
                {canRetry && (
                  <button disabled={!!retryingId} onClick={() => retry(row)} style={btn(retryingId === row.id ? GREY : row.state === 'failed' ? RED : AMBER, !!retryingId)}>
                    {retryingId === row.id ? '重推中…' : '一键重推'}
                  </button>
                )}
              </span>
            </div>
          )
        })}
      </div>

      {/* 分页 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, justifyContent: 'flex-end' }}>
        <button disabled={page <= 1 || loading} onClick={() => load(page - 1)} style={btn(CYAN, page <= 1 || loading)}>上一页</button>
        <button disabled={page >= totalPages || loading} onClick={() => load(page + 1)} style={btn(CYAN, page >= totalPages || loading)}>下一页</button>
      </div>
    </div>
  )
}
