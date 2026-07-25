import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../../lib/apiFetch'
import { ROLE_LABELS, type Role } from '../../lib/auth'

const CYAN = '#00aaff'
const GREEN = '#00e676'
const AMBER = '#ffd740'
const RED = '#ff4444'

interface UserRow {
  id: string
  username: string
  role: Role
  enabled: number | boolean
  force_change?: number
  last_login_at?: string
}

const inputStyle: React.CSSProperties = {
  padding: '7px 10px', background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.25)',
  borderRadius: 3, color: '#c8e6ff', fontSize: 13, outline: 'none',
}

interface Props { currentUserId: string }

export function UsersPage({ currentUserId }: Props) {
  const [users, setUsers] = useState<UserRow[]>([])
  const [toast, setToast] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState<{ username: string; password: string; role: Role }>({ username: '', password: '', role: 'viewer' })
  const [resetFor, setResetFor] = useState<UserRow | null>(null)
  const [newPwd, setNewPwd] = useState('')

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3000) }

  const load = useCallback(() => {
    apiFetch<UserRow[]>('/api/users').then(setUsers).catch((e: any) => flash('加载失败：' + (e.error || e)))
  }, [])
  useEffect(() => { load() }, [load])

  const addUser = async () => {
    if (!form.username || !form.password) { flash('请填用户名和密码'); return }
    try {
      await apiFetch('/api/users', { method: 'POST', body: JSON.stringify(form) })
      flash('已创建用户'); setShowAdd(false); setForm({ username: '', password: '', role: 'viewer' }); load()
    } catch (e: any) { flash('创建失败：' + (e.error || e)) }
  }

  const setRole = async (u: UserRow, role: Role) => {
    try { await apiFetch(`/api/users/${u.id}`, { method: 'PATCH', body: JSON.stringify({ role }) }); load() }
    catch (e: any) { flash('修改失败：' + (e.error || e)) }
  }
  const toggleEnabled = async (u: UserRow) => {
    try { await apiFetch(`/api/users/${u.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !(u.enabled === 1 || u.enabled === true) }) }); load() }
    catch (e: any) { flash('修改失败：' + (e.error || e)) }
  }
  const doReset = async () => {
    if (!resetFor || newPwd.length < 6) { flash('新密码至少 6 位'); return }
    try {
      await apiFetch(`/api/users/${resetFor.id}/reset-password`, { method: 'POST', body: JSON.stringify({ newPassword: newPwd }) })
      flash('密码已重置'); setResetFor(null); setNewPwd('')
    } catch (e: any) { flash('重置失败：' + (e.error || e)) }
  }
  const del = async (u: UserRow) => {
    if (!confirm(`确认删除用户 ${u.username}？`)) return
    try { await apiFetch(`/api/users/${u.id}`, { method: 'DELETE' }); load() }
    catch (e: any) { flash('删除失败：' + (e.error || e)) }
  }

  const btn = (color: string): React.CSSProperties => ({
    padding: '4px 10px', fontSize: 12, borderRadius: 3, border: `1px solid ${color}55`,
    background: `${color}15`, color, cursor: 'pointer',
  })

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div style={{ color: '#c8e6ff', fontSize: 16, fontWeight: 600 }}>用户管理</div>
          <div style={{ color: '#3a5a70', fontSize: 12, marginTop: 3 }}>账号、角色与启用状态（仅管理员可见）</div>
        </div>
        <button onClick={() => setShowAdd(true)} style={btn(GREEN)}>+ 新增用户</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(0,150,220,0.2)', color: '#5a8aaa', fontSize: 12 }}>
              <th style={{ textAlign: 'left', padding: '8px 10px' }}>用户名</th>
              <th style={{ textAlign: 'left', padding: '8px 10px' }}>角色</th>
              <th style={{ textAlign: 'left', padding: '8px 10px' }}>状态</th>
              <th style={{ textAlign: 'left', padding: '8px 10px' }}>最近登录</th>
              <th style={{ textAlign: 'right', padding: '8px 10px' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => {
              const enabled = u.enabled === 1 || u.enabled === true
              const isSelf = u.id === currentUserId
              return (
                <tr key={u.id} style={{ borderBottom: '1px solid rgba(0,50,100,0.2)' }}>
                  <td style={{ padding: '8px 10px', color: '#c8e6ff' }}>
                    {u.username}{isSelf && <span style={{ color: '#3a5a70', fontSize: 11, marginLeft: 6 }}>(我)</span>}
                  </td>
                  <td style={{ padding: '8px 10px' }}>
                    <select value={u.role} disabled={isSelf} onChange={e => setRole(u, e.target.value as Role)}
                      style={{ ...inputStyle, padding: '4px 8px', opacity: isSelf ? 0.5 : 1 }}>
                      <option value="admin">{ROLE_LABELS.admin}</option>
                      <option value="operator">{ROLE_LABELS.operator}</option>
                      <option value="viewer">{ROLE_LABELS.viewer}</option>
                    </select>
                  </td>
                  <td style={{ padding: '8px 10px' }}>
                    <span style={{ color: enabled ? GREEN : '#5a6a70', fontSize: 12 }}>{enabled ? '● 启用' : '○ 禁用'}</span>
                  </td>
                  <td style={{ padding: '8px 10px', color: '#5a8aaa', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
                    {u.last_login_at ? u.last_login_at.slice(0, 19).replace('T', ' ') : '—'}
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button onClick={() => setResetFor(u)} style={{ ...btn(AMBER), marginRight: 6 }}>重置密码</button>
                    {!isSelf && <button onClick={() => toggleEnabled(u)} style={{ ...btn(enabled ? '#5a8aaa' : GREEN), marginRight: 6 }}>{enabled ? '禁用' : '启用'}</button>}
                    {!isSelf && <button onClick={() => del(u)} style={btn(RED)}>删除</button>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* 新增用户弹窗 */}
      {showAdd && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget) setShowAdd(false) }}>
          <div style={{ width: 400, background: '#040e25', border: '1px solid rgba(0,150,220,0.3)', borderRadius: 6, padding: 24 }}>
            <div style={{ color: '#c8e6ff', fontSize: 15, fontWeight: 600, marginBottom: 16 }}>新增用户</div>
            <label style={{ color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 5 }}>用户名</label>
            <input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} style={{ ...inputStyle, width: '100%', marginBottom: 12, boxSizing: 'border-box' }} />
            <label style={{ color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 5 }}>初始密码（至少6位）</label>
            <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} style={{ ...inputStyle, width: '100%', marginBottom: 12, boxSizing: 'border-box' }} />
            <label style={{ color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 5 }}>角色</label>
            <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value as Role }))} style={{ ...inputStyle, width: '100%', marginBottom: 18, boxSizing: 'border-box' }}>
              <option value="viewer">{ROLE_LABELS.viewer}（只读）</option>
              <option value="operator">{ROLE_LABELS.operator}（处理预警/发短信）</option>
              <option value="admin">{ROLE_LABELS.admin}（全部权限）</option>
            </select>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowAdd(false)} style={btn('#5a8aaa')}>取消</button>
              <button onClick={addUser} style={btn(GREEN)}>创建</button>
            </div>
          </div>
        </div>
      )}

      {/* 重置密码弹窗 */}
      {resetFor && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget) setResetFor(null) }}>
          <div style={{ width: 400, background: '#040e25', border: '1px solid rgba(0,150,220,0.3)', borderRadius: 6, padding: 24 }}>
            <div style={{ color: '#c8e6ff', fontSize: 15, fontWeight: 600, marginBottom: 8 }}>重置「{resetFor.username}」的密码</div>
            <div style={{ color: '#5a8aaa', fontSize: 12, marginBottom: 14 }}>重置后该用户的登录会话将失效，需用新密码重新登录。</div>
            <input type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)} placeholder="新密码（至少6位）"
              style={{ ...inputStyle, width: '100%', marginBottom: 16, boxSizing: 'border-box' }} />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => { setResetFor(null); setNewPwd('') }} style={btn('#5a8aaa')}>取消</button>
              <button onClick={doReset} style={btn(AMBER)}>确认重置</button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 4000,
          background: '#061530', border: '1px solid rgba(0,150,220,0.4)', borderRadius: 4, padding: '10px 20px',
          color: '#c8e6ff', fontSize: 13 }}>{toast}</div>
      )}
    </div>
  )
}
