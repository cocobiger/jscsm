import { useCallback, useEffect, useRef, useState } from 'react'

// ── 全屏图片查看器（放大复核）──────────────────────────────────────────
// 需求：复核图点击后要能放大 —— 2942×1732 原图被压缩到几百像素宽，1km 细微烟柱看不清
// 功能：滚轮缩放（以鼠标为中心 5%~1200%）· 拖拽平移 · 显隐框 · 0=适应 1=1:1 ±=缩放 · Esc 关闭
// 关键：keydown 在 window 捕获阶段拦截（stopImmediatePropagation），
//       保证父层（详情弹层/放大复核）的 1/2/3/5/←/→/Esc 快捷键不会误触发
// 关键：wheel 用原生非 passive listener（React 合成 wheel 无法 preventDefault 滚动）

interface B { cls: number; conf: number; x1: number; y1: number; x2: number; y2: number }

const mono = { fontFamily: "'JetBrains Mono', 'Consolas', monospace" } as const

const clsColor = (c: number) => (c === 1 ? '#ff4444' : c === 2 ? '#ffb74d' : '#00aaff')
const clsName = (c: number) => (c === 1 ? 'fire' : c === 2 ? 'house' : 'smoke')

const MIN_SCALE = 0.05
const MAX_SCALE = 12

const toolBtn: React.CSSProperties = {
  padding: '4px 12px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
  background: 'rgba(0,80,160,0.18)', color: '#7ee0ff', border: '1px solid rgba(0,170,255,0.4)',
  whiteSpace: 'nowrap',
}

export function ImgViewer({ src, boxes, title, subtitle, showBoxes: initShow, onClose }: {
  src: string
  boxes?: B[]
  title?: string
  subtitle?: string
  showBoxes?: boolean
  onClose: () => void
}) {
  const stageRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const [showBoxes, setShowBoxes] = useState(initShow !== false)
  const [dragging, setDragging] = useState(false)
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 })
  const viewRef = useRef(view)
  const apply = useCallback((scale: number, tx: number, ty: number) => {
    viewRef.current = { scale, tx, ty }
    setView({ scale, tx, ty })
  }, [])
  const drag = useRef<{ sx: number; sy: number; tx: number; ty: number } | null>(null)
  const moved = useRef(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // 适应窗口（contain 填满）
  const fit = useCallback(() => {
    const stage = stageRef.current, img = imgRef.current
    if (!stage || !img) return
    const sw = stage.clientWidth, sh = stage.clientHeight
    const iw = img.naturalWidth || 1, ih = img.naturalHeight || 1
    const s = Math.max(MIN_SCALE, Math.min(sw / iw, sh / ih))
    apply(s, (sw - iw * s) / 2, (sh - ih * s) / 2)
  }, [apply])

  // 1:1 原始像素居中
  const actual = useCallback(() => {
    const stage = stageRef.current, img = imgRef.current
    if (!stage || !img) return
    const iw = img.naturalWidth || 1, ih = img.naturalHeight || 1
    apply(1, (stage.clientWidth - iw) / 2, (stage.clientHeight - ih) / 2)
  }, [apply])

  // 以鼠标/中心为焦点缩放
  const zoomAt = useCallback((mx: number, my: number, factor: number) => {
    const { scale, tx, ty } = viewRef.current
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor))
    if (next === scale) return
    apply(next, mx - (mx - tx) * (next / scale), my - (my - ty) * (next / scale))
  }, [apply])

  // 原生 wheel（非 passive 才能 preventDefault 阻止页面滚动）
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  // 捕获阶段拦截所有键盘事件，父层快捷键（1/2/3/5/←/→ 等）不会误触发
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation()
      e.stopImmediatePropagation()
      const stage = stageRef.current
      const cx = stage ? stage.clientWidth / 2 : 0
      const cy = stage ? stage.clientHeight / 2 : 0
      if (e.key === 'Escape') onCloseRef.current()
      else if (e.key === '0') fit()
      else if (e.key === '1') actual()
      else if (e.key === '=' || e.key === '+') zoomAt(cx, cy, 1.25)
      else if (e.key === '-') zoomAt(cx, cy, 1 / 1.25)
      else if (e.key === 'b' || e.key === 'B') setShowBoxes(v => !v)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [fit, actual, zoomAt])

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    drag.current = { sx: e.clientX, sy: e.clientY, tx: viewRef.current.tx, ty: viewRef.current.ty }
    moved.current = false
    setDragging(true)
  }
  const onMouseMove = (e: React.MouseEvent) => {
    const d = drag.current
    if (!d) return
    moved.current = true
    apply(viewRef.current.scale, d.tx + e.clientX - d.sx, d.ty + e.clientY - d.sy)
  }
  const onMouseUp = () => {
    drag.current = null
    setDragging(false)
  }
  const onStageClick = () => {
    if (moved.current) { moved.current = false; return }
    onCloseRef.current()
  }
  const onDoubleClick = () => {
    const stage = stageRef.current
    if (!stage) return
    zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, 1.8)
  }

  return (
    <div ref={stageRef}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onClick={onStageClick}
      onDoubleClick={onDoubleClick}
      style={{
        position: 'fixed', inset: 0, zIndex: 3200, background: 'rgba(0,0,0,0.94)',
        overflow: 'hidden', cursor: dragging ? 'grabbing' : 'grab',
        userSelect: 'none', touchAction: 'none',
      }}>
      {/* 工具条 */}
      <div onClick={e => e.stopPropagation()} style={{
        position: 'absolute', top: 0, left: 0, right: 0, zIndex: 3,
        display: 'flex', gap: 8, alignItems: 'center', padding: '10px 14px',
        background: 'rgba(4,14,35,0.88)', borderBottom: '1px solid rgba(0,150,220,0.25)',
      }}>
        <span style={{ color: '#7ee0ff', fontSize: 13, fontWeight: 700 }}>{title || '图片查看'}</span>
        {subtitle && <span style={{ fontSize: 11, color: '#5a8aaa', ...mono }}>{subtitle}</span>}
        <span style={{ fontSize: 11, color: '#3a5a70', marginLeft: 8 }}>滚轮缩放 · 拖拽平移 · 0=适应 1=1:1 b=显隐框</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#7ab8e0', ...mono }}>{Math.round(view.scale * 100)}%</span>
        <button onClick={() => setShowBoxes(v => !v)} title="显示/隐藏检测标注框（b）"
          style={{ ...toolBtn, background: showBoxes ? 'rgba(0,170,255,0.25)' : 'rgba(90,138,170,0.12)', color: showBoxes ? '#7ee0ff' : '#7ab8e0', borderColor: showBoxes ? 'rgba(0,170,255,0.55)' : 'rgba(90,138,170,0.35)' }}>
          {showBoxes ? '◉ 显示框' : '○ 隐藏框'}
        </button>
        <button onClick={() => zoomAt(0, 0, 1 / 1.25)} style={toolBtn}>−</button>
        <button onClick={() => zoomAt(0, 0, 1.25)} style={toolBtn}>＋</button>
        <button onClick={actual} title="1:1 原始像素（1）" style={toolBtn}>1:1</button>
        <button onClick={fit} title="适应窗口（0）" style={toolBtn}>适应</button>
        <button onClick={onClose} style={{ ...toolBtn, color: '#ff8a8a', borderColor: 'rgba(255,120,120,0.45)' }}>关闭 ✕ (Esc)</button>
      </div>

      {/* 内容层（transform 缩放平移） */}
      <div style={{
        position: 'absolute', left: 0, top: 0,
        transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
        transformOrigin: '0 0', willChange: 'transform',
      }}>
        <img ref={imgRef} src={src} alt="" draggable={false} onLoad={fit}
          style={{ display: 'block', maxWidth: 'none', userSelect: 'none', pointerEvents: 'none' }} />
        {showBoxes && (boxes || []).map((b, i) => (
          <div key={i} style={{
            position: 'absolute',
            left: b.x1, top: b.y1, width: Math.max(0, b.x2 - b.x1), height: Math.max(0, b.y2 - b.y1),
            border: `2px solid ${clsColor(b.cls)}`, boxSizing: 'border-box', pointerEvents: 'none',
          }}>
            <span style={{
              position: 'absolute', top: -17, left: 0, background: clsColor(b.cls), color: '#000',
              fontSize: 11, padding: '0 4px', borderRadius: 2, fontWeight: 600, lineHeight: '16px', ...mono,
            }}>
              {clsName(b.cls)} {(b.conf || 0).toFixed(2)}
            </span>
          </div>
        ))}
      </div>

      {/* 底部提示 */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 3, textAlign: 'center',
        padding: '6px 0', fontSize: 11, color: '#3a5a70',
        background: 'linear-gradient(transparent, rgba(0,0,0,0.6))',
      }}>
        滚轮/±=缩放 · 按住拖拽=平移 · 双击=放大 · Esc=关闭
      </div>
    </div>
  )
}

