/**
 * 司空2 设备清单下钻弹窗（2026-09-16 迁移到通用骨架）
 *
 * 用途：点击统计条「无人机」展开司空设备台账 —— 机场 / 配对无人机 / 机型 / SN / 实时遥测。
 * 为什么需要：KPI 只给一个数字，运维核对（哪台机场掉线、哪架飞机没配对、电量多少）要能一步看到明细。
 *
 * 架构（2026-09-16 调整）：表格/头部/降级条/脚注统一走 components/KpiDrilldownModal.tsx 通用骨架，
 *   本文件只做两件专属的事：① 用 lib/kpiDrilldown.specSikongDevices 描述列与口径
 *   ② 提供头部副指标角标 FlyingBadge（在飞 N 架）。这样 5 个 KPI 的下钻只维护一套骨架。
 *
 * 数据源：useDashboard() 的 sikongDevices（DashboardContext 全局单例 15s 轮询 /api/sikong/devices）。
 *   ⚠️ 数组每项是「机场(dock)」，无人机在其 drone 字段里 —— 不是无人机列表。
 * 降级：available=false（司空链路不可达且超 5min 宽限）时顶部显式告警，避免把"未知"读成"0 架"。
 */
import { useMemo } from 'react'
import type { SikongDevice } from '../lib/api-types'
import { specSikongDevices } from '../lib/kpiDrilldown'
import { droneDockState, DOCK_STATE_LABEL } from '../lib/sikongStatus'
import { KpiDrilldownModal } from './KpiDrilldownModal'
import { CK, alpha } from '../lib/cockpitTheme'

const mono = { fontFamily: "'JetBrains Mono', monospace" } as const

export function SikongDeviceModal({ devices, available, flyingCount, dockedCount, osdMissingCount, onLocate, onClose }: {
  devices: SikongDevice[]
  available: boolean
  /** 副指标：在飞 / 待命 / 遥测未推送。⚠️ 由后端与 Context 统一口径（lib/sikongStatus.ts），
   *  本组件不再自行统计，避免"头部角标说在飞、列表却显示待命"的矛盾。 */
  flyingCount: number
  dockedCount: number
  osdMissingCount: number
  /** KPI 行内「地图定位」（可选） */
  onLocate?: (id: string, name: string, lon: number, lat: number) => void
  onClose: () => void
}) {
  const spec = useMemo(
    () => specSikongDevices(devices, osd => DOCK_STATE_LABEL[droneDockState(osd)]),
    [devices])

  return (
    <KpiDrilldownModal
      spec={spec}
      degraded={!available}
      degradedText="司空链路不可达（dji-openapi:17810）—— 下面显示的是最后一次成功同步的台账；统计条同时显示「—」而非 0，避免误读为「设备全部离线」。"
      headerExtra={<FlyingBadge flying={flyingCount} docked={dockedCount} unknown={osdMissingCount} />}
      onLocate={onLocate
        ? (row, name) => onLocate(String(row.dockSn), name, Number(row.__lon), Number(row.__lat))
        : undefined}
      onClose={onClose}
    />
  )
}

/** 弹窗头部副指标角标：在飞 / 待命 / 遥测未推送
 *  - 在飞 > 0：绿色 + 呼吸点（醒目，提示"此刻有任务在飞"）
 *  - 在飞 = 0：灰蓝静默展示（不隐藏——否则用户无法区分"0 架在飞"与"没做这个指标"）
 *  - 遥测未推送 > 0：琥珀色提示（不得把"未知"算进"待命"） */
export function FlyingBadge({ flying, docked, unknown }: { flying: number; docked: number; unknown: number }) {
  const active = flying > 0
  const color = active ? CK.green : CK.textDim
  return (
    <>
      <style>{`@keyframes sk-fly-pulse{0%,100%{opacity:1;box-shadow:0 0 6px currentColor}50%{opacity:.35;box-shadow:0 0 2px currentColor}}`}</style>
      <span
        data-sikong-flying={flying}
        title={`在飞 ${flying} 架 · 机场内待命 ${docked} 架${unknown > 0 ? ` · 遥测未推送 ${unknown} 座` : ''}`}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '2px 9px', borderRadius: 10,
          background: alpha(active ? CK.green : CK.cyan, active ? 0.14 : 0.07),
          border: `1px solid ${alpha(active ? CK.green : CK.cyan, active ? 0.45 : 0.2)}`,
          fontSize: 12, fontWeight: 700, ...mono, color,
        }}
      >
        <span style={{
          width: 6, height: 6, borderRadius: '50%', background: color, color,
          animation: active ? 'sk-fly-pulse 1.6s ease-in-out infinite' : undefined,
        }} />
        在飞 {flying} 架
      </span>
      {unknown > 0 && (
        <span
          title={`${unknown} 座机场的 OSD 遥测未推送，"在飞/待命"状态未知（未计入待命）`}
          style={{
            padding: '2px 8px', borderRadius: 10, fontSize: 11.5,
            background: alpha(CK.amber, 0.1), border: `1px solid ${alpha(CK.amber, 0.38)}`,
            color: '#ffd180', ...mono,
          }}
        >遥测未推送 {unknown}</span>
      )}
    </>
  )
}
