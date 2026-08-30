import { useState, useRef, useEffect, useMemo } from 'react'

interface Props {
  src?: string
  alt?: string
  onClick?: () => void
  /** 无图或加载失败时显示的占位内容（如 SVG 图标 + 文案） */
  fallback?: React.ReactNode
  /** 边框颜色（加载骨架/外框） */
  borderColor?: string
  /** 右上角徽章（如聚合计数） */
  badge?: React.ReactNode
  width?: number
  height?: number
}

// 告警缩略图：骨架 shimmer → 图片加载完成淡入；lazy 加载；失败回退占位
export function AlertThumbnail({ src, alt = '', onClick, fallback, borderColor = 'rgba(0,150,220,0.4)', badge, width = 72, height = 48 }: Props) {
  const [loaded, setLoaded] = useState(false)
  const [errored, setErrored] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)

  // src 变化时重置状态（列表复用时避免旧图残留）
  useEffect(() => { setLoaded(false); setErrored(false) }, [src])

  // 缩略图加速：/api/iot-image 原图代理 → /api/thumb 缩放+webp 压缩（72×48 显示不再加载 ~1MB 原图）
  const thumbSrc = useMemo(() => {
    if (!src) return src
    const m = src.match(/\/api\/iot-image\?url=([^&]+)/)
    if (m) return '/api/thumb?url=' + m[1] + '&w=200'
    return src
  }, [src])

  const showImg = !!thumbSrc && !errored

  return (
    <div
      className="shrink-0"
      style={{
        position: 'relative', width, height, borderRadius: 3, overflow: 'hidden',
        border: `1px solid ${borderColor}40`, background: 'rgba(0,20,60,0.6)',
        cursor: showImg && onClick ? 'pointer' : 'default',
      }}
      onClick={(e) => { if (showImg && onClick) { e.stopPropagation(); onClick() } }}
    >
      {/* 骨架 shimmer（图片未加载完成时显示） */}
      {showImg && !loaded && (
        <div style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(100deg, rgba(20,50,90,0.6) 30%, rgba(40,90,150,0.9) 50%, rgba(20,50,90,0.6) 70%)',
          backgroundSize: '200% 100%',
          animation: 'thumb-shimmer 1.2s ease-in-out infinite',
        }} />
      )}

      {/* 无图 / 失败占位 */}
      {!showImg && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          color: '#3a5a70', fontSize: 10, gap: 2,
        }}>
          {fallback}
        </div>
      )}

      {/* 实际图片（淡入） */}
      {showImg && (
        <img
          ref={imgRef}
          src={thumbSrc}
          alt={alt}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setErrored(true)}
          style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover',
            opacity: loaded ? 1 : 0, transition: 'opacity 0.35s ease',
          }}
        />
      )}

      {/* 徽章 */}
      {badge}

      <style>{`
        @keyframes thumb-shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  )
}
