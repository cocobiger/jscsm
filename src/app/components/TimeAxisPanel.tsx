import { useEffect, useRef, useState } from 'react'
import { authFetch } from '../lib/apiFetch'
import { aqiColor, aqiLevel } from '../lib/airQuality'
import { CK } from '../lib/cockpitTheme'

// ── 类型（与后端 /api/hourly-pollution 对齐）──────────────────────────
export interface HourlyPoint {
  hour: number
  aqi: number
  pm25: number
  pm10: number
  so2: number
  no2: number
  o3: number
  co: number
}
export interface HourlyStation {
  name: string
  lat: number | null
  lon: number | null
  series: HourlyPoint[]
}
export interface HourlyPollutionData {
  date: string
  stations: HourlyStation[]
}
/** 时间轴选中态：非 null 时 MapView 按该小时历史数据渲染标记 */
export interface TimelineSelection {
  date: string
  hour: number
  data: HourlyPollutionData
}

interface Props {
  onTimelineChange: (sel: TimelineSelection | null) => void
}

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const SPEEDS = [1, 2, 4]

function todayStr(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function TimeAxisPanel({ onTimelineChange }: Props) {
  const [date, setDate] = useState(todayStr())
  const [hour, setHour] = useState(0)
  const [data, setData] = useState<HourlyPollutionData | null>(null)
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  // 记录用户是否已手动选过小时（避免数据加载时自动覆盖）
  const hourPickedRef = useRef(false)

  // 拉取指定日期逐小时数据
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    authFetch(`/api/hourly-pollution?date=${date}`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        const parsed = d && d.stations ? (d as HourlyPollutionData) : null
        setData(parsed)
        // 默认定位到该日最近有数据的小时
        if (parsed && parsed.stations.length) {
          const maxHour = parsed.stations.reduce<number>((mx: number, s: HourlyStation) => {
            const last = s.series[s.series.length - 1]
            return last && last.hour > mx ? last.hour : mx
          }, 0)
          setHour(maxHour)
        }
      })
      .catch(() => { if (!cancelled) setData(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [date])

  // 播放推进
  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => {
      setHour(h => (h >= 23 ? 0 : h + 1))
    }, 1000 / speed)
    return () => clearInterval(t)
  }, [playing, speed])

  // 同步选中态给上层（MapView 联动）
  useEffect(() => {
    if (!active || !data) {
      onTimelineChange(null)
      return
    }
    onTimelineChange({ date, hour, data })
  }, [active, date, hour, data, onTimelineChange])

  const pickHour = (h: number) => {
    hourPickedRef.current = true
    setHour(h)
    setActive(true)
    setPlaying(false)
  }

  // 该小时两站平均 AQI（用于轨道圆点着色与数值展示）
  const avgAqi = (h: number): number | null => {
    if (!data) return null
    const vals = data.stations
      .map(s => s.series.find(p => p.hour === h)?.aqi)
      .filter((v): v is number => typeof v === 'number')
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null
  }
  const curAqi = avgAqi(hour)

  const dateBack = () => {
    const d = new Date(date + 'T00:00:00')
    d.setDate(d.getDate() - 1)
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    setDate(`${d.getFullYear()}-${m}-${day}`)
    setPlaying(false)
  }
  const dateFwd = () => {
    const d = new Date(date + 'T00:00:00')
    d.setDate(d.getDate() + 1)
    if (d.getTime() > Date.now()) return
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    setDate(`${d.getFullYear()}-${m}-${day}`)
    setPlaying(false)
  }

  return (
    <div style={{
      position: 'absolute', bottom: 56, left: '50%', transform: 'translateX(-50%)',
      zIndex: 26, display: 'flex', alignItems: 'center', gap: 10,
      background: active
        ? 'linear-gradient(160deg, rgba(10,32,66,0.88), rgba(4,12,30,0.82))'
        : 'linear-gradient(160deg, rgba(10,26,56,0.66), rgba(5,13,30,0.52))',
      backdropFilter: 'blur(14px) saturate(1.35)',
      WebkitBackdropFilter: 'blur(14px) saturate(1.35)',
      border: `1px solid ${active ? 'rgba(0,220,255,0.55)' : 'rgba(0,180,255,0.30)'}`,
      borderRadius: 6,
      padding: '6px 12px',
      boxShadow: active
        ? '0 0 24px -4px rgba(0,190,255,0.45), 0 6px 24px rgba(0,0,0,0.42), inset 0 0 20px -10px rgba(0,180,255,0.35)'
        : '0 6px 24px rgba(0,0,0,0.42), inset 0 0 20px -10px rgba(0,180,255,0.35)',
      maxWidth: 'calc(100% - 40px)',
    }}>
      {/* 标题 + 日期切换 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{
          color: active ? '#00ccff' : CK.textDim, fontSize: 11, letterSpacing: '0.12em',
          textShadow: active ? '0 0 8px rgba(0,190,255,0.6)' : 'none',
        }}>时间轴</span>
        <ArrowBtn label="◀" title="前一天" onClick={dateBack} />
        <span style={{
          color: CK.textSub, fontSize: 11,
          fontFamily: "'JetBrains Mono', monospace", minWidth: 78, textAlign: 'center',
        }}>{date}</span>
        <ArrowBtn label="▶" title="后一天" onClick={dateFwd} />
      </div>

      <div style={{ width: 1, height: 22, background: 'rgba(0,150,220,0.2)' }} />

      {/* 0-23 小时轨道 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 3, position: 'relative' }}>
        {HOURS.map(h => {
          const aqi = avgAqi(h)
          const isCur = h === hour && active
          const color = aqi == null ? '#2a3f55' : aqiColor(aqi)
          return (
            <div
              key={h}
              onClick={() => pickHour(h)}
              title={`${String(h).padStart(2, '0')}:00 · AQI ${aqi ?? '—'}`}
              style={{
                width: isCur ? 13 : 9, height: isCur ? 13 : 9,
                borderRadius: '50%', cursor: 'pointer', flexShrink: 0,
                background: aqi == null ? '#223548' : color,
                boxShadow: isCur
                  ? `0 0 10px ${color}, 0 0 0 3px rgba(0,200,255,0.25)`
                  : aqi == null ? 'none' : `0 0 5px ${color}88`,
                border: isCur ? '1.5px solid rgba(255,255,255,0.75)' : '1px solid rgba(255,255,255,0.12)',
                transform: isCur ? 'scale(1.05)' : 'none',
                transition: 'all 0.15s',
              }}
            />
          )
        })}
      </div>

      <div style={{ width: 1, height: 22, background: 'rgba(0,150,220,0.2)' }} />

      {/* 当前小时 AQI 数值 */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 58, lineHeight: 1.15 }}>
        <span style={{
          color: curAqi == null ? '#3a5a70' : aqiColor(curAqi),
          fontSize: 18, fontWeight: 700,
          fontFamily: "'JetBrains Mono', monospace",
          textShadow: curAqi == null ? 'none' : `0 0 10px ${aqiColor(curAqi)}88`,
        }}>
          {active ? (curAqi ?? '—') : '实时'}
        </span>
        <span style={{ color: CK.textDim, fontSize: 9 }}>
          {active ? (curAqi == null ? '无数据' : `AQI ${aqiLevel(curAqi).label}`) : '模式'}
        </span>
      </div>

      <div style={{ width: 1, height: 22, background: 'rgba(0,150,220,0.2)' }} />

      {/* 播放控制 */}
      <button
        onClick={() => {
          if (!active) { setActive(true); setPlaying(true) }
          else setPlaying(p => !p)
        }}
        title={playing ? '暂停' : '播放'}
        style={{
          width: 26, height: 26, borderRadius: '50%', cursor: 'pointer',
          border: '1px solid rgba(0,200,255,0.5)',
          background: playing ? 'rgba(0,200,255,0.25)' : 'rgba(5,15,35,0.7)',
          color: '#00ccff', fontSize: 11, fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: playing ? '0 0 10px -2px rgba(0,200,255,0.6)' : 'none',
          transition: 'all 0.15s',
        }}
      >
        {playing ? '⏸' : '▶'}
      </button>
      <div style={{ display: 'flex', gap: 2 }}>
        {SPEEDS.map(s => (
          <button
            key={s}
            onClick={() => setSpeed(s)}
            style={{
              padding: '2px 6px', borderRadius: 3, cursor: 'pointer', fontSize: 10,
              fontFamily: "'JetBrains Mono', monospace",
              color: speed === s ? '#04122a' : CK.textSub,
              background: speed === s ? 'linear-gradient(180deg,#37c8ff,#00a8e8)' : 'transparent',
              border: `1px solid ${speed === s ? 'rgba(0,200,255,0.6)' : 'rgba(0,150,220,0.18)'}`,
            }}
          >{s}x</button>
        ))}
      </div>

      {/* 退出时间轴（回到实时） */}
      <button
        onClick={() => { setActive(false); setPlaying(false) }}
        style={{
          padding: '4px 10px', borderRadius: 3, cursor: 'pointer', fontSize: 11,
          color: active ? '#04122a' : CK.textSub,
          background: active ? 'linear-gradient(180deg,#37c8ff,#00a8e8)' : 'transparent',
          border: `1px solid ${active ? 'rgba(0,200,255,0.6)' : 'rgba(0,150,220,0.18)'}`,
          letterSpacing: '0.05em',
        }}
      >
        实时
      </button>

      {loading && (
        <span style={{ color: '#3a5a70', fontSize: 9 }}>…</span>
      )}
    </div>
  )
}

function ArrowBtn({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        padding: '1px 5px', borderRadius: 3, cursor: 'pointer', fontSize: 9,
        color: '#5a8aaa', background: 'transparent',
        border: '1px solid rgba(0,150,220,0.2)',
        transition: 'all 0.15s',
      }}
      onMouseEnter={e => { e.currentTarget.style.color = '#00ccff'; e.currentTarget.style.borderColor = 'rgba(0,200,255,0.5)' }}
      onMouseLeave={e => { e.currentTarget.style.color = '#5a8aaa'; e.currentTarget.style.borderColor = 'rgba(0,150,220,0.2)' }}
    >
      {label}
    </button>
  )
}
