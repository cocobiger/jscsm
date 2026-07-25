import { useState, useEffect, useCallback } from 'react'
import { apiFetch, getApiKey, authFetch } from '../../lib/apiFetch'

const CYAN = '#00aaff'
const GREEN = '#00e676'
const AMBER = '#ffd740'
const RED = '#ff4444'

interface ZlmConfig {
  name: string
  zlmHost: string
  domain: string
  scheme: 'http' | 'https'
  zlmPort: number
  httpsPort: number
  rtspPort: number
  rtmpPort: number
  hookUrl: string
  recordPort: number
  rtpMode: 'single' | 'multi'
  rtpPortRange: string
  rtpPort: number
  autoConfig: boolean
  configured: boolean
}

const EMPTY: ZlmConfig = {
  name: 'media', zlmHost: '', domain: '', scheme: 'http',
  zlmPort: 8080, httpsPort: 443, rtspPort: 554, rtmpPort: 1935,
  hookUrl: '', recordPort: 0, rtpMode: 'single', rtpPortRange: '', rtpPort: 0,
  autoConfig: true, configured: false,
}

const labelStyle: React.CSSProperties = { color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 5 }
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 11px', background: 'rgba(0,20,60,0.6)',
  border: '1px solid rgba(0,150,220,0.25)', borderRadius: 4, color: '#c8e6ff',
  fontSize: 13, outline: 'none', boxSizing: 'border-box',
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={labelStyle}>
        {required && <span style={{ color: RED, marginRight: 3 }}>*</span>}{label}
      </label>
      {children}
    </div>
  )
}

function TextField({ label, value, onChange, placeholder, required, mono }: {
  label: string; value: string | number; onChange: (v: string) => void
  placeholder?: string; required?: boolean; mono?: boolean
}) {
  return (
    <Field label={label} required={required}>
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{ ...inputStyle, fontFamily: mono ? "'JetBrains Mono', monospace" : 'inherit' }} />
    </Field>
  )
}

