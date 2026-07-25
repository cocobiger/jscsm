import { useEffect, useRef, useState } from 'react'

export interface DisplayConfig {
  baseWidth: number
  baseHeight: number
  mode: 'fit' | 'stretch'
  layout?: 'default' | 'wide'
  presets?: Record<string, { scale: number; baseWidth?: number; baseHeight?: number; layout?: 'default' | 'wide'; mode?: 'fit' | 'stretch'; note?: string }>
}

export interface ScreenInfo {
  innerWidth: number
  innerHeight: number
  screenWidth: number
  screenHeight: number
  dpr: number
  matchedPreset: string | null
}

export interface DisplayScale {
  config: DisplayConfig
  screen: ScreenInfo
  scale: number
  layout: 'default' | 'wide'
}

const DEFAULT_CONFIG: DisplayConfig = {
  baseWidth: 1920,
  baseHeight: 1080,
  mode: 'fit',
  layout: 'default',
}

/**
 * 分辨率检测 + 自适应缩放
 * - 检测 window.screen（物理分辨率）/ innerWidth（视口）/ devicePixelRatio
 * - 拉取后端 /api/display-config，按物理分辨率匹配预设；预设可覆盖画布尺寸/布局/缩放
 * - 同时按「设计画布等比缩放到当前视口」计算实时 scale，二者取较小值，确保任何窗口都不溢出
 */
export function useDisplayScale(): DisplayScale {
  const [config, setConfig] = useState<DisplayConfig>(DEFAULT_CONFIG)
  const [screen, setScreen] = useState<ScreenInfo>(() => readScreen())
  const rafRef = useRef<number | null>(null)

  // 拉取后端显示配置
  useEffect(() => {
    let alive = true
    fetch('/api/display-config')
      .then(r => (r.ok ? r.json() : null))
      .then((cfg: DisplayConfig | null) => {
        if (alive && cfg && typeof cfg.baseWidth === 'number') setConfig(cfg)
      })
      .catch(() => {/* 使用默认 1920×1080 */})
    return () => { alive = false }
  }, [])

  // 监听窗口/分辨率变化
  useEffect(() => {
    const onResize = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(() => setScreen(readScreen()))
    }
    window.addEventListener('resize', onResize)
    // 部分浏览器切换显示器/缩放比会触发 matchMedia 变化
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    mq.addEventListener?.('change', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      mq.removeEventListener?.('change', onResize)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // 命中物理分辨率时，把该预设的画布/布局/模式覆盖到 config 上，得到「有效配置」
  const matchedPreset = config.presets
    ? Object.keys(config.presets).find(k => {
        const [w, h] = k.split('x').map(Number)
        return screen.screenWidth === w && screen.screenHeight === h
      }) ?? null
    : null
  const preset = matchedPreset ? config.presets![matchedPreset] : null
  const effective: DisplayConfig = {
    ...config,
    baseWidth: preset?.baseWidth ?? config.baseWidth,
    baseHeight: preset?.baseHeight ?? config.baseHeight,
    mode: preset?.mode ?? config.mode,
    layout: preset?.layout ?? config.layout ?? 'default',
  }

  let scale = 1
  if (effective.mode === 'fit') {
    const byViewport = Math.min(
      screen.innerWidth / effective.baseWidth,
      screen.innerHeight / effective.baseHeight,
    )
    // 优先采用预设系数（命中物理分辨率时），否则用视口自适应系数；二者取小保证不溢出
    const presetScale = preset?.scale ?? Infinity
    scale = Math.min(byViewport, presetScale === Infinity ? byViewport : presetScale)
  } else {
    // stretch 模式：x/y 独立拉伸（可能变形）
    scale = Math.min(
      screen.innerWidth / effective.baseWidth,
      screen.innerHeight / effective.baseHeight,
    )
  }
  // 防御：避免极小/NaN
  if (!isFinite(scale) || scale <= 0) scale = 1

  return { config: effective, screen, scale, layout: effective.layout ?? 'default' }
}

function readScreen(): ScreenInfo {
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    screenWidth: window.screen?.width ?? window.innerWidth,
    screenHeight: window.screen?.height ?? window.innerHeight,
    dpr: window.devicePixelRatio || 1,
    matchedPreset: null,
  }
}
