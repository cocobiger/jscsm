import { useState, useEffect, useMemo } from 'react'
import { AirQualityModal } from './AirQualityModal'
import { AnimatedNumber } from './AnimatedNumber'
import { PanelFrame } from './PanelFrame'
import { useDashboard } from '../context/DashboardContext'
import { CK, alpha } from '../lib/cockpitTheme'

const CYAN = CK.cyanSoft
const GREEN = CK.green
const AMBER = CK.amber
const ORANGE = CK.orange
const RED = CK.red

interface DeviceCategory {
  label: string
  online: number
  total: number
  key: string
  color: string
}

interface DeviceStatusData {
  total: { online: number; total: number; rate: number }
  categories: DeviceCategory[]
  updatedAt: string
}

type Status = 'good' | 'light' | 'moderate' | 'heavy'

function statusColor(s: Status) {
  return { good: GREEN, light: AMBER, moderate: ORANGE, heavy: RED }[s]
}

function aqiLevel(aqi: number): { label: string; color: string } {
  if (aqi <= 50) return { label: '优', color: GREEN }
  if (aqi <= 100) return { label: '良', color: AMBER }
  if (aqi <= 150) return { label: '轻度', color: ORANGE }
  if (aqi <= 200) return { label: '中度', color: '#ff5722' }
  return { label: '重度', color: RED }
}

interface Metric {
  key: string; label: string; value: number; unit: string; limit: number
}

function deriveStatus(value: number, limit: number): Status {
  if (value > limit) return 'heavy'
  if (value > limit * 0.8) return 'moderate'
  if (value > limit * 0.6) return 'light'
  return 'good'
}

const STATION_BASE: Record<string, { aqi: number; metrics: Metric[] }> = {
  '周家坝': {
    aqi: 78,
    metrics: [
      { key: 'pm25', label: 'PM2.5', value: 22, unit: 'μg/m³', limit: 75 },
      { key: 'pm10', label: 'PM10',  value: 48, unit: 'μg/m³', limit: 150 },
      { key: 'so2',  label: 'SO₂',   value: 14, unit: 'μg/m³', limit: 60 },
      { key: 'no2',  label: 'NO₂',   value: 31, unit: 'μg/m³', limit: 40 },
      { key: 'o3',   label: 'O₃',    value: 126, unit: 'μg/m³', limit: 160 },
      { key: 'co',   label: 'CO',    value: 0.9, unit: 'mg/m³', limit: 4 },
    ],
  },
  '百安坝': {
    aqi: 55,
    metrics: [
      { key: 'pm25', label: 'PM2.5', value: 15, unit: 'μg/m³', limit: 75 },
      { key: 'pm10', label: 'PM10',  value: 38, unit: 'μg/m³', limit: 150 },
      { key: 'so2',  label: 'SO₂',   value: 9,  unit: 'μg/m³', limit: 60 },
      { key: 'no2',  label: 'NO₂',   value: 22, unit: 'μg/m³', limit: 40 },
      { key: 'o3',   label: 'O₃',    value: 88, unit: 'μg/m³', limit: 160 },
      { key: 'co',   label: 'CO',    value: 0.7, unit: 'mg/m³', limit: 4 },
    ],
  },
}

function genSparkline(base: number, count = 14) {
  return Array.from({ length: count }, () => ({
    v: base + (Math.random() - 0.5) * base * 0.22,
  }))
}

function initSparklines(metrics: Metric[]) {
  return metrics.map(m => genSparkline(m.value))
}

