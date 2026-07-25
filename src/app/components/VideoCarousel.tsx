import { useState, useEffect } from 'react'
import { useDashboard, GROUP_COLORS } from '../context/DashboardContext'
import type { VideoStream, VideoGroup } from '../context/DashboardContext'
import { VideoPlayerModal } from './VideoPlayerModal'
import { VideoWall } from './VideoWall'

const VIDEO_GROUPS_ORDER: VideoGroup[] = ['无人机视频', '港口堆场', '道路监控', '水体监控', '重点企业']

interface VideoThumbProps {
  stream: VideoStream
  color: string
  index: number
  onClick: () => void
}

function VideoThumb({ stream, color, index, onClick }: VideoThumbProps) {
  const { name, location, offline, url, thumbnail } = stream
  const hasStream = !!url && !offline
  const gradients = [
    'linear-gradient(180deg, #0a1520 0%, #0d2535 40%, #071520 70%, #030c18 100%)',
    'linear-gradient(180deg, #071525 0%, #0a1f30 50%, #050e1a 100%)',
    'linear-gradient(180deg, #0c1a28 0%, #081528 50%, #040c1a 100%)',
    'linear-gradient(180deg, #0a1a22 0%, #0d2030 40%, #071520 100%)',
  ]
  // 卡片底色：有"视频流显示图片"时用图片铺底，否则用默认渐变
  const bgStyle: React.CSSProperties = thumbnail
    ? { backgroundImage: `url("${thumbnail}")`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : { background: gradients[index % 4] }
  return (
    <div
      onClick={onClick}
      style={{
        width: '100%', height: '100%', minWidth: 0, minHeight: 0,
        ...bgStyle, borderRadius: 3, overflow: 'hidden',
        border: offline ? '1px solid rgba(255,70,70,0.3)' : `1px solid ${color}25`,
        position: 'relative',
        cursor: 'pointer',
        transition: 'border-color 0.18s',
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = offline ? 'rgba(255,70,70,0.5)' : `${color}60` }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = offline ? 'rgba(255,70,70,0.3)' : `${color}25` }}
    >
      {/* 有底图时压一层暗色蒙版，保证文字/角标可读 */}
      {thumbnail && <div style={{ position: 'absolute', inset: 0, background: offline ? 'rgba(10,0,0,0.55)' : 'rgba(0,8,20,0.28)', pointerEvents: 'none' }} />}
      {/* scan-line texture */}
      <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.06) 2px, rgba(0,0,0,0.06) 4px)', pointerEvents: 'none' }} />
      {!thumbnail && <div style={{ position: 'absolute', inset: 0, background: offline ? 'rgba(20,0,0,0.6)' : `radial-gradient(ellipse at 50% 70%, ${color}08, transparent 70%)` }} />}
      {!offline && !thumbnail && <div style={{ position: 'absolute', top: '45%', left: 0, right: 0, height: 1, background: `${color}15` }} />}

      {/* LIVE / OFF badge */}
      <div style={{ position: 'absolute', top: 3, left: 3 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '1px 4px', background: offline ? 'rgba(80,0,0,0.7)' : 'rgba(0,0,0,0.6)', borderRadius: 2 }}>
          <div style={{ width: 4, height: 4, borderRadius: '50%', background: offline ? '#ff4444' : '#ff2020', boxShadow: offline ? 'none' : '0 0 4px #ff2020', animation: offline ? 'none' : 'live-blink 1.5s infinite' }} />
          <span style={{ color: offline ? '#ff6060' : '#ffffff', fontSize: 8, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>{offline ? 'OFF' : 'LIVE'}</span>
        </div>
      </div>

      {/* Center icon */}
      <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)' }}>
        {offline ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ff4444" strokeWidth="1.5" opacity="0.5">
            <path d="M1 1l22 22M16.72 11.06A10.94 10.94 0 0119 12.55M5 5a10.94 10.94 0 0114.22 2.78M10.9 10.9a3 3 0 004.2 4.2" />
          </svg>
        ) : hasStream ? (
          // Play button hint for streams with URL
          <div style={{ width: 20, height: 20, borderRadius: '50%', background: 'rgba(0,0,0,0.5)', border: `1px solid ${color}60`, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.6 }}>
            <svg width="8" height="8" viewBox="0 0 24 24" fill={color}>
              <polygon points="5,3 19,12 5,21" />
            </svg>
          </div>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" opacity="0.2">
            <path d="M14.5 4h-5L7 7H4a2 2 0 00-2 2v9a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2h-3l-2.5-3z" />
            <circle cx="12" cy="13" r="3" />
          </svg>
        )}
      </div>

      {/* Timestamp */}
      {!offline && (
        <div style={{ position: 'absolute', top: 3, right: 3, color: 'rgba(255,255,255,0.5)', fontSize: 8, fontFamily: "'JetBrains Mono', monospace" }}>
          {new Date().toTimeString().slice(0, 8)}
        </div>
      )}

      {/* Bottom label */}
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'linear-gradient(0deg, rgba(0,0,0,0.8), transparent)', padding: '4px 4px 3px' }}>
        <div style={{ color: '#c8e6ff', fontSize: 9, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
        <div style={{ color: '#5a8aaa', fontSize: 8 }}>{location}</div>
      </div>
    </div>
  )
}

