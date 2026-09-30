import { useState } from 'react'
import { MapCenterPage } from './MapCenterPage'
import { GovDataPage } from './GovDataPage'
import { roleAtLeast, type Role } from '../../lib/auth'

// ── 系统设置：地图管理 + 政务数据导入 集中入口 ──

const CYAN = '#00aaff'
const AMBER = '#ffb74d'

export function SystemSettingsPage({ role }: { role: Role }) {
  const [subTab, setSubTab] = useState<'map' | 'govdata'>('map')
  const isAdmin = roleAtLeast(role, 'admin')

  return (
    <div style={{ padding: '16px 20px', overflowY: 'auto', height: '100%', scrollbarWidth: 'none' }}>
      {/* 子 Tab：地图管理 / 政务数据导入（后者仅 admin） */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid rgba(0,80,150,0.2)' }}>
        <button onClick={() => setSubTab('map')} style={{
          padding: '7px 18px', fontSize: 13, borderRadius: '4px 4px 0 0', cursor: 'pointer',
          border: `1px solid ${subTab === 'map' ? AMBER : 'transparent'}`, borderBottom: 'none',
          background: subTab === 'map' ? 'rgba(255,183,77,0.10)' : 'transparent',
          color: subTab === 'map' ? AMBER : '#5a8aaa',
        }}>🗺 地图管理</button>
        {isAdmin && (
          <button onClick={() => setSubTab('govdata')} style={{
            padding: '7px 18px', fontSize: 13, borderRadius: '4px 4px 0 0', cursor: 'pointer',
            border: `1px solid ${subTab === 'govdata' ? CYAN : 'transparent'}`, borderBottom: 'none',
            background: subTab === 'govdata' ? 'rgba(0,170,255,0.10)' : 'transparent',
            color: subTab === 'govdata' ? CYAN : '#5a8aaa',
          }}>📊 政务数据导入</button>
        )}
      </div>

      {subTab === 'map' ? <MapCenterPage role={role} /> : <GovDataPage />}
    </div>
  )
}
