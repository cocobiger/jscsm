/**
 * 统计条 KPI 下钻弹窗 · 通用骨架（2026-09-16）
 *
 * 为什么做通用骨架：
 *   统计条 5 个 KPI 都要「点击 → 看构成明细」。若各写一个组件，会出现 5 份重复的
 *   「头部 / 降级条 / 表格 / 脚注 / 关闭」，改一处要改 5 处（SikongDeviceModal 已是第一份）。
 *   故抽成本组件：**列定义与分组由 lib/kpiDrilldown.ts 的描述符提供**，弹窗只负责渲染。
 *
 * 能力（对齐评估阶段的四条硬约束）：
 *   ① 分组展示（解决"水质点位 5 = 流域站 4 + 水质点 1"的异类相加不可解释）
 *   ② 异常置顶 + 「只看异常」筛选（离线摄像头一眼看到）
 *   ③ 降级条（链路不可达时说明"显示的是最后一次数据"，且统计条同时显示「—」而非 0）
 *   ④ 口径脚注（数据源 / 统计规则 / 脱敏说明，逐项写明）
 *   另：行内「地图定位」（spec.locateKeys + onLocate）
 *
 * ⚠️ 安全：URL 等敏感字段由描述符预先脱敏（lib/maskUrl.ts），本组件不做任何凭据处理。
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { KpiSpec, KpiRow } from '../lib/kpiDrilldown'
import { CK, alpha } from '../lib/cockpitTheme'

const mono = { fontFamily: "'JetBrains Mono', monospace" } as const

/** 单元格取色规则（值驱动，避免在描述符里写逻辑） */
function cellColor(value: unknown, row: KpiRow, colColor?: string): string | undefined {
  if (colColor) return colColor
  const s = typeof value === 'string' ? value : ''
  if (row.offline === true && (s === '离线' || s === '停用')) return CK.red
  switch (s) {
    case '离线': return CK.red
    case '在线': return CK.green
    case '无监控': return CK.textDim
    case '未配对': return CK.red
    case '飞行中': return CK.green
    case '机场内待命': return CK.cyan
    case '遥测待推送': return CK.textDim
    case '停用': return CK.red
    case '已启用': return CK.cyan
    default: return undefined
  }
}

const cellText = (v: unknown): string =>
  v === null || v === undefined || v === '' ? '—' : typeof v === 'boolean' ? (v ? '是' : '否') : String(v)

