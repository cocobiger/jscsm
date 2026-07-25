import { useState, useEffect, useRef } from 'react'
import { SinglePlayer } from './VideoPlayerModal'
import { useDashboard } from '../context/DashboardContext'
import type { VideoStream, VideoGroup } from '../context/DashboardContext'

const CYAN = '#00aaff'

interface WallGroup {
  name: VideoGroup
  color: string
  videos: VideoStream[]
}

interface Props {
  groups: WallGroup[]
  onClose: () => void
}

// 视频墙：按视频群组分类，九宫格全屏展示该组视频（每格实时播放）
export function VideoWall({ groups, onClose }: Props) {
  const { updateStream } = useDashboard()
  // 本次 VideoWall 会话中已截图的流 ID，避免重复截图
  const snapshottedRef = useRef<Set<string>>(new Set())
  // groupIdx === -1 表示"所有视频"模式（展示所有群组合集）
  const [groupIdx, setGroupIdx] = useState(0)
  const [slideOffset, setSlideOffset] = useState(0)
  const showAll = groupIdx === -1
  const realGroups = groups.filter(g => g.videos.some(v => v.id !== 'placeholder'))
  const safeIdx = Math.min(Math.max(groupIdx, 0), Math.max(0, realGroups.length - 1))
  const group = realGroups[safeIdx]
  const activeColor = showAll ? CYAN : (group?.color || CYAN)
  const videos = showAll
    ? realGroups.flatMap(g => g.videos).filter(v => v.id !== 'placeholder')
    : (group?.videos || []).filter(v => v.id !== 'placeholder')
  const allCount = realGroups.flatMap(g => g.videos).filter(v => v.id !== 'placeholder').length
  const PER_SCREEN = 9
  const totalSlides = Math.ceil(videos.length / PER_SCREEN)
  const visibleVideos = videos.slice(slideOffset * PER_SCREEN, slideOffset * PER_SCREEN + PER_SCREEN)

  useEffect(() => { setSlideOffset(0) }, [groupIdx])

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,0.95)', backdropFilter: 'blur(3px)', display: 'flex', flexDirection: 'column' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      {/* Header：群组切换 + 所有视频 + 关闭 */}
      <div style={{ height: 52, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, padding: '0 20px', borderBottom: '1px solid rgba(0,150,220,0.2)', background: 'linear-gradient(90deg, #040e25, #061530 50%, #040e25)' }}>
        <div style={{ width: 3, height: 18, background: '#7b7bff', borderRadius: 1 }} />
        <span style={{ color: '#c8e6ff', fontSize: 16, fontWeight: 700, letterSpacing: '0.06em' }}>视频墙</span>
        <div style={{ display: 'flex', gap: 6, marginLeft: 16, overflowX: 'auto', scrollbarWidth: 'none' }}>
          {realGroups.map((g, i) => (
            <button key={g.name} onClick={() => setGroupIdx(i)} style={{
              padding: '4px 14px', fontSize: 12, borderRadius: 3, flexShrink: 0,
              border: `1px solid ${!showAll && i === safeIdx ? g.color : 'rgba(0,150,220,0.25)'}`,
              background: !showAll && i === safeIdx ? `${g.color}22` : 'transparent',
              color: !showAll && i === safeIdx ? g.color : '#5a8aaa', cursor: 'pointer', transition: 'all 0.2s',
            }}>{g.name}<span style={{ color: '#3a5a70', marginLeft: 6, fontSize: 11 }}>{g.videos.filter(v => v.id !== 'placeholder').length}</span></button>
          ))}
          {/* 所有视频按钮：展示所有群组合集 */}
          <button onClick={() => setGroupIdx(-1)} style={{
            padding: '4px 14px', fontSize: 12, borderRadius: 3, flexShrink: 0, marginLeft: 4,
            border: `1px solid ${showAll ? CYAN : 'rgba(0,170,255,0.4)'}`,
            background: showAll ? `${CYAN}22` : 'transparent',
            color: showAll ? CYAN : '#5a8aaa', cursor: 'pointer', transition: 'all 0.2s', fontWeight: 600,
          }}>所有视频<span style={{ color: '#3a5a70', marginLeft: 6, fontSize: 11 }}>{allCount}</span></button>
        </div>
        <button onClick={onClose} style={{ marginLeft: 'auto', width: 30, height: 30, borderRadius: 4, border: '1px solid rgba(0,150,220,0.25)', background: 'rgba(0,80,150,0.15)', color: '#5a8aaa', cursor: 'pointer', fontSize: 15, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
      </div>

      {/* 九宫格：3×3 */}
      <div style={{ flex: 1, minHeight: 0, padding: 12, position: 'relative' }}>
        <div
          style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gridTemplateRows: 'repeat(3, 1fr)', gap: 8, width: '100%', height: '100%' }}
          onWheel={(e) => {
            e.preventDefault()
            if (e.deltaY > 0 && slideOffset + 1 < totalSlides) {
              setSlideOffset(s => s + 1)
            } else if (e.deltaY < 0 && slideOffset > 0) {
              setSlideOffset(s => s - 1)
            }
          }}
        >
          {Array.from({ length: 9 }).map((_, i) => {
            const v = visibleVideos[i]
            if (!v) return (
              <div key={`empty-${i}`} style={{ background: 'rgba(0,15,35,0.5)', border: '1px solid rgba(0,80,150,0.15)', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ color: '#2a4a60', fontSize: 12 }}>—</span>
              </div>
            )
            return (
              <div key={v.id} style={{ position: 'relative', background: '#000', border: `1px solid ${activeColor}33`, borderRadius: 4, overflow: 'hidden', minHeight: 0 }}>
                {v.offline || (!v.url && v.protocol !== 'dji_webrtc') ? (
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#5a6b7a', fontSize: 12 }}>
                    {v.offline ? '离线' : '无地址'}
                  </div>
                ) : (
                  <SinglePlayer
                    url={v.url}
                    protocol={v.protocol}
                    djiConfig={v.djiWebRTCConfig}
                    primary={false}
                    onSnapshot={(dataUri) => {
                      if (snapshottedRef.current.has(v.id)) return
                      snapshottedRef.current.add(v.id)
                      updateStream(v.id, { thumbnail: dataUri })
                    }}
                  />
                )}
                {/* 名称标签 */}
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'linear-gradient(0deg, rgba(0,0,0,0.85), transparent)', padding: '6px 8px 4px', pointerEvents: 'none' }}>
                  <div style={{ color: '#c8e6ff', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.name}</div>
                  <div style={{ color: '#5a8aaa', fontSize: 10 }}>{v.location}</div>
                </div>
              </div>
            )
          })}
        </div>
        {totalSlides > 1 && (
          <div style={{ position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 4 }}>
            {Array.from({ length: totalSlides }).map((_, i) => (
              <div key={i} onClick={() => setSlideOffset(i)} style={{ width: i === slideOffset ? 14 : 6, height: 4, borderRadius: 2, background: i === slideOffset ? activeColor : 'rgba(0,150,220,0.25)', transition: 'all 0.3s', cursor: 'pointer' }} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
