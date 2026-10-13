import { useState } from 'react'
import { MapCenterPage } from './MapCenterPage'
import { GovDataPage } from './GovDataPage'
import { TimeServerPanel } from './TimeServerPanel'
import { roleAtLeast, type Role } from '../../lib/auth'

// ── 系统设置：地图管理 + 政务数据导入 + 时间服务器 集中入口 ──

const CYAN = '#00aaff'
const AMBER = '#ffb74d'
const PURPLE = '#b388ff'

export function SystemSettingsPage({ role }: { role: Role }) {
  const [subTab, setSubTab] = useState<'map' | 'govdata' | 'time'>('map')
  const isAdmin = roleAtLeast(role, 'admin')

  // 子 Tab 定义（「时间服务器」对全体登录用户可见：只读状态；**编辑区**仅 admin 可见）
  const tabs: { key: 'map' | 'govdata' | 'time'; label: string; color: string; show: boolean }[] = [
    { key: 'map', label: '🗺 地图管理', color: AMBER, show: true },
    { key: 'govdata', label: '📊 政务数据导入', color: CYAN, show: isAdmin },
    { key: 'time', label: '🕐 时间服务器', color: PURPLE, show: true },
  ]

  return (
    <div style={{ padding: '16px 20px', overflowY: 'auto', height: '100%', scrollbarWidth: 'none' }}>
      {/* 子 Tab：地图管理 / 政务数据导入（仅 admin） / 时间服务器（只读；编辑区仅 admin） */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid rgba(0,80,150,0.2)' }}>
        {tabs.filter(t => t.show).map(t => (
          <button key={t.key} onClick={() => setSubTab(t.key)} style={{
            padding: '7px 18px', fontSize: 13, borderRadius: '4px 4px 0 0', cursor: 'pointer',
            border: `1px solid ${subTab === t.key ? t.color : 'transparent'}`, borderBottom: 'none',
            background: subTab === t.key ? `${t.color}1a` : 'transparent',
            color: subTab === t.key ? t.color : '#5a8aaa',
          }}>{t.label}</button>
        ))}
      </div>

      {subTab === 'map' && <MapCenterPage role={role} />}
      {subTab === 'govdata' && <GovDataPage />}
      {subTab === 'time' && <TimeServerPanel role={role} />}
    </div>
  )
}
