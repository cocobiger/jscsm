import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../../lib/apiFetch'

const CYAN = '#00aaff'
const GREEN = '#00e676'
const AMBER = '#ffd740'
const RED = '#ff4444'

interface Enterprise {
  id: number
  name: string
  industry_type: string
  location: string
  contact: string
  created_at: string
  updated_at: string
}

interface EventRow {
  id: number
  enterprise_id: number
  enterprise_name: string
  event_type: string
  severity: string
  description: string
  reported_at: string
}

const inputStyle: React.CSSProperties = {
  padding: '7px 10px', background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.25)',
  borderRadius: 3, color: '#c8e6ff', fontSize: 13, outline: 'none',
}

export function EnterprisePage() {
  const [enterprises, setEnterprises] = useState<Enterprise[]>([])
  const [events, setEvents] = useState<EventRow[]>([])
  const [toast, setToast] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [showEvents, setShowEvents] = useState(false)
  const [editing, setEditing] = useState<Enterprise | null>(null)
  const [form, setForm] = useState<{ name: string; industry_type: string; location: string; contact: string }>({
    name: '', industry_type: '', location: '', contact: '',
  })

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3000) }

  const load = useCallback(() => {
    apiFetch<Enterprise[]>('/api/enterprises').then(setEnterprises).catch((e: any) => flash('加载失败：' + (e.error || e)))
  }, [])
  const loadEvents = useCallback(() => {
    apiFetch<EventRow[]>('/api/events?limit=100').then(setEvents).catch((e: any) => flash('加载事件失败：' + (e.error || e)))
  }, [])
  useEffect(() => { load() }, [load])

  const save = async () => {
    if (!form.name) { flash('企业名称不能为空'); return }
    try {
      if (editing) {
        await apiFetch(`/api/enterprises/${editing.id}`, { method: 'PATCH', body: JSON.stringify(form) })
        flash('已更新'); setEditing(null)
      } else {
        await apiFetch('/api/enterprises', { method: 'POST', body: JSON.stringify(form) })
        flash('已新增')
      }
      setForm({ name: '', industry_type: '', location: '', contact: '' })
      setShowAdd(false)
      load()
    } catch (e: any) { flash((editing ? '更新' : '新增') + '失败：' + (e.error || e)) }
  }

  const del = async (ent: Enterprise) => {
    if (!confirm(`确认删除企业「${ent.name}」？删除后该企业的污染事件记录也会被删除。`)) return
    try {
      await apiFetch(`/api/enterprises/${ent.id}`, { method: 'DELETE' })
      flash('已删除'); load()
    } catch (e: any) { flash('删除失败：' + (e.error || e)) }
  }

  const startEdit = (ent: Enterprise) => {
    setEditing(ent)
    setForm({ name: ent.name, industry_type: ent.industry_type || '', location: ent.location || '', contact: ent.contact || '' })
    setShowAdd(true)
  }

  const btn = (color: string): React.CSSProperties => ({
    padding: '4px 10px', fontSize: 12, borderRadius: 3, border: `1px solid ${color}55`,
    background: `${color}15`, color, cursor: 'pointer',
  })

  const severityColor = (s: string) => s === 'severe' ? RED : s === 'warning' ? AMBER : GREEN

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: 20, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div style={{ color: '#c8e6ff', fontSize: 16, fontWeight: 600 }}>重点企业管理</div>
          <div style={{ color: '#3a5a70', fontSize: 12, marginTop: 3 }}>企业名单维护与污染事件记录</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => { setShowEvents(!showEvents); if (!showEvents && !events.length) loadEvents() }} style={btn(AMBER)}>
            {showEvents ? '隐藏事件' : '查看事件'}
          </button>
          <button onClick={() => { setEditing(null); setForm({ name: '', industry_type: '', location: '', contact: '' }); setShowAdd(!showAdd) }} style={btn(CYAN)}>
            {showAdd ? '取消' : '＋ 新增企业'}
          </button>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', top: 80, right: 40, zIndex: 3000, background: 'rgba(0,40,80,0.95)', border: '1px solid rgba(0,150,220,0.3)', borderRadius: 6, padding: '10px 20px', color: CYAN, fontSize: 13 }}>
          {toast}
        </div>
      )}

      {/* Add/Edit Form */}
      {showAdd && (
        <div style={{ background: 'rgba(0,20,60,0.4)', border: '1px solid rgba(0,150,220,0.2)', borderRadius: 6, padding: 16, marginBottom: 16, flexShrink: 0 }}>
          <div style={{ color: '#c8e6ff', fontSize: 14, fontWeight: 600, marginBottom: 12 }}>{editing ? '编辑企业' : '新增企业'}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <div style={{ color: '#5a8aaa', fontSize: 11, marginBottom: 4 }}>企业名称 *</div>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={inputStyle} placeholder="必填" />
            </div>
            <div>
              <div style={{ color: '#5a8aaa', fontSize: 11, marginBottom: 4 }}>行业类型</div>
              <select value={form.industry_type} onChange={e => setForm(f => ({ ...f, industry_type: e.target.value }))} style={{ ...inputStyle, width: '100%' }}>
                <option value="">请选择</option>
                <option value="化工">化工</option>
                <option value="新材料">新材料</option>
                <option value="热电">热电</option>
                <option value="水泥">水泥</option>
                <option value="环保发电">环保发电</option>
                <option value="汽车制造">汽车制造</option>
                <option value="建材">建材</option>
                <option value="建筑施工">建筑施工</option>
                <option value="其他">其他</option>
              </select>
            </div>
            <div>
              <div style={{ color: '#5a8aaa', fontSize: 11, marginBottom: 4 }}>地址</div>
              <input value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} style={inputStyle} placeholder="可选" />
            </div>
            <div>
              <div style={{ color: '#5a8aaa', fontSize: 11, marginBottom: 4 }}>联系人</div>
              <input value={form.contact} onChange={e => setForm(f => ({ ...f, contact: e.target.value }))} style={inputStyle} placeholder="可选" />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => { setShowAdd(false); setEditing(null) }} style={btn('#3a5a70')}>取消</button>
            <button onClick={save} style={btn(CYAN)}>{editing ? '保存修改' : '确认新增'}</button>
          </div>
        </div>
      )}

      {/* Enterprise Table */}
      <div style={{ flex: showEvents ? 0.5 : 1, overflow: 'auto', border: '1px solid rgba(0,150,220,0.15)', borderRadius: 6, flexShrink: 0 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '50px 2fr 1fr 1.5fr 1fr 120px', background: 'rgba(0,30,70,0.5)', padding: '8px 12px', fontSize: 11, color: '#3a5a70', fontWeight: 600, borderBottom: '1px solid rgba(0,150,220,0.15)' }}>
          <span>ID</span><span>企业名称</span><span>行业</span><span>地址</span><span>联系人</span><span style={{ textAlign: 'right' }}>操作</span>
        </div>
        {enterprises.map(ent => (
          <div key={ent.id} style={{ display: 'grid', gridTemplateColumns: '50px 2fr 1fr 1.5fr 1fr 120px', padding: '8px 12px', fontSize: 12, borderBottom: '1px solid rgba(0,80,150,0.1)', alignItems: 'center' }}>
            <span style={{ color: '#2a4a60', fontFamily: "'JetBrains Mono', monospace" }}>{ent.id}</span>
            <span style={{ color: '#c8e6ff' }}>{ent.name}</span>
            <span style={{ color: '#7ab8e0' }}>{ent.industry_type || '-'}</span>
            <span style={{ color: '#5a8aaa', fontSize: 11 }}>{ent.location || '-'}</span>
            <span style={{ color: '#5a8aaa', fontSize: 11 }}>{ent.contact || '-'}</span>
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <button onClick={() => startEdit(ent)} style={btn(AMBER)}>编辑</button>
              <button onClick={() => del(ent)} style={btn(RED)}>删除</button>
            </div>
          </div>
        ))}
        {!enterprises.length && (
          <div style={{ padding: 40, textAlign: 'center', color: '#2a4a60', fontSize: 13 }}>暂无企业数据，请点击"新增企业"添加</div>
        )}
      </div>

      {/* Events Panel */}
      {showEvents && (
        <div style={{ flex: 0.5, overflow: 'auto', border: '1px solid rgba(0,150,220,0.15)', borderRadius: 6, marginTop: 16, flexShrink: 0 }}>
          <div style={{ background: 'rgba(0,30,70,0.5)', padding: '8px 12px', fontSize: 11, color: '#3a5a70', fontWeight: 600, borderBottom: '1px solid rgba(0,150,220,0.15)' }}>
            污染事件记录（最近100条）
            <button onClick={loadEvents} style={{ ...btn(CYAN), marginLeft: 12, padding: '2px 8px' }}>刷新</button>
          </div>
          {events.map(ev => (
            <div key={ev.id} style={{ display: 'grid', gridTemplateColumns: '50px 1.5fr 1fr 80px 2fr 140px', padding: '6px 12px', fontSize: 11, borderBottom: '1px solid rgba(0,80,150,0.08)', alignItems: 'center' }}>
              <span style={{ color: '#2a4a60', fontFamily: "'JetBrains Mono', monospace" }}>{ev.id}</span>
              <span style={{ color: '#c8e6ff' }}>{ev.enterprise_name}</span>
              <span style={{ color: '#7ab8e0' }}>{ev.event_type}</span>
              <span style={{ color: severityColor(ev.severity), fontWeight: 600 }}>{ev.severity === 'severe' ? '严重' : ev.severity === 'warning' ? '警告' : '普通'}</span>
              <span style={{ color: '#5a8aaa', fontSize: 10 }}>{ev.description || '-'}</span>
              <span style={{ color: '#3a5a70', fontSize: 10 }}>{ev.reported_at?.slice(0, 19).replace('T', ' ') || '-'}</span>
            </div>
          ))}
          {!events.length && (
            <div style={{ padding: 40, textAlign: 'center', color: '#2a4a60', fontSize: 13 }}>暂无污染事件记录</div>
          )}
        </div>
      )}
    </div>
  )
}
