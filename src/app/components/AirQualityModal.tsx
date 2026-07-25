import { authFetch } from '../lib/apiFetch'
import { useState, useMemo, useEffect } from 'react'
import { useDashboard } from '../context/DashboardContext'
import type { AirQualityRecord } from '../context/DashboardContext'

const CYAN = '#00aaff'
const GREEN = '#00e676'
const AMBER = '#ffd740'
const ORANGE = '#ff7043'
const RED = '#ff4444'
const TEAL = '#00bcd4'

const STATIONS = ['周家坝', '百安坝'] as const
type Station = typeof STATIONS[number]

interface HourRecord {
  hour: string
  aqi: number
  pm25: number
  pm10: number
  so2: number
  no2: number
  o3: number
  co: number
}

function aqiColor(aqi: number) {
  if (aqi <= 50)  return GREEN
  if (aqi <= 100) return AMBER
  if (aqi <= 150) return ORANGE
  if (aqi <= 200) return '#ff5722'
  return RED
}

function aqiLabel(aqi: number) {
  if (aqi <= 50)  return '优'
  if (aqi <= 100) return '良'
  if (aqi <= 150) return '轻度'
  if (aqi <= 200) return '中度'
  return '重度'
}

const METRICS: { key: keyof Omit<HourRecord, 'hour'>; label: string; unit: string; color: string }[] = [
  { key: 'aqi',  label: 'AQI',   unit: '',      color: CYAN },
  { key: 'pm25', label: 'PM2.5', unit: 'μg/m³', color: '#00ccff' },
  { key: 'pm10', label: 'PM10',  unit: 'μg/m³', color: TEAL },
  { key: 'so2',  label: 'SO₂',   unit: 'μg/m³', color: AMBER },
  { key: 'no2',  label: 'NO₂',   unit: 'μg/m³', color: ORANGE },
  { key: 'o3',   label: 'O₃',    unit: 'μg/m³', color: '#ab47bc' },
  { key: 'co',   label: 'CO',    unit: 'mg/m³', color: GREEN },
]

// Convert stored AirQualityRecord for a station → last 24h HourRecord[]
function recordsToHourly(records: AirQualityRecord[], station: string): HourRecord[] {
  const now = new Date()
  const cutoff = now.getTime() - 24 * 3600 * 1000
  const stationRecs = records
    .filter(r => r.station === station && r.aqi > 0)  // aqi=0 为无效数据，过滤
    .filter(r => {
      const recTime = new Date(`${r.date}T${String(r.hour).padStart(2, '0')}:00:00`).getTime()
      return recTime >= cutoff
    })
    .sort((a, b) => {
      const ta = new Date(`${a.date}T${String(a.hour).padStart(2, '0')}:00:00`).getTime()
      const tb = new Date(`${b.date}T${String(b.hour).padStart(2, '0')}:00:00`).getTime()
      return ta - tb
    })
  return stationRecs.map(r => ({
    hour: `${String(r.hour).padStart(2, '0')}:00`,
    aqi: r.aqi, pm25: r.pm25, pm10: r.pm10,
    so2: r.so2, no2: r.no2, o3: r.o3, co: r.co,
  }))
}

interface Props {
  onClose: () => void
}

