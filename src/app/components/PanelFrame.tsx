import React from 'react'
import { CK, alpha } from '../lib/cockpitTheme'

interface PanelFrameProps {
  title: string
  /** 主题色：四角描边、标题角标、发光均以此色为基调 */
  color?: string
  /** 高度占比（沿用旧 PanelSection 语义：4→40%，其余→30%），left panel 三段布局专用 */
  flexGrow?: number
  /** 显式高度百分比，优先于 flexGrow（多段不等高布局用，如 37/19/22/22） */
  heightPct?: number
  /**
   * 高度模式：
   * - 'pct'（默认）：按 heightPct/flexGrow 百分比定高
   * - 'content'：自适应内容高度（内容多少占多少，不撑不占）
   * - 'fill'：占满父容器剩余空间（flex:1），适合放在最后一段
   */
  fit?: 'pct' | 'content' | 'fill'
  /** 顶部是否跑扫描光带 */
  scan?: boolean
  headerExtra?: React.ReactNode
  children: React.ReactNode
}

const CORNER = 14 // 四角描边臂长

/**
 * DataV 风格装饰面板：四角描边 + 菱形发光角标标题 + 可选扫描线 + 渐变底。
 * 纯 SVG/CSS 实现，零三方依赖，用于替换旧 PanelSection 的左侧光带。
 */
export function PanelFrame({ title, color = CK.cyan, flexGrow = 1, heightPct, fit = 'pct', headerExtra, scan = false, children }: PanelFrameProps) {
  const pct = heightPct ?? (flexGrow === 4 ? 40 : 30)
  const sizeStyle: React.CSSProperties =
    fit === 'content'
      ? { flexShrink: 0 }
      : fit === 'fill'
        ? { flex: 1, minHeight: 0 }
        : { height: `${pct}%`, flexShrink: 0 }
  return (
    <section
      className="flex flex-col"
      style={{
        position: 'relative',
        ...sizeStyle,
        overflow: 'hidden',
        background: `linear-gradient(165deg, ${alpha(color, 0.09)} 0%, rgba(6,14,32,0.52) 42%, rgba(4,10,24,0.35) 100%)`,
        border: `1px solid ${alpha(color, 0.20)}`,
        boxShadow: `inset 0 0 26px -14px ${alpha(color, 0.45)}`,
      }}
    >
      {/* 四角描边（4 组 L 形角臂，带发光） */}
      <CornerArm pos="tl" color={color} />
      <CornerArm pos="tr" color={color} />
      <CornerArm pos="bl" color={color} />
      <CornerArm pos="br" color={color} />

      {/* 扫描光带 */}
      {scan && (
        <div
          style={{
            position: 'absolute', top: 0, left: 0, height: 1.5, width: 120, zIndex: 2,
            background: `linear-gradient(90deg, transparent, ${alpha(color, 0.75)}, transparent)`,
            animation: 'cockpit-frame-scan 5s ease-in-out infinite',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* 标题栏：菱形角标 + 发光标题 + 装饰渐变线 */}
      <div
        className="flex items-center justify-between px-3 shrink-0"
        style={{
          height: 36,
          position: 'relative',
          zIndex: 2,
          borderBottom: `1px solid ${alpha(color, 0.14)}`,
          background: `linear-gradient(180deg, ${alpha(color, 0.10)}, transparent)`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span
            style={{
              width: 8, height: 8, flexShrink: 0,
              transform: 'rotate(45deg)',
              background: color,
              boxShadow: `0 0 8px ${alpha(color, 0.9)}`,
            }}
          />
          <span
            style={{
              color: CK.textMain,
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: '0.10em',
              textShadow: `0 0 10px ${alpha(color, 0.55)}`,
              whiteSpace: 'nowrap',
            }}
          >
            {title}
          </span>
          <span
            style={{
              width: 46, height: 1, flexShrink: 0,
              background: `linear-gradient(90deg, ${alpha(color, 0.6)}, transparent)`,
            }}
          />
        </div>
        {headerExtra}
      </div>

      {/* 内容区：content 模式用自然流（section 高度=标题+内容，零 flex 分配黑盒）；pct/fill 模式 flex-1 填满 */}
      <div
        className={fit === 'content' ? 'overflow-y-auto px-3 py-1.5' : 'flex-1 overflow-y-auto px-3 py-1.5'}
        style={{ scrollbarWidth: 'none', minHeight: 0, position: 'relative', zIndex: 2 }}
      >
        {children}
      </div>

      <style>{`
        @keyframes cockpit-frame-scan {
          0% { left: -120px; }
          60%, 100% { left: calc(100% + 120px); }
        }
      `}</style>
    </section>
  )
}

/** L 形角臂：两个边各一条带发光的细条 */
function CornerArm({ pos, color }: { pos: 'tl' | 'tr' | 'bl' | 'br'; color: string }) {
  const isTop = pos === 'tl' || pos === 'tr'
  const isLeft = pos === 'tl' || pos === 'bl'
  const glow = `0 0 5px ${alpha(color, 0.9)}`
  const base: React.CSSProperties = { position: 'absolute', zIndex: 3, pointerEvents: 'none' }
  return (
    <>
      <span
        style={{
          ...base,
          width: CORNER, height: 2,
          top: isTop ? 0 : undefined,
          bottom: isTop ? undefined : 0,
          left: isLeft ? 0 : undefined,
          right: isLeft ? undefined : 0,
          background: color,
          boxShadow: glow,
        }}
      />
      <span
        style={{
          ...base,
          width: 2, height: CORNER,
          top: isTop ? 0 : undefined,
          bottom: isTop ? undefined : 0,
          left: isLeft ? 0 : undefined,
          right: isLeft ? undefined : 0,
          background: color,
          boxShadow: glow,
        }}
      />
    </>
  )
}
