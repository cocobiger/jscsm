import { authFetch } from '../../lib/apiFetch'
import { useState, useMemo, useEffect, useCallback } from 'react'
import { useDashboard } from '../../context/DashboardContext'
import type { AirQualityRecord } from '../../context/DashboardContext'

const CYAN = '#00aaff'
const GREEN = '#00e676'
const AMBER = '#ffd740'
const ORANGE = '#ff7043'
const RED = '#ff4444'

const STATIONS = ['全部', '周家坝', '百安坝'] as const
const GAS_TYPES = ['全部', 'AQI', 'PM2.5', 'PM10', 'SO₂', 'NO₂', 'O₃', 'CO'] as const
type GasType = typeof GAS_TYPES[number]

const GAS_KEY_MAP: Record<string, keyof Omit<AirQualityRecord, 'id' | 'station' | 'date' | 'hour' | 'pushedAt'>> = {
  'AQI': 'aqi', 'PM2.5': 'pm25', 'PM10': 'pm10', 'SO₂': 'so2', 'NO₂': 'no2', 'O₃': 'o3', 'CO': 'co',
}

const GAS_COLORS: Record<string, string> = {
  'AQI': CYAN, 'PM2.5': '#00ccff', 'PM10': '#00bcd4', 'SO₂': AMBER, 'NO₂': ORANGE, 'O₃': '#ab47bc', 'CO': GREEN,
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

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 10px',
  background: 'rgba(0,20,60,0.6)',
  border: '1px solid rgba(0,150,220,0.25)',
  borderRadius: 3, color: '#c8e6ff', fontSize: 13,
  fontFamily: "'JetBrains Mono', monospace",
  outline: 'none',
}

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  fontFamily: 'inherit',
}

function btn(color: string, size: 'sm' | 'md' = 'md') {
  return {
    padding: size === 'sm' ? '3px 10px' : '6px 16px',
    fontSize: size === 'sm' ? 11 : 12,
    borderRadius: 3,
    border: `1px solid ${color}55`,
    background: `${color}18`,
    color,
    cursor: 'pointer' as const,
    transition: 'all 0.15s',
  }
}

const EMPTY_FORM = {
  station: '周家坝' as string,
  date: todayStr(),
  hour: new Date().getHours(),
  aqi: 75,
  pm25: 20,
  pm10: 45,
  so2: 12,
  no2: 28,
  o3: 110,
  co: 0.9,
}

function genAutoRecord(station: string): typeof EMPTY_FORM {
  const bases: Record<string, typeof EMPTY_FORM> = {
    '周家坝': { station: '周家坝', date: todayStr(), hour: new Date().getHours(), aqi: 78, pm25: 22, pm10: 48, so2: 14, no2: 31, o3: 126, co: 0.9 },
    '百安坝': { station: '百安坝', date: todayStr(), hour: new Date().getHours(), aqi: 55, pm25: 15, pm10: 38, so2: 9, no2: 22, o3: 88, co: 0.7 },
  }
  const base = bases[station] ?? EMPTY_FORM
  const r = (v: number, pct = 0.15) => parseFloat((v * (1 + (Math.random() - 0.5) * pct)).toFixed(1))
  return {
    ...base,
    aqi: Math.round(r(base.aqi)),
    pm25: Math.round(r(base.pm25)),
    pm10: Math.round(r(base.pm10)),
    so2: Math.round(r(base.so2)),
    no2: Math.round(r(base.no2)),
    o3: Math.round(r(base.o3)),
    co: r(base.co),
  }
}

