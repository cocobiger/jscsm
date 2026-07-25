import { useState, useEffect, useRef } from 'react'

interface Props {
  value: number
  duration?: number
  style?: React.CSSProperties
}

/**
 * 数字递增动效组件 — 驾驶舱大屏的数字翻牌效果。
 * 首次渲染从 0 递增到目标值，后续值变化时从上一次值递增/递减。
 */
export function AnimatedNumber({ value, duration = 800, style }: Props) {
  const [display, setDisplay] = useState(0)
  const prevRef = useRef(value)

  useEffect(() => {
    const start = prevRef.current
    prevRef.current = value
    const startTime = performance.now()
    const range = value - start
    let raf: number

    const tick = (now: number) => {
      const elapsed = now - startTime
      const progress = Math.min(elapsed / duration, 1)
      // ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3)
      setDisplay(Math.round(start + range * eased))
      if (progress < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, duration])

  return <span style={style}>{display}</span>
}
