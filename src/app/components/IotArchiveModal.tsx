import { useState, useEffect, useCallback } from 'react'
import type { AlertItem } from './AlertPanel'
import { authFetch } from '../lib/apiFetch'

const CYAN = '#00aaff'
const GREEN = '#00e676'

interface IotRecord {
  id: string
  createdAt: string
  time: string
  fullTime: string
  aiType: string
  aiConfidence: number
  level: number
  imageUrl: string | null
  channelName: string
  deviceName: string
}

interface IotChannel {
  channelName: string
  spid: string
  deviceId: string
  streamId: string
  lat: number | null
  lon: number | null
  total: number
  latestAt: string
  records: IotRecord[]
}

interface StatusChannel {
  spid: string
  name: string
  streamId: string
  lat: number | null
  lon: number | null
  alerting: boolean
  lastEventAt: string
  lastEventType: string
}

interface Props {
  onClose: () => void
  onLocate: (alert: AlertItem) => void
}

function confColor(c: number): string {
  if (c >= 0.7) return '#ff4444'
  if (c >= 0.5) return '#ff7043'
  if (c >= 0.3) return '#ffd740'
  return '#64b5f6'
}
function levelColor(l: number): string {
  return ['#64b5f6', '#64b5f6', '#ffd740', '#ff7043', '#ff4444'][l] || '#64b5f6'
}

