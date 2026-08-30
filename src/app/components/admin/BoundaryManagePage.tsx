import { useState, useEffect, useCallback, useRef } from 'react'
import { authFetch } from '../../lib/apiFetch'

// ── 行政边界管理（P1：导入/导出/回滚；P2 地图编辑预留）──
// 行政区域调整后，后台导入官方新边界 GeoJSON，热生效（无需重启后端）

const CYAN = '#00aaff'
const GREEN = '#4ade80'
const RED = '#ff4444'
const AMBER = '#ffb74d'
const ORANGE = '#ff7043'

const card: React.CSSProperties = {
  background: 'rgba(4,14,35,0.7)',
  border: '1px solid rgba(0,80,150,0.25)',
  borderRadius: 8,
  padding: '14px 16px',
}

interface BoundaryRow { town: string; division_code: string; ring: string; source: string; updated_at: string }
interface Snapshot { id: number; note: string; created_at: string; bytes: number }

export function BoundaryManagePage() {
  const [rows, setRows] = useState<BoundaryRow[]>([])
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [geojson, setGeojson] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'import' | 'map'>('import')

  const load = useCallback(() => {
    authFetch('/api/straw/boundary').then(r => r.json()).then(d => {
      if (d && Array.isArray(d.rows)) setRows(d.rows)
    }).catch(() => {})
    authFetch('/api/straw/boundary/snapshots').then(r => r.json()).then(d => {
      if (Array.isArray(d)) setSnapshots(d)
    }).catch(() => {})
  }, [])

  useEffect(() => { load() }, [load])

  const handleFile = (f: File) => {
    const reader = new FileReader()
    reader.onload = () => setGeojson(String(reader.result || ''))
    reader.readAsText(f)
  }

  const doImport = async () => {
    if (!geojson.trim()) { setMsg('请粘贴或选择 GeoJSON 文件'); return }
    setBusy(true)
    setMsg('')
    try {
      const r = await authFetch('/api/straw/boundary/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ geojson, note: '后台手动导入' }),
      })
      const d = await r.json()
      if (d.ok) {
        setMsg(`✓ 导入成功：${d.imported} 个乡镇（原 ${d.prevCount} → 新 ${d.nowCount}），已热生效`)
        setGeojson('')
        load()
      } else {
        setMsg('导入失败: ' + (d.error || r.status))
      }
    } catch (e: any) {
      setMsg('导入失败: ' + (e?.message || e))
    }
    setBusy(false)
  }

  const doExport = async () => {
    try {
      const r = await authFetch('/api/straw/boundary/export')
      const data = await r.json()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `wanzhou_towns_${new Date().toISOString().slice(0, 10)}.geojson`
      a.click()
      URL.revokeObjectURL(a.href)
    } catch {}
  }

  const doRestore = async (id: number) => {
    if (!confirm(`回滚到快照 #${id}？当前边界将被替换（会自动再备份一次）。`)) return
    setBusy(true)
    try {
      const r = await authFetch(`/api/straw/boundary/restore/${id}`, { method: 'POST' })
      const d = await r.json()
      setMsg(d.ok ? `✓ 已回滚到快照 #${id}（${d.restored} 个乡镇）` : '回滚失败: ' + (d.error || ''))
      load()
    } catch (e: any) { setMsg('回滚失败: ' + (e?.message || e)) }
    setBusy(false)
    setTimeout(() => setMsg(''), 5000)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 页头 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <div style={{ width: 3, height: 18, background: AMBER, borderRadius: 1 }} />
        <span style={{ color: '#c8e6ff', fontSize: 16, fontWeight: 700 }}>行政边界管理</span>
        <span style={{ fontSize: 12, color: '#5a8aaa' }}>
          行政区划调整后导入官方 GeoJSON · 热生效（无需重启）· 版本可回滚
        </span>
        <button onClick={load} style={{
          marginLeft: 'auto', padding: '4px 14px', fontSize: 12, borderRadius: 3, cursor: 'pointer',
          border: '1px solid rgba(0,150,220,0.3)', background: 'rgba(0,80,180,0.12)', color: '#7ab8e0',
        }}>刷新</button>
      </div>

      {/* Tab 切换 */}
      <div style={{ display: 'flex', gap: 6 }}>
        {([
          ['import', '📤 导入 / 导出 / 回滚'],
          ['map', '🗺 地图编辑'],
        ] as const).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} style={{
            padding: '6px 18px', fontSize: 13, borderRadius: 4, cursor: 'pointer', fontWeight: 600,
            border: `1px solid ${tab === key ? AMBER : 'rgba(255,183,77,0.25)'}`,
            background: tab === key ? 'rgba(255,183,77,0.15)' : 'transparent',
            color: tab === key ? AMBER : '#5a8aaa',
          }}>{label}</button>
        ))}
      </div>

      {tab === 'import' ? (
        <>
      {/* 统计卡 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        <div style={{ ...card }}>
          <div style={{ fontSize: 12, color: '#5a8aaa' }}>乡镇/街道数</div>
          <div style={{ color: '#c8e6ff', fontSize: 20, fontWeight: 700 }}>{rows.length}</div>
        </div>
        <div style={{ ...card }}>
          <div style={{ fontSize: 12, color: '#5a8aaa' }}>边界来源</div>
          <div style={{ color: rows.some(r => r.source === 'manual') ? GREEN : CYAN, fontSize: 20, fontWeight: 700 }}>
            {rows.some(r => r.source === 'manual') ? '含手工修订' : '官方导入'}
          </div>
        </div>
        <div style={{ ...card }}>
          <div style={{ fontSize: 12, color: '#5a8aaa' }}>版本快照数</div>
          <div style={{ color: AMBER, fontSize: 20, fontWeight: 700 }}>{snapshots.length}</div>
        </div>
      </div>

      {/* 导入区 */}
      <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: '#7ab8e0', fontSize: 13, fontWeight: 700 }}>📤 导入新边界 GeoJSON</span>
          <label style={{
            padding: '4px 12px', fontSize: 12, borderRadius: 3, cursor: 'pointer',
            border: '1px solid rgba(0,150,220,0.3)', background: 'rgba(0,80,180,0.12)', color: '#7ab8e0',
          }}>
            选择文件
            <input type="file" accept=".geojson,.json" style={{ display: 'none' }}
              onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])} />
          </label>
        </div>
        <textarea
          value={geojson}
          onChange={e => setGeojson(e.target.value)}
          placeholder='粘贴 GeoJSON（FeatureCollection，含 properties.name 与 Polygon geometry）…'
          rows={6}
          style={{
            width: '100%', boxSizing: 'border-box', resize: 'vertical',
            background: 'rgba(0,20,60,0.6)', color: '#c8e6ff',
            border: '1px solid rgba(0,150,220,0.3)', borderRadius: 4,
            padding: '10px', fontSize: 11, fontFamily: "'JetBrains Mono', monospace",
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={doImport} disabled={busy} style={{
            padding: '6px 18px', fontSize: 12, fontWeight: 700, cursor: busy ? 'wait' : 'pointer', borderRadius: 4,
            border: 'none', color: '#fff', background: busy ? '#3a5a70' : 'linear-gradient(90deg, #0080d0, #00aaff)',
          }}>{busy ? '导入中…' : '校验并导入'}</button>
          <button onClick={doExport} style={{
            padding: '6px 14px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
            border: '1px solid rgba(74,222,128,0.4)', background: 'rgba(74,222,128,0.1)', color: GREEN,
          }}>📤 导出当前边界</button>
          {msg && <span style={{ fontSize: 12, color: msg.startsWith('✓') ? GREEN : RED }}>{msg}</span>}
        </div>
      </div>

      {/* 边界列表 */}
      <div style={{ overflowX: 'auto', ...card, padding: 0 }}>
        <div style={{ padding: '10px 16px', color: '#7ab8e0', fontSize: 13, fontWeight: 700, borderBottom: '1px solid rgba(0,80,150,0.15)' }}>
          当前边界（{rows.length} 个乡镇/街道）
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'rgba(4,14,35,0.98)', borderBottom: '1px solid rgba(0,80,150,0.2)' }}>
              {['乡镇/街道', '区划代码', '顶点数', '来源', '更新时间'].map(h => (
                <th key={h} style={{ padding: '8px 10px', textAlign: 'left', color: '#5a8aaa', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.town} style={{ borderBottom: '1px solid rgba(0,50,100,0.15)', background: i % 2 ? 'rgba(0,20,50,0.2)' : 'transparent' }}>
                <td style={{ padding: '6px 10px', color: '#c8e6ff', fontWeight: 600 }}>{r.town}</td>
                <td style={{ padding: '6px 10px', color: '#5a8aaa', fontFamily: "'JetBrains Mono',monospace", fontSize: 11 }}>{r.division_code || '—'}</td>
                <td style={{ padding: '6px 10px', color: '#7ab8e0', fontFamily: "'JetBrains Mono',monospace", fontSize: 11 }}>
                  {(() => { try { return JSON.parse(r.ring).length } catch { return 0 } })()}
                </td>
                <td style={{ padding: '6px 10px' }}>
                  <span style={{
                    padding: '1px 8px', borderRadius: 2, fontSize: 10,
                    background: r.source === 'manual' ? 'rgba(74,222,128,0.15)' : 'rgba(0,150,220,0.12)',
                    border: `1px solid ${r.source === 'manual' ? '#4ade80' : CYAN}40`,
                    color: r.source === 'manual' ? GREEN : CYAN,
                  }}>{r.source === 'manual' ? '手工修订' : '官方导入'}</span>
                </td>
                <td style={{ padding: '6px 10px', color: '#5a8aaa', fontSize: 11 }}>{r.updated_at?.replace('T', ' ').slice(5, 16) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 版本快照 */}
      <div style={{ ...card, padding: 0 }}>
        <div style={{ padding: '10px 16px', color: '#ffb74d', fontSize: 13, fontWeight: 700, borderBottom: '1px solid rgba(0,80,150,0.15)' }}>
          ⏮ 版本快照（每次导入/回滚前自动备份，可一键回退）
        </div>
        {snapshots.length === 0 ? (
          <div style={{ padding: '16px', color: '#3a5a70', fontSize: 12 }}>暂无快照</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'rgba(4,14,35,0.98)', borderBottom: '1px solid rgba(0,80,150,0.2)' }}>
                {['#', '说明', '备份时间', '数据量', '操作'].map(h => (
                  <th key={h} style={{ padding: '8px 10px', textAlign: 'left', color: '#5a8aaa', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {snapshots.map((s, i) => (
                <tr key={s.id} style={{ borderBottom: '1px solid rgba(0,50,100,0.15)', background: i % 2 ? 'rgba(0,20,50,0.2)' : 'transparent' }}>
                  <td style={{ padding: '6px 10px', color: '#5a8aaa', fontFamily: "'JetBrains Mono',monospace" }}>{s.id}</td>
                  <td style={{ padding: '6px 10px', color: '#c8e6ff' }}>{s.note}</td>
                  <td style={{ padding: '6px 10px', color: '#5a8aaa', fontSize: 11 }}>{s.created_at?.replace('T', ' ').slice(0, 19) || '—'}</td>
                  <td style={{ padding: '6px 10px', color: '#7ab8e0', fontFamily: "'JetBrains Mono',monospace", fontSize: 11 }}>{Math.round(s.bytes / 1024)}KB</td>
                  <td style={{ padding: '6px 10px' }}>
                    <button onClick={() => doRestore(s.id)} disabled={busy} style={{
                      padding: '2px 10px', fontSize: 11, cursor: busy ? 'wait' : 'pointer', borderRadius: 3,
                      border: '1px solid rgba(255,170,60,0.4)', background: 'rgba(255,170,60,0.1)', color: AMBER,
                    }}>回滚</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ fontSize: 11, color: '#3a5a70', lineHeight: 1.8 }}>
        <b style={{ color: '#5a8aaa' }}>说明</b>：边界数据用于告警坐标的乡镇归属判定（Point-in-Polygon 反查）。行政区域调整后，将官方新边界（GeoJSON，properties.name=乡镇名，Polygon 几何）导入即可热生效；
        导入前自动备份当前版本，可随时回滚。
      </div>
        </>
      ) : (
        <BoundaryMapEditor onChanged={load} />
      )}
    </div>
  )
}

// ═══════════════ P2 地图编辑 ═══════════════

// ═══════════════ P2 地图编辑（自实现顶点拖拽，不依赖旧插件）═══════════════

function loadScript(src: string, ready: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ready()) return resolve()
    const s = document.createElement('script')
    s.src = src
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('脚本加载失败: ' + src))
    document.head.appendChild(s)
  })
}

const vertexIcon = () => (window as any).L.divIcon({
  className: '',
  html: '<div style="width:11px;height:11px;border-radius:50%;background:#ff7043;border:2px solid #fff;box-shadow:0 0 5px rgba(0,0,0,.7);cursor:grab;"></div>',
  iconSize: [11, 11], iconAnchor: [5.5, 5.5],
})
const midIcon = () => (window as any).L.divIcon({
  className: '',
  html: '<div style="width:8px;height:8px;border-radius:50%;background:#4ade80;border:1px solid #fff;cursor:pointer;opacity:.9;"></div>',
  iconSize: [8, 8], iconAnchor: [4, 4],
})

function BoundaryMapEditor({ onChanged }: { onChanged: () => void }) {
  const mapRef = useRef<HTMLDivElement>(null)
  const mapIns = useRef<any>(null)
  const baseLayer = useRef<any>(null)     // 全部乡镇边界层
  const editingPoly = useRef<any>(null)   // 当前编辑 polygon
  const vertexMarkers = useRef<any[]>([]) // 顶点 marker（可拖拽/右键删除）
  const midMarkers = useRef<any[]>([])    // 边中点 marker（点击添加顶点）
  const townsRef = useRef<{ town: string; ring: [number, number][] }[]>([])
  const [selected, setSelected] = useState('')
  const [status, setStatus] = useState('加载中…')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    const init = async () => {
      try {
        await loadScript('/jsc/lib/leaflet.js', () => !!(window as any).L)
        if (!document.querySelector('link[href*="leaflet.css"]')) {
          const link = document.createElement('link')
          link.rel = 'stylesheet'
          link.href = '/jsc/lib/leaflet.css'
          document.head.appendChild(link)
        }
        if (cancelled || !mapRef.current) return
        const L = (window as any).L
        const map = L.map(mapRef.current, { center: [30.80, 108.40], zoom: 11 })
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map)
        mapIns.current = map
        const res = await authFetch('/api/straw/boundary/export')
        const geo = await res.json()
        townsRef.current = geo.features.map((f: any) => ({ town: f.properties.name, ring: f.geometry.coordinates[0] }))
        baseLayer.current = L.geoJSON(geo, {
          style: { color: '#00aaff', weight: 1.5, fillColor: '#00aaff', fillOpacity: 0.1 },
        }).addTo(map)
        map.fitBounds(baseLayer.current.getBounds())
        setStatus(`已加载 ${geo.features.length} 个乡镇 · 下拉选择 → 拖拽顶点编辑`)
      } catch (e: any) {
        setStatus('地图加载失败: ' + (e?.message || e))
      }
    }
    init()
    return () => { cancelled = true; clearEdit(); if (mapIns.current) { mapIns.current.remove(); mapIns.current = null } }
  }, [])

  const clearEdit = () => {
    vertexMarkers.current.forEach(m => mapIns.current?.removeLayer(m))
    midMarkers.current.forEach(m => mapIns.current?.removeLayer(m))
    vertexMarkers.current = []
    midMarkers.current = []
    if (editingPoly.current) { mapIns.current?.removeLayer(editingPoly.current); editingPoly.current = null }
  }

  // 由顶点 markers 同步 polygon
  const syncPoly = () => {
    if (!editingPoly.current) return
    const latlngs = vertexMarkers.current.map(m => m.getLatLng())
    if (latlngs.length >= 3) editingPoly.current.setLatLngs([latlngs])
  }

  // 重建边中点 marker
  const rebuildMid = () => {
    midMarkers.current.forEach(m => mapIns.current?.removeLayer(m))
    midMarkers.current = []
    const L = (window as any).L
    const latlngs = vertexMarkers.current.map(m => m.getLatLng())
    if (latlngs.length < 3) return
    for (let i = 0; i < latlngs.length; i++) {
      const a = latlngs[i], b = latlngs[(i + 1) % latlngs.length]
      const mid = L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2)
      const mk = L.marker(mid, { icon: midIcon() })
      mk.on('click', () => {
        if (vertexMarkers.current.length >= 200) { setStatus('顶点数已达上限 200'); return }
        const vm = makeVertex(mid)
        vertexMarkers.current.splice(i + 1, 0, vm)
        syncPoly()
        rebuildMid()
        setStatus(`已添加顶点（当前 ${vertexMarkers.current.length}）· 拖拽 / 右键删除`)
      })
      mk.addTo(mapIns.current)
      midMarkers.current.push(mk)
    }
  }

  const makeVertex = (ll: any) => {
    const L = (window as any).L
    const mk = L.marker(ll, { draggable: true, icon: vertexIcon() })
    mk.on('drag', () => { syncPoly(); rebuildMid() })
    mk.on('contextmenu', (e: any) => {
      L.DomEvent.stop(e)
      if (vertexMarkers.current.length <= 3) { setStatus('至少保留 3 个顶点'); return }
      const idx = vertexMarkers.current.indexOf(mk)
      if (idx >= 0) {
        mapIns.current?.removeLayer(mk)
        vertexMarkers.current.splice(idx, 1)
        syncPoly()
        rebuildMid()
        setStatus(`已删除顶点（当前 ${vertexMarkers.current.length}）`)
      }
    })
    mk.addTo(mapIns.current)
    return mk
  }

  const selectTown = (town: string) => {
    setSelected(town)
    const t = townsRef.current.find(x => x.town === town)
    if (!t || !mapIns.current) return
    const L = (window as any).L
    clearEdit()
    if (baseLayer.current) baseLayer.current.setStyle({ color: '#00aaff', weight: 1.5, fillOpacity: 0.1 })
    // 去闭合重复点（首尾相同）
    let pts = t.ring.slice()
    if (pts.length > 1) {
      const first = pts[0], last = pts[pts.length - 1]
      if (first[0] === last[0] && first[1] === last[1]) pts = pts.slice(0, -1)
    }
    const latlngs = pts.map(([lng, lat]) => L.latLng(lat, lng))
    const poly = L.polygon(latlngs, { color: '#ff7043', weight: 2.5, fillColor: '#ff7043', fillOpacity: 0.15 })
    poly.addTo(mapIns.current)
    editingPoly.current = poly
    latlngs.forEach(ll => vertexMarkers.current.push(makeVertex(ll)))
    rebuildMid()
    mapIns.current.fitBounds(poly.getBounds())
    setStatus(`编辑中：${town}（${latlngs.length} 顶点）· 拖拽顶点 / 点击边中点添加 / 右键删除 · 保存后热生效`)
  }

  const cancelEdit = () => {
    clearEdit()
    if (baseLayer.current) baseLayer.current.setStyle({ color: '#00aaff', weight: 1.5, fillOpacity: 0.1 })
    setSelected('')
    setStatus('已取消编辑')
  }

  const save = async () => {
    if (!editingPoly.current || !selected) return
    setBusy(true)
    try {
      const latlngs = vertexMarkers.current.map((m: any) => m.getLatLng())
      const ring = latlngs.map((ll: any) => [Number(ll.lng.toFixed(6)), Number(ll.lat.toFixed(6))])
      if (ring.length < 3) { setStatus('顶点数不足，无法保存'); setBusy(false); return }
      const closed = [...ring, ring[0]]
      const r = await authFetch(`/api/straw/boundary/${encodeURIComponent(selected)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ring: closed }),
      })
      const d = await r.json()
      if (d.ok) {
        const t = townsRef.current.find(x => x.town === selected)
        if (t) t.ring = closed
        setStatus(`✓ 已保存 ${selected}（${ring.length} 顶点）· 热生效 · 可继续编辑`)
        onChanged()
      } else {
        setStatus('保存失败: ' + (d.error || r.status))
      }
    } catch (e: any) {
      setStatus('保存失败: ' + (e?.message || e))
    }
    setBusy(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', ...card, padding: '10px 14px' }}>
        <span style={{ color: '#7ab8e0', fontSize: 13, fontWeight: 700 }}>🗺 地图编辑</span>
        <select
          value={selected}
          onChange={e => selectTown(e.target.value)}
          style={{
            background: 'rgba(0,20,60,0.8)', color: '#c8e6ff', border: '1px solid rgba(255,183,77,0.4)',
            borderRadius: 3, padding: '5px 8px', fontSize: 12, fontFamily: "'JetBrains Mono',monospace",
          }}
        >
          <option value="">— 选择乡镇/街道 —</option>
          {townsRef.current.map(t => <option key={t.town} value={t.town}>{t.town}</option>)}
        </select>
        <button onClick={save} disabled={busy || !editingPoly.current} style={{
          padding: '5px 16px', fontSize: 12, fontWeight: 700, cursor: busy ? 'wait' : (editingPoly.current ? 'pointer' : 'default'),
          borderRadius: 4, border: 'none', color: '#fff', opacity: editingPoly.current ? 1 : 0.4,
          background: busy ? '#3a5a70' : 'linear-gradient(90deg, #0e8f4a, #1fb96a)',
        }}>{busy ? '保存中…' : '💾 保存修改'}</button>
        {editingPoly.current && (
          <button onClick={cancelEdit} style={{
            padding: '5px 12px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
            border: '1px solid rgba(255,80,80,0.3)', background: 'rgba(255,60,60,0.1)', color: RED,
          }}>取消编辑</button>
        )}
        <span style={{ fontSize: 11, color: '#5a8aaa', marginLeft: 'auto' }}>🟠 拖拽顶点移动 · 🟢 点击边中点添加 · 右键顶点删除</span>
      </div>

      <div style={{ fontSize: 12, color: status.startsWith('✓') ? GREEN : status.includes('失败') ? RED : '#7ab8e0' }}>{status}</div>

      <div ref={mapRef} style={{ height: 560, borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(0,80,150,0.3)', background: '#0a1628' }} />

      <div style={{ fontSize: 11, color: '#3a5a70', lineHeight: 1.8 }}>
        <b style={{ color: '#5a8aaa' }}>提示</b>：选择乡镇后地图聚焦该边界，拖拽橙色圆点移动顶点、点击绿色中点添加顶点、右键圆点删除顶点（至少保留 3 个）。保存后立即热生效（无需重启），且自动生成版本快照可回滚。
      </div>
    </div>
  )
}

