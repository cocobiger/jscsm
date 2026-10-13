import { describe, it, expect } from 'vitest'
import { evidenceImgUrl } from './evidenceImage'

/**
 * 2026-09-20 回归测试：存档页「看不到图」根治
 *
 * 病状：无人机（straw-engine）记录的 picUrl 是**站内相对路径** `/api/evidence/<日期>/xxx.jpg`，
 *   由后端 `app.get('/api/evidence/*')` 静态托管（直连 200）。
 *   但后端旧版无条件拼 `/api/iot-image?url=` → 代理侧 validatePicUrl 只认 http(s) → **400** →
 *   前端 <img> onError 隐藏自身 → 用户看到**空蓝块**。
 * 线上实测：可见 144 条中 36 条（4 个无人机分组）100% 空块，108 条真实摄像头通道正常。
 */
describe('evidenceImgUrl（图片 URL 统一解析）', () => {
  it('站内相对路径 /api/evidence/… → 直连，不套代理（本条就是空块根因）', () => {
    expect(evidenceImgUrl('/api/evidence/20260913/sikong_1581F8HGX258600A0S4G_190719.jpg'))
      .toBe('/api/evidence/20260913/sikong_1581F8HGX258600A0S4G_190719.jpg')
  })

  it('绝对 http(s) 上游 → 套 /api/iot-image 代理（跨域 + 内网可达）', () => {
    expect(evidenceImgUrl('http://172.16.8.11:5001/images/detect/2026/09/16/a.jpg'))
      .toBe('/api/iot-image?url=' + encodeURIComponent('http://172.16.8.11:5001/images/detect/2026/09/16/a.jpg'))
    expect(evidenceImgUrl('https://iotcloud.example.com/x.jpg'))
      .toBe('/api/iot-image?url=' + encodeURIComponent('https://iotcloud.example.com/x.jpg'))
  })

  it('🔴 回归：已被包装成代理的相对路径 → 解回站内直链（幂等兜底）', () => {
    // 这正是线上 36 条的形态
    const bad = '/api/iot-image?url=' + encodeURIComponent('/api/evidence/20260913/sikong_1581F8HGX258600A0S4G_190719.jpg')
    expect(evidenceImgUrl(bad)).toBe('/api/evidence/20260913/sikong_1581F8HGX258600A0S4G_190719.jpg')
  })

  it('已正确包装的绝对地址 → 原样返回（不被二次处理）', () => {
    const good = '/api/iot-image?url=' + encodeURIComponent('http://172.16.8.11:5001/images/detect/a.jpg')
    expect(evidenceImgUrl(good)).toBe(good)
  })

  it('幂等：反复调用结果稳定（不会越包越多层）', () => {
    const once = evidenceImgUrl('/api/evidence/20260913/x.jpg')
    expect(evidenceImgUrl(once)).toBe(once)
    const abs = evidenceImgUrl('http://172.16.8.11:5001/a.jpg')
    expect(evidenceImgUrl(abs)).toBe(abs)
  })

  it('代理串带额外参数（如 RoiEditor 的 &t=tick）→ 不误判、不改写', () => {
    const withTick = '/api/iot-image?url=' + encodeURIComponent('http://172.16.8.11:5001/a.jpg') + '&t=1730000000'
    expect(evidenceImgUrl(withTick)).toBe(withTick)
  })

  it('非法百分号编码 → 不抛异常，原样返回', () => {
    expect(evidenceImgUrl('/api/iot-image?url=%E0%A4%A')).toBe('/api/iot-image?url=%E0%A4%A')
  })

  it('空值 → null；非常规形态原样透传', () => {
    expect(evidenceImgUrl(null)).toBeNull()
    expect(evidenceImgUrl(undefined)).toBeNull()
    expect(evidenceImgUrl('')).toBeNull()
    expect(evidenceImgUrl('data:image/png;base64,AAA')).toBe('data:image/png;base64,AAA')
    expect(evidenceImgUrl('//cdn.example.com/a.jpg')).toBe('//cdn.example.com/a.jpg')
  })
})