export function IotArchiveModal({ onClose, onLocate }: Props) {
  const [channels, setChannels] = useState<IotChannel[]>([])
  const [statusMap, setStatusMap] = useState<Record<string, StatusChannel>>({})
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    Promise.all([
      authFetch('/api/iot-analysis/archive').then(r => r.ok ? r.json() : { channels: [] }),
      authFetch('/api/iot-analysis/status').then(r => r.ok ? r.json() : { channels: [] }),
    ]).then(([arc, st]) => {
      const chs: IotChannel[] = Array.isArray(arc.channels) ? arc.channels : []
      const m: Record<string, StatusChannel> = {}
      for (const c of (st.channels || [])) m[c.spid] = c
      setChannels(chs)
      setStatusMap(m)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 10000)
    return () => clearInterval(t)
  }, [load])

  const locate = (ch: IotChannel) => {
    if (typeof ch.lat !== 'number' || typeof ch.lon !== 'number') return
    onLocate({
      id: `iot-archive-${ch.streamId || ch.spid}`,
      lat: ch.lat,
      lon: ch.lon,
      type: `AI分析 · ${ch.channelName}`,
      location: ch.channelName,
      time: '',
      fullTime: ch.latestAt,
      level: 2,
      value: '',
      standard: '',
    })
  }

  const totalRecords = channels.reduce((s, c) => s + c.total, 0)
  const alertingCount = channels.filter(c => statusMap[c.spid]?.alerting).length

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(2,8,20,0.85)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        width: 1000, maxWidth: '95vw', maxHeight: '90vh',
        background: 'linear-gradient(180deg, #040e25 0%, #030c1e 100%)',
        border: '1px solid rgba(0,170,255,0.25)', borderRadius: 6,
        boxShadow: '0 0 60px rgba(0,120,255,0.15), 0 0 20px rgba(0,120,255,0.1)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          height: 52, padding: '0 20px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderBottom: '1px solid rgba(0,170,255,0.2)',
          background: 'linear-gradient(90deg, rgba(0,170,255,0.08), transparent)', flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 3, height: 16, background: CYAN, borderRadius: 1 }} />
            <span style={{ color: '#c8e6ff', fontSize: 15, fontWeight: 600, letterSpacing: '0.05em' }}>AI视频分析存档</span>
            <span style={{ color: '#3a5a70', fontSize: 12 }}>（按通道分类 · 实时同步 IoTCloud）</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ color: '#3a5a70', fontSize: 12 }}>
              通道 <span style={{ color: CYAN, fontFamily: "'JetBrains Mono', monospace" }}>{channels.length}</span>
              　记录 <span style={{ color: '#c8e6ff', fontFamily: "'JetBrains Mono', monospace" }}>{totalRecords}</span>
              　<span style={{ color: alertingCount ? '#ff4444' : '#3a5a70' }}>告警中 {alertingCount}</span>
            </span>
            <button onClick={onClose} style={{
              width: 28, height: 28, borderRadius: 4,
              border: '1px solid rgba(0,170,255,0.25)', background: 'rgba(0,170,255,0.1)',
              color: '#80cfff', cursor: 'pointer', fontSize: 14,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>✕</button>
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none', padding: '12px 16px 16px' }}>
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 140, color: '#3a5a70', fontSize: 13 }}>加载中…</div>
          ) : channels.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 140, color: '#3a5a70', fontSize: 13 }}>
              暂无 AI 视频分析记录
            </div>
          ) : (
            channels.map(ch => {
              const st = statusMap[ch.spid]
              const alerting = !!st?.alerting
              return (
                <div key={ch.spid} style={{
                  marginBottom: 14, borderRadius: 4,
                  border: `1px solid ${alerting ? 'rgba(255,68,68,0.4)' : 'rgba(0,120,200,0.22)'}`,
                  background: alerting ? 'rgba(255,68,68,0.05)' : 'rgba(2,14,38,0.5)',
                  overflow: 'hidden',
                }}>
                  {/* Channel header */}
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
                    borderBottom: '1px solid rgba(0,120,200,0.18)',
                    background: alerting ? 'rgba(255,68,68,0.08)' : 'rgba(0,40,90,0.25)',
                  }}>
                    <span style={{
                      width: 9, height: 9, borderRadius: '50%', flexShrink: 0,
                      background: alerting ? '#ff3b3b' : '#00bcd4',
                      boxShadow: alerting ? '0 0 10px #ff3b3b' : 'none',
                      animation: alerting ? 'amap-alert-pulse-red 1.1s ease-in-out infinite' : 'none',
                    }} />
                    <span style={{ color: '#c8e6ff', fontSize: 15, fontWeight: 600 }}>{ch.channelName}</span>
                    {alerting && (
                      <span style={{ padding: '2px 8px', borderRadius: 2, background: 'rgba(255,68,68,0.2)', color: '#ff8080', fontSize: 11, fontWeight: 600 }}>
                        AI分析告警 · {st?.lastEventType || '—'}
                      </span>
                    )}
                    <span style={{ color: '#3a5a70', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
                      共 {ch.total} 条
                    </span>
                    <span style={{ color: '#3a5a70', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
                      最近 {ch.latestAt || '—'}
                    </span>
                    <div style={{ flex: 1 }} />
                    <span style={{ color: '#3a5a70', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
                      {typeof ch.lat === 'number' && typeof ch.lon === 'number' ? `${ch.lat.toFixed(4)}, ${ch.lon.toFixed(4)}` : '无坐标'}
                    </span>
                    <button
                      disabled={typeof ch.lat !== 'number' || typeof ch.lon !== 'number'}
                      onClick={() => locate(ch)}
                      style={{
                        padding: '4px 14px', fontSize: 12, borderRadius: 3,
                        border: '1px solid rgba(0,170,255,0.35)', background: 'rgba(0,170,255,0.1)',
                        color: CYAN, cursor: 'pointer', whiteSpace: 'nowrap',
                      }}
                    >定位</button>
                  </div>

                  {/* Records grid */}
                  <div style={{
                    display: 'grid', gap: 10, padding: 12,
                    gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
                  }}>
                    {ch.records.map(rec => (
                      <div key={rec.id} style={{
                        background: 'rgba(3,16,40,0.7)',
                        border: '1px solid rgba(0,120,200,0.18)', borderRadius: 3, overflow: 'hidden',
                      }}>
                        <div style={{ position: 'relative', width: '100%', height: 116, background: '#020a18', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {rec.imageUrl ? (
                            <img
                              src={rec.imageUrl}
                              alt={rec.aiType}
                              loading="lazy"
                              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                            />
                          ) : (
                            <span style={{ color: '#3a5a70', fontSize: 11 }}>无抓拍图</span>
                          )}
                          <span style={{
                            position: 'absolute', top: 6, right: 6,
                            padding: '2px 7px', borderRadius: 2, fontSize: 11, fontWeight: 700,
                            background: 'rgba(0,0,0,0.55)', color: confColor(rec.aiConfidence),
                            fontFamily: "'JetBrains Mono', monospace",
                          }}>
                            {Math.round(rec.aiConfidence * 100)}%
                          </span>
                        </div>
                        <div style={{ padding: '7px 9px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: levelColor(rec.level), flexShrink: 0 }} />
                            <span style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 600 }}>{rec.aiType || 'AI分析'}</span>
                          </div>
                          <div style={{ color: '#5a8aaa', fontSize: 11, marginTop: 3, fontFamily: "'JetBrains Mono', monospace" }}>
                            {rec.fullTime ? rec.fullTime.slice(5) : (rec.time || '—')}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Footer */}
        <div style={{
          height: 44, padding: '0 20px', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderTop: '1px solid rgba(0,80,150,0.2)', background: 'rgba(0,20,50,0.3)',
        }}>
          <span style={{ color: '#3a5a70', fontSize: 11 }}>
            通道产生 AI 分析推送时，对应视频流摄像头图标将在地图红闪（30 分钟内有效）
          </span>
          <span style={{ color: '#3a5a70', fontSize: 11 }}>点击「定位」可在地图聚焦该通道摄像头</span>
        </div>
      </div>
    </div>
  )
}
