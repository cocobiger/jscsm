import { useEffect, useState } from 'react'
import { authFetch } from '../../lib/apiFetch'

const CYAN = '#00aaff'
const GREEN = '#00e676'
const RED = '#ff4444'
const AMBER = '#ffd740'

type CoordSystem = 'gcj02' | 'wgs84'

const OPTIONS: { value: CoordSystem; label: string; desc: string }[] = [
  { value: 'gcj02', label: 'GCJ-02（火星坐标）', desc: '高德/腾讯等地图拾取的坐标（历史点位录入格式）' },
  { value: 'wgs84', label: 'WGS-84（GPS/天地图）', desc: '原始 GPS 坐标，与当前天地图底图一致' },
]

/** 地图坐标系设置：点位源坐标系 → 底图(WGS-84) 的统一转换开关 */
export function MapCoordPage() {
  const [system, setSystem] = useState<CoordSystem>('gcj02')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    authFetch('/api/map-coord-system')
      .then(r => r.json())
      .then(d => {
        if (d && (d.system === 'gcj02' || d.system === 'wgs84')) {
          setSystem(d.system)
          setLoaded(true)
        }
      })
      .catch(() => { setLoaded(true) })
  }, [])

  const save = async () => {
    setSaving(true)
    setMsg(null)
    try {
      const r = await authFetch('/api/map-coord-system', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system }),
      })
      const d = await r.json()
      if (d && d.ok) setMsg({ ok: true, text: '已保存，驾驶舱地图点位将按新坐标系重算（页面刷新后生效）' })
      else setMsg({ ok: false, text: d?.error || '保存失败' })
    } catch (e: any) {
      setMsg({ ok: false, text: e?.error || '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: '#c8e6ff', marginBottom: 4 }}>
        🧭 地图坐标系
      </div>
      <div style={{ color: '#5a8aaa', fontSize: 12, marginBottom: 20 }}>
        底图为天地图（WGS-84 瓦片）；历史点位为高德时代录入的 GCJ-02 加密坐标，直接显示会整体偏移数百米。
        此处选择<strong style={{ color: '#9ad6f0' }}>点位数据的源坐标系</strong>，系统会自动转换为 WGS-84 显示。
      </div>

      <div style={{
        background: 'linear-gradient(160deg, rgba(10,26,56,0.6), rgba(5,13,30,0.5))',
        border: '1px solid rgba(0,180,255,0.3)', borderRadius: 6, padding: 18,
      }}>
        <div style={{ color: '#8fc6ea', fontSize: 12, marginBottom: 12, letterSpacing: '0.08em' }}>
          点位源坐标系
          {!loaded && <span style={{ color: '#3a5a70', marginLeft: 8 }}>读取中…</span>}
        </div>

        {OPTIONS.map(opt => {
          const active = system === opt.value
          return (
            <label
              key={opt.value}
              onClick={() => setSystem(opt.value)}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 10,
                padding: '11px 14px', marginBottom: 8, cursor: 'pointer',
                borderRadius: 4,
                border: `1px solid ${active ? 'rgba(0,200,255,0.6)' : 'rgba(0,150,220,0.18)'}`,
                background: active ? 'rgba(0,170,255,0.1)' : 'rgba(2,10,28,0.5)',
                transition: 'all 0.15s',
              }}
            >
              <div style={{
                width: 14, height: 14, borderRadius: '50%', flexShrink: 0, marginTop: 2,
                border: `2px solid ${active ? CYAN : '#3a5a70'}`,
                boxShadow: active ? `0 0 8px ${CYAN}88, inset 0 0 0 3px #04122a` : 'none',
                background: active ? CYAN : 'transparent',
              }} />
              <div>
                <div style={{ color: active ? '#c8e6ff' : '#7ab8e0', fontSize: 13, fontWeight: active ? 600 : 400 }}>
                  {opt.label}
                  {opt.value === 'gcj02' && <span style={{ marginLeft: 8, padding: '1px 6px', fontSize: 10, borderRadius: 2, background: `${AMBER}18`, border: `1px solid ${AMBER}44`, color: AMBER }}>当前默认</span>}
                </div>
                <div style={{ color: '#3a5a70', fontSize: 11, marginTop: 2 }}>{opt.desc}</div>
              </div>
            </label>
          )
        })}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
          <button
            onClick={save}
            disabled={saving}
            style={{
              padding: '8px 22px', fontSize: 13, borderRadius: 3, cursor: 'pointer',
              border: `1px solid ${CYAN}55`, background: `${CYAN}18`, color: CYAN,
              fontWeight: 600,
            }}
          >
            {saving ? '保存中…' : '保存设置'}
          </button>
          {msg && (
            <span style={{ color: msg.ok ? GREEN : RED, fontSize: 12 }}>{msg.ok ? '✓ ' : '✗ '}{msg.text}</span>
          )}
        </div>
      </div>

      <div style={{
        marginTop: 16, padding: '10px 14px', borderRadius: 4,
        border: '1px solid rgba(255,215,64,0.25)', background: 'rgba(255,215,64,0.05)',
        color: '#8a7a3a', fontSize: 11, lineHeight: 1.7,
      }}>
        💡 说明：切换只影响地图展示（输出层转换），<strong>不修改数据库中的原始坐标</strong>，可随时切回。
        若切换后点位仍与底图地物错位，多为点位录入时本身不精确（非坐标系问题），可在「地图点位管理」中逐个修正。
        告警联动按名称匹配为主，坐标转换不影响联动逻辑。
      </div>
    </div>
  )
}
