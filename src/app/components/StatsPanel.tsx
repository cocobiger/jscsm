import { useState, useEffect } from 'react'
import { PieChart, Pie, Cell, Tooltip } from 'recharts'
import { apiFetch } from '../lib/apiFetch'

const CYAN = '#00aaff'
const GREEN = '#00e676'
const AMBER = '#ffd740'
const ORANGE = '#ff7043'
const PURPLE = '#ab47bc'
const RED = '#ff5252'
const TEAL = '#00bcd4'

// 告警类型 → 饼图颜色（与 AlertFormatPage 对齐）
const ALERT_TYPE_COLORS: Record<string, string> = {
  '气体污染': '#ab47bc',
  '水体污染': TEAL,
  '秸秆燃烧': AMBER,
  '道路扬尘': ORANGE,
  '堆头未覆盖': RED,
  '气体采集预警': CYAN,
}
const ALERT_TYPE_ORDER = ['气体污染', '水体污染', '秸秆燃烧', '道路扬尘', '堆头未覆盖', '气体采集预警']

const pollutionRank = [
  { name: '万州化工厂', val: 0.42, unit: 'mg/m³' },
  { name: '三峡港口', val: 0.38, unit: 'mg/m³' },
  { name: '龙头化工', val: 0.31, unit: 'mg/m³' },
  { name: '新港堆场', val: 0.28, unit: 'mg/m³' },
  { name: '万达实业', val: 0.22, unit: 'mg/m³' },
]

const CHART_TOOLTIP_STYLE = {
  background: 'rgba(4,14,35,0.95)',
  border: '1px solid rgba(0,150,220,0.25)',
  borderRadius: 3,
  color: '#c8e6ff',
  fontSize: 11,
  padding: '4px 8px',
}

function SectionTitle({ title, color = CYAN }: { title: string; color?: string }) {
  return (
    <div className="flex items-center gap-2 mb-1" style={{ paddingLeft: 6 }}>
      <div style={{ width: 3, height: 10, background: color, borderRadius: 1 }} />
      <span style={{ color: '#7ab8e0', fontSize: 11, fontWeight: 600 }}>{title}</span>
    </div>
  )
}

