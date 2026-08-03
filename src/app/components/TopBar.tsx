import { useState, useEffect } from 'react'

export function TopBar({ onOpenAdmin }: { onOpenAdmin?: () => void }) {
  const [time, setTime] = useState(new Date())
  const [weather, setWeather] = useState<{ text: string; temp: string; iconType: string; windSpeed: string; windDir: string }>({
    text: '晴',
    temp: '--',
    iconType: 'sun',
    windSpeed: '--',
    windDir: '',
  })

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  // 获取真实天气（默认重庆万州）
  useEffect(() => {
    const fetchWeather = async () => {
      try {
        const res = await fetch('/api/weather')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        const code = data?.current_weather?.weathercode ?? 0
        const temp = data?.current_weather?.temperature
        const windSpeed = data?.current_weather?.windspeed
        const windDeg = data?.current_weather?.winddirection
        const info = wmoToWeather(code)
        setWeather({
          text: info.text,
          temp: temp != null ? String(Math.round(temp)) : '--',
          iconType: info.iconType,
          windSpeed: windSpeed != null ? String(Math.round(windSpeed)) : '--',
          windDir: windDeg != null ? windDirToText(windDeg) : '',
        })
      } catch (e) {
        // 失败时保持默认，避免空白
        console.warn('天气获取失败:', e)
      }
    }
    fetchWeather()
    const weatherTimer = setInterval(fetchWeather, 10 * 60 * 1000) // 10 分钟刷新
    return () => clearInterval(weatherTimer)
  }, [])

  const pad = (n: number) => String(n).padStart(2, '0')
  const dateStr = `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`
  const timeStr = `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`
  const weekStr = `星期${['日', '一', '二', '三', '四', '五', '六'][time.getDay()]}`

  return (
    <header
      className="relative flex items-center justify-between px-6 shrink-0"
      style={{
        height: 84,
        background: 'linear-gradient(90deg, #020915 0%, #061530 40%, #071840 60%, #020915 100%)',
        borderBottom: '1px solid rgba(0,180,255,0.25)',
        boxShadow: '0 2px 20px rgba(0,120,255,0.15)',
      }}
    >
      {/* 扫描线 */}
      <div style={{
        position: 'absolute', top: 0, left: 0, height: 1.5, width: 140,
        background: 'linear-gradient(90deg, transparent, rgba(0,200,255,0.7), transparent)',
        animation: 'scan-line 4s ease-in-out infinite',
      }} />

      {/* Left: 日期星期 + 大时间 + 天气（对齐参考图左侧信息位） */}
      <div className="flex items-center gap-4" style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ color: '#7ab8e0', fontSize: 12, letterSpacing: '0.08em', whiteSpace: 'nowrap' }}>
            {dateStr} <span style={{ color: '#5a8aaa' }}>{weekStr}</span>
          </span>
          <span
            style={{
              color: '#c8e6ff',
              fontSize: 22,
              fontFamily: "'JetBrains Mono', monospace",
              fontWeight: 700,
              letterSpacing: '0.06em',
              lineHeight: 1.1,
              textShadow: '0 0 12px rgba(0,180,255,0.45)',
              whiteSpace: 'nowrap',
            }}
          >
            {timeStr}
          </span>
        </div>

        <div style={{ width: 1, height: 34, background: 'rgba(0,150,220,0.3)' }} />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div className="flex items-center gap-1.5" style={{ fontSize: 13, whiteSpace: 'nowrap' }}>
            <WeatherIcon type={weather.iconType} />
            <span style={{ color: '#ffd740' }}>{weather.text} {weather.temp}°C</span>
          </div>
          <span style={{ color: '#5a8aaa', fontSize: 11, whiteSpace: 'nowrap' }}>
            {weather.windDir ? `${weather.windDir}风 ${weather.windSpeed}km/h` : '风力数据加载中'}
          </span>
        </div>
      </div>

      {/* Center: 科技翼 + 发光标题 + 副标题 + 跑马灯 */}
      <div
        className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center"
        style={{ pointerEvents: 'none' }}
      >
        <div className="flex items-center">
          <HeaderWing />
          <h1
            style={{
              fontFamily: "'Noto Sans SC', sans-serif",
              fontSize: 27,
              fontWeight: 700,
              letterSpacing: '0.06em',
              background: 'linear-gradient(90deg, #7dd3ff, #ffffff 45%, #7dd3ff)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              lineHeight: 1.15,
              filter: 'drop-shadow(0 0 14px rgba(0,180,255,0.5))',
              whiteSpace: 'nowrap',
              margin: '0 6px',
            }}
          >
            万州区生态环境局AI环境防控物联网系统
          </h1>
          <HeaderWing flip />
        </div>
        {/* 副标题 */}
        <div className="flex items-center gap-2" style={{ marginTop: 2 }}>
          <div style={{ width: 56, height: 1, background: 'linear-gradient(90deg, transparent, rgba(0,180,255,0.5))' }} />
          <span style={{ color: 'rgba(0,200,255,0.55)', fontSize: 10, letterSpacing: '0.32em', fontWeight: 500 }}>
            生态环境智慧防控一体化平台
          </span>
          <div style={{ width: 56, height: 1, background: 'linear-gradient(90deg, rgba(0,180,255,0.5), transparent)' }} />
        </div>
        {/* 跑马灯公告 */}
        <div style={{
          marginTop: 4, width: 280, height: 17, overflow: 'hidden',
          background: 'rgba(0,30,60,0.45)', border: '1px solid rgba(0,140,220,0.12)', borderRadius: 2, position: 'relative',
        }}>
          <div style={{
            position: 'absolute', top: -1, bottom: -1, left: -1, width: 3,
            background: 'rgba(0,200,255,0.25)', boxShadow: '0 0 6px rgba(0,200,255,0.4)',
          }} />
          <div style={{
            display: 'inline-flex', whiteSpace: 'nowrap',
            animation: 'marquee 16s linear infinite',
            color: '#7ab8e0', fontSize: 11, lineHeight: '17px',
            paddingLeft: 10,
          }}>
            <span style={{ marginRight: 36 }}>今日推送 8 件</span>
            <span style={{ marginRight: 36 }}>已结案 6 件</span>
            <span style={{ marginRight: 36 }}>处置率 75%</span>
            <span style={{ marginRight: 36 }}>系统运行正常 · 万州区生态环境局</span>
            <span style={{ marginRight: 36 }}>今日推送 8 件</span>
            <span style={{ marginRight: 36 }}>已结案 6 件</span>
            <span style={{ marginRight: 36 }}>处置率 75%</span>
            <span style={{ marginRight: 36 }}>系统运行正常 · 万州区生态环境局</span>
          </div>
        </div>
      </div>

      {/* Right: 模式标签（参考图「大气环境管理/渝小蓝/PC端」位） + 系统状态 */}
      <div className="flex items-center gap-4" style={{ flex: 1, justifyContent: 'flex-end' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              width: 9, height: 9, borderRadius: '50%',
              background: '#00e676', boxShadow: '0 0 7px #00e676',
              animation: 'pulse-dot 2s infinite',
            }}
          />
          <span style={{ color: '#5a8aaa', fontSize: 12, whiteSpace: 'nowrap' }}>系统运行正常</span>
        </div>

        <div
          style={{
            display: 'flex', overflow: 'hidden', borderRadius: 3,
            border: '1px solid rgba(0,180,255,0.32)',
            boxShadow: '0 0 12px -4px rgba(0,180,255,0.35)',
          }}
        >
          <span
            style={{
              padding: '5px 14px', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
              color: '#04122a',
              background: 'linear-gradient(180deg, #37c8ff, #00a8e8)',
              letterSpacing: '0.06em',
            }}
          >
            AI环境防控
          </span>
          {onOpenAdmin && (
            <button
              onClick={onOpenAdmin}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '5px 14px', fontSize: 12, whiteSpace: 'nowrap',
                background: 'rgba(0,60,110,0.35)',
                color: '#7ab8e0', cursor: 'pointer',
                borderLeft: '1px solid rgba(0,180,255,0.32)',
                transition: 'all 0.15s',
                letterSpacing: '0.06em',
              }}
              onMouseEnter={e => { e.currentTarget.style.color = '#00e5ff'; e.currentTarget.style.background = 'rgba(0,120,200,0.35)' }}
              onMouseLeave={e => { e.currentTarget.style.color = '#7ab8e0'; e.currentTarget.style.background = 'rgba(0,60,110,0.35)' }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
              </svg>
              管理后台
            </button>
          )}
        </div>
      </div>

      <style>{`
        @keyframes pulse-dot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(0.8); }
        }
        @keyframes scan-line {
          0% { left: -140px; }
          100% { left: calc(100% + 140px); }
        }
        @keyframes marquee {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
      `}</style>
    </header>
  )
}

