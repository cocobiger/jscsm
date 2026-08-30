import { useState } from 'react'
import { IconConfigPage } from './IconConfigPage'
import { MapPointManage } from './MapPointManage'
import { MapCoordPage } from './MapCoordPage'
import { BoundaryManagePage } from './BoundaryManagePage'
import { roleAtLeast } from '../../lib/auth'

// ── 地图管理栏目：图标配置 / 点位管理 / 坐标系 / 边界管理 集中入口 ──

const AMBER = '#ffb74d'
const CYAN = '#00aaff'

export function MapCenterPage({ role }: { role: string }) {
  // 各 tab 的权限：与导航一致（operator 可见点位管理，admin 见全部）
  const tabs: { key: string; label: string; icon: string; minRole: 'viewer' | 'operator' | 'admin' }[] = [
    { key: 'icons', label: '地图图标配置', icon: '🗺', minRole: 'admin' },
    { key: 'points', label: '地图点位管理', icon: '📍', minRole: 'operator' },
    { key: 'coord', label: '地图坐标系', icon: '🧭', minRole: 'admin' },
    { key: 'boundary', label: '行政边界管理', icon: '🏘', minRole: 'admin' },
  ]
  const visible = tabs.filter(t => roleAtLeast(role, t.minRole))
  const [active, setActive] = useState(visible[0]?.key || 'points')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 页头 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <div style={{ width: 3, height: 18, background: AMBER, borderRadius: 1 }} />
        <span style={{ color: '#c8e6ff', fontSize: 16, fontWeight: 700 }}>🗺 地图管理</span>
        <span style={{ fontSize: 12, color: '#5a8aaa' }}>
          图标配置 · 点位管理 · 坐标系 · 行政边界
        </span>
      </div>

      {/* Tab 切换 */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {visible.map(t => (
          <button key={t.key} onClick={() => setActive(t.key)} style={{
            padding: '6px 16px', fontSize: 13, borderRadius: 4, cursor: 'pointer', fontWeight: 600,
            border: `1px solid ${active === t.key ? AMBER : 'rgba(255,183,77,0.25)'}`,
            background: active === t.key ? 'rgba(255,183,77,0.15)' : 'transparent',
            color: active === t.key ? AMBER : '#5a8aaa',
          }}>{t.icon} {t.label}</button>
        ))}
      </div>

      {/* 内容区 */}
      <div style={{
        background: 'rgba(4,14,35,0.35)', border: '1px solid rgba(0,80,150,0.15)', borderRadius: 8, padding: 14,
      }}>
        {active === 'icons' && <IconConfigPage />}
        {active === 'points' && <MapPointManage />}
        {active === 'coord' && <MapCoordPage />}
        {active === 'boundary' && <BoundaryManagePage />}
      </div>
    </div>
  )
}
