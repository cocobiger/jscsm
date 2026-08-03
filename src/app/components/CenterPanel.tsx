import type { MapTab } from './MapView'
import { MapView } from './MapView'
import type { AlertItem } from './AlertPanel'
import { useDashboard } from '../context/DashboardContext'
import { useState, useEffect } from 'react'
import { authFetch } from '../lib/apiFetch'
import { IotArchiveModal } from './IotArchiveModal'

interface Props {
  activeTab: MapTab
  onTabChange: (tab: MapTab) => void
  selectedAlert: AlertItem | null
  onLocate?: (alert: AlertItem) => void
}

const TABS: { id: MapTab; label: string }[] = [
  { id: 'default', label: '全域态势' },
  { id: 'air', label: '气环境驾驶舱' },
  { id: 'water', label: '水环境驾驶舱' },
]

export function CenterPanel({ activeTab, onTabChange, selectedAlert, onLocate }: Props) {
  const { mapPoints, videoStreams, externalAlerts } = useDashboard()
  const [showArchive, setShowArchive] = useState(false)

  // ── 实时数据：监测站数量（来自后端数据源配置） ──
  const [stationCount, setStationCount] = useState(0)
  useEffect(() => {
    const load = () => authFetch('/api/stations')
      .then(r => r.json())
      .then(d => Array.isArray(d) && setStationCount(d.length))
      .catch(() => {})
    load()
    const t = setInterval(load, 10000)
    return () => clearInterval(t)
  }, [])

  // 从真实数据计算统计
  const uavCount = mapPoints.filter(p => p.type === 'uav').length
  const portCount = videoStreams.filter(s => s.group === '港口堆场').length
  const roadCount = videoStreams.filter(s => s.group === '道路监控').length
  const corpCount = videoStreams.filter(s => s.group === '重点企业').length
  const waterMonCount = mapPoints.filter(p => p.type === 'watermon').length
  const waterPointCount = mapPoints.filter(p => p.type === 'water').length
  // 驾驶舱视图分类过滤：气环境/水环境只统计对应分类视频流；全域态势统计全部
  const visibleStreams = videoStreams.filter(s => {
    if (activeTab === 'air') return s.category === '气环境'
    if (activeTab === 'water') return s.category === '水环境'
    return true
  })

  return (
    <div className="flex flex-col flex-1 min-w-0 h-full">
      {/* Tab bar */}
      <div
        className="flex items-center gap-1 px-3 shrink-0"
        style={{
          height: 52,
          background: 'rgba(3, 10, 25, 0.95)',
          borderBottom: '1px solid rgba(0, 150, 220, 0.2)',
          borderTop: '1px solid rgba(0, 150, 220, 0.1)',
        }}
      >
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            style={{
              padding: '5px 20px',
              fontSize: 14,
              fontWeight: activeTab === tab.id ? 600 : 400,
              color: activeTab === tab.id ? '#00ccff' : '#5a8aaa',
              background: activeTab === tab.id ? 'rgba(0, 200, 255, 0.1)' : 'transparent',
              border: activeTab === tab.id ? '1px solid rgba(0,200,255,0.3)' : '1px solid transparent',
              borderRadius: 3,
              cursor: 'pointer',
              transition: 'all 0.2s',
              position: 'relative',
              fontFamily: "'Noto Sans SC', sans-serif",
            }}
          >
            {tab.label}
            {activeTab === tab.id && (
              <div style={{
                position: 'absolute',
                bottom: -4,
                left: '50%',
                transform: 'translateX(-50%)',
                width: 40,
                height: 2,
                background: '#00ccff',
                borderRadius: 1,
                boxShadow: '0 0 6px #00ccff',
              }} />
            )}
          </button>
        ))}

        {/* 无人机溯源 - 外部快捷入口 */}
        <a
          href="http://111.10.220.226:81/qitijsc/"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            padding: '5px 20px',
            fontSize: 14,
            fontWeight: 400,
            color: '#5a8aaa',
            background: 'transparent',
            border: '1px solid transparent',
            borderRadius: 3,
            cursor: 'pointer',
            transition: 'all 0.2s',
            fontFamily: "'Noto Sans SC', sans-serif",
            textDecoration: 'none',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.color = '#00ccff'
            e.currentTarget.style.background = 'rgba(0,200,255,0.08)'
            e.currentTarget.style.border = '1px solid rgba(0,200,255,0.2)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.color = '#5a8aaa'
            e.currentTarget.style.background = 'transparent'
            e.currentTarget.style.border = '1px solid transparent'
          }}
        >
          无人机溯源
          <span style={{ marginLeft: 4, fontSize: 11 }}>↗</span>
        </a>

        {/* AI 视频分析存档入口 */}
        <button
          onClick={() => setShowArchive(true)}
          style={{
            padding: '5px 16px',
            fontSize: 14,
            fontWeight: 400,
            color: showArchive ? '#00ccff' : '#5a8aaa',
            background: showArchive ? 'rgba(0,200,255,0.1)' : 'transparent',
            border: '1px solid ' + (showArchive ? 'rgba(0,200,255,0.3)' : 'transparent'),
            borderRadius: 3,
            cursor: 'pointer',
            transition: 'all 0.2s',
            fontFamily: "'Noto Sans SC', sans-serif",
          }}
          onMouseEnter={e => { e.currentTarget.style.color = '#00ccff'; e.currentTarget.style.background = 'rgba(0,200,255,0.08)' }}
          onMouseLeave={e => { e.currentTarget.style.color = showArchive ? '#00ccff' : '#5a8aaa'; e.currentTarget.style.background = showArchive ? 'rgba(0,200,255,0.1)' : 'transparent' }}
        >
          AI分析存档
        </button>

        {/* Right side info — 实时数据 */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <DataBadge label="监测站" value={String(stationCount)} color="#00aaff" />
          <DataBadge label="摄像头" value={String(visibleStreams.length)} color="#00e676" />
          <DataBadge label="今日告警" value={String(externalAlerts.length)} color="#ff7043" />
        </div>
      </div>

      {/* Map area */}
      <div className="flex-1 relative min-h-0">
        <MapView activeTab={activeTab} selectedAlert={selectedAlert} />

        {/* Air environment overlay info */}
        {activeTab === 'air' && (
          <div style={{
            position: 'absolute', top: 12, left: 12, zIndex: 20,
            display: 'flex', flexDirection: 'column', gap: 4,
          }}>
            {uavCount > 0 && (
              <OverlayCard title="气体快检设备" items={[
                { label: '无人机机场', value: `${uavCount}座`, color: '#ab47bc' },
                { label: '快检任务', value: '暂无数据', color: '#ab47bc' },
              ]} />
            )}
            <OverlayCard title="扬尘监控" items={[
              { label: '港口堆场', value: `${portCount}个`, color: '#ffd740' },
              { label: '道路监控', value: `${roadCount}个`, color: '#ffd740' },
            ]} />
            <OverlayCard title="企业监控" items={[
              { label: '高危企业', value: `${corpCount}家`, color: '#ff7043' },
              { label: '今日违规', value: '暂无数据', color: '#ff4444' },
            ]} />
          </div>
        )}

        {/* Water environment overlay info */}
        {activeTab === 'water' && (
          <div style={{
            position: 'absolute', top: 12, left: 12, zIndex: 20,
            display: 'flex', flexDirection: 'column', gap: 4,
          }}>
            <OverlayCard title="流域水质" items={[
              { label: '监测断面', value: `${waterMonCount}个`, color: '#00bcd4' },
              { label: '水质等级', value: '暂无数据', color: '#00e676' },
            ]} />
            <OverlayCard title="排污口监控" items={[
              { label: '监控点位', value: `${waterPointCount}个`, color: '#00bcd4' },
              { label: '今日异常', value: '暂无数据', color: '#ffd740' },
            ]} />
          </div>
        )}
      </div>

      {/* AI 视频分析存档弹窗 */}
      {showArchive && (
        <IotArchiveModal
          onClose={() => setShowArchive(false)}
          onLocate={(a) => { setShowArchive(false); onLocate?.(a) }}
        />
      )}
    </div>
  )
}