/** 标题两侧对称科技翼装饰（参考图风格），flip 镜像 */
function HeaderWing({ flip }: { flip?: boolean }) {
  const gid = flip ? 'wing-grad-r' : 'wing-grad-l'
  return (
    <svg
      width="150" height="30" viewBox="0 0 150 30"
      style={{ transform: flip ? 'scaleX(-1)' : undefined, flexShrink: 0, opacity: 0.9 }}
      aria-hidden
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#00d4ff" stopOpacity="0" />
          <stop offset="100%" stopColor="#00d4ff" stopOpacity="0.85" />
        </linearGradient>
      </defs>
      <path d="M2 15 H96 L114 5 H146" stroke={`url(#${gid})`} strokeWidth="2" fill="none" />
      <path d="M10 15 H90 L106 24 H138" stroke={`url(#${gid})`} strokeWidth="1" fill="none" opacity="0.55" />
      <circle cx="146" cy="5" r="2" fill="#00d4ff" opacity="0.9" />
      <circle cx="138" cy="24" r="1.5" fill="#00d4ff" opacity="0.6" />
    </svg>
  )
}

function WeatherIcon({ type }: { type: string }) {
  const color = '#ffd740'
  const size = 18
  switch (type) {
    case 'cloud':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="rgba(255,255,255,0.1)" />
        </svg>
      )
    case 'rain':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="rgba(255,255,255,0.1)" />
          <path d="M8 22v-2M12 22v-2M16 22v-2" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )
    case 'snow':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="3" stroke={color} strokeWidth="1.5" />
          <path d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )
    case 'thunder':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="rgba(255,255,255,0.1)" />
          <path d="M13 16l-2 4h4l-2 4" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'fog':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <path d="M4 14h16M4 18h16M4 10h16M4 6h16" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )
    case 'sun':
    default:
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="4" fill={color} />
          <path d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )
  }
}