export function VideoCarousel({ activeTab = 'default' }: { activeTab?: 'default' | 'air' | 'water' }) {
  const { videoStreams } = useDashboard()
  const [groupIdx, setGroupIdx] = useState(0)
  const [slideOffset, setSlideOffset] = useState(0)
  const [selectedStream, setSelectedStream] = useState<VideoStream | null>(null)
  const [showWall, setShowWall] = useState(false)

  // 驾驶舱视图分类过滤：气环境驾驶舱只显示 category=气环境；水环境驾驶舱只显示 category=水环境；全域态势显示全部
  const categoryStreams = videoStreams.filter(s => {
    if (activeTab === 'air') return s.category === '气环境'
    if (activeTab === 'water') return s.category === '水环境'
    return true
  })

  const activeGroups = VIDEO_GROUPS_ORDER
    .map(name => ({ name, color: GROUP_COLORS[name], videos: categoryStreams.filter(s => s.group === name) }))
    .filter(g => g.videos.length > 0)

  const groups = activeGroups.length > 0 ? activeGroups : [
    {
      name: '重点企业' as VideoGroup, color: '#3a5a70',
      videos: [{
        id: 'placeholder', name: '暂无视频流', location: '请在管理后台配置',
        url: '', group: '重点企业' as VideoGroup, offline: true,
        protocol: 'rtsp' as const, lat: '' as const, lon: '' as const,
      }],
    }
  ]

  const safeIdx = Math.min(groupIdx, groups.length - 1)
  const currentGroup = groups[safeIdx]
  const PER_SCREEN = 6
  const totalSlides = Math.ceil(currentGroup.videos.length / PER_SCREEN)

  useEffect(() => { setSlideOffset(0) }, [safeIdx])

  const visibleVideos = currentGroup.videos.slice(slideOffset * PER_SCREEN, slideOffset * PER_SCREEN + PER_SCREEN)

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 shrink-0" style={{ height: 40, borderLeft: '3px solid #7b7bff', borderBottom: '1px solid rgba(0,150,220,0.1)', background: 'linear-gradient(90deg, rgba(123,123,255,0.08), transparent)' }}>
        <span style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 600 }}>视频群组轮巡</span>
        <div className="flex items-center gap-1.5" style={{ overflowX: 'auto', scrollbarWidth: 'none' }}>
          {groups.map((g, i) => (
            <button key={g.name} onClick={() => { setGroupIdx(i); setSlideOffset(0) }} style={{
              padding: '2px 8px', fontSize: 11, borderRadius: 2, flexShrink: 0,
              border: `1px solid ${i === safeIdx ? g.color : 'rgba(0,150,220,0.2)'}`,
              background: i === safeIdx ? `${g.color}20` : 'transparent',
              color: i === safeIdx ? g.color : '#5a8aaa',
              cursor: 'pointer', transition: 'all 0.2s',
            }}>{g.name}</button>
          ))}
          {/* 视频墙按钮：按群组九宫格全屏展示 */}
          <button onClick={() => setShowWall(true)} title="视频墙" style={{
            padding: '2px 10px', fontSize: 11, borderRadius: 2, flexShrink: 0,
            border: '1px solid rgba(123,123,255,0.5)', background: 'rgba(123,123,255,0.15)',
            color: '#a0a0ff', cursor: 'pointer', fontWeight: 600, marginLeft: 4,
          }}>▦ 视频墙</button>
        </div>
      </div>

      <div className="flex-1 px-2 py-2" style={{ minHeight: 0 }}>
        <div
          style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gridTemplateRows: 'repeat(2, 1fr)', gap: 4, height: '100%' }}
          onWheel={(e) => {
            e.preventDefault()
            if (e.deltaY > 0 && slideOffset + 1 < totalSlides) {
              setSlideOffset(s => s + 1)
            } else if (e.deltaY < 0 && slideOffset > 0) {
              setSlideOffset(s => s - 1)
            }
          }}
        >
          {Array.from({ length: PER_SCREEN }).map((_, i) => {
            const video = visibleVideos[i]
            if (!video) return (
              <div key={`empty-${i}`} style={{ minHeight: 0, background: 'rgba(0,20,50,0.3)', border: '1px solid rgba(0,80,150,0.15)', borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ color: '#2a4a60', fontSize: 9 }}>无信号</span>
              </div>
            )
            return (
              <VideoThumb
                key={video.id}
                stream={video}
                color={currentGroup.color}
                index={i}
                onClick={() => setSelectedStream(video)}
              />
            )
          })}
        </div>
        {totalSlides > 1 && (
          <div className="flex justify-center gap-1 mt-1.5">
            {Array.from({ length: totalSlides }).map((_, i) => (
              <div key={i} onClick={() => setSlideOffset(i)} style={{ width: i === slideOffset ? 12 : 5, height: 3, borderRadius: 1.5, background: i === slideOffset ? currentGroup.color : 'rgba(0,150,220,0.2)', transition: 'all 0.3s', cursor: 'pointer' }} />
            ))}
          </div>
        )}
      </div>

      <style>{`@keyframes live-blink { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>

      {selectedStream && (
        <VideoPlayerModal
          name={selectedStream.name}
          location={selectedStream.location}
          url={selectedStream.url}
          protocol={selectedStream.protocol}
          djiConfig={selectedStream.djiWebRTCConfig}
          onClose={() => setSelectedStream(null)}
        />
      )}

      {showWall && <VideoWall groups={groups} onClose={() => setShowWall(false)} />}
    </div>
  )
}