// ── 画框画布缩放 hook（滚轮缩放，以鼠标为中心；平移交给容器滚动条）──────
// 关键：canvas pos() 基于 getBoundingClientRect 比率换算，CSS transform 缩放后坐标自动正确
// 用法：容器 div（overflow:auto）挂 ref → const { zoom, zoomBy, resetZoom } = useCanvasZoom(ref)
//       内层 wrapper style={{ transform: `scale(${zoom})`, transformOrigin: '0 0' }}
export function useCanvasZoom(ref: React.RefObject<HTMLElement | null>, min = 0.5, max = 8) {
  const [zoom, setZoomState] = useState(1)
  const zoomRef = useRef(1)

  const setZoom = useCallback((z: number) => {
    const next = Math.max(min, Math.min(max, z))
    if (next === zoomRef.current) return
    zoomRef.current = next
    setZoomState(next)
  }, [min, max])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const old = zoomRef.current
      const next = Math.max(min, Math.min(max, old * (e.deltaY < 0 ? 1.18 : 1 / 1.18)))
      if (next === old) return
      // 保持鼠标指向的内容点不动：内容原始坐标 = (scrollLeft + mx) / old
      const cx = (el.scrollLeft + mx) / old
      const cy = (el.scrollTop + my) / old
      el.scrollLeft = cx * next - mx
      el.scrollTop = cy * next - my
      zoomRef.current = next
      setZoomState(next)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [ref, min, max])

  const zoomBy = useCallback((f: number) => {
    const el = ref.current
    if (!el) return
    const old = zoomRef.current
    const next = Math.max(min, Math.min(max, old * f))
    if (next === old) return
    const cx = (el.scrollLeft + el.clientWidth / 2) / old
    const cy = (el.scrollTop + el.clientHeight / 2) / old
    el.scrollLeft = cx * next - el.clientWidth / 2
    el.scrollTop = cy * next - el.clientHeight / 2
    zoomRef.current = next
    setZoomState(next)
  }, [ref, min, max])

  const resetZoom = useCallback(() => {
    const el = ref.current
    if (!el) return
    zoomRef.current = 1
    setZoomState(1)
  }, [ref])

  return { zoom, zoomBy, resetZoom }
}
