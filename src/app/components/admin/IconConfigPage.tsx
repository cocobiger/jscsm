import { useState, useEffect, useCallback } from 'react'
import { apiFetch, getApiKey, authFetch } from '../../lib/apiFetch'
import { MAP_ICONS, ICON_MAP, ICON_COLORS, ICON_CATEGORIES } from '../../lib/mapIcons'

const CYAN = '#00aaff'
const GREEN = '#00e676'
const AMBER = '#ffd740'
const RED = '#ff4444'

interface IconCfgItem { icon: string; color: string }
type IconCfg = Record<string, IconCfgItem>

// 固定的点位类型分组（含中文名）
const POINT_TYPES: { key: string; label: string; desc: string }[] = [
  { key: 'station', label: '市监测站', desc: '空气质量监测站（🏠）' },
  { key: 'air', label: '大气监测点', desc: '地图大气点位' },
  { key: 'water', label: '水质监测点', desc: '地图水质点位' },
  { key: 'watermon', label: '流域监测站', desc: '水环境专项视图' },
  { key: 'uav', label: '无人机机场', desc: '气环境专项视图' },
  { key: 'alert', label: '告警点', desc: '地图告警标注' },
  { key: 'camera', label: '摄像头(默认)', desc: '未匹配分组时的摄像头图标' },
]

// 渲染单个图标预览（SVG）
function IconSvg({ iconKey, color, size = 20 }: { iconKey: string; color: string; size?: number }) {
  const icon = ICON_MAP[iconKey] || ICON_MAP['pin']
  return (
    <span style={{ display: 'inline-flex', color }} dangerouslySetInnerHTML={{ __html: `<svg width="${size}" height="${size}" viewBox="0 0 24 24">${icon.svg}</svg>` }} />
  )
}

