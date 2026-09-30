/**
 * 司空机场/无人机「在飞 / 待命」状态判定（单一出处，2026-09-16）
 *
 * 为什么单独抽出来：
 *   地图标注（MapView）与设备清单弹窗（SikongDeviceModal）都要判「这架是否在飞」，
 *   原先各自写 `osd.droneInDock === 1 / === 0` 的严格比较；一旦后端字段类型变化
 *   （number ↔ string），两处漂移就会出现「头部角标说在飞 1 架、列表却显示机场内待命」的矛盾。
 *   故统一到这里，前端只此一处判定。
 *
 * 数据来源：机场 OSD（dji-openapi telemetry 的 deviceType=0 帧）的 `droneInDock` 字段。
 *   0 = 无人机不在仓（飞行中）｜1 = 在仓待命｜其它或缺失 = 遥测未推送（未知，不得当作"待命"）
 *
 * 后端聚合口径必须与此一致：见 server/sikong.js 的 flyingCount / dockedCount / osdMissingCount。
 */
export type DroneDockState = 'flying' | 'docked' | 'unknown'

export function droneDockState(osd: Record<string, unknown> | null | undefined): DroneDockState {
  const v = osd ? osd['droneInDock'] : undefined
  if (v === null || v === undefined || v === '') return 'unknown'
  const n = Number(v)
  if (n === 0) return 'flying'
  if (n === 1) return 'docked'
  return 'unknown'
}

export const DOCK_STATE_LABEL: Record<DroneDockState, string> = {
  flying: '飞行中',
  docked: '机场内待命',
  unknown: '遥测待推送',
}
