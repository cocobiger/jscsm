import { authFetch } from '../lib/apiFetch'
import { useEffect, useRef, useState } from 'react'
import type { AlertItem } from './AlertPanel'
import { useDashboard } from '../context/DashboardContext'
import type { VideoStream } from '../context/DashboardContext'
import { renderMarkerIcon } from '../lib/mapIcons'
import { VideoPlayerModal } from './VideoPlayerModal'

declare global {
  interface Window {
    AMap: any
    _AMapSecurityConfig: { securityJsCode: string }
  }
}

export type MapTab = 'default' | 'air' | 'water'

// 高德地图 Key：优先读环境变量（.env 的 VITE_AMAP_KEY / VITE_AMAP_SECURITY），
// 未配置时回退到内置默认值，保证开箱即用。生产部署建议用 .env 配置自己的 Key。
const AMAP_KEY = (import.meta.env.VITE_AMAP_KEY as string) || '72b6dd5eb838c3b4fd1f9c466f48a5e2'
const AMAP_SECURITY = (import.meta.env.VITE_AMAP_SECURITY as string) || '08e88a8e76d867ec63378b39419c89f4'







interface Props {
  activeTab: MapTab
  selectedAlert: AlertItem | null
}

const MARKER_CSS = `
  .amap-info-outer, .amap-info-content { padding: 0 !important; background: transparent !important; border: none !important; box-shadow: none !important; }
  .amap-info-close { display: none !important; }
  .amap-copyright, .amap-logo { opacity: 0.5 !important; filter: brightness(0.4) !important; }
  @keyframes amap-alert-pulse {
    0% { transform: translate(-50%, -50%) scale(1); opacity: 0.8; }
    100% { transform: translate(-50%, -50%) scale(2.8); opacity: 0; }
  }
  @keyframes amap-water-pulse {
    0%, 100% { box-shadow: 0 0 8px rgba(0,188,212,0.8); }
    50% { box-shadow: 0 0 20px rgba(0,188,212,1), 0 0 35px rgba(0,188,212,0.4); }
  }
  @keyframes amap-marker-spin {
    to { transform: rotate(360deg); }
  }
  @keyframes amap-alert-pulse-red {
    0%, 100% { box-shadow: 0 0 8px rgba(255,59,59,0.8), 0 0 0 0 rgba(255,59,59,0.55); }
    50% { box-shadow: 0 0 20px rgba(255,59,59,1), 0 0 0 7px rgba(255,59,59,0); }
  }
`

