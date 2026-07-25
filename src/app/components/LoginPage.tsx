import { useState } from 'react'
import { login, type CurrentUser } from '../lib/auth'

const CYAN = '#00aaff'
const RED = '#ff4444'

interface Props {
  onSuccess: (user: CurrentUser) => void
}

export function LoginPage({ onSuccess }: Props) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username || !password) { setErr('请输入用户名和密码'); return }
    setBusy(true); setErr('')
    try {
      const user = await login(username.trim(), password)
      onSuccess(user)
    } catch (e: any) {
      setErr(e?.error || '登录失败')
    } finally { setBusy(false) }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '11px 14px', marginBottom: 14,
    background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.3)',
    borderRadius: 5, color: '#c8e6ff', fontSize: 14, outline: 'none', boxSizing: 'border-box',
  }

  return (
    <div style={{
      width: '100vw', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'radial-gradient(ellipse at center, #061530 0%, #030c1e 100%)',
      fontFamily: "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif",
    }}>
      <form onSubmit={submit} style={{
        width: 360, padding: '36px 32px',
        background: 'linear-gradient(180deg, #051022 0%, #030c1e 100%)',
        border: '1px solid rgba(0,150,220,0.25)', borderRadius: 8,
        boxShadow: '0 0 60px rgba(0,120,255,0.15)',
      }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ color: '#c8e6ff', fontSize: 19, fontWeight: 700, letterSpacing: '0.05em' }}>
            生态环境局驾驶舱
          </div>
          <div style={{ color: '#3a5a70', fontSize: 12, marginTop: 6 }}>请登录后访问</div>
        </div>

        <label style={{ color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 5 }}>用户名</label>
        <input value={username} onChange={e => setUsername(e.target.value)} autoFocus
          placeholder="用户名" style={inputStyle} />

        <label style={{ color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 5 }}>密码</label>
        <input type="password" value={password} onChange={e => setPassword(e.target.value)}
          placeholder="密码" style={inputStyle} />

        {err && (
          <div style={{ color: RED, fontSize: 12, marginBottom: 14, textAlign: 'center' }}>{err}</div>
        )}

        <button type="submit" disabled={busy} style={{
          width: '100%', padding: '11px', fontSize: 14, fontWeight: 600, borderRadius: 5,
          border: `1px solid ${CYAN}66`, background: busy ? 'rgba(0,170,255,0.15)' : `${CYAN}22`,
          color: CYAN, cursor: busy ? 'wait' : 'pointer', transition: 'all 0.18s',
        }}>
          {busy ? '登录中…' : '登 录'}
        </button>
      </form>
    </div>
  )
}
