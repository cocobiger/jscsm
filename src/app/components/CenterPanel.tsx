import type { MapTab, MapScene } from './MapView'
import { MapView } from './MapView'
import { TimeAxisPanel } from './TimeAxisPanel'
import type { TimelineSelection } from './TimeAxisPanel'
import type { AlertItem } from './AlertPanel'
import { useDashboard } from '../context/DashboardContext'
import { useState, useMemo, useCallback } from 'react'
import { IotArchiveModal } from './IotArchiveModal'
import { SikongDeviceModal } from './SikongDeviceModal'
import { KpiDrilldownModal } from './KpiDrilldownModal'
import { specMonitorStations, specWaterPoints, specCameras, specEnterprises } from '../lib/kpiDrilldown'
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
  const {
    mapPoints, mapPointsAvailable, videoStreams, streamsAvailable, externalAlerts,
    droneCount, dockCount, sikongAvailable, sikongDevices, droneUnpaired, flyingCount, dockedCount, osdMissingCount,
    stations, stationsAvailable, enterprises, enterprisesAvailable,
  } = useDashboard()
  const [showArchive, setShowArchive] = useState(false)
  // P2 司空设备下钻弹窗（点击 KPI「无人机」展开机场/机型/SN 清单）
  const [showSikong, setShowSikong] = useState(false)
  /** 当前打开的 KPI 下钻弹窗 —— 5 项共用一套骨架 KpiDrilldownModal（详见 docs/驾驶舱KPI下钻扩展到其余4项…） */
  const [openKpi, setOpenKpi] = useState<'station' | 'water' | 'camera' | 'enterprise' | null>(null)
  // P1 场景聚焦（底部场景标签）：全域 / 扬尘管控 / 秸秆焚烧
  const [scene, setScene] = useState<MapScene>('none')
  // P2b 地图时间轴：非 null 时 MapView 按该小时历史数据渲染（回放模式）
  const [timeline, setTimeline] = useState<TimelineSelection | null>(null)

  // 从真实数据计算统计
  // 2026-09-16：无人机数改取「司空2 设备台账」droneCount（原取 mapPoints(type='uav') 人工点位 → 恒 0，与司空无关）。
  //   注意 items 每项是「机场」，无人机在其 drone 字段内，计数逻辑已统一放在后端 server/sikong.js。
  //   口径区分：KPI「无人机 N 架」= droneCount；气环境覆盖卡「无人机机场 N 座」= dockCount。
  // 2026-09-16（本次）：其余 4 项接入 Context 的单一出处 + 统一「不可达 → 显示 —（不是 0）」语义。
  const num = (n: number, ok: boolean): number | '—' => (ok ? n : '—')
  const uavValue = num(droneCount, sikongAvailable)
  const stationValue = num(stations.length, stationsAvailable)
  const corpValue = num(enterprises.length, enterprisesAvailable)
  const portCount = videoStreams.filter(s => s.group === '港口堆场').length
  const roadCount = videoStreams.filter(s => s.group === '道路监控').length
  const corpCount = videoStreams.filter(s => s.group === '重点企业').length
  const waterMonCount = mapPoints.filter(p => p.type === 'watermon').length
  const waterPointCount = mapPoints.filter(p => p.type === 'water').length
  const waterValue = num(waterMonCount + waterPointCount, mapPointsAvailable)
  // 驾驶舱视图分类过滤：气环境/水环境只统计对应分类视频流；全域态势统计全部
  const visibleStreams = videoStreams.filter(s => {
    if (activeTab === 'air') return s.category === '气环境'
    if (activeTab === 'water') return s.category === '水环境'
    return true
  })
  const offlineCount = visibleStreams.filter(s => s.offline).length
  const camValue = num(visibleStreams.length, streamsAvailable)

  // 重点企业行业分布（原在组件内 fetch 后丢弃原始列表；现保留 enterprises 明细供下钻）
  const industryStats = useMemo(() => {
    const agg: Record<string, number> = {}
    for (const e of enterprises) {
      const k = (e.industry_type || '').trim() || '未分类'
      agg[k] = (agg[k] || 0) + 1
    }
    const industries = Object.entries(agg)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
    return { total: enterprises.length, industries }
  }, [enterprises])

  // ── KPI 下钻描述符（列定义/分组/口径脚注都集中在 lib/kpiDrilldown.ts）──
  const scopeLabel = activeTab === 'air' ? '气环境驾驶舱' : activeTab === 'water' ? '水环境驾驶舱' : '全域态势'
  const specStation = useMemo(
    () => specMonitorStations(stations, mapPoints.filter(p => p.type === 'air')), [stations, mapPoints])
  const specWater = useMemo(
    () => specWaterPoints(mapPoints.filter(p => p.type === 'water' || p.type === 'watermon')), [mapPoints])
  const specCamera = useMemo(
    () => specCameras(visibleStreams, scopeLabel), [visibleStreams, scopeLabel])
  const specEnterprise = useMemo(
    // 联动用 videoStreams（全量，非当前 tab 过滤）：企业维度不受驾驶舱视图切换影响
    () => specEnterprises(enterprises, videoStreams), [enterprises, videoStreams])

  /** KPI 行内「地图定位」：复用 App 的 onLocate（MapView 只需 lon/lat 即 panTo + 放大到 14 级） */
  const locateRow = useCallback((id: string, name: string, lon: number, lat: number) => {
    onLocate?.({
      id: 'kpi:' + id, time: new Date().toTimeString().slice(0, 8),
      location: name, type: 'KPI 定位', value: '—', standard: '—', level: 1, lat, lon,
    })
    setOpenKpi(null)
  }, [onLocate])

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
          <DataBadge label="监测站" value={String(stationValue)} color="#00aaff" />
          <DataBadge label="摄像头" value={String(visibleStreams.length)} color="#00e676" />
          <DataBadge label="今日告警" value={String(externalAlerts.length)} color="#ff7043" />
        </div>
      </div>

      {/* Map area */}
      <div className="flex-1 relative min-h-0">
        <MapView activeTab={activeTab} selectedAlert={selectedAlert} scene={scene} timeline={timeline} />

        {/* P2b 地图时间轴（底部场景条上方，00-23 时逐小时污染回放） */}
        <TimeAxisPanel onTimelineChange={setTimeline} />

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
          {/* 5 个统计格全部可点击下钻；不可达时显示「—」并转琥珀色（warn） */}
          <StatsCell
            label="监测站" value={stationValue} unit="座" color={CK.cyan} icon="gauge"
            onClick={() => setOpenKpi('station')} warn={!stationsAvailable}
            title={stationsAvailable ? '点击查看监测站清单（含实时 AQI / PM2.5 等）' : '监测站接口不可达，数值未知（非 0）—— 点击查看详情'}
          />
          <StatsCell
            label="水质点位" value={waterValue} unit="个" color={CK.teal} icon="wave"
            onClick={() => setOpenKpi('water')} warn={!mapPointsAvailable}
            title={mapPointsAvailable ? '点击查看水质点位清单（流域监测站 + 水质监测点）' : '点位接口不可达，数值未知（非 0）—— 点击查看详情'}
          />
          <StatsCell
            label="摄像头" value={camValue} unit="路" color={CK.green} icon="cam"
            onClick={() => setOpenKpi('camera')} warn={!streamsAvailable}
            trailing={streamsAvailable && offlineCount > 0 ? { text: `${offlineCount} 离线`, color: CK.amber } : undefined}
            title={streamsAvailable
              ? `点击查看摄像头清单（${scopeLabel} ${visibleStreams.length} 路${offlineCount > 0 ? `，其中 ${offlineCount} 路离线` : ''}）`
              : '视频流接口不可达，数值未知（非 0）—— 点击查看详情'}
          />
          <StatsCell
            label="无人机" value={uavValue} unit="架" color={CK.purple} icon="plane"
            onClick={() => setShowSikong(true)}
            title={sikongAvailable
              ? `点击查看司空设备清单（机场 ${dockCount} 座 / 无人机 ${droneCount} 架 / 在飞 ${flyingCount} 架${droneUnpaired > 0 ? ` / 未配对机场 ${droneUnpaired} 座` : ''}）`
              : '司空链路不可达，数值未知（非 0）—— 点击查看详情'}
            warn={!sikongAvailable}
          />
          <StatsCell
            label="重点企业" value={corpValue} unit="家" color={CK.orange} icon="factory"
            detail={industryStats.industries}
            onClick={() => setOpenKpi('enterprise')} warn={!enterprisesAvailable}
            title={enterprisesAvailable ? '点击查看重点企业清单（行业 + 视频监控在线情况）' : '企业台账接口不可达，数值未知（非 0）—— 点击查看详情'}
          />
        </div>

        {/* Air environment overlay info */}
        {activeTab === 'air' && (
          <div style={{
            position: 'absolute', top: 12, left: 12, zIndex: 20,
            display: 'flex', flexDirection: 'column', gap: 4,
          }}>
            {sikongAvailable && dockCount > 0 && (
              <OverlayCard title="气体快检设备" items={[
                { label: '无人机机场', value: `${dockCount}座`, color: '#ab47bc' },
                { label: '无人机', value: `${droneCount}架`, color: '#ab47bc' },
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

      {/* P2 司空设备下钻（点击统计条「无人机」） */}
      {showSikong && (
        <SikongDeviceModal
          devices={sikongDevices}
          available={sikongAvailable}
          flyingCount={flyingCount}
          dockedCount={dockedCount}
          osdMissingCount={osdMissingCount}
          onLocate={(id, name, lon, lat) => locateRow(id, name, lon, lat)}
          onClose={() => setShowSikong(false)}
        />
      )}

      {/* 其余 4 项 KPI 下钻（共用骨架 KpiDrilldownModal，列/分组/口径来自 lib/kpiDrilldown.ts） */}
      {openKpi === 'station' && (
        <KpiDrilldownModal
          spec={specStation} degraded={!stationsAvailable}
          degradedText="监测站接口（/api/stations）不可达 —— 下面显示的是最后一次成功同步的台帐；统计条同时显示「—」而非 0。"
          onLocate={(row, name) => locateRow(String(row.station), name, Number(row.__lon), Number(row.__lat))}
          onClose={() => setOpenKpi(null)}
        />
      )}
      {openKpi === 'water' && (
        <KpiDrilldownModal
          spec={specWater} degraded={!mapPointsAvailable}
          degradedText="点位接口（/api/map-points）不可达 —— 下面显示的是最后一次成功同步的点位；统计条同时显示「—」而非 0。"
          onLocate={(row, name) => locateRow(String(row.id), name, Number(row.__lon), Number(row.__lat))}
          onClose={() => setOpenKpi(null)}
        />
      )}
      {openKpi === 'camera' && (
        <KpiDrilldownModal
          spec={specCamera} degraded={!streamsAvailable}
          degradedText="视频流接口（/api/streams）不可达 —— 下面显示的是最后一次成功同步的列表；统计条同时显示「—」而非 0。"
          onLocate={(row, name) => locateRow(String(row.name), name, Number(row.__lon), Number(row.__lat))}
          onClose={() => setOpenKpi(null)}
        />
      )}
      {openKpi === 'enterprise' && (
        <KpiDrilldownModal
          spec={specEnterprise} degraded={!enterprisesAvailable}
          degradedText="企业台账接口（/api/enterprises）不可达 —— 下面显示的是最后一次成功同步的清单；统计条同时显示「—」而非 0。"
          onClose={() => setOpenKpi(null)}
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

/** P1 统计条单元格：图标 + 大数字 + 标签；detail 存在时 hover 展开明细（如企业行业分布）
 *  onClick 存在时可点击下钻（如「无人机」→ 司空设备清单弹窗）
 *  value 支持字符串（链路不可达时传 '—'，**不得用 0 表示未知**）
 *  warn: true 时数值转为琥珀色并加小警示点（司空离线等降级态） */
function StatsCell({ label, value, unit, color, icon, detail, onClick, title, warn, trailing }: {
  label: string
  value: number | string
  unit: string
  color: string
  icon: 'gauge' | 'wave' | 'cam' | 'plane' | 'factory'
  detail?: { name: string; count: number }[]
  onClick?: () => void
  title?: string
  warn?: boolean
  /** 单位后的附加标识（如摄像头的「7 离线」），用小字弱化展示，不改变主数值口径 */
  trailing?: { text: string; color: string }
}) {
  const [hover, setHover] = useState(false)
  const shown = warn ? '#ffb74d' : color
  return (
    <div
      data-kpi={label}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      title={title}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } } : undefined}
      style={{
        position: 'relative',
        display: 'flex', alignItems: 'center', gap: 7,
        padding: '7px 14px',
        borderRight: '1px solid rgba(0,150,220,0.16)',
        cursor: onClick ? 'pointer' : detail ? 'default' : undefined,
        background: onClick && hover ? 'rgba(0,180,255,0.07)' : undefined,
        transition: 'background 0.15s',
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <StatsCellIcon type={icon} color={shown} />
      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
          <span style={{
            color: shown, fontSize: 19, fontWeight: 700,
            fontFamily: "'JetBrains Mono', monospace",
            textShadow: `0 0 10px ${shown}88`,
          }}>
            {value}
          </span>
          <span style={{ color: CK.textFaint, fontSize: 10 }}>{unit}</span>
          {trailing && (
            <span style={{ color: trailing.color, fontSize: 9.5, marginLeft: 1, opacity: 0.95, whiteSpace: 'nowrap' }}>
              ·{trailing.text}
            </span>
          )}
          {warn && (
            <span style={{
              alignSelf: 'center', marginLeft: 1, width: 4, height: 4, borderRadius: '50%',
              background: '#ffb74d', boxShadow: '0 0 5px #ffb74d',
            }} />
          )}
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