// Custom SVG line chart — no recharts, no key collisions
function TrendChart({ data }: { data: { weekday: string; count: number; date?: string }[] }) {
  const W = 280
  const H = 76
  const padL = 28
  const padR = 10
  const padT = 6
  const padB = 18

  const maxVal = Math.max(...data.map(d => d.count))
  const minVal = 0
  const range = maxVal - minVal || 1

  const xStep = (W - padL - padR) / (data.length - 1)
  const yScale = (v: number) => padT + (1 - (v - minVal) / range) * (H - padT - padB)

  const points = data.map((d, i) => ({
    x: padL + i * xStep,
    y: yScale(d.count),
    ...d,
  }))

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(1)},${H - padB} L${points[0].x.toFixed(1)},${H - padB} Z`

  // Y-axis ticks
  const yTicks = [0, Math.round(maxVal / 2), maxVal]

  const [hovered, setHovered] = useState<number | null>(null)

  return (
    <div style={{ width: '100%', height: H, flexShrink: 0 }}>
    <svg
      width="100%" height="100%"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ display: 'block', overflow: 'visible' }}
    >
      <defs>
        <linearGradient id="trend-area-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={CYAN} stopOpacity="0.18" />
          <stop offset="100%" stopColor={CYAN} stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Horizontal grid lines */}
      {yTicks.map(v => {
        const y = yScale(v)
        return (
          <g key={v}>
            <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="rgba(0,80,150,0.2)" strokeWidth="1" />
            <text x={padL - 4} y={y + 4} textAnchor="end" fill="#3a5a70" fontSize="9">{v}</text>
          </g>
        )
      })}

      {/* Area fill */}
      <path d={areaPath} fill="url(#trend-area-grad)" />

      {/* Line */}
      <path d={linePath} fill="none" stroke={CYAN} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />

      {/* Dots + hover */}
      {points.map((p, i) => (
        <g key={p.weekday}>
          <circle
            cx={p.x} cy={p.y} r={hovered === i ? 4 : 2.5}
            fill={hovered === i ? '#fff' : CYAN}
            stroke={CYAN} strokeWidth="1"
            style={{ cursor: 'default', transition: 'r 0.1s' }}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
          />
          {/* X-axis label */}
          <text x={p.x} y={H - 4} textAnchor="middle" fill="#3a5a70" fontSize="9">{p.weekday}</text>
          {/* Tooltip on hover */}
          {hovered === i && (
            <g>
              <rect
                x={p.x - 16} y={p.y - 22}
                width={32} height={16}
                rx={2} fill="rgba(4,14,35,0.92)"
                stroke="rgba(0,150,220,0.3)" strokeWidth="1"
              />
              <text x={p.x} y={p.y - 11} textAnchor="middle" fill={CYAN} fontSize="10" fontWeight="bold">
                {p.count}
              </text>
            </g>
          )}
        </g>
      ))}
    </svg>
    </div>
  )
}

export function StatsPanel() {
  const [eventRank, setEventRank] = useState<any[]>([])
  const [eventLoading, setEventLoading] = useState(true)
  // 告警类型占比 → 预警类型统计（实时数据）
  const [alertTypeCounts, setAlertTypeCounts] = useState<Record<string, number>>({})
  const [alertTypeTotal, setAlertTypeTotal] = useState(0)
  const [alertTypeLoading, setAlertTypeLoading] = useState(true)
  // 智治推送排行 → 事件推送排行（实时数据）
  const [pushRank, setPushRank] = useState<{ plan_name: string; push_count: number; success_count: number; fail_count: number }[]>([])
  const [pushRankLoading, setPushRankLoading] = useState(true)
  // 近7天告警趋势 → 真实数据（后端按上海本地日期聚合）
  const [trendData, setTrendData] = useState<{ date: string; weekday: string; count: number }[]>([])
  const [trendLoading, setTrendLoading] = useState(true)

  useEffect(() => {
    const loadEventRank = async () => {
      try {
        const data = await apiFetch<any[]>('/api/events/rank?limit=5&period=30d')
        setEventRank(data || [])
      } catch (e: any) {
        console.warn('加载污染事件排行失败:', e)
      } finally {
        setEventLoading(false)
      }
    }
    const loadAlertTypes = async () => {
      try {
        const data = await apiFetch<any>('/api/alert-type-stats?hours=48')
        if (data && data.categories) {
          setAlertTypeCounts(data.categories)
          setAlertTypeTotal(data.total || 0)
        }
      } catch (e: any) {
        console.warn('加载预警类型统计数据失败:', e)
      } finally {
        setAlertTypeLoading(false)
      }
    }
    const loadPushRank = async () => {
      try {
        const data = await apiFetch<any[]>('/api/smart-push/stats?limit=5')
        setPushRank(data || [])
      } catch (e: any) {
        console.warn('加载事件推送排行数据失败:', e)
      } finally {
        setPushRankLoading(false)
      }
    }
    const loadTrend = async () => {
      try {
        const data = await apiFetch<{ days: number; data: { date: string; weekday: string; count: number }[] }>('/api/alert-trend?days=7')
        if (data && Array.isArray(data.data)) setTrendData(data.data)
      } catch (e: any) {
        console.warn('加载告警趋势数据失败:', e)
      } finally {
        setTrendLoading(false)
      }
    }
    loadEventRank()
    loadAlertTypes()
    loadPushRank()
    loadTrend()
    const timer = setInterval(loadEventRank, 60000)
    const timer2 = setInterval(loadAlertTypes, 10000)
    const timer3 = setInterval(loadPushRank, 10000) // 每10秒刷新推送排行
    const timer4 = setInterval(loadTrend, 60000) // 每分钟刷新趋势
    return () => { clearInterval(timer); clearInterval(timer2); clearInterval(timer3); clearInterval(timer4) }
  }, [])

  return (
    <div
      className="flex flex-col h-full overflow-y-hidden px-2 py-1.5 gap-2"
      style={{
        scrollbarWidth: 'none',
        borderLeft: '3px solid #ffd740',
        background: 'linear-gradient(90deg, rgba(255,215,64,0.05), transparent 60%)',
        borderTop: '1px solid rgba(0,150,220,0.1)',
      }}
    >
      <div style={{
        height: 36,
        display: 'flex', alignItems: 'center',
        borderBottom: '1px solid rgba(0,150,220,0.1)',
        marginLeft: -8, marginRight: -8, paddingLeft: 12,
      }}>
        <span style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 600 }}>统计分析</span>
      </div>

      {/* 7-day trend — custom SVG, no recharts */}
      <div>
        <SectionTitle title="近7天告警趋势" />
        {trendLoading ? (
          <div style={{ color: '#3a5a70', fontSize: 11, padding: '18px 0' }}>加载告警趋势…</div>
        ) : trendData.length === 0 ? (
          <div style={{ color: '#3a5a70', fontSize: 11, padding: '18px 0' }}>暂无告警数据</div>
        ) : (
          <TrendChart data={trendData} />
        )}
      </div>

      {/* Pie chart — 实时数据：告警接入 + 气体采集预警 */}
      <div>
        <SectionTitle title="预警类型统计" color={AMBER} />
        {alertTypeLoading ? (
          <div style={{ color: '#3a5a70', fontSize: 11, padding: '8px 0' }}>加载告警数据…</div>
        ) : alertTypeTotal === 0 ? (
          <div style={{ color: '#3a5a70', fontSize: 11, padding: '8px 0' }}>暂无告警数据</div>
        ) : (
          (() => {
            // 按固定顺序构建饼图数据，值为原始计数
            const dynPieData = ALERT_TYPE_ORDER
              .map(name => ({ name, value: alertTypeCounts[name] || 0, color: ALERT_TYPE_COLORS[name] || CYAN }))
              .filter(d => d.value > 0) // 隐藏 0 值条目
            if (dynPieData.length === 0) return <div style={{ color: '#3a5a70', fontSize: 11, padding: '8px 0' }}>暂无告警数据</div>
            const maxCount = Math.max(...dynPieData.map(d => d.value))
            return (
              <div className="flex items-center gap-2">
                <div style={{ flexShrink: 0 }}>
                  <PieChart width={90} height={84}>
                    <Pie
                      data={dynPieData}
                      cx={45} cy={42}
                      innerRadius={22} outerRadius={38}
                      dataKey="value"
                      strokeWidth={0}
                      isAnimationActive={false}
                    >
                      {dynPieData.map(entry => (
                        <Cell key={entry.name} fill={entry.color} opacity={0.85} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={CHART_TOOLTIP_STYLE}
                      formatter={(v: number, name: string) => [`${v} 条`, name]}
                    />
                  </PieChart>
                </div>
                <div className="flex flex-col gap-0.5">
                  {dynPieData.map(d => {
                    const pct = Math.round((d.value / alertTypeTotal) * 100)
                    // 横向进度条宽度按最大计数值比例
                    const barW = d.value === maxCount ? 48 : Math.max(6, Math.round(d.value / maxCount * 48))
                    return (
                      <div key={d.name} className="flex items-center gap-1.5">
                        <div style={{ width: 6, height: 6, borderRadius: 1, background: d.color, flexShrink: 0 }} />
                        <span style={{ color: '#7ab8e0', fontSize: 11, width: 72, whiteSpace: 'nowrap' }}>{d.name}</span>
                        <div style={{ width: barW, height: 4, background: d.color, borderRadius: 2, opacity: 0.55, flexShrink: 0 }} />
                        <span style={{ color: d.color, fontSize: 11, fontFamily: "'JetBrains Mono', monospace", marginLeft: 'auto' }}>
                          {d.value}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })()
        )}
      </div>

      {/* 事件推送排行 — 实时数据：按预案名称聚合推送次数 */}
      <div>
        <SectionTitle title="事件推送排行" color={ORANGE} />
        {pushRankLoading ? (
          <div style={{ color: '#3a5a70', fontSize: 11, padding: '8px 0' }}>加载推送数据…</div>
        ) : pushRank.length === 0 ? (
          <div style={{ color: '#3a5a70', fontSize: 11, padding: '8px 0' }}>暂无推送记录</div>
        ) : (
          <div className="flex flex-col gap-1" style={{ paddingLeft: 4 }}>
            {pushRank.map((item, i) => {
              const maxCount = pushRank[0]?.push_count || 1
              const pct = (item.push_count / maxCount) * 100
              const barColor = i === 0 ? '#ff4444' : i === 1 ? ORANGE : `${ORANGE}99`
              return (
                <div key={i} className="flex items-center gap-2">
                  <span style={{
                    width: 14, color: '#3a5a70', fontSize: 11,
                    fontFamily: "'JetBrains Mono', monospace", flexShrink: 0,
                  }}>
                    {i + 1}
                  </span>
                  <span style={{ color: '#5a8aaa', fontSize: 12, width: 78, flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {item.plan_name || '未命名预案'}
                  </span>
                  <div style={{ flex: 1, height: 7, background: 'rgba(0,60,120,0.3)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{
                      width: `${pct}%`, height: '100%',
                      background: barColor, borderRadius: 3, opacity: 0.85,
                    }} />
                  </div>
                  <span style={{
                    color: ORANGE, fontSize: 12, width: 24, textAlign: 'right',
                    fontFamily: "'JetBrains Mono', monospace", flexShrink: 0,
                  }}>
                    {item.push_count}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 重点企业污染事件排行 */}
      <div>
        <SectionTitle title="重点企业污染事件排行 TOP5" color={PURPLE} />
        {eventLoading ? (
          <div style={{ color: '#3a5a70', fontSize: 12, padding: 8 }}>加载中…</div>
        ) : eventRank.length === 0 ? (
          <div style={{ color: '#3a5a70', fontSize: 12, padding: 8 }}>近30天无污染事件</div>
        ) : (
          <div className="flex flex-col gap-1">
            {eventRank.map((p: any, i: number) => {
              const maxCount = eventRank[0]?.event_count || 1
              const barW = Math.max(8, Math.round(p.event_count / maxCount * 52))
              return (
              <div key={p.enterprise_id} className="flex items-center gap-2">
                <span style={{
                  width: 18, height: 18, borderRadius: 2,
                  background: i === 0 ? '#ff4444' : i === 1 ? ORANGE : 'rgba(0,80,150,0.4)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: i < 2 ? '#fff' : '#5a8aaa', fontSize: 11, fontWeight: 700, flexShrink: 0,
                }}>
                  {i + 1}
                </span>
                <span style={{ color: '#7ab8e0', fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.enterprise_name}
                </span>
                <div className="flex items-center gap-1.5">
                  <div style={{
                    width: barW,
                    height: 5,
                    background: i === 0 ? '#ff4444' : i === 1 ? ORANGE : PURPLE,
                    borderRadius: 2, opacity: 0.85,
                  }} />
                  <span style={{ color: PURPLE, fontSize: 12, fontFamily: "'JetBrains Mono', monospace", width: 24, textAlign: 'right' }}>
                    {p.event_count}
                  </span>
                </div>
              </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