function DataBadge({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <span style={{ color: '#3a5a70', fontSize: 12 }}>{label}</span>
      <span style={{ color, fontSize: 16, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>{value}</span>
    </div>
  )
}

function OverlayCard({ title, items }: { title: string; items: { label: string; value: string; color: string }[] }) {
  return (
    <div style={{
      position: 'relative',
      background: 'linear-gradient(160deg, rgba(10,26,56,0.62), rgba(5,13,30,0.48))',
      backdropFilter: 'blur(14px) saturate(1.35)',
      WebkitBackdropFilter: 'blur(14px) saturate(1.35)',
      border: '1px solid rgba(0,180,255,0.28)',
      borderRadius: 6,
      padding: '7px 11px',
      minWidth: 148,
      boxShadow: '0 6px 24px rgba(0,0,0,0.4), inset 0 0 18px -10px rgba(0,180,255,0.35)',
      overflow: 'hidden',
    }}>
      {/* 顶部高光线（玻璃拟态边缘反光） */}
      <div style={{
        position: 'absolute', top: 0, left: 8, right: 8, height: 1,
        background: 'linear-gradient(90deg, transparent, rgba(120,220,255,0.55), transparent)',
        pointerEvents: 'none',
      }} />
      <div style={{ color: '#8fc6ea', fontSize: 10, marginBottom: 3, letterSpacing: '0.08em', textShadow: '0 0 6px rgba(0,180,255,0.35)' }}>{title}</div>
      {items.map(item => (
        <div key={item.label} className="flex items-center justify-between gap-4">
          <span style={{ color: '#7ab8e0', fontSize: 11 }}>{item.label}</span>
          <span style={{ color: item.color, fontSize: 11, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, textShadow: `0 0 6px ${item.color}66` }}>{item.value}</span>
        </div>
      ))}
    </div>
  )
}