export function MediaServerPage() {
  const [cfg, setCfg] = useState<ZlmConfig>(EMPTY)
  const [secret, setSecret] = useState('')
  const [toast, setToast] = useState('')
  const [busy, setBusy] = useState('')
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [urls, setUrls] = useState<Record<string, string> | null>(null)
  const hasKey = !!getApiKey()

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3000) }

  const load = useCallback(() => {
    authFetch('/api/zlm/config').then(r => r.json()).then((d: ZlmConfig) => {
      setCfg({ ...EMPTY, ...d })
    }).catch(() => {})
  }, [])

  useEffect(() => { load() }, [load])

  const set = (patch: Partial<ZlmConfig>) => setCfg(c => ({ ...c, ...patch }))

  const save = async () => {
    if (!cfg.zlmHost) { flash('请填写服务器IP'); return }
    setBusy('save')
    try {
      const payload: any = { ...cfg }
      delete payload.configured
      if (secret) payload.zlmSecret = secret  // 仅填了才提交，空则保留旧密钥
      await apiFetch('/api/zlm/config', { method: 'POST', body: JSON.stringify(payload) })
      flash('流媒体配置已保存'); setSecret(''); load()
    } catch (e: any) {
      flash('保存失败：' + (e.error || e.message))
    } finally { setBusy('') }
  }

  const test = async () => {
    setBusy('test'); setTestResult(null)
    try {
      const r = await apiFetch<{ ok: boolean; activeStreams?: number; error?: string }>('/api/zlm/test', { method: 'POST' })
      setTestResult(r.ok
        ? { ok: true, msg: `连通正常，当前活跃流 ${r.activeStreams ?? 0} 路` }
        : { ok: false, msg: r.error || '连接失败' })
    } catch (e: any) {
      setTestResult({ ok: false, msg: e.error || e.message })
    } finally { setBusy('') }
  }

  const preview = async () => {
    setBusy('preview')
    try {
      const r = await apiFetch<{ urls: Record<string, string> }>('/api/zlm/play-urls?stream=demo', { method: 'GET' })
      setUrls(r.urls)
    } catch (e: any) {
      flash('预览失败：' + (e.error || e.message))
    } finally { setBusy('') }
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div style={{ color: '#c8e6ff', fontSize: 16, fontWeight: 600 }}>流媒体服务器节点</div>
          <div style={{ color: '#3a5a70', fontSize: 12, marginTop: 3 }}>ZLMediaKit 拉流代理 / 播放地址生成配置</div>
        </div>
        <div style={{
          padding: '4px 12px', borderRadius: 4, fontSize: 12,
          background: cfg.configured ? 'rgba(0,230,118,0.12)' : 'rgba(255,179,0,0.12)',
          border: `1px solid ${cfg.configured ? 'rgba(0,230,118,0.4)' : 'rgba(255,179,0,0.4)'}`,
          color: cfg.configured ? GREEN : AMBER,
        }}>
          {cfg.configured ? '● 已配置密钥' : '○ 未配置密钥'}
        </div>
      </div>

      {!hasKey && (
        <div style={{ marginBottom: 14, padding: '8px 12px', borderRadius: 4, background: 'rgba(255,68,68,0.1)', border: '1px solid rgba(255,68,68,0.3)', color: '#ff8080', fontSize: 12 }}>
          未设置 API Key，保存将失败。请先在右上角「🔑 API Key」填入密钥。
        </div>
      )}

      {/* 两列表单 */}
      <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none', paddingRight: 4 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 28px' }}>
          {/* 左列 */}
          <div>
            <TextField label="配置名称" value={cfg.name} onChange={v => set({ name: v })} placeholder="media" />
            <TextField label="服务器IP" required value={cfg.zlmHost} onChange={v => set({ zlmHost: v })} placeholder="27.8.193.205" mono />
            <Field label="播放协议">
              <select value={cfg.scheme} onChange={e => set({ scheme: e.target.value as 'http' | 'https' })} style={inputStyle}>
                <option value="http">http</option>
                <option value="https">https</option>
              </select>
            </Field>
            <TextField label="HookUrl" value={cfg.hookUrl} onChange={v => set({ hookUrl: v })} placeholder="177.7.0.13:8080" mono />
            <TextField label="Http端口" required value={cfg.zlmPort} onChange={v => set({ zlmPort: Number(v) || 0 })} placeholder="6082" mono />
            <TextField label="Https端口" required value={cfg.httpsPort} onChange={v => set({ httpsPort: Number(v) || 0 })} placeholder="8443" mono />
            <TextField label="Rtsp端口" required value={cfg.rtspPort} onChange={v => set({ rtspPort: Number(v) || 0 })} placeholder="554" mono />
          </div>

          {/* 右列 */}
          <div>
            <Field label="流媒体密钥" required>
              <input value={secret} onChange={e => setSecret(e.target.value)}
                placeholder={cfg.configured ? '已配置（留空不修改）' : 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'}
                style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }} />
            </Field>
            <TextField label="服务器域名" value={cfg.domain} onChange={v => set({ domain: v })} placeholder="www.theoa.top（可选，填了优先用域名）" mono />
            <Field label="自动配置">
              <Toggle on={cfg.autoConfig} onToggle={() => set({ autoConfig: !cfg.autoConfig })} />
            </Field>
            <Field label="收流模式">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ color: cfg.rtpMode === 'single' ? CYAN : '#5a8aaa', fontSize: 12 }}>单端口</span>
                <Toggle on={cfg.rtpMode === 'multi'} onToggle={() => set({ rtpMode: cfg.rtpMode === 'multi' ? 'single' : 'multi' })} />
                <span style={{ color: cfg.rtpMode === 'multi' ? CYAN : '#5a8aaa', fontSize: 12 }}>多端口</span>
              </div>
            </Field>
            {cfg.rtpMode === 'multi' ? (
              <TextField label="收流端口范围" value={cfg.rtpPortRange} onChange={v => set({ rtpPortRange: v })} placeholder="50000-50300" mono />
            ) : (
              <TextField label="收流端口" value={cfg.rtpPort} onChange={v => set({ rtpPort: Number(v) || 0 })} placeholder="50000" mono />
            )}
            <TextField label="Rtmp端口" required value={cfg.rtmpPort} onChange={v => set({ rtmpPort: Number(v) || 0 })} placeholder="1935" mono />
            <TextField label="录像管理端口" value={cfg.recordPort} onChange={v => set({ recordPort: Number(v) || 0 })} placeholder="6081（0=不启用）" mono />
          </div>
        </div>

        {/* 测试结果 */}
        {testResult && (
          <div style={{
            marginTop: 8, padding: '8px 12px', borderRadius: 4, fontSize: 12,
            background: testResult.ok ? 'rgba(0,230,118,0.1)' : 'rgba(255,68,68,0.1)',
            border: `1px solid ${testResult.ok ? 'rgba(0,230,118,0.35)' : 'rgba(255,68,68,0.3)'}`,
            color: testResult.ok ? GREEN : '#ff8080',
          }}>
            {testResult.ok ? '✓ ' : '✗ '}{testResult.msg}
          </div>
        )}

        {/* 播放地址预览 */}
        {urls && (
          <div style={{ marginTop: 12, padding: '10px 12px', background: 'rgba(0,20,50,0.5)', border: '1px solid rgba(0,100,180,0.2)', borderRadius: 4 }}>
            <div style={{ color: '#5a8aaa', fontSize: 11, marginBottom: 8 }}>播放地址预览（stream=demo）</div>
            {Object.entries(urls).map(([k, v]) => (
              <div key={k} style={{ display: 'flex', gap: 8, marginBottom: 4, fontSize: 11 }}>
                <span style={{ color: AMBER, width: 56, flexShrink: 0, textTransform: 'uppercase' }}>{k}</span>
                <span style={{ color: '#9ec5e0', fontFamily: "'JetBrains Mono', monospace", wordBreak: 'break-all' }}>{v}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 底部操作 */}
      <div style={{ display: 'flex', gap: 10, paddingTop: 14, borderTop: '1px solid rgba(0,80,150,0.2)', marginTop: 8 }}>
        <button onClick={save} disabled={busy === 'save'} style={btn(GREEN, busy === 'save')}>
          {busy === 'save' ? '保存中…' : '提交保存'}
        </button>
        <button onClick={test} disabled={busy === 'test'} style={btn(CYAN, busy === 'test')}>
          {busy === 'test' ? '测试中…' : '测试连通'}
        </button>
        <button onClick={preview} disabled={busy === 'preview'} style={btn('#7e57c2', busy === 'preview')}>
          播放地址预览
        </button>
      </div>

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 4000,
          background: '#061530', border: '1px solid rgba(0,150,220,0.4)', borderRadius: 4, padding: '10px 20px',
          color: '#c8e6ff', fontSize: 13, boxShadow: '0 4px 20px rgba(0,0,0,0.5)' }}>{toast}</div>
      )}
    </div>
  )
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} style={{
      width: 42, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer', position: 'relative',
      background: on ? CYAN : 'rgba(80,100,130,0.5)', transition: 'background 0.2s', padding: 0,
    }}>
      <span style={{
        position: 'absolute', top: 2, left: on ? 22 : 2, width: 18, height: 18, borderRadius: '50%',
        background: '#fff', transition: 'left 0.2s',
      }} />
    </button>
  )
}

function btn(color: string, disabled: boolean): React.CSSProperties {
  return {
    padding: '9px 22px', fontSize: 13, borderRadius: 4, fontWeight: 600,
    border: `1px solid ${color}66`, background: `${color}1a`, color,
    cursor: disabled ? 'wait' : 'pointer', opacity: disabled ? 0.6 : 1,
  }
}
