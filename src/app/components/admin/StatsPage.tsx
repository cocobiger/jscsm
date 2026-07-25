import { authFetch } from '../../lib/apiFetch'
import { useState, useEffect, useCallback } from 'react'
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'

const CYAN = '#00aaff'
const GREEN = '#00e676'
const AMBER = '#ffd740'
const ORANGE = '#ff7043'
const RED = '#ff4444'
const PURPLE = '#ab47bc'

const PIE_COLORS = [RED, AMBER, ORANGE, CYAN, PURPLE, GREEN]

interface Stats {
  range: { hours: number; since: string }
  summary: { totalRecords: number; points: number; pollutantKinds: number; totalExceed: number; warnings: number }
  points: string[]
  pollutants: { code: string; name: string; unit: string; standardValue?: number; avg: number; max: number; exceed: number; samples: number }[]
  trendByPoint: Record<string, { time: string; aqi: number }[]>
  pointRanking: { name: string; exceed: number }[]
  warningByType: Record<string, number>
  warningLabels: Record<string, string>
}

const RANGE_OPTIONS = [
  { label: '近 24 小时', value: 24 },
  { label: '近 48 小时', value: 48 },
  { label: '近 7 天', value: 168 },
  { label: '近 30 天', value: 720 },
]

export function StatsPage() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [hours, setHours] = useState(48)
  const [point, setPoint] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    const q = new URLSearchParams({ hours: String(hours) })
    if (point) q.set('point', point)
    authFetch(`/api/stats?${q}`).then(r => r.json()).then(s => { setStats(s); setLoading(false) }).catch(() => setLoading(false))
  }, [hours, point])

  useEffect(() => { load() }, [load])

  // 趋势图：把各点位序列合并成统一时间轴
  const trendData = (() => {
    if (!stats) return []
    const points = Object.keys(stats.trendByPoint)
    const timeMap: Record<string, any> = {}
    for (const pt of points) {
      for (const d of stats.trendByPoint[pt]) {
        const t = (d.time || '').slice(5, 16) // MM-DD HH:mm
        if (!timeMap[t]) timeMap[t] = { time: t }
        timeMap[t][pt] = d.aqi
      }
    }
    return Object.values(timeMap).sort((a: any, b: any) => (a.time < b.time ? -1 : 1))
  })()

  const trendPoints = stats ? Object.keys(stats.trendByPoint) : []
  const warningPieData = stats ? Object.entries(stats.warningByType).map(([type, count]) => ({
    name: stats.warningLabels[type] || type, value: count,
  })) : []

  const card: React.CSSProperties = {
    background: 'rgba(0,30,70,0.3)', border: '1px solid rgba(0,80,150,0.2)', borderRadius: 6, padding: 16, marginBottom: 16,
  }
  const cardTitle: React.CSSProperties = { color: '#7ab8e0', fontSize: 13, fontWeight: 600, marginBottom: 12 }
  const axisStyle = { fontSize: 11, fill: '#5a8aaa' }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: '20px 24px', overflow: 'hidden' }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16, flexShrink: 0 }}>
        <div style={{ width: 3, height: 18, background: CYAN, borderRadius: 1, marginRight: 10 }} />
        <span style={{ color: '#c8e6ff', fontSize: 16, fontWeight: 700, letterSpacing: '0.05em' }}>数据统计报表</span>
        <span style={{ color: '#3a5a70', fontSize: 12, marginLeft: 12 }}>采集趋势 · 超标统计 · 预警分布</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <select value={point} onChange={e => setPoint(e.target.value)}
            style={{ padding: '6px 10px', background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3, color: '#c8e6ff', fontSize: 12, outline: 'none' }}>
            <option value="">全部点位</option>
            {stats?.points.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <select value={hours} onChange={e => setHours(Number(e.target.value))}
            style={{ padding: '6px 10px', background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3, color: '#c8e6ff', fontSize: 12, outline: 'none' }}>
            {RANGE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button onClick={load} style={{ padding: '6px 14px', fontSize: 12, borderRadius: 3, border: `1px solid ${CYAN}55`, background: `${CYAN}18`, color: CYAN, cursor: 'pointer' }}>刷新</button>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {loading && <div style={{ color: '#5a8aaa', textAlign: 'center', padding: 40 }}>加载中…</div>}
        {!loading && stats && (
          <>
            {/* 概览卡片 */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
              {[
                { label: '采集记录', value: stats.summary.totalRecords, color: CYAN },
                { label: '监测点位', value: stats.summary.points, color: GREEN },
                { label: '污染物种类', value: stats.summary.pollutantKinds, color: PURPLE },
                { label: '超标次数', value: stats.summary.totalExceed, color: ORANGE },
                { label: '预警记录', value: stats.summary.warnings, color: RED },
              ].map(m => (
                <div key={m.label} style={{ flex: 1, ...card, marginBottom: 0, textAlign: 'center' }}>
                  <div style={{ color: m.color, fontSize: 28, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace" }}>{m.value}</div>
                  <div style={{ color: '#5a8aaa', fontSize: 12, marginTop: 4 }}>{m.label}</div>
                </div>
              ))}
            </div>

            {/* AQI 趋势 */}
            <div style={card}>
              <div style={cardTitle}>AQI 趋势</div>
              {trendData.length ? (
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={trendData} margin={{ top: 5, right: 20, bottom: 5, left: -10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,80,150,0.15)" />
                    <XAxis dataKey="time" tick={axisStyle} />
                    <YAxis tick={axisStyle} />
                    <Tooltip contentStyle={{ background: '#061530', border: '1px solid rgba(0,150,220,0.3)', borderRadius: 4, fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    {trendPoints.map((pt, i) => (
                      <Line key={pt} type="monotone" dataKey={pt} stroke={PIE_COLORS[i % PIE_COLORS.length]} dot={false} strokeWidth={2} connectNulls />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              ) : <div style={{ color: '#3a5a70', textAlign: 'center', padding: 30 }}>暂无数据</div>}
            </div>

            <div style={{ display: 'flex', gap: 16 }}>
              {/* 污染物均值/超标 */}
              <div style={{ ...card, flex: 1.4 }}>
                <div style={cardTitle}>各污染物均值与超标次数</div>
                {stats.pollutants.length ? (
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={stats.pollutants} margin={{ top: 5, right: 10, bottom: 5, left: -10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,80,150,0.15)" />
                      <XAxis dataKey="name" tick={axisStyle} />
                      <YAxis tick={axisStyle} />
                      <Tooltip contentStyle={{ background: '#061530', border: '1px solid rgba(0,150,220,0.3)', borderRadius: 4, fontSize: 12 }} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar dataKey="avg" name="平均值" fill={CYAN} />
                      <Bar dataKey="exceed" name="超标次数" fill={RED} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : <div style={{ color: '#3a5a70', textAlign: 'center', padding: 30 }}>暂无数据</div>}
              </div>

              {/* 预警类型分布 */}
              <div style={{ ...card, flex: 1 }}>
                <div style={cardTitle}>预警类型分布</div>
                {warningPieData.length ? (
                  <ResponsiveContainer width="100%" height={240}>
                    <PieChart>
                      <Pie data={warningPieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={(e: any) => `${e.name} ${e.value}`}>
                        {warningPieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                      </Pie>
                      <Tooltip contentStyle={{ background: '#061530', border: '1px solid rgba(0,150,220,0.3)', borderRadius: 4, fontSize: 12 }} />
                    </PieChart>
                  </ResponsiveContainer>
                ) : <div style={{ color: '#3a5a70', textAlign: 'center', padding: 40 }}>暂无预警记录</div>}
              </div>
            </div>

            {/* 点位超标排行 */}
            <div style={card}>
              <div style={cardTitle}>点位超标排行</div>
              {stats.pointRanking.length ? (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>
                    <th style={{ color: '#5a8aaa', fontSize: 11, fontWeight: 600, padding: '8px 10px', textAlign: 'left', borderBottom: '1px solid rgba(0,80,150,0.25)' }}>排名</th>
                    <th style={{ color: '#5a8aaa', fontSize: 11, fontWeight: 600, padding: '8px 10px', textAlign: 'left', borderBottom: '1px solid rgba(0,80,150,0.25)' }}>点位</th>
                    <th style={{ color: '#5a8aaa', fontSize: 11, fontWeight: 600, padding: '8px 10px', textAlign: 'left', borderBottom: '1px solid rgba(0,80,150,0.25)' }}>超标次数</th>
                  </tr></thead>
                  <tbody>
                    {stats.pointRanking.map((p, i) => (
                      <tr key={p.name}>
                        <td style={{ color: i < 3 ? AMBER : '#9ec5e0', fontSize: 12, padding: '8px 10px', borderBottom: '1px solid rgba(0,60,120,0.15)', fontWeight: i < 3 ? 700 : 400 }}>{i + 1}</td>
                        <td style={{ color: '#9ec5e0', fontSize: 12, padding: '8px 10px', borderBottom: '1px solid rgba(0,60,120,0.15)' }}>{p.name}</td>
                        <td style={{ color: p.exceed > 0 ? ORANGE : '#5a8aaa', fontSize: 12, padding: '8px 10px', borderBottom: '1px solid rgba(0,60,120,0.15)', fontFamily: "'JetBrains Mono',monospace" }}>{p.exceed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <div style={{ color: '#3a5a70', textAlign: 'center', padding: 30 }}>暂无数据</div>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
