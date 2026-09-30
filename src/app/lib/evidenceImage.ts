// 证据图片 URL 统一解析（2026-09-14 修复：秸秆告警证据图空块 + 通道 null 的图片侧根因）
//
// 背景：picUrl 有两种形态——
//   ① straw-engine 源：站内相对路径 /api/evidence/<日期>/xxx.jpg（后端免登录静态路由，直连 200）
//   ② iotcloud/NVR 源：外链 http(s)（如 6882 认证网关 / 5001 抓图），需走 /api/iot-image 代理
// 此前多处 UI 无脑拼 /api/iot-image?url=<相对路径> → 代理 400 → <img> onError 被隐藏 → 空蓝块。
// AlertThumbnail 内部 9/3 已有同类防御（解码还原直链），但仅限自身；本函数供其余裸 <img> 场景统一使用。
export function evidenceImgUrl(picUrl: string | null | undefined): string | null {
  if (!picUrl) return null
  if (picUrl.startsWith('/')) return picUrl                     // 站内路径：直连
  if (/^https?:\/\//i.test(picUrl)) return `/api/iot-image?url=${encodeURIComponent(picUrl)}`
  return picUrl                                                  // 其他形态：原样（由调用方兜底）
}
