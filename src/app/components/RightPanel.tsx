import { AlertPanel } from './AlertPanel'
import type { AlertItem } from './AlertPanel'
import { VideoCarousel } from './VideoCarousel'
import { StatsPanel } from './StatsPanel'
import type { MapTab } from './MapView'

interface Props {
  activeTab?: MapTab
  onSelectAlert?: (alert: AlertItem) => void
  selectedAlertId?: string | null
}

export function RightPanel({ activeTab = 'default', onSelectAlert, selectedAlertId }: Props) {
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

      {/* Stats panel */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <StatsPanel />
      </div>
    </div>
  )
}
