import { describe, it, expect } from 'vitest'
import { renderMarkerIcon } from './mapIcons'

// renderMarkerIcon(iconKey, color, name?, opts?) 生成地图标注 HTML 字符串。
// 关键点：纯函数、不依赖 DOM；颜色经 hexA() 转 rgba 阴影；alert 强制染红+红脉冲；
// 未知 iconKey 回退 pin；name 非空才渲染标签。
describe('renderMarkerIcon', () => {
  it('默认渲染：尺寸26、注入颜色、hexA 阴影、无动画、无标签', () => {
    const html = renderMarkerIcon('camera', '#1a7fff')
    // 盒子尺寸与背景
    expect(html).toContain('width:26px;height:26px')
    expect(html).toContain('background:rgba(5,15,35,0.78)')
    // 边框使用传入颜色
    expect(html).toContain('border:1.5px solid #1a7fff')
    // box-shadow 经由 hexA('#1a7fff', 0.55) → rgba(26,127,255,0.55)
    expect(html).toContain('box-shadow:0 0 12px rgba(26,127,255,0.55)')
    // 内嵌 svg + 24x24 viewBox
    expect(html).toContain('viewBox="0 0 24 24"')
    // 注入了 camera 图标 svg
    expect(html).toContain('M17 10.5V7a1 1 0 0 0-1-1H4')
    // 默认无 name → 不应出现动画与标签
    expect(html).not.toContain('animation:')
    expect(html).not.toContain('摄像头')
  })

  it('未知 iconKey 回退到 pin', () => {
    const html = renderMarkerIcon('__not_exist__', '#ff4444')
    // pin 的 path
    expect(html).toContain('M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5')
    // 不应包含 camera 图标
    expect(html).not.toContain('M17 10.5V7a1 1 0 0 0-1-1H4')
  })

  it('name 非空渲染标签（含颜色）', () => {
    const html = renderMarkerIcon('camera', '#1a7fff', '摄像头A')
    expect(html).toContain('>摄像头A<')
    expect(html).toContain('color:#1a7fff')
  })

  it('alert:true 强制染红 + 红色脉冲，忽略传入颜色', () => {
    const html = renderMarkerIcon('alert', '#1a7fff', '', { alert: true })
    expect(html).toContain('border:1.5px solid #ff3b3b')
    expect(html).toContain('style="color:#ff3b3b"')
    expect(html).toContain('animation:amap-alert-pulse-red 1.1s ease-in-out infinite')
    // 传入颜色不应出现
    expect(html).not.toContain('#1a7fff')
  })

  it('pulse:true 水波脉冲（非告警）', () => {
    const html = renderMarkerIcon('water', '#00b84a', '', { pulse: true })
    expect(html).toContain('animation:amap-water-pulse 2s ease-in-out infinite')
    expect(html).toContain('border:1.5px solid #00b84a')
    expect(html).not.toContain('amap-alert-pulse-red')
  })

  it('size 选项影响盒子与 svg 内尺寸', () => {
    const html = renderMarkerIcon('camera', '#1a7fff', '', { size: 40 })
    expect(html).toContain('width:40px;height:40px')
    // inner = Math.round(40 * 0.62) = 25
    expect(html).toContain('width="25" height="25"')
  })

  it('非6位 hex 时 hexA 透传原色（box-shadow 不转 rgba）', () => {
    const html = renderMarkerIcon('camera', '#abc')
    expect(html).toContain('border:1.5px solid #abc')
    expect(html).toContain('box-shadow:0 0 12px #abc')
  })
})