export function AirQualityDataPage() {
  const { airQualityData, pushAirQualityRecord, deleteAirQualityRecord, clearAirQualityData } = useDashboard()

  // Filters
  const [filterStation, setFilterStation] = useState<string>('全部')
  const [filterDate, setFilterDate] = useState<string>('')
  const [filterGas, setFilterGas] = useState<GasType>('全部')

  // Push form
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [lastSimPushed, setLastSimPushed] = useState<string | null>(null)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)

  const filtered = useMemo(() => {
    return airQualityData.filter(r => {
      if (filterStation !== '全部' && r.station !== filterStation) return false
      if (filterDate && r.date !== filterDate) return false
      return true
    }).sort((a, b) => {
      const ta = `${a.date}${String(a.hour).padStart(2, '0')}`
      const tb = `${b.date}${String(b.hour).padStart(2, '0')}`
      return tb.localeCompare(ta)
    })
  }, [airQualityData, filterStation, filterDate])

  const stats = useMemo(() => {
    const today = todayStr()
    const todayRecs = airQualityData.filter(r => r.date === today)
    const last = airQualityData.reduce<AirQualityRecord | null>((acc, r) => {
      if (!acc || r.pushedAt > acc.pushedAt) return r
      return acc
    }, null)
    return { total: airQualityData.length, todayCount: todayRecs.length, lastPush: last?.pushedAt ?? null }
  }, [airQualityData])

  const handlePush = () => {
    if (!form.station || !form.date) return
    pushAirQualityRecord({
      station: form.station,
      date: form.date,
      hour: Number(form.hour),
      aqi: Number(form.aqi),
      pm25: Number(form.pm25),
      pm10: Number(form.pm10),
      so2: Number(form.so2),
      no2: Number(form.no2),
      o3: Number(form.o3),
      co: Number(form.co),
    })
    setShowForm(false)
    setForm(EMPTY_FORM)
  }

  const handleSimPush = (station: string) => {
    const rec = genAutoRecord(station)
    pushAirQualityRecord({
      station: rec.station,
      date: rec.date,
      hour: rec.hour,
      aqi: rec.aqi,
      pm25: rec.pm25,
      pm10: rec.pm10,
      so2: rec.so2,
      no2: rec.no2,
      o3: rec.o3,
      co: rec.co,
    })
    setLastSimPushed(`${station} ${rec.date} ${String(rec.hour).padStart(2, '0')}:05 — AQI ${rec.aqi}`)
    setTimeout(() => setLastSimPushed(null), 4000)
  }

  const handleSync = useCallback(async (silent = false) => {
    if (!silent) setSyncMsg('同步中…')
    setSyncMsg('同步中…')
    try {
      const res = await authFetch('/api/collected/as-aq?stations=周家坝,百安坝')
      const records: any[] = await res.json()
      // 去重：跳过 station+date+hour 已存在的
      const existKeys = new Set(airQualityData.map(r => `${r.station}|${r.date}|${r.hour}`))
      const toAdd = records.filter(r => !existKeys.has(`${r.station}|${r.date}|${r.hour}`))
      toAdd.forEach(r => pushAirQualityRecord({
        station: r.station, date: r.date, hour: r.hour,
        aqi: r.aqi, pm25: r.pm25, pm10: r.pm10,
        so2: r.so2, no2: r.no2, o3: r.o3, co: r.co,
      }))
      if (!silent || toAdd.length > 0) setSyncMsg(`同步完成：新增 ${toAdd.length} 条，跳过重复 ${records.length - toAdd.length} 条`)
    } catch {
      if (!silent) setSyncMsg('同步失败：无法连接后端服务')
    }
    if (!silent) setTimeout(() => setSyncMsg(null), 5000)
  }, [airQualityData, pushAirQualityRecord])

  // 10 分钟自动同步
  useEffect(() => {
    handleSync(true)  // 页面打开立即同步一次
    const t = setInterval(() => handleSync(true), 10 * 60 * 1000)
    return () => clearInterval(t)
  }, [handleSync])

  const highlightKey = filterGas !== '全部' ? GAS_KEY_MAP[filterGas] : null

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', gap: 0 }}>
      {/* Left: push controls */}
      <div style={{ width: 300, flexShrink: 0, borderRight: '1px solid rgba(0,80,150,0.2)', overflowY: 'auto', scrollbarWidth: 'none', padding: '20px' }}>
        <h2 style={{ color: '#c8e6ff', fontSize: 16, fontWeight: 600, marginBottom: 16 }}>市局监测站数据管理</h2>

        {/* Stats */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 20 }}>
          <div style={{ padding: '10px 12px', background: 'rgba(0,20,50,0.5)', border: '1px solid rgba(0,170,255,0.15)', borderRadius: 4, borderLeft: `3px solid ${CYAN}` }}>
            <div style={{ color: '#5a8aaa', fontSize: 11, marginBottom: 4 }}>总记录数</div>
            <div style={{ color: CYAN, fontSize: 22, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>{stats.total}</div>
          </div>
          <div style={{ padding: '10px 12px', background: 'rgba(0,20,50,0.5)', border: '1px solid rgba(0,230,118,0.15)', borderRadius: 4, borderLeft: `3px solid ${GREEN}` }}>
            <div style={{ color: '#5a8aaa', fontSize: 11, marginBottom: 4 }}>今日推送</div>
            <div style={{ color: GREEN, fontSize: 22, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>{stats.todayCount}</div>
          </div>
        </div>

        {stats.lastPush && (
          <div style={{ padding: '8px 10px', background: 'rgba(0,0,0,0.25)', borderRadius: 3, fontSize: 11, color: '#3a5a70', fontFamily: "'JetBrains Mono', monospace", marginBottom: 16, wordBreak: 'break-all' }}>
            最后推送：{new Date(stats.lastPush).toLocaleString('zh-CN', { hour12: false })}
          </div>
        )}

        {/* Sync from gas collection module */}
        <div style={{ marginBottom: 16, padding: '14px', background: 'rgba(0,230,118,0.06)', border: '1px solid rgba(0,230,118,0.2)', borderRadius: 4 }}>
          <div style={{ color: GREEN, fontSize: 13, fontWeight: 600, marginBottom: 6 }}>从采集模块同步</div>
          <div style={{ color: '#3a5a70', fontSize: 11, marginBottom: 10, lineHeight: 1.7 }}>
            将「气体采集预警」模块已采集的周家坝/百安坝数据同步到此页（自动去重）
          </div>
          <button onClick={handleSync} style={{ width: '100%', ...btn(GREEN) }}>⟳ 立即同步</button>
          {syncMsg && (
            <div style={{ marginTop: 8, padding: '5px 8px', background: `${GREEN}12`, border: `1px solid ${GREEN}30`, borderRadius: 3, fontSize: 11, color: GREEN }}>
              {syncMsg}
            </div>
          )}
        </div>


        {/* Manual push form */}
        <div style={{ marginBottom: 12 }}>
          <button
            onClick={() => setShowForm(v => !v)}
            style={{ width: '100%', ...btn(AMBER), marginBottom: showForm ? 12 : 0 }}
          >
            {showForm ? '▾ 折叠手动录入' : '▸ 手动录入数据'}
          </button>
        </div>

        {showForm && (
          <div style={{ background: 'rgba(0,30,80,0.2)', border: '1px solid rgba(0,150,220,0.15)', borderRadius: 4, padding: '14px' }}>
            <Field label="监测站">
              <select value={form.station} onChange={e => setForm(f => ({ ...f, station: e.target.value }))} style={selectStyle}>
                <option value="周家坝">周家坝</option>
                <option value="百安坝">百安坝</option>
              </select>
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Field label="日期">
                <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} style={inputStyle} />
              </Field>
              <Field label="小时（0-23）">
                <input type="number" min={0} max={23} value={form.hour} onChange={e => setForm(f => ({ ...f, hour: Number(e.target.value) }))} style={inputStyle} />
              </Field>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Field label="AQI"><input type="number" value={form.aqi} onChange={e => setForm(f => ({ ...f, aqi: Number(e.target.value) }))} style={inputStyle} /></Field>
              <Field label="PM2.5 (μg/m³)"><input type="number" value={form.pm25} onChange={e => setForm(f => ({ ...f, pm25: Number(e.target.value) }))} style={inputStyle} /></Field>
              <Field label="PM10 (μg/m³)"><input type="number" value={form.pm10} onChange={e => setForm(f => ({ ...f, pm10: Number(e.target.value) }))} style={inputStyle} /></Field>
              <Field label="SO₂ (μg/m³)"><input type="number" value={form.so2} onChange={e => setForm(f => ({ ...f, so2: Number(e.target.value) }))} style={inputStyle} /></Field>
              <Field label="NO₂ (μg/m³)"><input type="number" value={form.no2} onChange={e => setForm(f => ({ ...f, no2: Number(e.target.value) }))} style={inputStyle} /></Field>
              <Field label="O₃ (μg/m³)"><input type="number" value={form.o3} onChange={e => setForm(f => ({ ...f, o3: Number(e.target.value) }))} style={inputStyle} /></Field>
              <Field label="CO (mg/m³)"><input type="number" step="0.1" value={form.co} onChange={e => setForm(f => ({ ...f, co: Number(e.target.value) }))} style={inputStyle} /></Field>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button onClick={handlePush} style={{ flex: 1, ...btn(GREEN) }}>录入</button>
              <button onClick={() => setShowForm(false)} style={btn('#5a8aaa')}>取消</button>
            </div>
          </div>
        )}

        {/* Danger zone */}
        <div style={{ marginTop: 20, padding: '10px 12px', background: 'rgba(255,68,68,0.05)', border: '1px solid rgba(255,68,68,0.15)', borderRadius: 4 }}>
          <div style={{ color: '#5a8aaa', fontSize: 11, marginBottom: 8 }}>清除数据</div>
          <button
            onClick={() => { if (window.confirm('确定清空所有大气质量数据？')) clearAirQualityData() }}
            style={{ ...btn(RED, 'sm'), width: '100%' }}
          >
            清空全部数据
          </button>
        </div>
      </div>

      {/* Right: data table */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Filter bar */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(0,80,150,0.2)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ color: '#5a8aaa', fontSize: 12 }}>筛选：</span>

            {/* Station filter */}
            <div style={{ display: 'flex', gap: 4 }}>
              {STATIONS.map(s => (
                <button key={s} onClick={() => setFilterStation(s)} style={{
                  padding: '3px 12px', fontSize: 12, borderRadius: 3,
                  border: `1px solid ${filterStation === s ? CYAN : 'rgba(0,150,220,0.2)'}`,
                  background: filterStation === s ? `${CYAN}18` : 'transparent',
                  color: filterStation === s ? CYAN : '#5a8aaa',
                  cursor: 'pointer',
                }}>{s}</button>
              ))}
            </div>

            <div style={{ width: 1, height: 18, background: 'rgba(0,100,180,0.3)' }} />

            {/* Date filter */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: '#5a8aaa', fontSize: 12 }}>日期</span>
              <input
                type="date"
                value={filterDate}
                onChange={e => setFilterDate(e.target.value)}
                style={{ ...inputStyle, width: 140, padding: '3px 8px' }}
              />
              {filterDate && (
                <button onClick={() => setFilterDate('')} style={{ ...btn('#5a8aaa', 'sm') }}>清除</button>
              )}
            </div>

            <div style={{ width: 1, height: 18, background: 'rgba(0,100,180,0.3)' }} />

            {/* Gas type filter */}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {GAS_TYPES.map(g => (
                <button key={g} onClick={() => setFilterGas(g)} style={{
                  padding: '3px 10px', fontSize: 11, borderRadius: 3,
                  border: `1px solid ${filterGas === g ? (GAS_COLORS[g] ?? CYAN) : 'rgba(0,150,220,0.15)'}`,
                  background: filterGas === g ? `${GAS_COLORS[g] ?? CYAN}18` : 'transparent',
                  color: filterGas === g ? (GAS_COLORS[g] ?? CYAN) : '#3a5a70',
                  cursor: 'pointer',
                }}>{g}</button>
              ))}
            </div>

            <div style={{ marginLeft: 'auto', color: '#3a5a70', fontSize: 12 }}>
              共 <span style={{ color: CYAN, fontFamily: "'JetBrains Mono', monospace" }}>{filtered.length}</span> 条记录
            </div>
          </div>
        </div>

        {/* Table */}
        <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
              <tr style={{ background: 'rgba(4,14,35,0.98)', borderBottom: '1px solid rgba(0,80,150,0.2)' }}>
                {['监测站', '日期', '小时', 'AQI', 'PM2.5', 'PM10', 'SO₂', 'NO₂', 'O₃', 'CO', '等级', '推送时间', '操作'].map(h => (
                  <th key={h} style={{
                    padding: '8px 10px', textAlign: h === '监测站' || h === '日期' || h === '推送时间' || h === '操作' ? 'left' : 'right',
                    color: '#5a8aaa', fontWeight: 600, fontSize: 11, whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={13} style={{ padding: '40px 0', textAlign: 'center', color: '#3a5a70' }}>暂无匹配数据</td></tr>
              )}
              {filtered.map((r, i) => {
                const aColor = aqiColor(r.aqi)
                const isToday = r.date === todayStr()
                return (
                  <tr
                    key={r.id}
                    style={{
                      borderBottom: '1px solid rgba(0,50,100,0.15)',
                      background: i % 2 === 0 ? 'transparent' : 'rgba(0,20,50,0.2)',
                    }}
                  >
                    <td style={{ padding: '7px 10px' }}>
                      <span style={{ padding: '1px 8px', borderRadius: 2, fontSize: 11,
                        background: r.station === '周家坝' ? `${CYAN}15` : 'rgba(0,188,212,0.15)',
                        color: r.station === '周家坝' ? CYAN : '#00bcd4',
                        border: `1px solid ${r.station === '周家坝' ? CYAN : '#00bcd4'}30`,
                      }}>{r.station}</span>
                    </td>
                    <td style={{ padding: '7px 10px', color: isToday ? '#7ab8e0' : '#5a8aaa', fontFamily: "'JetBrains Mono', monospace" }}>
                      {r.date}{isToday && <span style={{ color: GREEN, fontSize: 10, marginLeft: 4 }}>今日</span>}
                    </td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', color: '#5a8aaa', fontFamily: "'JetBrains Mono', monospace" }}>
                      {String(r.hour).padStart(2, '0')}:00
                    </td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace', monospace", fontWeight: highlightKey === 'aqi' ? 700 : 400, color: highlightKey === 'aqi' ? aColor : aColor }}>{r.aqi}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', color: highlightKey === 'pm25' ? '#00ccff' : '#c8e6ff', fontFamily: "'JetBrains Mono', monospace", fontWeight: highlightKey === 'pm25' ? 700 : 400 }}>{r.pm25}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', color: highlightKey === 'pm10' ? '#00bcd4' : '#c8e6ff', fontFamily: "'JetBrains Mono', monospace", fontWeight: highlightKey === 'pm10' ? 700 : 400 }}>{r.pm10}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', color: highlightKey === 'so2' ? AMBER : '#c8e6ff', fontFamily: "'JetBrains Mono', monospace", fontWeight: highlightKey === 'so2' ? 700 : 400 }}>{r.so2}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', color: highlightKey === 'no2' ? ORANGE : '#c8e6ff', fontFamily: "'JetBrains Mono', monospace", fontWeight: highlightKey === 'no2' ? 700 : 400 }}>{r.no2}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', color: highlightKey === 'o3' ? '#ab47bc' : '#c8e6ff', fontFamily: "'JetBrains Mono', monospace", fontWeight: highlightKey === 'o3' ? 700 : 400 }}>{r.o3}</td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', color: highlightKey === 'co' ? GREEN : '#c8e6ff', fontFamily: "'JetBrains Mono', monospace", fontWeight: highlightKey === 'co' ? 700 : 400 }}>{r.co}</td>
                    <td style={{ padding: '7px 10px' }}>
                      <span style={{ padding: '1px 7px', borderRadius: 2, fontSize: 10,
                        background: `${aColor}18`, border: `1px solid ${aColor}35`, color: aColor,
                      }}>{aqiLabel(r.aqi)}</span>
                    </td>
                    <td style={{ padding: '7px 10px', color: '#3a5a70', fontSize: 11, fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'nowrap' }}>
                      {new Date(r.pushedAt).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td style={{ padding: '7px 10px' }}>
                      <button onClick={() => deleteAirQualityRecord(r.id)} style={btn(RED, 'sm')}>删除</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Footer info */}
        <div style={{ padding: '10px 20px', borderTop: '1px solid rgba(0,80,150,0.2)', background: 'rgba(0,10,30,0.4)', flexShrink: 0 }}>
          <div style={{ color: '#3a5a70', fontSize: 11, display: 'flex', alignItems: 'center', gap: 16 }}>
            <span>数据说明：每小时整点由第三方平台推送 • 前台仅展示近24小时数据</span>
            <span style={{ marginLeft: 'auto' }}>单位：AQI无单位 | PM2.5/PM10/SO₂/NO₂/O₃ μg/m³ | CO mg/m³</span>
          </div>
        </div>
      </div>
    </div>
  )
}
