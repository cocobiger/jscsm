// 证据图片 URL 统一解析（2026-09-14 修复：秸秆告警证据图空块 + 通道 null 的图片侧根因）
//
// 背景：picUrl 有两种形态——
//   ① straw-engine 源：站内相对路径 /api/evidence/<日期>/xxx.jpg（后端免登录静态路由，直连 200）
//   ② iotcloud/NVR 源：外链 http(s)（如 6882 认证网关 / 5001 抓图），需走 /api/iot-image 代理
// 此前多处 UI 无脑拼 /api/iot-image?url=<相对路径> → 代理 400 → <img> onError 被隐藏 → 空蓝块。
// AlertThumbnail 内部 9/3 已有同类防御（解码还原直链），但仅限自身；本函数供其余裸 <img> 场景统一使用。
//
// 2026-09-20 补强（存档页「看不到图」根治）：本函数同时**幂等消化「已被包装成代理」的输入**。
//   后端 iot-fetcher/index.js 旧版会无条件拼 `/api/iot-image?url=`，对相对路径必然 400。
//   后端已改为只代理绝对 http(s)，但前端仍保留这层兜底——万一拿到历史/其他来源的已包装数据，
//   或是接口缓存尚未刷新，也不会再渲染成空蓝块。
export function evidenceImgUrl(picUrl: string | null | undefined): string | null {
  if (!picUrl) return null

  // ③ 输入已是 /api/iot-image?url=<内层>：若内层是站内相对路径 → 解回直链（幂等）；
  //    若内层是绝对 http(s) → 本身用法正确，原样返回。
  const m = /^\/api\/iot-image\?url=([^&]+)/.exec(picUrl)
  if (m) {
    let inner = m[1]
    try { inner = decodeURIComponent(m[1]) } catch { /* 非法编码：保留原文 */ }
    if (inner.startsWith('/')) return inner
    return picUrl
  }

  if (picUrl.startsWith('/')) return picUrl                     // 站内路径：直连
  if (/^https?:\/\//i.test(picUrl)) return `/api/iot-image?url=${encodeURIComponent(picUrl)}`
  return picUrl                                                  // 其他形态：原样（由调用方兜底）
}