export function KpiDrilldownModal({ spec, degraded, degradedText, headerExtra, onLocate, onClose, footerExtra }: {
  spec: KpiSpec
  degraded?: boolean
  degradedText?: string
  headerExtra?: ReactNode
  onLocate?: (row: KpiRow, label: string) => void
  onClose: () => void
  footerExtra?: ReactNode
}) {
  const [onlyOffline, setOnlyOffline] = useState(false)
  const offlineKey = spec.offlineKey
  const countOffline = (rows: KpiRow[]) => (offlineKey ? rows.filter(r => r[offlineKey] === true).length : 0)
  const totalRows = spec.groups.reduce((n, g) => n + g.rows.length, 0)
  const totalOffline = spec.groups.reduce((n, g) => n + countOffline(g.rows), 0)
  const showFilter = !!offlineKey && totalOffline > 0
  const multiGroup = spec.groups.length > 1

  // 异常置顶 + 筛选（保持组内稳定顺序）
  const prepared = spec.groups.map(g => {
    let rows = [...g.rows]
    if (offlineKey) rows.sort((a, b) => Number(b[offlineKey] === true) - Number(a[offlineKey] === true))
    if (onlyOffline && offlineKey) rows = rows.filter(r => r[offlineKey] === true)
    return { ...g, rows }
  }).filter(g => g.rows.length > 0)

  const th = (label: string, width?: number) => (
    <th key={label} style={{
      padding: '6px 9px', borderBottom: `1px solid ${CK.borderSoft}`, fontWeight: 600,
      whiteSpace: 'nowrap', color: '#8fc6ea', width,
    }}>{label}</th>
  )

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 3000,
        background: 'rgba(2,8,20,0.66)', backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(1120px, 95vw)', maxHeight: '86vh', overflow: 'auto',
          background: 'linear-gradient(165deg, rgba(10,26,56,0.97), rgba(5,13,30,0.94))',
          border: `1px solid ${CK.border}`, borderRadius: 8,
          boxShadow: '0 18px 60px rgba(0,0,0,0.65)',
        }}
      >
        {/* 头部 */}
        <div style={{
          position: 'sticky', top: 0, zIndex: 2,
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          padding: '13px 18px', borderBottom: `1px solid ${CK.borderSoft}`,
          background: 'linear-gradient(180deg, rgba(10,26,56,0.98), rgba(10,26,56,0.88))',
        }}>
          <span style={{ color: CK.textMain, fontSize: 15, fontWeight: 700 }}>{spec.title}</span>
          {spec.subtitle && (
            <span style={{ ...mono, color: CK.purple, fontSize: 14, fontWeight: 700 }}>{spec.subtitle}</span>
          )}
          {showFilter && (
            <button
              data-kpi-filter="offline"
              onClick={() => setOnlyOffline(v => !v)}
              style={{
                cursor: 'pointer', fontSize: 11.5, padding: '2px 9px', borderRadius: 10,
                background: alpha(onlyOffline ? CK.red : CK.amber, onlyOffline ? 0.16 : 0.09),
                border: `1px solid ${alpha(onlyOffline ? CK.red : CK.amber, 0.45)}`,
                color: onlyOffline ? '#ff8a80' : '#ffd180', ...mono,
              }}
            >{onlyOffline ? `只看异常（${totalOffline}）` : `只看异常`}</button>
          )}
          {headerExtra}
          <button
            onClick={onClose}
            style={{
              marginLeft: 'auto', cursor: 'pointer', fontSize: 12,
              color: CK.textSub, background: 'transparent',
              border: `1px solid ${alpha(CK.cyan, 0.3)}`, borderRadius: 4, padding: '3px 12px',
            }}
          >关闭</button>
        </div>

        {/* 降级条 */}
        {degraded && (
          <div style={{
            margin: '12px 18px 0', padding: '9px 13px',
            background: alpha(CK.amber, 0.1), border: `1px solid ${alpha(CK.amber, 0.42)}`,
            borderRadius: 5, color: '#ffd180', fontSize: 12.5,
          }}>
            {degradedText || '数据源当前不可达 —— 下面显示的是最后一次成功同步的内容；统计条同时显示「—」而非 0，避免误读为"设备全部离线"。'}
          </div>
        )}

        {/* 明细 */}
        <div style={{ padding: '14px 18px 4px' }}>
          {prepared.map(g => (
            <div key={g.name} style={{ marginBottom: multiGroup ? 16 : 0 }}>
              {(multiGroup || g.note) && (
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: '2px 0 6px', flexWrap: 'wrap' }}>
                  {multiGroup && (
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: g.color || CK.textMain }}>{g.name}</span>
                  )}
                  {g.note && <span style={{ fontSize: 11.5, color: CK.textDim }}>{g.note}</span>}
                </div>
              )}
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead>
                  <tr>{spec.columns.map(c => th(c.label, c.width))}{onLocate && spec.locateKeys ? th('') : null}</tr>
                </thead>
                <tbody>
                  {g.rows.map((row, i) => {
                    const canLocate = !!(onLocate && spec.locateKeys
                      && typeof row[spec.locateKeys.lat] === 'number'
                      && typeof row[spec.locateKeys.lon] === 'number')
                    return (
                      <tr key={String(row.id ?? row.deviceSn ?? i)} style={{ color: CK.textMain }}>
                        {spec.columns.map(c => (
                          <td key={c.key} style={{
                            padding: '7px 9px', borderBottom: `1px solid ${alpha(CK.cyan, 0.08)}`,
                            whiteSpace: 'nowrap', wordBreak: 'keep-all',
                            color: cellColor(row[c.key], row, c.color),
                            ...(c.mono ? { ...mono, fontSize: 11.5 } : {}),
                          }}>{cellText(row[c.key])}</td>
                        ))}
                        {onLocate && spec.locateKeys ? (
                          <td style={{ padding: '7px 9px', borderBottom: `1px solid ${alpha(CK.cyan, 0.08)}`, textAlign: 'right' }}>
                            {canLocate && (
                              <button
                                data-kpi-locate="1"
                                onClick={() => onLocate(row, String(row[spec.locateKeys!.name] ?? ''))}
                                style={{
                                  cursor: 'pointer', fontSize: 11, padding: '2px 8px', borderRadius: 3,
                                  background: alpha(CK.cyan, 0.1), border: `1px solid ${alpha(CK.cyan, 0.35)}`,
                                  color: CK.cyanSoft,
                                }}
                              >地图定位</button>
                            )}
                          </td>
                        ) : null}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ))}
          {prepared.length === 0 && (
            <div style={{ padding: '26px 9px', textAlign: 'center', color: CK.textDim, fontSize: 13 }}>
              {onlyOffline
                ? '当前没有异常项（可点「只看异常」取消筛选）'
                : (degraded ? '数据源不可达，且暂无历史数据' : '暂无数据')}
            </div>
          )}
          {prepared.length === 0 && totalRows > 0 && !onlyOffline && (
            <div style={{ color: CK.textDim, fontSize: 12, textAlign: 'center' }}>共 {totalRows} 行</div>
          )}
        </div>

        {/* 脚注（口径说明） */}
        <div style={{
          padding: '10px 18px 14px', color: CK.textDim, fontSize: 11.5, lineHeight: 1.75,
          borderTop: `1px dashed ${CK.borderSoft}`, marginTop: 8,
        }}>
          <span dangerouslySetInnerHTML={{ __html: spec.footnote }} />
          {footerExtra}
        </div>
      </div>
    </div>
  )
}