function Sparkline({ data }: { data: { v: number }[] }) {
  const W = 68, H = 26, pad = 2
  const vals = data.map(d => d.v)
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const range = max - min || 1
  const xStep = (W - pad * 2) / (vals.length - 1)
  const y = (v: number) => pad + (1 - (v - min) / range) * (H - pad * 2)
  const pts = vals.map((v, i) => `${pad + i * xStep},${y(v)}`)
  const d = `M${pts.join(' L')}`
  return (
    <svg width={W} height={H} style={{ display: 'block', flexShrink: 0 }}>
      <path d={d} fill="none" stroke={CYAN} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

const WATER_METRICS = [
  { key: 'ph',  label: 'pH',    value: 7.2,  unit: '',     status: 'good' as Status, range: '6.5-8.5' },
  { key: 'do',  label: '溶解氧', value: 8.4,  unit: 'mg/L', status: 'good' as Status, range: '>5' },
  { key: 'nh3', label: '氨氮',   value: 0.32, unit: 'mg/L', status: 'good' as Status, range: '<1.0' },
  { key: 'tp',  label: '总磷',   value: 0.08, unit: 'mg/L', status: 'good' as Status, range: '<0.1' },
  { key: 'cod', label: '高锰酸盐', value: 3.2, unit: 'mg/L', status: 'good' as Status, range: '<6' },
]

interface PanelSectionProps {
  title: string
  color: string
  flexGrow?: number
  heightPct?: number
  fit?: 'pct' | 'content' | 'fill' | 'grow'
  grow?: number
  headerExtra?: React.ReactNode
  children: React.ReactNode
}

/** 兼容层：旧 PanelSection 调用签名 → 新 PanelFrame（DataV 风格四角描边面板） */
function PanelSection(props: PanelSectionProps) {
  return <PanelFrame {...props} scan />
}

const STATIONS = Object.keys(STATION_BASE) as (keyof typeof STATION_BASE)[]

export function LeftPanel() {
  const [activeStation, setActiveStation] = useState<string>('周家坝')
  const [showModal, setShowModal] = useState(false)
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatusData | null>(null)

  const { airQualityData } = useDashboard()

  // 轮询设备在线状态（真实数据）
  useEffect(() => {
    const fetchStatus = () =>
      fetch('/api/device-status')
        .then(r => r.json())
        .then(d => { if (d.total) setDeviceStatus(d) })
        .catch(() => {})
    fetchStatus()
    const t = setInterval(fetchStatus, 15000)
    return () => clearInterval(t)
  }, [])

  // Derive live data from real airQualityData; fallback to STATION_BASE when empty
  const liveData = useMemo(() => {
    return Object.fromEntries(STATIONS.map(name => {
      const records = airQualityData
        .filter(r => r.station === name)
        .sort((a, b) => {
          const ta = a.date + String(a.hour).padStart(2, '0')
          const tb = b.date + String(b.hour).padStart(2, '0')
          return tb.localeCompare(ta)
        })
      const latest = records[0]
      if (!latest) {
        return [name, { aqi: STATION_BASE[name].aqi, metrics: [...STATION_BASE[name].metrics] }]
      }
      const base = STATION_BASE[name]
      const metrics = base.metrics.map(m => {
        const val = latest[m.key as keyof typeof latest] as number
        return { ...m, value: typeof val === 'number' ? val : m.value }
      })
      return [name, { aqi: latest.aqi, metrics }]
    }))
  }, [airQualityData])

  // Sparklines: use recent history per station (up to 14 data points)
  const sparklines = useMemo(() => {
    return Object.fromEntries(STATIONS.map(name => {
      const records = airQualityData
        .filter(r => r.station === name)
        .sort((a, b) => {
          const ta = a.date + String(a.hour).padStart(2, '0')
          const tb = b.date + String(b.hour).padStart(2, '0')
          return ta.localeCompare(tb)  // ascending for sparkline
        })
        .slice(-14)
      const base = STATION_BASE[name]
      return [name, base.metrics.map(m => {
        if (records.length >= 2) {
          return records.map(r => ({ v: (r[m.key as keyof typeof r] as number) ?? m.value }))
        }
        return genSparkline(m.value)
      })]
    }))
  }, [airQualityData])

  const station = liveData[activeStation]
  const sl = sparklines[activeStation]
  const aqiInfo = aqiLevel(station.aqi)

  const stationToggle = (
    <div className="flex items-center gap-1">
      {STATIONS.map(name => (
        <button
          key={name}
          onClick={() => setActiveStation(name)}
          style={{
            padding: '3px 10px',
            fontSize: 11,
            borderRadius: 3,
            border: `1px solid ${activeStation === name ? CYAN : 'rgba(0,150,220,0.2)'}`,
            background: activeStation === name ? `${CYAN}22` : 'transparent',
            color: activeStation === name ? CYAN : '#5a8aaa',
            cursor: 'pointer',
            transition: 'all 0.18s',
            fontFamily: "'Noto Sans SC', sans-serif",
            fontWeight: activeStation === name ? 600 : 400,
          }}
        >
          {name}
        </button>
      ))}
      <button
        onClick={() => setShowModal(true)}
        style={{
          padding: '3px 9px',
          fontSize: 11,
          borderRadius: 3,
          border: '1px solid rgba(255,215,64,0.35)',
          background: 'rgba(255,215,64,0.08)',
          color: '#ffd740',
          cursor: 'pointer',
          transition: 'all 0.18s',
          display: 'flex',
          alignItems: 'center',
          gap: 3,
          marginLeft: 2,
        }}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#ffd740" strokeWidth="2.5">
          <path d="M9 18l6-6-6-6" />
        </svg>
        更多
      </button>
    </div>
  )

  return (
    <div
      className="flex flex-col h-full"
      style={{
        background: 'rgba(4, 12, 30, 0.98)',
        borderRight: '1px solid rgba(0, 150, 220, 0.15)',
        overflow: 'hidden',
        minHeight: 0,
      }}
    >
      {/* Panels wrapper — takes ALL remaining space; weather block is excluded */}
      <div style={{ flex: 1, minHeight: 0, height: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Atmospheric section — grow 占满分配（内容保底，余量拉伸网格行高） */}
      <PanelSection title="大气环境质量" color={CYAN} fit="grow" grow={4} headerExtra={stationToggle}>
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* AQI 大字报卡 */}
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 12,
            marginTop: 4, marginBottom: 8,
            padding: '7px 12px',
            background: `linear-gradient(135deg, ${alpha(aqiInfo.color, 0.16)}, rgba(6,14,32,0.35) 68%)`,
            border: `1px solid ${alpha(aqiInfo.color, 0.42)}`,
            borderRadius: 4,
            boxShadow: `inset 0 0 22px -10px ${alpha(aqiInfo.color, 0.55)}, 0 0 14px -8px ${alpha(aqiInfo.color, 0.4)}`,
            transition: 'all 0.3s',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: CK.textSub, fontSize: 11 }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={CK.textDim} strokeWidth="2">
                <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" />
                <circle cx="12" cy="9" r="2.5" />
              </svg>
              AQI · {activeStation}监测站
            </div>
            <AnimatedNumber
              value={station.aqi}
              style={{
                color: aqiInfo.color,
                fontSize: 38,
                fontFamily: "'JetBrains Mono', monospace",
                fontWeight: 700,
                lineHeight: 1.15,
                textShadow: `0 0 18px ${alpha(aqiInfo.color, 0.7)}`,
                transition: 'color 0.3s',
              }}
            />
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right', flexShrink: 0 }}>
            <span
              style={{
                display: 'inline-block',
                padding: '2px 14px',
                background: alpha(aqiInfo.color, 0.16),
                border: `1px solid ${alpha(aqiInfo.color, 0.55)}`,
                borderRadius: 3,
                color: aqiInfo.color,
                fontSize: 14,
                fontWeight: 700,
                letterSpacing: '0.12em',
                textShadow: `0 0 8px ${alpha(aqiInfo.color, 0.6)}`,
                transition: 'all 0.3s',
              }}
            >
              {aqiInfo.label}
            </span>
            <div className="flex items-center justify-end gap-1.5" style={{ marginTop: 5 }}>
              <div style={{
                width: 6, height: 6, borderRadius: '50%',
                background: GREEN, boxShadow: `0 0 5px ${GREEN}`,
                animation: 'live-pulse 2s ease-in-out infinite',
              }} />
              <span style={{ color: CK.textFaint, fontSize: 11 }}>实时</span>
            </div>
          </div>
        </div>

        {/* 6 指标网格卡（2×3，gridAutoRows 1fr 随空间拉伸行高） */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gridAutoRows: '1fr', gap: 6, flex: 1, minHeight: 0 }}>
          {station.metrics.map((m, i) => {
            const st = deriveStatus(m.value, m.limit)
            return (
              <div
                key={m.key}
                style={{
                  background: 'rgba(8,20,44,0.5)',
                  border: `1px solid ${alpha(statusColor(st), 0.22)}`,
                  borderRadius: 4,
                  padding: '5px 8px 4px',
                  boxShadow: `inset 0 0 12px -8px ${alpha(statusColor(st), 0.4)}`,
                  transition: 'border-color 0.3s',
                  display: 'flex', flexDirection: 'column', justifyContent: 'center',
                }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <div style={{
                      width: 6, height: 6, borderRadius: '50%',
                      background: statusColor(st),
                      boxShadow: `0 0 5px ${statusColor(st)}`,
                    }} />
                    <span style={{ color: CK.textSub, fontSize: 12 }}>{m.label}</span>
                  </div>
                  <span style={{ color: CK.textFaint, fontSize: 10 }}>{m.unit}</span>
                </div>
                <div className="flex items-end justify-between" style={{ marginTop: 1 }}>
                  <span style={{
                    color: statusColor(st),
                    fontSize: 18,
                    fontFamily: "'JetBrains Mono', monospace",
                    fontWeight: 700,
                    lineHeight: 1.2,
                    textShadow: `0 0 10px ${alpha(statusColor(st), 0.45)}`,
                    transition: 'color 0.3s',
                  }}>
                    {m.value}
                  </span>
                  <Sparkline data={sl[i]} />
                </div>
              </div>
            )
          })}
        </div>
        </div>
      </PanelSection>

      {/* P1 站点空气质量排名（真实数据：两站 AQI 降序 + 首要污染物）— grow 占满分配 */}
      <PanelSection title="站点空气质量排名" color={AMBER} fit="grow" grow={2}>
        {(() => {
          const ranked = STATIONS
            .map(name => {
              const d = liveData[name]
              // 首要污染物 = 占标率最高的指标
              let primary = d.metrics[0]
              let maxRatio = -1
              for (const m of d.metrics) {
                const r = m.value / m.limit
                if (r > maxRatio) { maxRatio = r; primary = m }
              }
              return { name, aqi: d.aqi, info: aqiLevel(d.aqi), primary, ratio: maxRatio }
            })
            .sort((a, b) => b.aqi - a.aqi)
          const maxAqi = ranked[0]?.aqi || 1
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 3, height: '100%' }}>
              {ranked.map((s, i) => (
                <div
                  key={s.name}
                  onClick={() => setActiveStation(s.name)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 7,
                    padding: '4px 7px',
                    flex: 1,
                    minHeight: 0,
                    background: s.name === activeStation ? 'rgba(0,170,255,0.10)' : 'rgba(8,20,44,0.45)',
                    border: `1px solid ${s.name === activeStation ? 'rgba(0,170,255,0.35)' : 'rgba(0,150,220,0.12)'}`,
                    borderRadius: 4,
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                  }}
                >
                  <span style={{
                    width: 16, height: 16, borderRadius: 2, flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: i === 0 ? 'rgba(255,112,67,0.9)' : 'rgba(0,80,150,0.5)',
                    color: i === 0 ? '#fff' : CK.textSub,
                    fontSize: 10, fontWeight: 700,
                    fontFamily: "'JetBrains Mono', monospace",
                    boxShadow: i === 0 ? '0 0 8px rgba(255,112,67,0.5)' : 'none',
                  }}>
                    {i + 1}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="flex items-center justify-between">
                      <span style={{ color: CK.textMain, fontSize: 12 }}>{s.name}</span>
                      <span style={{
                        color: s.info.color, fontSize: 13, fontWeight: 700,
                        fontFamily: "'JetBrains Mono', monospace",
                        textShadow: `0 0 8px ${alpha(s.info.color, 0.5)}`,
                      }}>
                        {s.aqi} <span style={{ fontSize: 10, fontWeight: 400 }}>{s.info.label}</span>
                      </span>
                    </div>
                    <div style={{ height: 4, background: 'rgba(0,60,120,0.35)', borderRadius: 2, marginTop: 3, overflow: 'hidden' }}>
                      <div style={{
                        width: `${Math.max(6, (s.aqi / maxAqi) * 100)}%`, height: '100%',
                        background: `linear-gradient(90deg, ${alpha(s.info.color, 0.55)}, ${s.info.color})`,
                        borderRadius: 2,
                        boxShadow: `0 0 6px ${alpha(s.info.color, 0.5)}`,
                        transition: 'width 0.5s',
                      }} />
                    </div>
                    <div style={{ color: CK.textFaint, fontSize: 10, marginTop: 2 }}>
                      首要污染物 {s.primary.label} · 占标率 {Math.round(s.ratio * 100)}%
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )
        })()}
      </PanelSection>

      {/* Water section — grow 占满分配（5 项指标行随空间均分拉高） */}
      <PanelSection title="水质监测数据" color="#00bcd4" fit="grow" grow={2.5}>
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div className="flex items-center gap-2 mb-1.5" style={{ fontSize: 12, color: '#5a8aaa', flexShrink: 0 }}>
          <span>长江入库断面</span>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: GREEN, boxShadow: `0 0 4px ${GREEN}` }} />
          <span style={{ color: GREEN }}>Ⅱ类水质</span>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {WATER_METRICS.map(m => (
          <div key={m.key} className="flex items-center justify-between" style={{ borderBottom: '1px solid rgba(0,80,150,0.12)', flex: 1, minHeight: 0 }}>
            <div className="flex items-center gap-2">
              <div style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor(m.status), boxShadow: `0 0 5px ${statusColor(m.status)}` }} />
              <span style={{ color: '#7ab8e0', fontSize: 13 }}>{m.label}</span>
            </div>
            <span style={{ color: '#3a5a70', fontSize: 12 }}>{m.range}</span>
            <div>
              <span style={{ color: statusColor(m.status), fontSize: 14, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>
                {m.value}
              </span>
              <span style={{ color: '#3a5a70', fontSize: 11, marginLeft: 3 }}>{m.unit}</span>
            </div>
          </div>
        ))}
        </div>
        </div>
      </PanelSection>

      {/* Device section — 真实数据；grow 占满分配（分类行随空间均分拉高） */}
      <PanelSection title="设备在线状态" color={GREEN} fit="grow" grow={2.5}>
        {deviceStatus ? (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div className="flex items-center justify-between mb-2" style={{ flexShrink: 0 }}>
              <div>
                <span style={{ color: '#c8e6ff', fontSize: 22, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>
                  <AnimatedNumber value={deviceStatus.total.online} style={{ color: 'inherit', fontFamily: 'inherit', fontSize: 'inherit', fontWeight: 'inherit' }} />
                </span>
                <span style={{ color: '#5a8aaa', fontSize: 14 }}>/{deviceStatus.total.total}</span>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ color: GREEN, fontSize: 16, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>{deviceStatus.total.rate}%</div>
                <div style={{ color: '#5a8aaa', fontSize: 11 }}>在线率</div>
              </div>
            </div>
            <div style={{ height: 5, background: 'rgba(0,80,150,0.3)', borderRadius: 3, marginBottom: 10, overflow: 'hidden', flexShrink: 0 }}>
              <div style={{ width: `${deviceStatus.total.rate}%`, height: '100%', background: `linear-gradient(90deg, ${GREEN}, #00bcd4)`, borderRadius: 3 }} />
            </div>
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {deviceStatus.categories.map(d => (
              <div key={d.label} className="flex items-center justify-between" style={{ borderBottom: '1px solid rgba(0,80,150,0.12)', flex: 1, minHeight: 0 }}>
                <div className="flex items-center gap-2">
                  <div style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: d.online < d.total ? AMBER : d.color,
                    boxShadow: `0 0 5px ${d.online < d.total ? AMBER : d.color}`,
                  }} />
                  <span style={{ color: '#7ab8e0', fontSize: 13 }}>{d.label}</span>
                  {d.online < d.total && <span style={{ color: AMBER, fontSize: 11 }}>⚠ {d.total - d.online}离线</span>}
                </div>
                <span style={{ color: d.color, fontSize: 13, fontFamily: "'JetBrains Mono', monospace" }}>
                  {d.online}<span style={{ color: '#3a8aaa' }}>/{d.total}</span>
                </span>
              </div>
            ))}
            </div>
          </div>
        ) : (
          <div style={{ color: '#3a5a70', fontSize: 12, textAlign: 'center', padding: 20 }}>加载中...</div>
        )}
      </PanelSection>

      <style>{`
        @keyframes live-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>

      </div>{/* end panels wrapper */}

      {showModal && <AirQualityModal onClose={() => setShowModal(false)} />}
    </div>
  )
}
