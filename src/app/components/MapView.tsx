import { authFetch } from '../lib/apiFetch'
import { useEffect, useRef, useState } from 'react'
import type { AlertItem } from './AlertPanel'
import { useDashboard } from '../context/DashboardContext'
import type { VideoStream } from '../context/DashboardContext'
import { renderMarkerIcon } from '../lib/mapIcons'
import { VideoPlayerModal } from './VideoPlayerModal'
import { initMap } from '../lib/mapAdapter'
import type { MapHandle } from '../lib/mapAdapter'
import type { TimelineSelection, HourlyPoint } from './TimeAxisPanel'
import { aqiColor } from '../lib/airQuality'

export type MapTab = 'default' | 'air' | 'water'
/** P1 场景聚焦：与 MapTab 正交，在任意驾驶舱视图之上再做一层点位过滤 */
export type MapScene = 'none' | 'dust' | 'straw'

/** 司空2 机场（dji-openapi 聚合：设备 + OSD 实时遥测） */
interface SikongDock {
  id: string
  deviceSn: string
  deviceName: string
  latitude: number
  longitude: number
  height?: number | null
  drone?: { droneSn?: string; droneName?: string } | null
  osd?: Record<string, unknown> | null
}

interface Props {
  activeTab: MapTab
  selectedAlert: AlertItem | null
  /** P1 场景聚焦（可选，默认 'none' 不过滤） */
  scene?: MapScene
  /** P2b 地图时间轴：非 null 时站点标记按该小时历史数据着色/展示 */
  timeline?: TimelineSelection | null
}