export function AirQualityModal({ onClose }: Props) {
  const { airQualityData, pushAirQualityRecord } = useDashboard()

  // 弹窗打开时自动从后端同步最新数据
  useEffect(() => {
    const sync = () => authFetch('/api/collected/as-aq?stations=周家坝,百安坝')
      .then(r => r.ok ? r.json() : [])
      .then((records: any[]) => {
        const existKeys = new Set(airQualityData.map((r: any) => `${r.station}|${r.date}|${r.hour}`))
        records.filter((r: any) => !existKeys.has(`${r.station}|${r.date}|${r.hour}`))
          .forEach((r: any) => pushAirQualityRecord({ station: r.station, date: r.date, hour: r.hour, aqi: r.aqi, pm25: r.pm25, pm10: r.pm10, so2: r.so2, no2: r.no2, o3: r.o3, co: r.co }))
      })
      .catch(() => {})
    sync()
    const t = setInterval(sync, 5 * 60 * 1000)
    return () => clearInterval(t)
  }, [])
  const [activeStation, setActiveStation] = useState<Station>('周家坝')
  const [view, setView] = useState<'table' | 'chart'>('table')
  const [chartMetric, setChartMetric] = useState<keyof Omit<HourRecord, 'hour'>>('aqi')

  const zhouData = useMemo(() => recordsToHourly(airQualityData, '周家坝'), [airQualityData])
  const baiData = useMemo(() => recordsToHourly(airQualityData, '百安坝'), [airQualityData])
  const stationData: Record<Station, HourRecord[]> = { '周家坝': zhouData, '百安坝': baiData }
  const data = stationData[activeStation]

  const comparisonData = useMemo(() => {
    const len = Math.max(zhouData.length, baiData.length)
    return Array.from({ length: len }, (_, i) => ({
      hour: (zhouData[i] ?? baiData[i]).hour,
      '周家坝': zhouData[i]?.[chartMetric] as number ?? 0,
      '百安坝': baiData[i]?.[chartMetric] as number ?? 0,
    }))
  }, [zhouData, baiData, chartMetric])

  const metricInfo = METRICS.find(m => m.key === chartMetric)!

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(2, 8, 20, 0.85)',
        backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        style={{
          width: 900, maxWidth: '95vw',
          background: 'linear-gradient(180deg, #040e25 0%, #030c1e 100%)',
          border: '1px solid rgba(0,170,255,0.25)',
          borderRadius: 6,
          boxShadow: '0 0 60px rgba(0,120,255,0.2), 0 0 20px rgba(0,120,255,0.1)',
          display: 'flex', flexDirection: 'column',
          maxHeight: '90vh',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          height: 52,
          padding: '0 20px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderBottom: '1px solid rgba(0,150,220,0.2)',
          background: 'linear-gradient(90deg, rgba(0,170,255,0.08), transparent)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 3, height: 16, background: CYAN, borderRadius: 1 }} />
            <span style={{ color: '#c8e6ff', fontSize: 15, fontWeight: 600, letterSpacing: '0.06em' }}>
              大气环境质量 — 近24小时数据
            </span>
            <span style={{ color: '#3a5a70', fontSize: 12 }}>（每小时整点报送）</span>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 28, height: 28, borderRadius: 4,
              border: '1px solid rgba(0,150,220,0.25)',
              background: 'rgba(0,80,150,0.15)',
              color: '#5a8aaa', cursor: 'pointer', fontSize: 14,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >✕</button>
        </div>

        {/* Controls */}
        <div style={{
          padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 12,
          borderBottom: '1px solid rgba(0,80,150,0.15)',
          flexShrink: 0, flexWrap: 'wrap',
        }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {STATIONS.map(s => (
              <button key={s} onClick={() => setActiveStation(s)} style={{
                padding: '4px 14px', fontSize: 12, borderRadius: 3,
                border: `1px solid ${activeStation === s ? CYAN : 'rgba(0,150,220,0.2)'}`,
                background: activeStation === s ? `${CYAN}20` : 'transparent',
                color: activeStation === s ? CYAN : '#5a8aaa',
                cursor: 'pointer', transition: 'all 0.18s',
                fontFamily: "'Noto Sans SC', sans-serif",
              }}>{s}</button>
            ))}
          </div>

          <div style={{ width: 1, height: 20, background: 'rgba(0,150,220,0.2)' }} />

          <div style={{ display: 'flex', gap: 4 }}>
            {(['table', 'chart'] as const).map(v => (
              <button key={v} onClick={() => setView(v)} style={{
                padding: '4px 14px', fontSize: 12, borderRadius: 3,
                border: `1px solid ${view === v ? '#ffd740' : 'rgba(0,150,220,0.2)'}`,
                background: view === v ? 'rgba(255,215,64,0.1)' : 'transparent',
                color: view === v ? '#ffd740' : '#5a8aaa',
                cursor: 'pointer', transition: 'all 0.18s',
              }}>{v === 'table' ? '数据表格' : '趋势图'}</button>
            ))}
          </div>

          {view === 'chart' && (
            <>
              <div style={{ width: 1, height: 20, background: 'rgba(0,150,220,0.2)' }} />
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {METRICS.map(m => (
                  <button key={m.key} onClick={() => setChartMetric(m.key)} style={{
                    padding: '3px 10px', fontSize: 11, borderRadius: 3,
                    border: `1px solid ${chartMetric === m.key ? m.color : 'rgba(0,150,220,0.15)'}`,
                    background: chartMetric === m.key ? `${m.color}18` : 'transparent',
                    color: chartMetric === m.key ? m.color : '#3a5a70',
                    cursor: 'pointer', transition: 'all 0.15s',
                  }}>{m.label}</button>
                ))}
              </div>
            </>
          )}

          <div style={{ marginLeft: 'auto', color: '#3a5a70', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
            {new Date().toLocaleDateString('zh-CN')} 数据
          </div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {view === 'table' ? (
            <TableView data={data} />
          ) : (
            <ChartView compData={comparisonData} metric={metricInfo} />
          )}
        </div>
      </div>
    </div>
  )
}

function TableView({ data }: { data: HourRecord[] }) {
  const cols: { key: keyof HourRecord; label: string; unit: string }[] = [
    { key: 'hour',  label: '时间',  unit: '' },
    { key: 'aqi',   label: 'AQI',   unit: '' },
    { key: 'pm25',  label: 'PM2.5', unit: 'μg/m³' },
    { key: 'pm10',  label: 'PM10',  unit: 'μg/m³' },
    { key: 'so2',   label: 'SO₂',   unit: 'μg/m³' },
    { key: 'no2',   label: 'NO₂',   unit: 'μg/m³' },
    { key: 'o3',    label: 'O₃',    unit: 'μg/m³' },
    { key: 'co',    label: 'CO',    unit: 'mg/m³' },
  ]

  if (data.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3a5a70', fontSize: 14 }}>
        暂无近24小时数据，请在管理后台推送大气数据
      </div>
    )
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead style={{ position: 'sticky', top: 0, zIndex: 10 }}>
          <tr style={{ background: 'rgba(4,14,35,0.98)', borderBottom: '1px solid rgba(0,150,220,0.2)' }}>
            {cols.map(c => (
              <th key={c.key} style={{
                padding: '8px 12px', textAlign: c.key === 'hour' ? 'left' : 'right',
                color: '#5a8aaa', fontWeight: 600, fontSize: 11,
                whiteSpace: 'nowrap',
              }}>
                {c.label}{c.unit ? <span style={{ color: '#3a5a70', fontSize: 10, marginLeft: 2 }}>{c.unit}</span> : null}
              </th>
            ))}
            <th style={{ padding: '8px 16px 8px 12px', textAlign: 'right', color: '#5a8aaa', fontWeight: 600, fontSize: 11 }}>等级</th>
          </tr>
        </thead>
        <tbody>
          {[...data].reverse().map((row, i) => {
            const isLatest = i === 0
            const aColor = aqiColor(row.aqi)
            return (
              <tr
                key={row.hour}
                style={{
                  borderBottom: '1px solid rgba(0,50,100,0.2)',
                  background: isLatest ? 'rgba(0,170,255,0.06)' : i % 2 === 0 ? 'transparent' : 'rgba(0,30,70,0.15)',
                  transition: 'background 0.15s',
                }}
              >
                <td style={{
                  padding: '7px 12px', color: isLatest ? CYAN : '#5a8aaa',
                  fontFamily: "'JetBrains Mono', monospace", fontWeight: isLatest ? 700 : 400,
                }}>
                  {row.hour}
                  {isLatest && <span style={{ color: '#3a5a70', fontSize: 10, marginLeft: 6 }}>最新</span>}
                </td>
                <td style={{ padding: '7px 12px', textAlign: 'right', color: aColor, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>{row.aqi}</td>
                <td style={{ padding: '7px 12px', textAlign: 'right', color: '#c8e6ff', fontFamily: "'JetBrains Mono', monospace" }}>{row.pm25}</td>
                <td style={{ padding: '7px 12px', textAlign: 'right', color: '#c8e6ff', fontFamily: "'JetBrains Mono', monospace" }}>{row.pm10}</td>
                <td style={{ padding: '7px 12px', textAlign: 'right', color: '#c8e6ff', fontFamily: "'JetBrains Mono', monospace" }}>{row.so2}</td>
                <td style={{ padding: '7px 12px', textAlign: 'right', color: '#c8e6ff', fontFamily: "'JetBrains Mono', monospace" }}>{row.no2}</td>
                <td style={{ padding: '7px 12px', textAlign: 'right', color: '#c8e6ff', fontFamily: "'JetBrains Mono', monospace" }}>{row.o3}</td>
                <td style={{ padding: '7px 12px', textAlign: 'right', color: '#c8e6ff', fontFamily: "'JetBrains Mono', monospace" }}>{row.co}</td>
                <td style={{ padding: '7px 16px 7px 12px', textAlign: 'right' }}>
                  <span style={{
                    padding: '2px 8px', borderRadius: 2, fontSize: 11,
                    background: `${aColor}18`,
                    border: `1px solid ${aColor}40`,
                    color: aColor,
                  }}>{aqiLabel(row.aqi)}</span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ChartView({ compData, metric }: {
  compData: { hour: string; '周家坝': number; '百安坝': number }[]
  metric: { key: string; label: string; unit: string; color: string }
}) {
  if (compData.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3a5a70', fontSize: 14 }}>
        暂无图表数据
      </div>
    )
  }

  const vals1 = compData.map(d => d['周家坝'])
  const vals2 = compData.map(d => d['百安坝'])
  const allVals = [...vals1, ...vals2].filter(v => v > 0)
  const minV = allVals.length ? Math.min(...allVals) : 0
  const maxV = allVals.length ? Math.max(...allVals) : 100
  const range = maxV - minV || 1

  const W = 820, H = 200, PL = 40, PR = 16, PT = 12, PB = 28
  const cW = W - PL - PR
  const cH = H - PT - PB
  const xStep = compData.length > 1 ? cW / (compData.length - 1) : cW

  const toX = (i: number) => PL + i * xStep
  const toY = (v: number) => PT + cH - (v - minV) / range * cH

  const path1 = vals1.map((v, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ')
  const path2 = vals2.map((v, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ')

  const yTicks = 4
  const summaries = [
    { name: '周家坝', vals: vals1, color: CYAN },
    { name: '百安坝', vals: vals2, color: TEAL },
  ]

  return (
    <div style={{ flex: 1, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12, overflow: 'hidden' }}>
      {/* Summary strip */}
      <div style={{ display: 'flex', gap: 12, flexShrink: 0 }}>
        {summaries.map(({ name, vals, color }) => {
          const avg = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10 : 0
          const max = vals.length ? Math.max(...vals) : 0
          const min = vals.length ? Math.min(...vals) : 0
          return (
            <div key={name} style={{
              flex: 1, padding: '10px 14px',
              background: 'rgba(0,30,70,0.4)',
              border: `1px solid ${color}30`,
              borderRadius: 4,
              display: 'flex', alignItems: 'center', gap: 16,
            }}>
              <div style={{ width: 3, height: 28, background: color, borderRadius: 1 }} />
              <div>
                <div style={{ color: '#5a8aaa', fontSize: 11, marginBottom: 2 }}>{name}</div>
                <div style={{ color: color, fontSize: 18, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>
                  {metric.label} <span style={{ fontSize: 13 }}>{avg}</span>
                  {metric.unit && <span style={{ color: '#3a5a70', fontSize: 10, marginLeft: 3 }}>{metric.unit}</span>}
                </div>
              </div>
              <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                <div style={{ color: '#5a8aaa', fontSize: 11 }}>最高 <span style={{ color: AMBER, fontFamily: "'JetBrains Mono', monospace" }}>{max}</span></div>
                <div style={{ color: '#5a8aaa', fontSize: 11 }}>最低 <span style={{ color: GREEN, fontFamily: "'JetBrains Mono', monospace" }}>{min}</span></div>
              </div>
            </div>
          )
        })}
      </div>

      {/* SVG Chart */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', height: '100%' }}>
          {/* Y grid + labels */}
          {Array.from({ length: yTicks + 1 }, (_, ti) => {
            const v = minV + (range * ti / yTicks)
            const y = toY(v)
            return (
              <g key={ti}>
                <line x1={PL} y1={y} x2={W - PR} y2={y} stroke="rgba(0,80,150,0.2)" strokeWidth={0.5} />
                <text x={PL - 4} y={y + 4} textAnchor="end" fill="#3a5a70" fontSize={9}>{Math.round(v)}</text>
              </g>
            )
          })}

          {/* X axis labels */}
          {compData.map((d, i) => {
            if (compData.length > 12 && i % 3 !== 0) return null
            if (compData.length <= 12 && i % 2 !== 0) return null
            return (
              <text key={i} x={toX(i)} y={H - 4} textAnchor="middle" fill="#3a5a70" fontSize={9}>
                {d.hour}
              </text>
            )
          })}

          {/* Lines */}
          {vals1.length > 1 && <path d={path1} fill="none" stroke={CYAN} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />}
          {vals2.length > 1 && <path d={path2} fill="none" stroke={TEAL} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" strokeDasharray="4 2" />}

          {/* Dots for last points */}
          {vals1.length > 0 && <circle cx={toX(vals1.length - 1)} cy={toY(vals1[vals1.length - 1])} r={3} fill={CYAN} />}
          {vals2.length > 0 && <circle cx={toX(vals2.length - 1)} cy={toY(vals2[vals2.length - 1])} r={3} fill={TEAL} />}
        </svg>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 16, flexShrink: 0, justifyContent: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width="20" height="4"><line x1="0" y1="2" x2="20" y2="2" stroke={CYAN} strokeWidth="1.5" /></svg>
          <span style={{ color: '#5a8aaa', fontSize: 12 }}>周家坝</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width="20" height="4"><line x1="0" y1="2" x2="20" y2="2" stroke={TEAL} strokeWidth="1.5" strokeDasharray="4 2" /></svg>
          <span style={{ color: '#5a8aaa', fontSize: 12 }}>百安坝</span>
        </div>
      </div>
    </div>
  )
}
