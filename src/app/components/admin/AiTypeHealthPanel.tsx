import { useState, useEffect } from 'react'
import { authFetch } from '../../lib/apiFetch'

/**
 * 算法健康度总览（2026-09-15 整改 P1）
 *
 * 背景：AI分析存档原先只列算法名字，点进去 6 类没数据，用户无法区分
 *   「云平台没部署该算法」与「部署了但没检出」→ 本面板让"空壳算法"一眼可见。
 *
 * 数据源：GET /api/ai-types/health
 *   status: active=近7天有产出 · idle7d=有历史但近7天静默 · never=从未产出 · unbound=未绑定云平台算法key
 */

interface AiTypeHealth {
  name: string
  sourceKey: string
  sortOrder: number
  total: number
  last7d: number
  last30d: number
  lastAt: string | null
  status: 'active' | 'idle7d' | 'never' | 'unbound'
}

const CYAN = '#00aaff'
const GREEN = '#4ade80'
const AMBER = '#ffb74d'
const RED = '#ff4444'

const STATUS_META: Record<string, { label: string; color: string; desc: string }> = {
  active: { label: '运行中', color: GREEN, desc: '近 7 天有产出' },
  idle7d: { label: '近 7 天静默', color: AMBER, desc: '有历史数据，近 7 天无产出' },
  never: { label: '从未产出', color: RED, desc: '云平台未部署该算法（空壳）' },
  unbound: { label: '未绑定算法', color: '#6b87a8', desc: '未绑定云平台算法 key，接不到数据' },
}

const card: React.CSSProperties = { background: 'rgba(4,14,35,0.7)', border: '1px solid rgba(0,80,150,0.25)', borderRadius: 8, padding: '14px 16px' }

export function AiTypeHealthPanel() {
  const [rows, setRows] = useState<AiTypeHealth[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const load = () => {
    setLoading(true)
    setErr('')
    authFetch('/api/ai-types/health')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((d: unknown) => setRows(Array.isArray(d) ? (d as AiTypeHealth[]) : []))
      .catch((e: unknown) => setErr(String((e as Error)?.message || e)))
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [])

  const nActive = rows.filter(r => r.status === 'active').length
  const nIdle = rows.filter(r => r.status === 'idle7d').length
  const nDead = rows.filter(r => r.status === 'never' || r.status === 'unbound').length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto', flex: 1 }}>
      {/* 统计条 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
        {([
          ['算法总数', rows.length, CYAN],
          ['运行中', nActive, GREEN],
          ['近 7 天静默', nIdle, AMBER],
          ['从未产出 / 未绑定', nDead, RED],
        ] as const).map(([label, val, color]) => (
          <div key={label} style={card}>
            <div style={{ fontSize: 12, color: '#5a8aaa' }}>{label}</div>
            <div style={{ color: color as string, fontSize: 22, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>{val}</div>
          </div>
        ))}
      </div>

      {/* 说明 */}
      <div style={{ ...card, borderLeft: `4px solid ${AMBER}`, fontSize: 12.5, color: '#9ad6f0', lineHeight: 1.8 }}>
        <b style={{ color: '#c8e6ff' }}>为什么要有这一屏</b>：AI分析存档里列出的算法，是「业务期望清单」；
        而<b>云平台实际部署了几类、是否在产出数据</b>，此前无从判断 —— 管理员点进没数据的算法会误以为系统故障。
        本表用实际产出数据给出结论：<b style={{ color: RED }}>「从未产出 / 未绑定」即为空壳算法</b>，需与平台方确认部署情况，
        或从 UI 撤下以免误导。数据来源：warnings 表按 aiType 统计（近 7 天 / 近 30 天 / 最后一条时间）。
      </div>

      {/* 表格 */}
      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid rgba(0,80,150,0.2)' }}>
          <span style={{ color: '#c8e6ff', fontSize: 14, fontWeight: 600 }}>算法接入状态</span>
          <span style={{ color: '#3a5a70', fontSize: 11 }}>云平台算法 key ↔ 中文类型名 的绑定与产出情况</span>
          <div style={{ flex: 1 }} />
          <button onClick={load} disabled={loading} style={{
            padding: '4px 14px', fontSize: 12, borderRadius: 3, cursor: loading ? 'wait' : 'pointer',
            border: `1px solid ${CYAN}55`, background: `${CYAN}18`, color: CYAN,
          }}>{loading ? '加载中…' : '刷新'}</button>
        </div>
        {err && <div style={{ padding: '10px 14px', color: RED, fontSize: 12 }}>加载失败：{err}</div>}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: 'rgba(4,14,35,0.95)' }}>
                {['状态', '算法名称', '云平台 key', '累计', '近 7 天', '近 30 天', '最后一条'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: '#5a8aaa', fontWeight: 600, borderBottom: '1px solid rgba(0,80,150,0.2)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading && (
                <tr><td colSpan={7} style={{ padding: '26px 0', textAlign: 'center', color: '#3a5a70' }}>暂无数据</td></tr>
              )}
              {rows.map(r => {
                const meta = STATUS_META[r.status] || STATUS_META.never
                return (
                  <tr key={r.name} style={{ borderBottom: '1px solid rgba(0,50,100,0.15)' }}>
                    <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
                      <span title={meta.desc} style={{
                        padding: '2px 8px', borderRadius: 3, fontSize: 11, fontWeight: 700,
                        color: meta.color, border: `1px solid ${meta.color}70`, background: `${meta.color}18`,
                      }}>{meta.label}</span>
                    </td>
                    <td style={{ padding: '8px 12px', color: '#c8e6ff', fontWeight: 600 }}>{r.name}</td>
                    <td style={{ padding: '8px 12px', fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, color: r.sourceKey ? '#7ab8e0' : '#3a5a70' }}>
                      {r.sourceKey || '—'}
                    </td>
                    <td style={{ padding: '8px 12px', fontFamily: "'JetBrains Mono', monospace", color: r.total > 0 ? '#c8e6ff' : '#3a5a70' }}>{r.total}</td>
                    <td style={{ padding: '8px 12px', fontFamily: "'JetBrains Mono', monospace", color: r.last7d > 0 ? GREEN : '#3a5a70' }}>{r.last7d}</td>
                    <td style={{ padding: '8px 12px', fontFamily: "'JetBrains Mono', monospace", color: r.last30d > 0 ? '#9ad6f0' : '#3a5a70' }}>{r.last30d}</td>
                    <td style={{ padding: '8px 12px', fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, color: '#5a8aaa', whiteSpace: 'nowrap' }}>
                      {r.lastAt ? String(r.lastAt).replace('T', ' ').slice(0, 19) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ fontSize: 11.5, color: '#3a5a70', lineHeight: 1.9 }}>
        <b style={{ color: '#5a8aaa' }}>说明</b>：① 「云平台 key」为空 = 该算法未与云平台算法绑定，接不到数据（需在平台侧配置或改由自研引擎产出）；
        ② 标注「从未产出」的算法建议与 IoTCloud / EasyAIoT 平台方确认是否已部署；
        ③ 统计口径为 warnings 表 data_json.aiType 精确匹配，含已处置历史数据。
      </div>
    </div>
  )
}
