import { useEffect, useRef, useState, useCallback } from 'react'
import { authFetch } from '../../lib/apiFetch'

/**
 * 实时检测框叠加层（T5 实时标框重构）
 * 在原流画面上用 canvas 叠加绘制 straw-engine 的实时检测框。
 * 数据：/api/drone-events/bbox?deviceSn=（straw-engine snapshot 的 boxes）
 * 更新：2s 轮询（与检测抽帧节奏一致，bbox 本身 2s 才变一次）
 *
 * ⚠️ 坐标映射（2026-09-11 修复关键 bug）：
 *   bbox 像素坐标基于"检测帧分辨率"（= 视频源分辨率，实测 1440×1080 等）；
 *   但**容器宽高比常与视频不一致**（如视频 4:3 塞进 16:9 的放大层 → 左右黑边，
 *   视频实际只占容器宽 75%）。旧实现按「整容器宽 / 视频宽」缩放 → 横向被放大 1.33 倍
 *   → 检测框向右溢出画面（真飞截图暴露）。
 *   现在按 **contain 规则**先算视频实际显示区（缩放 + 居中偏移），再把框映射到该区，
 *   自动兼容任意容器比例；分辨率优先取同容器内 <video> 的 videoWidth/videoHeight（最可靠）。
 */

interface BboxItem {
  cls: number
  conf: number
  box: [number, number, number, number] // x1,y1,x2,y2
}

interface Props {
  deviceSn: string
  /** 视频原始分辨率（用于 bbox 坐标缩放），未知时按容器尺寸近似 */
  videoWidth?: number | null
  videoHeight?: number | null
  /** 是否启用（画面 ready 后才轮询） */
  enabled: boolean
}

const CLASS_META: Record<number, { name: string; color: string }> = {
  0: { name: 'smoke', color: '#00e5ff' }, // 青
  1: { name: 'fire', color: '#ff4444' },  // 红
  2: { name: 'house', color: '#ffd740' }, // 黄
}

export function BboxOverlay({ deviceSn, videoWidth, videoHeight, enabled }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [boxes, setBoxes] = useState<BboxItem[]>([])
  const inFlightRef = useRef(false)

  const fetchBbox = useCallback(() => {
    if (!deviceSn || inFlightRef.current) return
    inFlightRef.current = true
    authFetch(`/api/drone-events/bbox?deviceSn=${encodeURIComponent(deviceSn)}`)
      .then(r => r.json())
      .then(d => { if (d && Array.isArray(d.boxes)) setBoxes(d.boxes) })
      .catch(() => { })
      .finally(() => { inFlightRef.current = false })
  }, [deviceSn])

  useEffect(() => {
    if (!enabled) return
    fetchBbox()
    const t = setInterval(fetchBbox, 2000)
    return () => clearInterval(t)
  }, [enabled, fetchBbox])

  // 绘制检测框（随 boxes / 容器尺寸变化）
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const parent = canvas.parentElement
    if (!parent) return
    const w = parent.clientWidth
    const h = parent.clientHeight
    if (w === 0 || h === 0) return
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, w, h)

    // 视频真实分辨率：优先同容器内 <video> 的 videoWidth/Height（播放器实际解码尺寸，最可靠），
    // 其次 props（后端 ZLM 解析，可能为空），最后回退容器尺寸
    const vid = document.querySelector('video') as HTMLVideoElement | null
    const vwRaw = (vid && vid.videoWidth) ? vid.videoWidth : (videoWidth && videoWidth > 0 ? videoWidth : w)
    const vhRaw = (vid && vid.videoHeight) ? vid.videoHeight : (videoHeight && videoHeight > 0 ? videoHeight : h)

    // contain 映射：视频等比缩放后居中（<video> 默认行为），算出实际显示区
    const scale = Math.min(w / vwRaw, h / vhRaw)
    const dispW = vwRaw * scale
    const dispH = vhRaw * scale
    const offX = (w - dispW) / 2
    const offY = (h - dispH) / 2

    for (const b of boxes) {
      const meta = CLASS_META[b.cls] || { name: `cls${b.cls}`, color: '#ffffff' }
      const [x1, y1, x2, y2] = b.box
      // 视频区域内坐标 → 容器坐标（含居中偏移），并夹到视频显示区内防溢出
      const vx1 = Math.max(0, Math.min(vwRaw, x1)) * scale + offX
      const vy1 = Math.max(0, Math.min(vhRaw, y1)) * scale + offY
      const vx2 = Math.max(0, Math.min(vwRaw, x2)) * scale + offX
      const vy2 = Math.max(0, Math.min(vhRaw, y2)) * scale + offY
      const rx = vx1, ry = vy1
      const rw = vx2 - vx1, rh = vy2 - vy1
      if (rw < 2 || rh < 2) continue
      ctx.strokeStyle = meta.color
      ctx.lineWidth = 2
      ctx.strokeRect(rx, ry, rw, rh)
      // 标签
      const label = `${meta.name} ${(b.conf * 100).toFixed(0)}%`
      ctx.font = 'bold 11px "JetBrains Mono", monospace'
      const tw = ctx.measureText(label).width + 8
      const th = 15
      const ly = ry > th ? ry - th : ry + rh + 2
      ctx.fillStyle = meta.color
      ctx.fillRect(rx, ly, tw, th)
      ctx.fillStyle = '#04101f'
      ctx.fillText(label, rx + 4, ly + th - 4)
    }
  }, [boxes, videoWidth, videoHeight])

  // 容器尺寸变化时重绘（ResizeObserver）
  useEffect(() => {
    const canvas = canvasRef.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return
    const ro = new ResizeObserver(() => {
      // 触发重绘（通过强制更新 boxes 依赖）
      setBoxes(prev => [...prev])
    })
    ro.observe(parent)
    return () => ro.disconnect()
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 5 }}
    />
  )
}