function wmoToWeather(code: number): { text: string; iconType: string } {
  // WMO Weather interpretation codes (WW)
  if (code === 0) return { text: '晴', iconType: 'sun' }
  if (code === 1) return { text: '多云', iconType: 'sun' }
  if (code === 2) return { text: '多云', iconType: 'cloud' }
  if (code === 3) return { text: '阴', iconType: 'cloud' }
  if (code === 45 || code === 48) return { text: '雾', iconType: 'fog' }
  if (code === 51 || code === 53 || code === 55) return { text: '毛毛雨', iconType: 'rain' }
  if (code === 56 || code === 57) return { text: '冻雨', iconType: 'rain' }
  if (code === 61 || code === 63 || code === 65) return { text: '雨', iconType: 'rain' }
  if (code === 66 || code === 67) return { text: '冻雨', iconType: 'rain' }
  if (code === 71 || code === 73 || code === 75 || code === 77) return { text: '雪', iconType: 'snow' }
  if (code === 80 || code === 81 || code === 82) return { text: '阵雨', iconType: 'rain' }
  if (code === 85 || code === 86) return { text: '阵雪', iconType: 'snow' }
  if (code === 95 || code === 96 || code === 99) return { text: '雷雨', iconType: 'thunder' }
  return { text: '晴', iconType: 'sun' }
}

function windDirToText(deg: number): string {
  // 风向角度 → 中文方位
  const dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北']
  const idx = Math.round(deg / 45) % 8
  return dirs[idx]
}