export function MapView({ activeTab, selectedAlert }: Props) {
  const { videoStreams, mapPoints, externalAlerts, iotAlertingStreamIds, iotChannelStatus } = useDashboard()
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<any>(null)
  const markersRef = useRef<any[]>([])
  const infoWindowRef = useRef<any>(null)
  const [loading, setLoading] = useState(true)
  const [mapReady, setMapReady] = useState(false)
  const [stations, setStations] = useState<Array<{ id: string; name: string; stationName: string; lon: number; lat: number }>>([])
  const [iconCfg, setIconCfg] = useState<Record<string, { icon: string; color: string }>>({})
  // 双击视频图标直接推流播放
  const [playStream, setPlayStream] = useState<VideoStream | null>(null)
  // 记录打开视频弹窗前的地图位置（关闭弹窗后恢复）
  const savedMapPosRef = useRef<{ center: [number, number]; zoom: number } | null>(null)
  // 鼠标交互帮助面板
  const [showHelp, setShowHelp] = useState(false)
  // 首次加载后自动调整视野，确保所有点位（含南端道路监控）都在可视区域内
  const hasFittedRef = useRef(false)

  // 加载监测站点位（来自后端数据源配置，10秒轮询保持同步）
  useEffect(() => {
    const load = () => authFetch('/api/stations').then(r => r.json()).then(d => Array.isArray(d) && setStations(d)).catch(() => {})
    load()
    const t = setInterval(load, 10000)
    return () => clearInterval(t)
  }, [])

  // 加载图标配置（点位类型/视频流分组 → 图标+颜色）
  useEffect(() => {
    const load = () => authFetch('/api/icon-config').then(r => r.json()).then(d => d && typeof d === 'object' && setIconCfg(d)).catch(() => {})
    load()
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [])

  // Inject marker CSS once
  useEffect(() => {
    if (!document.getElementById('amap-custom-styles')) {
      const s = document.createElement('style')
      s.id = 'amap-custom-styles'
      s.textContent = MARKER_CSS
      document.head.appendChild(s)
    }
  }, [])

  // Load AMap script
  useEffect(() => {
    if (window.AMap) {
      setMapReady(true)
      setLoading(false)
      return
    }

    // Check if script already injected
    if (document.querySelector('script[src*="webapi.amap.com"]')) {
      const poll = setInterval(() => {
        if (window.AMap) {
          setMapReady(true)
          setLoading(false)
          clearInterval(poll)
        }
      }, 150)
      return () => clearInterval(poll)
    }

    window._AMapSecurityConfig = { securityJsCode: AMAP_SECURITY }

    const script = document.createElement('script')
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${AMAP_KEY}&plugin=AMap.Scale,AMap.ToolBar`
    script.onload = () => {
      setMapReady(true)
      setLoading(false)
    }
    script.onerror = () => setLoading(false)
    document.head.appendChild(script)
  }, [])

  // Initialize map
  useEffect(() => {
    if (!mapReady || !containerRef.current || mapRef.current) return

    const AMap = window.AMap
    const map = new AMap.Map(containerRef.current, {
      center: [108.4076, 30.8077],
      zoom: 12,
      mapStyle: 'amap://styles/darkblue',
      viewMode: '2D',
      resizeEnable: true,
      doubleClickZoom: false,  // 关闭双击地图缩放，避免双击视频图标推流时误触缩放
    })

    try {
      map.addControl(new AMap.Scale({ position: 'LB' }))
    } catch (_) {}

    infoWindowRef.current = new AMap.InfoWindow({ isCustom: true, autoMove: false, offset: new AMap.Pixel(0, -10) })
    mapRef.current = map

    // 任何地图交互（点击空白/拖拽/缩放）都关闭信息窗，避免"锁死"需双击解锁
    const closeInfo = () => infoWindowRef.current?.close()
    map.on('click', closeInfo)
    map.on('dragstart', closeInfo)
    map.on('movestart', closeInfo)
    map.on('zoomstart', closeInfo)

    return () => {
      if (mapRef.current) {
        mapRef.current.destroy()
        mapRef.current = null
      }
    }
  }, [mapReady])

  // 告警联动：判断某地图点位是否命中当前实时告警（坐标优先 + 名称兜底）
  // 命中则返回 true，对应图标将染红并持续脉冲闪烁。
  const matchAlert = (lat: number, lon: number, name?: string): boolean => {
    if (!externalAlerts || externalAlerts.length === 0) return false
    return externalAlerts.some(a => {
      // 名称双向包含（取点位名与告警地址的交集关键字，如「百安坝」）
      const nm = (a.location || '').trim()
      const pn = (name || '').trim()
      if (nm && pn && (nm.includes(pn) || pn.includes(nm))) return true
      // 坐标临近（<0.005° ≈ 550m），覆盖告警坐标与地图点位坐标的微小偏差
      if (
        typeof lat === 'number' && typeof lon === 'number' &&
        typeof a.lat === 'number' && typeof a.lon === 'number' &&
        Math.abs(a.lat - lat) < 0.005 && Math.abs(a.lon - lon) < 0.005
      ) return true
      return false
    })
  }

  // Add markers whenever map or tab changes
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const AMap = window.AMap

    // Remove old markers
    if (markersRef.current.length > 0) {
      map.remove(markersRef.current)
      markersRef.current = []
    }

    const addM = (lon: number, lat: number, html: string, info: { title: string; lines: string[] }) => {
      const m = new AMap.Marker({
        position: [lon, lat],
        content: html,
        anchor: 'center',
        zIndex: 10,
      })
      m.on('mouseover', (e: any) => {
        e.originEvent?.stopPropagation()
        infoWindowRef.current.setContent(infoHTML(info.title, info.lines))
        infoWindowRef.current.open(map, [lon, lat])
      })
      m.on('mouseout', () => {
        infoWindowRef.current?.close()
      })
      map.add(m)
      markersRef.current.push(m)
    }

    // 标注：悬停时异步拉取信息（用于监测站🏠，悬停实时取最新采集数据）
    const addMAsync = (lon: number, lat: number, html: string, title: string, fetchLines: () => Promise<string[]>) => {
      const m = new AMap.Marker({ position: [lon, lat], content: html, anchor: 'center', zIndex: 11 })
      m.on('mouseover', async (e: any) => {
        e.originEvent?.stopPropagation()
        // 先显示加载中
        infoWindowRef.current.setContent(infoHTML(title, ['加载最新采集数据…']))
        infoWindowRef.current.open(map, [lon, lat])
        let lines: string[]
        try { lines = await fetchLines() } catch { lines = ['数据加载失败'] }
        // 若窗口仍打开在此处则更新（用户没移到别处）
        infoWindowRef.current.setContent(infoHTML(title, lines))
      })
      m.on('mouseout', () => {
        infoWindowRef.current?.close()
      })
      map.add(m)
      markersRef.current.push(m)
    }

    // Helper to read extra numeric/string fields safely
    const num = (v: unknown, d = 0) => (typeof v === 'number' ? v : d)
    const str = (v: unknown, d = '-') => (v == null ? d : String(v))

    // 按配置 key 取图标（不存在则用 fallback 默认图标+颜色）
    const icon = (key: string, name: string, fb: { icon: string; color: string }, opts?: { pulse?: boolean; size?: number; alert?: boolean }) => {
      const c = iconCfg[key] || fb
      return renderMarkerIcon(c.icon || fb.icon, c.color || fb.color, name, opts)
    }

    // Air quality stations (from backend map points)
    // 气环境驾驶舱+全域态势显示；水环境驾驶舱隐藏
    if (activeTab !== 'water') {
      mapPoints.filter(p => p.type === 'air').forEach(s => addM(s.lon, s.lat, icon('air', s.name, { icon: 'gauge', color: '#1a7fff' }, { alert: matchAlert(s.lat, s.lon, s.name) }), {
      title: s.name,
      lines: [`AQI&nbsp;&nbsp;: ${num(s.aqi)}`, `PM2.5: ${num(s.pm25)} μg/m³`, `PM10 : ${num(s.pm10)} μg/m³`, `NO₂&nbsp;: ${num(s.no2)} μg/m³`, `SO₂&nbsp;: ${num(s.so2)} μg/m³`],
    }))
    } // end activeTab !== 'water' (air stations hidden in water cockpit)

    // 市监测站 🏠（来自后端数据源配置的经纬度）— 点击实时拉取最近采集数据；气环境+全域显示
    if (activeTab !== 'water') {
      stations.forEach(st => addMAsync(st.lon, st.lat, icon('station', st.stationName || st.name, { icon: 'home', color: '#ffb300' }, { alert: matchAlert(st.lat, st.lon, st.stationName || st.name) }), st.stationName || st.name, async () => {
      const resp = await authFetch(`/api/collected/as-aq?stations=${encodeURIComponent(st.stationName)}`)
      const arr = await resp.json()
      if (!Array.isArray(arr) || !arr.length) return ['暂无采集数据', '（请确认数据源已启用并已采集）']
      // 取最新一条（按 date+hour 排序）
      const latest = [...arr].sort((a, b) => {
        const ka = `${a.date} ${String(a.hour).padStart(2, '0')}`
        const kb = `${b.date} ${String(b.hour).padStart(2, '0')}`
        return ka < kb ? 1 : -1
      })[0]
      return [
        `时间: ${latest.date} ${String(latest.hour).padStart(2, '0')}:00`,
        `AQI&nbsp;&nbsp;: ${num(latest.aqi)}`,
        `PM2.5: ${num(latest.pm25)} μg/m³`,
        `PM10&nbsp;: ${num(latest.pm10)} μg/m³`,
        `SO₂&nbsp;&nbsp;: ${num(latest.so2)} μg/m³`,
        `NO₂&nbsp;&nbsp;: ${num(latest.no2)} μg/m³`,
        `O₃&nbsp;&nbsp;&nbsp;: ${num(latest.o3)} μg/m³`,
        `CO&nbsp;&nbsp;&nbsp;: ${num(latest.co)} mg/m³`,
      ]
    }))
    } // end activeTab !== 'water' (stations hidden in water cockpit)

    // Water quality stations — 水环境驾驶舱+全域态势显示；气环境驾驶舱隐藏
    if (activeTab !== 'air') {
      mapPoints.filter(p => p.type === 'water').forEach(s => addM(s.lon, s.lat, icon('water', s.name, { icon: 'water', color: '#00e5ff' }, { pulse: true, alert: matchAlert(s.lat, s.lon, s.name) }), {
      title: s.name,
      lines: [`pH&nbsp;&nbsp;&nbsp;&nbsp;: ${num(s.ph)}`, `溶解氧: ${num(s.do_)} mg/L`, `氨氮&nbsp;: ${num(s.nh3)} mg/L`, `总磷&nbsp;: ${num(s.tp)} mg/L`],
    }))
    } // end activeTab !== 'air' (water stations hidden in air cockpit)

    // Pollution cameras — from videoStreams（按分组取图标，无分组配置回退 camera 默认）
    // 驾驶舱视图过滤：气环境驾驶舱只显示 category=气环境；水环境驾驶舱只显示 category=水环境；全域态势显示全部
    const tabCameraFilter = (s: VideoStream) => {
      if (typeof s.lat !== 'number' || typeof s.lon !== 'number') return false
      if (activeTab === 'air') return s.category === '气环境'
      if (activeTab === 'water') return s.category === '水环境'
      return true
    }
    videoStreams
      .filter(tabCameraFilter)
      .forEach(s => {
        const groupCfg = iconCfg[s.group] || iconCfg['camera'] || { icon: 'camera', color: '#00b84a' }
        // 摄像头图标告警：来自 IoT 视频分析通道的实时触发（地理坐标对应），
        // 仅当关联通道在 TTL 内推送过分析事件时才红闪，超时自动熄灭。
        const iotCh = iotChannelStatus.channels.find(c => c.streamId === s.id)
        const isAlertCam = iotAlertingStreamIds.includes(s.id)
        // 道路监控显示名称标签，便于在地图上快速识别具体路口
        const showLabel = s.group === '道路监控' ? s.name : ''
        const html = renderMarkerIcon(groupCfg.icon, s.offline ? '#5a6b7a' : groupCfg.color, showLabel, { size: 22, alert: isAlertCam })
        // 摄像头图标：悬停查看信息，双击直接推流播放
        const m = new AMap.Marker({ position: [s.lon as number, s.lat as number], content: html, anchor: 'center', zIndex: 10 })
        const info = {
          title: s.name,
          lines: [
            ...(isAlertCam && iotCh ? [`⚠ AI分析告警: ${iotCh.lastEventType || '—'}`, `最近事件: ${iotCh.lastEventAt || '—'}`] : []),
            `位置: ${s.location || '—'}`,
            `分组: ${s.group}`,
            `分类: ${s.category || '未分类'}`,
            `协议: ${s.protocol.toUpperCase()}`,
            `状态: ${s.offline ? '离线' : '在线'}`,
            `坐标: ${(s.lat as number).toFixed(4)}, ${(s.lon as number).toFixed(4)}`,
            '双击图标直接播放视频',
          ],
        }
        m.on('mouseover', (e: any) => {
          e.originEvent?.stopPropagation()
          infoWindowRef.current.setContent(infoHTML(info.title, info.lines))
          infoWindowRef.current.open(map, [s.lon as number, s.lat as number])
        })
        m.on('mouseout', () => {
          infoWindowRef.current?.close()
        })
        // 阻止 click 事件冒泡到地图，避免双击时地图意外位移
        m.on('click', (e: any) => { e.originEvent?.stopPropagation() })
        m.on('dblclick', (e: any) => {
          e.originEvent?.stopPropagation()
          infoWindowRef.current?.close()
          // 保存当前地图位置，关闭弹窗后恢复
          const c = map.getCenter()
          savedMapPosRef.current = { center: [c.lng, c.lat], zoom: map.getZoom() }
          setPlayStream(s)
        })
        map.add(m)
        markersRef.current.push(m)
      })

    // 首次有标注后自动调整视野，确保所有点位可见（40px 边距）
    if (markersRef.current.length > 0 && !hasFittedRef.current) {
      try {
        map.setFitView(null, false, [40, 40, 40, 40])
        hasFittedRef.current = true
      } catch (_) {}
    }

    // Alert markers
    mapPoints.filter(p => p.type === 'alert').forEach(s => addM(s.lon, s.lat, icon('alert', str(s.alertType, '告警'), { icon: 'alert', color: '#ff4444' }, { pulse: true }), {
      title: s.name,
      lines: [`告警类型: ${str(s.alertType)}`, `告警等级: ${['', '注意', '轻度', '中度', '重度'][num(s.level, 1)]}`, '处置状态: 待处置'],
    }))

    // Air tab extras — UAV airports
    if (activeTab === 'air') {
      mapPoints.filter(p => p.type === 'uav').forEach(s => addM(s.lon, s.lat, icon('uav', s.name, { icon: 'plane', color: '#ab47bc' }, { alert: matchAlert(s.lat, s.lon, s.name) }), {
        title: s.name,
        lines: ['设备类型: 无人机机场', '快检功能: 已接入', '当前状态: 运行中'],
      }))
    }

    // Water tab extras — basin monitoring
    if (activeTab === 'water') {
      mapPoints.filter(p => p.type === 'watermon').forEach(s => addM(s.lon, s.lat, icon('watermon', s.name, { icon: 'wave', color: '#00e5ff' }, { pulse: true, alert: matchAlert(s.lat, s.lon, s.name) }), {
        title: s.name,
        lines: ['设备类型: 流域监测站', '当前状态: 在线', '实时监测: 运行中'],
      }))
    }
  }, [mapReady, activeTab, videoStreams, mapPoints, stations, iconCfg, externalAlerts])

  // Pan to selected alert
  useEffect(() => {
    if (!mapRef.current || !selectedAlert) return
    mapRef.current.panTo([selectedAlert.lon, selectedAlert.lat])
    mapRef.current.setZoom(14, true)
  }, [selectedAlert])

  const legendItems = [
    { color: '#1e90ff', label: '大气监测站' },
    { color: '#00bcd4', label: '水质监测站' },
    { color: '#00c853', label: '污染源监控' },
    { color: '#ff3030', label: '超标告警' },
    ...(externalAlerts.length > 0 ? [{ color: '#ff3b3b', label: '实时告警·红闪' }] : []),
    ...(iotAlertingStreamIds.length > 0 ? [{ color: '#ff3b3b', label: 'AI分析触发·红闪' }] : []),
    ...(activeTab === 'air' ? [{ color: '#ab47bc', label: '无人机机场' }] : []),
    ...(activeTab === 'water' ? [{ color: '#00e5ff', label: '流域监测' }] : []),
  ]

  return (
    <div className="relative w-full h-full" style={{ background: '#040d1e' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      {/* Loading */}
      {loading && (
        <div style={{
          position: 'absolute', inset: 0,
          background: '#040d1e',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14,
        }}>
          <div style={{
            width: 44, height: 44,
            border: '3px solid rgba(0,170,255,0.15)',
            borderTopColor: '#00aaff',
            borderRadius: '50%',
            animation: 'amap-marker-spin 0.9s linear infinite',
          }} />
          <span style={{ color: '#5a8aaa', fontSize: 12, fontFamily: 'JetBrains Mono, monospace' }}>
            高德地图加载中…
          </span>
        </div>
      )}

      {/* Legend — 右下角图例（玻璃拟态） */}
      {mapReady && (
        <div style={{
          position: 'absolute', right: 10, bottom: 10, zIndex: 200,
          background: 'linear-gradient(160deg, rgba(10,26,56,0.62), rgba(5,13,30,0.5))',
          backdropFilter: 'blur(12px) saturate(1.3)',
          WebkitBackdropFilter: 'blur(12px) saturate(1.3)',
          border: '1px solid rgba(0,180,255,0.26)',
          borderRadius: 6, padding: '6px 10px',
          boxShadow: '0 6px 20px rgba(0,0,0,0.38), inset 0 0 16px -10px rgba(0,180,255,0.3)',
          pointerEvents: 'none',
        }}>
          <div style={{ color: '#8fc6ea', fontSize: 10, marginBottom: 4, letterSpacing: '0.15em' }}>图 例</div>
          {legendItems.map(item => (
            <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: item.color, boxShadow: `0 0 5px ${item.color}`, flexShrink: 0 }} />
              <span style={{ color: '#7ab8e0', fontSize: 10 }}>{item.label}</span>
            </div>
          ))}
        </div>
      )}

      {/* Active tab badge（玻璃拟态） */}
      {activeTab !== 'default' && mapReady && (
        <div style={{
          position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)',
          background: 'linear-gradient(160deg, rgba(0,45,100,0.72), rgba(0,25,60,0.6))',
          backdropFilter: 'blur(12px) saturate(1.3)',
          WebkitBackdropFilter: 'blur(12px) saturate(1.3)',
          border: '1px solid rgba(0,190,255,0.5)',
          borderRadius: 4, padding: '4px 18px',
          color: '#2fd4ff', fontSize: 11, fontWeight: 600, letterSpacing: '0.1em',
          zIndex: 200, pointerEvents: 'none',
          boxShadow: '0 0 16px rgba(0,170,255,0.28), inset 0 0 12px -6px rgba(0,190,255,0.5)',
          textShadow: '0 0 8px rgba(0,190,255,0.6)',
        }}>
          {activeTab === 'air' ? '⚡ 气环境专项视图' : '💧 水环境专项视图'}
        </div>
      )}

      {/* 鼠标交互帮助按钮 */}
      {mapReady && (
        <div
          style={{ position: 'absolute', top: 8, right: 10, zIndex: 210 }}
          onClick={e => e.stopPropagation()}
        >
          <div
            onClick={() => setShowHelp(v => !v)}
            style={{
              width: 26, height: 26, borderRadius: '50%',
              border: '1px solid rgba(0,170,255,0.4)',
              background: showHelp ? 'rgba(0,80,150,0.35)' : 'rgba(5,14,32,0.85)',
              color: showHelp ? '#00ccff' : '#5a8aaa',
              fontSize: 13, fontWeight: 700, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all 0.2s',
            }}
            title="鼠标交互说明"
          >
            ?
          </div>

          {/* 帮助面板（玻璃拟态） */}
          {showHelp && (
            <div style={{
              position: 'absolute', top: 32, right: 0,
              width: 240,
              background: 'linear-gradient(165deg, rgba(10,26,56,0.88), rgba(5,13,30,0.82))',
              backdropFilter: 'blur(14px) saturate(1.3)',
              WebkitBackdropFilter: 'blur(14px) saturate(1.3)',
              border: '1px solid rgba(0,180,255,0.35)',
              borderRadius: 6, padding: '10px 12px',
              boxShadow: '0 8px 28px rgba(0,0,0,0.7), inset 0 0 20px -12px rgba(0,180,255,0.4)',
            }}>
              <div style={{ color: '#00ccff', fontSize: 12, fontWeight: 600, marginBottom: 8, paddingBottom: 5, borderBottom: '1px solid rgba(0,150,220,0.2)' }}>
                摄像头点位 · 鼠标交互
              </div>
              {[
                { icon: '🖱', action: '悬停图标', desc: '查看点位信息（名称、位置、类型、状态、坐标）' },
                { icon: '🖱🖱', action: '双击图标', desc: '直接播放该摄像头视频流（仅摄像头点位）' },
                { icon: '🖱', action: '移开鼠标', desc: '自动关闭信息窗，不锁定交互' },
                { icon: '🖐', action: '拖拽 / 缩放', desc: '浏览地图，自动关闭信息窗' },
              ].map((item, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 7 }}>
                  <span style={{ fontSize: 13, flexShrink: 0, width: 28, textAlign: 'center' }}>{item.icon}</span>
                  <div>
                    <span style={{ color: '#9ad6f0', fontSize: 11, fontWeight: 600 }}>{item.action}</span>
                    <span style={{ color: '#5a8aaa', fontSize: 10, display: 'block', lineHeight: 1.5, marginTop: 1 }}>{item.desc}</span>
                  </div>
                </div>
              ))}
              <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid rgba(0,150,220,0.15)', color: '#3a5a70', fontSize: 9, textAlign: 'center' }}>
                绿色 = 在线 · 灰色 = 离线
              </div>
            </div>
          )}
        </div>
      )}

      {/* 双击视频图标 → 推流播放 */}
      {playStream && (
        <VideoPlayerModal
          name={playStream.name}
          location={playStream.location || ''}
          url={playStream.url}
          protocol={playStream.protocol}
          djiConfig={playStream.djiWebRTCConfig}
          onClose={() => {
            // 恢复地图到打开弹窗前的位置
            if (savedMapPosRef.current && mapRef.current) {
              mapRef.current.setZoomAndCenter(savedMapPosRef.current.zoom, savedMapPosRef.current.center)
              savedMapPosRef.current = null
            }
            setPlayStream(null)
          }}
        />
      )}
    </div>
  )
}

// ── Marker HTML helpers ──────────────────────────────────────────────────────
// 标注图标已统一由 src/app/lib/mapIcons.ts 的 renderMarkerIcon 生成（可后台自定义）

function infoHTML(title: string, lines: string[]) {
  return `<div style="background:rgba(4,14,38,0.97);border:1px solid rgba(0,180,255,0.45);border-radius:5px;padding:9px 12px;min-width:165px;box-shadow:0 6px 24px rgba(0,0,0,0.7)">
    <div style="color:#00ccff;font-size:12px;font-weight:600;margin-bottom:7px;padding-bottom:5px;border-bottom:1px solid rgba(0,150,220,0.25);font-family:'Noto Sans SC',sans-serif">${title}</div>
    ${lines.map(l => `<div style="color:#7ab8e0;font-size:11px;line-height:1.85;font-family:'JetBrains Mono',monospace">${l}</div>`).join('')}
  </div>`
}
