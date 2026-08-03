import type { MapTab, MapScene } from './MapView'
import { MapView } from './MapView'
import type { AlertItem } from './AlertPanel'
import { useDashboard } from '../context/DashboardContext'
import { useState, useEffect } from 'react'
import { authFetch, apiFetch } from '../lib/apiFetch'
import { IotArchiveModal } from './IotArchiveModal'
import { CK } from '../lib/cockpitTheme'

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
  // P1 场景聚焦（底部场景标签）：全域 / 扬尘管控 / 秸秆焚烧
  const [scene, setScene] = useState<MapScene>('none')

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

  // ── P1 统计条：重点企业行业分布（公开接口，30s 轮询） ──
  const [industryStats, setIndustryStats] = useState<{ total: number; industries: { name: string; count: number }[] }>({ total: 0, industries: [] })
  useEffect(() => {
    const load = () => apiFetch<{ industry_type?: string | null }[]>('/api/enterprises')
      .then(list => {
        if (!Array.isArray(list)) return
        const agg: Record<string, number> = {}
        for (const e of list) {
          const k = (e.industry_type || '').trim() || '未分类'
          agg[k] = (agg[k] || 0) + 1
        }
        const industries = Object.entries(agg)
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count)
        setIndustryStats({ total: list.length, industries })
      })
      .catch(() => {})
    load()
    const t = setInterval(load, 30000)
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
        <MapView activeTab={activeTab} selectedAlert={selectedAlert} scene={scene} />

        {/* P1 底部场景标签条（对齐参考图底部场景切换） */}
        {(() => {
          const dustCamCount = videoStreams.filter(s => s.group === '港口堆场' || s.group === '道路监控').length
          const dustAlertCount = mapPoints.filter(p => p.type === 'alert' && /扬尘|堆头|裸土/.test(String((p as any).alertType || ''))).length
          const strawAlertCount = mapPoints.filter(p => p.type === 'alert' && String((p as any).alertType || '').includes('秸秆')).length
          const scenes: { id: MapScene; label: string; count: number | null }[] = [
            { id: 'none', label: '全域', count: null },
            { id: 'dust', label: '扬尘管控', count: dustCamCount + dustAlertCount },
            { id: 'straw', label: '秸秆焚烧', count: strawAlertCount },
          ]
          return (
            <div style={{
              position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)',
              zIndex: 25, display: 'flex', alignItems: 'center', gap: 4,
              background: 'linear-gradient(160deg, rgba(10,26,56,0.66), rgba(5,13,30,0.52))',
              backdropFilter: 'blur(14px) saturate(1.35)',
              WebkitBackdropFilter: 'blur(14px) saturate(1.35)',
              border: '1px solid rgba(0,180,255,0.30)',
              borderRadius: 6,
              padding: '4px 6px',
              boxShadow: '0 6px 24px rgba(0,0,0,0.42), inset 0 0 20px -10px rgba(0,180,255,0.35)',
            }}>
              <span style={{ color: CK.textDim, fontSize: 11, padding: '0 6px', letterSpacing: '0.1em' }}>场景</span>
              {scenes.map(s => (
                <button
                  key={s.id}
                  onClick={() => setScene(s.id)}
                  style={{
                    padding: '4px 14px',
                    fontSize: 12,
                    fontWeight: scene === s.id ? 700 : 400,
                    color: scene === s.id ? '#04122a' : CK.textSub,
                    background: scene === s.id
                      ? 'linear-gradient(180deg, #37c8ff, #00a8e8)'
                      : 'transparent',
                    border: `1px solid ${scene === s.id ? 'rgba(0,200,255,0.6)' : 'rgba(0,150,220,0.18)'}`,
                    borderRadius: 4,
                    cursor: 'pointer',
                    transition: 'all 0.18s',
                    letterSpacing: '0.05em',
                    boxShadow: scene === s.id ? '0 0 12px -2px rgba(0,190,255,0.55)' : 'none',
                  }}
                >
                  {s.label}
                  {s.count !== null && (
                    <span style={{
                      marginLeft: 5, fontSize: 10,
                      fontFamily: "'JetBrains Mono', monospace",
                      opacity: 0.85,
                    }}>
                      {s.count}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )
        })()}

        {/* P1 顶部监测网络统计条（玻璃拟态悬浮，对齐参考图） */}
        <div style={{
          position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)',
          zIndex: 25, display: 'flex', alignItems: 'stretch', gap: 0,
          background: 'linear-gradient(160deg, rgba(10,26,56,0.66), rgba(5,13,30,0.52))',
          backdropFilter: 'blur(14px) saturate(1.35)',
          WebkitBackdropFilter: 'blur(14px) saturate(1.35)',
          border: '1px solid rgba(0,180,255,0.30)',
          borderRadius: 6,
          boxShadow: '0 6px 24px rgba(0,0,0,0.42), inset 0 0 20px -10px rgba(0,180,255,0.35)',
          overflow: 'visible',
        }}>
          <StatsCell label="监测站" value={stationCount} unit="座" color={CK.cyan} icon="gauge" />
          <StatsCell label="水质点位" value={waterMonCount + waterPointCount} unit="个" color={CK.teal} icon="wave" />
          <StatsCell label="摄像头" value={visibleStreams.length} unit="路" color={CK.green} icon="cam" />
          <StatsCell label="无人机" value={uavCount} unit="架" color={CK.purple} icon="plane" />
          <StatsCell
            label="重点企业" value={industryStats.total} unit="家" color={CK.orange} icon="factory"
            detail={industryStats.industries}
          />
        </div>

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

/** P1 统计条单元格：图标 + 大数字 + 标签；detail 存在时 hover 展开明细（如企业行业分布） */
function StatsCell({ label, value, unit, color, icon, detail }: {
  label: string
  value: number
  unit: string
  color: string
  icon: 'gauge' | 'wave' | 'cam' | 'plane' | 'factory'
  detail?: { name: string; count: number }[]
}) {
  const [hover, setHover] = useState(false)
  return (
    <div
      style={{
        position: 'relative',
        display: 'flex', alignItems: 'center', gap: 7,
        padding: '7px 14px',
        borderRight: '1px solid rgba(0,150,220,0.16)',
        cursor: detail ? 'default' : undefined,
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <StatsCellIcon type={icon} color={color} />
      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
          <span style={{
            color, fontSize: 19, fontWeight: 700,
            fontFamily: "'JetBrains Mono', monospace",
            textShadow: `0 0 10px ${color}88`,
          }}>
            {value}
          </span>
          <span style={{ color: CK.textFaint, fontSize: 10 }}>{unit}</span>
        </div>
        <span style={{ color: CK.textSub, fontSize: 10, letterSpacing: '0.08em' }}>{label}</span>
      </div>

      {/* 行业明细浮层 */}
      {detail && hover && detail.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
          marginTop: 6, minWidth: 128, zIndex: 40,
          background: 'linear-gradient(165deg, rgba(10,26,56,0.92), rgba(5,13,30,0.86))',
          backdropFilter: 'blur(14px)',
          WebkitBackdropFilter: 'blur(14px)',
          border: '1px solid rgba(0,180,255,0.32)',
          borderRadius: 5, padding: '7px 10px',
          boxShadow: '0 8px 26px rgba(0,0,0,0.55)',
        }}>
          <div style={{ color: '#8fc6ea', fontSize: 10, marginBottom: 4, letterSpacing: '0.1em' }}>行业分布</div>
          {detail.map(d => (
            <div key={d.name} className="flex items-center justify-between" style={{ gap: 14, padding: '1px 0' }}>
              <span style={{ color: CK.textSub, fontSize: 11 }}>{d.name}</span>
              <span style={{ color, fontSize: 11, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>{d.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 统计条小图标（极简线性 SVG） */
function StatsCellIcon({ type, color }: { type: 'gauge' | 'wave' | 'cam' | 'plane' | 'factory'; color: string }) {
  const s = { stroke: color, strokeWidth: 1.6, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  const size = 16
  const glow = { filter: `drop-shadow(0 0 4px ${color}88)` }
  switch (type) {
    case 'gauge':
      return <svg width={size} height={size} viewBox="0 0 24 24" style={glow}><path {...s} d="M12 15a3 3 0 100-6 3 3 0 000 6z" /><path {...s} d="M12 9V5" /><path {...s} d="M5 19a9 9 0 1114 0" /></svg>
    case 'wave':
      return <svg width={size} height={size} viewBox="0 0 24 24" style={glow}><path {...s} d="M2 8c2.5-2 5-2 7.5 0s5 2 7.5 0 3.5-1.5 5 0" /><path {...s} d="M2 13c2.5-2 5-2 7.5 0s5 2 7.5 0 3.5-1.5 5 0" /><path {...s} d="M2 18c2.5-2 5-2 7.5 0s5 2 7.5 0 3.5-1.5 5 0" /></svg>
    case 'cam':
      return <svg width={size} height={size} viewBox="0 0 24 24" style={glow}><rect {...s} x="2" y="7" width="13" height="10" rx="2" /><path {...s} d="M15 10l7-3v10l-7-3" /></svg>
    case 'plane':
      return <svg width={size} height={size} viewBox="0 0 24 24" style={glow}><path {...s} d="M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7z" /></svg>
    case 'factory':
      return <svg width={size} height={size} viewBox="0 0 24 24" style={glow}><path {...s} d="M3 21V10l5 3v-3l5 3V8l4-3v16H3z" /><path {...s} d="M7 17h2M12 17h2" /></svg>
  }
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