export function IconConfigPage() {
  const [cfg, setCfg] = useState<IconCfg>({})
  const [groups, setGroups] = useState<string[]>([])  // 视频流分组名
  const [toast, setToast] = useState('')
  const [busy, setBusy] = useState(false)
  const [picker, setPicker] = useState<string | null>(null)  // 正在选图标的 key
  const hasKey = !!getApiKey()

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3000) }

  const load = useCallback(() => {
    authFetch('/api/icon-config').then(r => r.json()).then(d => { if (d && typeof d === 'object') setCfg(d) }).catch(() => {})
    // 视频流分组（去重）
    authFetch('/api/streams').then(r => r.json()).then((s: any[]) => {
      if (Array.isArray(s)) setGroups([...new Set(s.map(x => x.group).filter(Boolean))])
    }).catch(() => {})
  }, [])
  useEffect(() => { load() }, [load])

  const getItem = (key: string): IconCfgItem => cfg[key] || { icon: 'pin', color: '#00b84a' }
  const update = (key: string, patch: Partial<IconCfgItem>) =>
    setCfg(prev => ({ ...prev, [key]: { ...getItem(key), ...patch } }))

  const save = async () => {
    setBusy(true)
    try {
      await apiFetch('/api/icon-config', { method: 'PUT', body: JSON.stringify(cfg) })
      flash('图标配置已保存，地图将在15秒内刷新')
    } catch (e: any) { flash('保存失败: ' + (e.error || e.message)) }
    finally { setBusy(false) }
  }

  const cell: React.CSSProperties = { padding: '10px 12px', borderBottom: '1px solid rgba(0,60,120,0.15)' }
  const head: React.CSSProperties = { color: '#5a8aaa', fontSize: 11, fontWeight: 600, padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid rgba(0,80,150,0.25)' }

  // 一行配置（点位类型或视频流分组）
  const ConfigRow = ({ rowKey, label, desc }: { rowKey: string; label: string; desc: string }) => {
    const item = getItem(rowKey)
    return (
      <tr>
        <td style={cell}>
          <div style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 500 }}>{label}</div>
          <div style={{ color: '#3a5a70', fontSize: 11 }}>{desc}</div>
        </td>
        <td style={cell}>
          <button onClick={() => setPicker(picker === rowKey ? null : rowKey)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px', borderRadius: 4, cursor: 'pointer',
              border: `1px solid ${item.color}55`, background: 'rgba(5,15,35,0.6)' }}>
            <span style={{ width: 30, height: 30, borderRadius: 6, border: `1.5px solid ${item.color}`, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(5,15,35,0.8)' }}>
              <IconSvg iconKey={item.icon} color={item.color} size={18} />
            </span>
            <span style={{ color: '#7ab8e0', fontSize: 12 }}>{ICON_MAP[item.icon]?.label || item.icon}</span>
            <span style={{ color: '#3a5a70', fontSize: 11 }}>▾</span>
          </button>
          {/* 图标选择网格（按分类分组） */}
          {picker === rowKey && (
            <div style={{ marginTop: 8, padding: 10, background: 'rgba(0,20,50,0.6)', border: '1px solid rgba(0,150,220,0.25)', borderRadius: 6, maxWidth: 440 }}>
              {ICON_CATEGORIES.map(catg => {
                const list = MAP_ICONS.filter(ic => ic.cat === catg.key)
                if (!list.length) return null
                return (
                  <div key={catg.key} style={{ marginBottom: 8 }}>
                    <div style={{ color: '#5a8aaa', fontSize: 11, marginBottom: 4 }}>{catg.label}</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 6 }}>
                      {list.map(ic => (
                        <button key={ic.key} title={ic.label} onClick={() => { update(rowKey, { icon: ic.key }) }}
                          style={{ width: 40, height: 40, borderRadius: 5, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                            border: `1px solid ${item.icon === ic.key ? item.color : 'rgba(0,100,180,0.25)'}`,
                            background: item.icon === ic.key ? `${item.color}18` : 'rgba(5,15,35,0.5)' }}>
                          <IconSvg iconKey={ic.key} color={item.icon === ic.key ? item.color : '#7ab8e0'} size={20} />
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </td>
        <td style={cell}>
          <div style={{ display: 'flex', gap: 5 }}>
            {ICON_COLORS.map(c => (
              <button key={c.value} title={c.label} onClick={() => update(rowKey, { color: c.value })}
                style={{ width: 22, height: 22, borderRadius: '50%', cursor: 'pointer', background: c.value,
                  border: item.color === c.value ? '2px solid #fff' : '2px solid transparent',
                  boxShadow: item.color === c.value ? `0 0 8px ${c.value}` : 'none' }} />
            ))}
            <input type="color" value={item.color} onChange={e => update(rowKey, { color: e.target.value })}
              style={{ width: 24, height: 24, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }} title="自定义颜色" />
          </div>
        </td>
        <td style={cell}>
          {/* 实时预览：方框图标 + 名称 */}
          <div style={{ position: 'relative', display: 'inline-block' }}>
            <div style={{ width: 30, height: 30, background: 'rgba(5,15,35,0.78)', border: `1.5px solid ${item.color}`, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 0 10px ${item.color}55` }}>
              <IconSvg iconKey={item.icon} color={item.color} size={18} />
            </div>
          </div>
        </td>
      </tr>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: '20px 24px', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16, flexShrink: 0 }}>
        <div style={{ width: 3, height: 18, background: CYAN, borderRadius: 1, marginRight: 10 }} />
        <span style={{ color: '#c8e6ff', fontSize: 16, fontWeight: 700, letterSpacing: '0.05em' }}>地图图标配置</span>
        <span style={{ color: '#3a5a70', fontSize: 12, marginLeft: 12 }}>自定义各类点位与视频流分组在地图上的图标和颜色</span>
        {!hasKey && <span style={{ marginLeft: 'auto', color: AMBER, fontSize: 12 }}>⚠ 未设置 API Key，无法保存</span>}
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {/* 点位类型 */}
        <div style={{ color: '#7ab8e0', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>点位类型</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 24 }}>
          <thead><tr><th style={head}>类型</th><th style={head}>图标</th><th style={head}>颜色</th><th style={head}>预览</th></tr></thead>
          <tbody>
            {POINT_TYPES.map(t => <ConfigRow key={t.key} rowKey={t.key} label={t.label} desc={t.desc} />)}
          </tbody>
        </table>

        {/* 视频流分组 */}
        <div style={{ color: '#7ab8e0', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
          视频流设备群组 <span style={{ color: '#3a5a70', fontSize: 11, fontWeight: 400 }}>（来自摄像头分组，同组摄像头用同一图标）</span>
        </div>
        {groups.length ? (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={head}>群组</th><th style={head}>图标</th><th style={head}>颜色</th><th style={head}>预览</th></tr></thead>
            <tbody>
              {groups.map(g => <ConfigRow key={g} rowKey={g} label={g} desc="该分组下所有摄像头" />)}
            </tbody>
          </table>
        ) : <div style={{ color: '#3a5a70', fontSize: 12, padding: 20 }}>暂无视频流分组</div>}
      </div>

      <div style={{ flexShrink: 0, paddingTop: 14, borderTop: '1px solid rgba(0,80,150,0.2)', display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={save} disabled={busy} style={{ padding: '8px 22px', fontSize: 13, borderRadius: 3, border: `1px solid ${GREEN}55`, background: `${GREEN}18`, color: GREEN, cursor: busy ? 'wait' : 'pointer' }}>保存配置</button>
        <button onClick={load} style={{ padding: '8px 16px', fontSize: 13, borderRadius: 3, border: '1px solid rgba(0,100,180,0.3)', background: 'transparent', color: '#5a8aaa', cursor: 'pointer' }}>重新加载</button>
        <span style={{ color: '#3a5a70', fontSize: 11, marginLeft: 8 }}>保存后地图标注会按新图标渲染（约15秒内自动刷新，或刷新页面立即生效）</span>
      </div>

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 4000,
          background: '#061530', border: '1px solid rgba(0,150,220,0.4)', borderRadius: 4, padding: '10px 20px',
          color: '#c8e6ff', fontSize: 13, boxShadow: '0 4px 20px rgba(0,0,0,0.5)' }}>{toast}</div>
      )}
    </div>
  )
}