const MARKER_CSS = `
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

export function MapView({ activeTab, selectedAlert, scene = 'none', timeline = null }: Props) {
  const { videoStreams, mapPoints, externalAlerts, iotAlertingStreamIds, iotChannelStatus } = useDashboard()
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapHandle | null>(null)
  const [loading, setLoading] = useState(true)
  const [mapReady, setMapReady] = useState(false)
  const [stations, setStations] = useState<Array<{ id: string; name: string; stationName: string; lon: number; lat: number }>>([])
  const [iconCfg, setIconCfg] = useState<Record<string, { icon: string; color: string }>>({})
  // 司空2 机场（实时 OSD 遥测：电量/风速/温度/GPS数；来自 dji-openapi 数据贯通）
  const [sikongDocks, setSikongDocks] = useState<SikongDock[]>([])
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

  // 加载司空2 机场（15s 轮询，OSD 实时遥测）
  useEffect(() => {
    const load = () => authFetch('/api/sikong/devices').then(r => r.json()).then(d => Array.isArray(d?.items) && setSikongDocks(d.items)).catch(() => {})
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

  // 初始化地图：经适配层加载引擎 → 创建实例（默认 Leaflet+天地图瓦片；VITE_MAP_ENGINE=amap 可回退高德）
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return
    let cancelled = false
    const engine = (import.meta.env.VITE_MAP_ENGINE as 'amap' | 'leaflet') || 'leaflet'
    initMap(containerRef.current, engine, {
      center: [108.4076, 30.8077],
      zoom: 12,
      // 双击缩放：视频图标 dblclick 已 stopPropagation，不会误触；空白区双击可缩放（走查建议 #4）
      doubleClickZoom: true,
    })
      .then(handle => {
        if (cancelled) {
          handle.destroy()
          return
        }
        mapRef.current = handle
        // 任何地图交互（点击空白/拖拽/缩放）都关闭信息窗，避免"锁死"需双击解锁
        const closeInfo = () => handle.closeInfoWindow()
        handle.on('click', closeInfo)
        handle.on('dragstart', closeInfo)
        handle.on('movestart', closeInfo)
        handle.on('zoomstart', closeInfo)
        setMapReady(true)
        setLoading(false)
      })
      .catch(() => setLoading(false))

    return () => {
      cancelled = true
      if (mapRef.current) {
        mapRef.current.destroy()
        mapRef.current = null
      }
    }
  }, [])

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

    // 清空旧标记（适配层统一管理）
    map.clearMarkers()

    const addM = (lon: number, lat: number, html: string, info: { title: string; lines: string[] }) => {
      map.addMarker({
        lon, lat, html,
        events: {
          mouseover: (e) => {
            e.stopPropagation()
            map.openInfoWindow(infoHTML(info.title, info.lines), lon, lat)
          },
          mouseout: () => map.closeInfoWindow(),
        },
      })
    }

    // 标注：悬停时异步拉取信息（用于监测站🏠，悬停实时取最新采集数据）
    const addMAsync = (lon: number, lat: number, html: string, title: string, fetchLines: () => Promise<string[]>) => {
      map.addMarker({
        lon, lat, html, zIndex: 11,
        events: {
          mouseover: async (e) => {
            e.stopPropagation()
            // 先显示加载中
            map.openInfoWindow(infoHTML(title, ['加载最新采集数据…']), lon, lat)
            let lines: string[]
            try { lines = await fetchLines() } catch { lines = ['数据加载失败'] }
            // 若窗口仍打开在此处则更新（用户没移到别处）
            map.openInfoWindow(infoHTML(title, lines), lon, lat)
          },
          mouseout: () => map.closeInfoWindow(),
        },
      })
    }

    // Helper to read extra numeric/string fields safely
    const num = (v: unknown, d = 0) => (typeof v === 'number' ? v : d)
    const str = (v: unknown, d = '-') => (v == null ? d : String(v))

    // 按配置 key 取图标（不存在则用 fallback 默认图标+颜色）
    const icon = (key: string, name: string, fb: { icon: string; color: string }, opts?: { pulse?: boolean; size?: number; alert?: boolean }) => {
      const c = iconCfg[key] || fb
      return renderMarkerIcon(c.icon || fb.icon, c.color || fb.color, name, opts)
    }

    // P1 场景聚焦：dust/straw 场景下隐藏常规站点，只保留场景相关点位
    const showGeneral = scene === 'none'

    // 统计本次绘制标记数，用于首次视野自适应（与旧逻辑等价）
    let markerCount = 0
    const track = () => { markerCount++ }

    // P2b 时间轴：取站点名对应历史小时数据（匹配周家坝/百安坝等短名）
    const tlPoint = (name: string): HourlyPoint | null => {
      if (!timeline) return null
      const st = timeline.data.stations.find(s => name.includes(s.name) || s.name.includes(name))
      return st ? st.series.find(p => p.hour === timeline.hour) || null : null
    }
    const tlTimeLabel = timeline ? `${timeline.date} ${String(timeline.hour).padStart(2, '0')}:00` : ''

    // Air quality stations (from backend map points)
    // 气环境驾驶舱+全域态势显示；水环境驾驶舱隐藏
    if (showGeneral && activeTab !== 'water') {
      mapPoints.filter(p => p.type === 'air').forEach(s => { track(); const tl = tlPoint(s.name); if (tl) {
        // 时间轴回放：AQI 着色 + 历史数值
        addM(s.lon, s.lat, renderMarkerIcon('gauge', aqiColor(tl.aqi), s.name, { alert: matchAlert(s.lat, s.lon, s.name) }), {
        title: `${s.name} · 回放`,
        lines: [`时间: ${tlTimeLabel}`, `AQI&nbsp;&nbsp;: ${tl.aqi}`, `PM2.5: ${tl.pm25} μg/m³`, `PM10 : ${tl.pm10} μg/m³`, `NO₂&nbsp;: ${tl.no2} μg/m³`, `SO₂&nbsp;: ${tl.so2} μg/m³`],
      }) } else {
      addM(s.lon, s.lat, icon('air', s.name, { icon: 'gauge', color: '#1a7fff' }, { alert: matchAlert(s.lat, s.lon, s.name) }), {
      title: s.name,
      lines: [`AQI&nbsp;&nbsp;: ${num(s.aqi)}`, `PM2.5: ${num(s.pm25)} μg/m³`, `PM10 : ${num(s.pm10)} μg/m³`, `NO₂&nbsp;: ${num(s.no2)} μg/m³`, `SO₂&nbsp;: ${num(s.so2)} μg/m³`],
    }) } })
    } // end activeTab !== 'water' (air stations hidden in water cockpit)

    // 市监测站 🏠（来自后端数据源配置的经纬度）— 点击实时拉取最近采集数据；气环境+全域显示
    if (showGeneral && activeTab !== 'water') {
      stations.forEach(st => { track(); const stName = st.stationName || st.name; const tl = tlPoint(stName); if (tl) {
        // 时间轴回放：同步历史数据，无需异步拉取
        addM(st.lon, st.lat, renderMarkerIcon('home', aqiColor(tl.aqi), stName, { alert: matchAlert(st.lat, st.lon, stName) }), {
        title: `${stName} · 回放`,
        lines: [
          `时间: ${tlTimeLabel}`,
          `AQI&nbsp;&nbsp;: ${tl.aqi}`,
          `PM2.5: ${tl.pm25} μg/m³`,
          `PM10&nbsp;: ${tl.pm10} μg/m³`,
          `SO₂&nbsp;&nbsp;: ${tl.so2} μg/m³`,
          `NO₂&nbsp;&nbsp;: ${tl.no2} μg/m³`,
          `O₃&nbsp;&nbsp;&nbsp;: ${tl.o3} μg/m³`,
          `CO&nbsp;&nbsp;&nbsp;: ${tl.co} mg/m³`,
        ],
      }) } else {
      addMAsync(st.lon, st.lat, icon('station', stName, { icon: 'home', color: '#ffb300' }, { alert: matchAlert(st.lat, st.lon, stName) }), stName, async () => {
      const resp = await authFetch(`/api/collected/as-aq?stations=${encodeURIComponent(stName)}`)
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
    }) } })
    } // end activeTab !== 'water' (stations hidden in water cockpit)

    // Water quality stations — 水环境驾驶舱+全域态势显示；气环境驾驶舱隐藏
    if (showGeneral && activeTab !== 'air') {
      mapPoints.filter(p => p.type === 'water').forEach(s => { track(); addM(s.lon, s.lat, icon('water', s.name, { icon: 'water', color: '#00e5ff' }, { pulse: true, alert: matchAlert(s.lat, s.lon, s.name) }), {
      title: s.name,
      lines: [`pH&nbsp;&nbsp;&nbsp;&nbsp;: ${num(s.ph)}`, `溶解氧: ${num(s.do_)} mg/L`, `氨氮&nbsp;: ${num(s.nh3)} mg/L`, `总磷&nbsp;: ${num(s.tp)} mg/L`],
    }) })
    } // end activeTab !== 'air' (water stations hidden in air cockpit)

    // Pollution cameras — from videoStreams（按分组取图标，无分组配置回退 camera 默认）
    // 驾驶舱视图过滤：气环境驾驶舱只显示 category=气环境；水环境驾驶舱只显示 category=水环境；全域态势显示全部
    // P1 场景过滤：扬尘管控只显示港口堆场/道路监控；秸秆焚烧不显示摄像头
    const tabCameraFilter = (s: VideoStream) => {
      if (typeof s.lat !== 'number' || typeof s.lon !== 'number') return false
      if (scene === 'dust') return s.group === '港口堆场' || s.group === '道路监控'
      if (scene === 'straw') return false
      if (activeTab === 'air') return s.category === '气环境'
      if (activeTab === 'water') return s.category === '水环境'
      return true
    }
    videoStreams
      .filter(tabCameraFilter)
      .forEach(s => {
        track()
        const groupCfg = iconCfg[s.group] || iconCfg['camera'] || { icon: 'camera', color: '#00b84a' }
        // 摄像头图标告警：来自 IoT 视频分析通道的实时触发（地理坐标对应），
        // 仅当关联通道在 TTL 内推送过分析事件时才红闪，超时自动熄灭。
        const iotCh = iotChannelStatus.channels.find(c => c.streamId === s.id)
        const isAlertCam = iotAlertingStreamIds.includes(s.id)
        // 道路监控显示名称标签，便于在地图上快速识别具体路口
        const showLabel = s.group === '道路监控' ? s.name : ''
        const html = renderMarkerIcon(groupCfg.icon, s.offline ? '#5a6b7a' : groupCfg.color, showLabel, { size: 22, alert: isAlertCam })
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
        // 摄像头图标：悬停查看信息，双击直接推流播放
        map.addMarker({
          lon: s.lon as number,
          lat: s.lat as number,
          html,
          events: {
            mouseover: (e) => {
              e.stopPropagation()
              map.openInfoWindow(infoHTML(info.title, info.lines), s.lon as number, s.lat as number)
            },
            mouseout: () => map.closeInfoWindow(),
            // 阻止 click 事件冒泡到地图，避免双击时地图意外位移
            click: (e) => { e.stopPropagation() },
            dblclick: (e) => {
              e.stopPropagation()
              map.closeInfoWindow()
              // 保存当前地图位置，关闭弹窗后恢复
              const c = map.getCenter()
              savedMapPosRef.current = { center: [c.lng, c.lat], zoom: map.getZoom() }
              setPlayStream(s)
            },
          },
        })
      })

    // 首次有标注后自动调整视野，确保所有点位可见（40px 边距）
    if (markerCount > 0 && !hasFittedRef.current) {
      try {
        map.fitView([40, 40, 40, 40])
        hasFittedRef.current = true
      } catch (_) {}
    }

    // Alert markers（P1 场景过滤：扬尘场景只留扬尘/堆头类，秸秆场景只留秸秆燃烧类）
    const alertSceneFilter = (s: any) => {
      const t = str(s.alertType, '')
      if (scene === 'dust') return t.includes('扬尘') || t.includes('堆头') || t.includes('裸土')
      if (scene === 'straw') return t.includes('秸秆')
      return true
    }
    mapPoints.filter(p => p.type === 'alert').filter(alertSceneFilter).forEach(s => { track(); addM(s.lon, s.lat, icon('alert', str(s.alertType, '告警'), { icon: 'alert', color: '#ff4444' }, { pulse: true }), {
      title: s.name,
      lines: [`告警类型: ${str(s.alertType)}`, `告警等级: ${['', '注意', '轻度', '中度', '重度'][num(s.level, 1)]}`, '处置状态: 待处置'],
    }) })

    // Air tab extras — UAV airports
    if (showGeneral && activeTab === 'air') {
      mapPoints.filter(p => p.type === 'uav').forEach(s => { track(); addM(s.lon, s.lat, icon('uav', s.name, { icon: 'plane', color: '#ab47bc' }, { alert: matchAlert(s.lat, s.lon, s.name) }), {
        title: s.name,
        lines: ['设备类型: 无人机机场', '快检功能: 已接入', '当前状态: 运行中'],
      }) })
    }

    // Water tab extras — basin monitoring
    if (showGeneral && activeTab === 'water') {
      mapPoints.filter(p => p.type === 'watermon').forEach(s => { track(); addM(s.lon, s.lat, icon('watermon', s.name, { icon: 'wave', color: '#00e5ff' }, { pulse: true, alert: matchAlert(s.lat, s.lon, s.name) }), {
        title: s.name,
        lines: ['设备类型: 流域监测站', '当前状态: 在线', '实时监测: 运行中'],
      }) })
    }

    // 司空2 机场（实时 OSD 遥测标注层：基础设施层，始终显示，不受场景/tab 隐藏——机场是秸秆/环境监测的数据源）
    sikongDocks.forEach(dk => {
      if (typeof dk.latitude !== 'number' || typeof dk.longitude !== 'number') return
      track()
      const o = dk.osd || null
      const osdLines: string[] = o ? [
        `无人机状态: ${o.droneInDock === 1 ? '机场内待命' : '飞行中'}`,
        `无人机电量: ${str(o.droneCapacityPercent, '—')}%`,
        `风速&nbsp;&nbsp;&nbsp;&nbsp;: ${str(o.windspeed, '—')} m/s`,
        `温度&nbsp;&nbsp;&nbsp;&nbsp;: ${str(o.temperature, '—')} ℃`,
        `环境温度&nbsp;&nbsp;: ${str(o.envTemperature, '—')} ℃`,
        `湿度&nbsp;&nbsp;&nbsp;&nbsp;: ${str(o.humidity, '—')}%`,
        `GPS卫星&nbsp;&nbsp;: ${str(o.gpsNumber, '—')} 颗`,
        `供电电压&nbsp;&nbsp;: ${str(o.electricSupplyVoltage, '—')} V`,
      ] : ['遥测&nbsp;&nbsp;&nbsp;&nbsp;: 暂无（等待 OSD 推送）']
      addM(dk.longitude, dk.latitude, icon('uav', dk.deviceName, { icon: 'plane', color: '#ab47bc' }, { pulse: true }), {
        title: `${dk.deviceName} · 司空机场`,
        lines: [
          `机场 SN&nbsp;&nbsp;: ${dk.deviceSn}`,
          `无人机&nbsp;&nbsp;&nbsp;&nbsp;: ${dk.drone?.droneName || '—'}`,
          `无人机 SN : ${dk.drone?.droneSn || '—'}`,
          ...osdLines,
          `坐标&nbsp;&nbsp;&nbsp;&nbsp;: ${dk.latitude.toFixed(4)}, ${dk.longitude.toFixed(4)}`,
        ],
      })
    })
  }, [mapReady, activeTab, scene, videoStreams, mapPoints, stations, iconCfg, externalAlerts, timeline, sikongDocks])

  // Pan to selected alert
  useEffect(() => {
    if (!mapRef.current || !selectedAlert) return
    mapRef.current.panTo(selectedAlert.lon, selectedAlert.lat)
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
    ...(sikongDocks.length > 0 ? [{ color: '#ab47bc', label: `司空机场·实时遥测(${sikongDocks.length})` }] : []),
  ]

  return (
    <div className="relative w-full h-full" style={{ background: '#040d1e', isolation: 'isolate' }}>
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
            地图加载中…
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

      {/* Active tab badge（玻璃拟态）——下移让位顶部统计条 */}
      {activeTab !== 'default' && mapReady && (
        <div style={{
          position: 'absolute', top: 62, left: '50%', transform: 'translateX(-50%)',
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
