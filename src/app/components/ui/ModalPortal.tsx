/**
 * ModalPortal —— 所有「全屏浮层」的统一基座（P1 · 2026-10-12）
 *
 * 🔴 为什么必须有它：
 *   `position: fixed` 名义上"相对视口"，但**一旦任意祖先带 `isolation / transform /
 *   filter / will-change / contain:paint`**，它就会被"夹"进祖先的层叠上下文 ——
 *   遮罩压不住同级或外层元素。
 *   本项目原有 9 个弹窗**全部渲染在宿主组件 DOM 内** ⇒ 已经因此出过一次线上问题：
 *   `MapView` 根容器的 `isolation:isolate` 让视频弹窗被左右侧栏盖住（REF §H35.22 / §H35.23）。
 *
 * ⇒ **一律**通过 `ModalPortal` 渲染到 `document.body`，从结构上杜绝这一类问题。
 *   新增弹窗请一律用它；**不要再把弹窗留在业务组件的 DOM 树里**。
 */
import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * z-index 分层（P1 规范）。新代码请用这里的常量，**不要再写裸数字**。
 * ⚠️ 旧组件里既有的 1000/1100/1200/1500/2000/2100/2300/2400/3000 尚未全部收敛，
 *    收敛属于独立一步（需逐组合验证视觉顺序），见排期 P1-3。
 */
export const Z = {
  base: 0,        // 地图 / 内容
  sticky: 10,     // 面板内吸顶
  dropdown: 100,  // 下拉 / 气泡 / 信息窗
  panel: 500,     // 抽屉 / 侧滑
  modal: 1000,    // 普通弹窗
  modalTop: 1100, // 弹窗之上的二级弹窗
  alert: 1200,    // 全局告警 / 无人机浮窗（故意高于普通弹窗）
  toast: 1300,    // Toast（最高）
} as const

/** 全屏浮层的统一行为：**Esc 关闭** + 锁背景滚动（避免"弹窗后面还能滚/点"） */
export function useModalBehavior (onClose?: () => void) {
  useEffect(() => {
    if (!onClose) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])
}

/** 把浮层渲染到 `document.body` —— 彻底摆脱祖先的层叠上下文 */
export function ModalPortal ({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined') return null   // 非浏览器环境兜底
  return createPortal(children, document.body)
}
