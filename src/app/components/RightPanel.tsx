import { useState } from 'react'
import { AlertPanel } from './AlertPanel'
import type { AlertItem } from './AlertPanel'
import { VideoCarousel } from './VideoCarousel'
import { StatsPanel } from './StatsPanel'
import { GovPanel } from './GovPanel'
import type { MapTab } from './MapView'

interface Props {
  activeTab?: MapTab
  onSelectAlert?: (alert: AlertItem) => void
  selectedAlertId?: string | null
}

export function RightPanel({ activeTab = 'default', onSelectAlert, selectedAlertId }: Props) {
  // P2 政务驾驶舱：右下区 tab 化（统计分析 / 政务驾驶舱）
  const [rightTab, setRightTab] = useState<'stats' | 'gov'>('stats')

  return (
    <div
      className="flex flex-col h-full"
      style={{
        background: 'rgba(4, 12, 30, 0.98)',
        borderLeft: '1px solid rgba(0, 150, 220, 0.15)',
      }}
    >
      {/* Alert panel */}
      <div style={{ flex: '0 0 18%', minHeight: 0, borderBottom: '1px solid rgba(0,150,220,0.12)' }}>
        <AlertPanel onSelectAlert={onSelectAlert} selectedAlertId={selectedAlertId} />
      </div>

      {/* Video carousel */}
      <div style={{ flex: '0 0 17%', minHeight: 0, borderBottom: '1px solid rgba(0,150,220,0.12)' }}>
        <VideoCarousel activeTab={activeTab} />
      </div>

      {/* Stats / Gov tab 区 */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div
          className="flex items-center shrink-0"
          style={{
            height: 30,
            borderBottom: '1px solid rgba(0,150,220,0.14)',
            paddingLeft: 8, gap: 4,
            background: 'rgba(3,10,25,0.6)',
          }}
        >
          {([['stats', '统计分析'], ['gov', '政务驾驶舱']] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setRightTab(key)}
              style={{
                padding: '3px 12px',
                fontSize: 12,
                fontWeight: rightTab === key ? 700 : 400,
                color: rightTab === key ? '#00d4ff' : '#5a8aaa',
                background: rightTab === key ? 'rgba(0,180,255,0.12)' : 'transparent',
                border: `1px solid ${rightTab === key ? 'rgba(0,180,255,0.4)' : 'transparent'}`,
                borderRadius: 3,
                cursor: 'pointer',
                transition: 'all 0.18s',
                letterSpacing: '0.05em',
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {rightTab === 'stats' ? <StatsPanel /> : <GovPanel />}
        </div>
      </div>
    </div>
  )
}
