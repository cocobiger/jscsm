import { useState, useEffect, useCallback } from 'react'
import { apiFetch, getApiKey, authFetch } from '../../lib/apiFetch'

const CYAN = '#00aaff'
const GREEN = '#00e676'
const AMBER = '#ffd740'
const RED = '#ff4444'
const PURPLE = '#ab47bc'

interface Contact {
  id: string; name: string; mobile: string; group: string; enabled: boolean; createdAt?: string
}
interface Template {
  id: string; name: string; content: string; triggerType: string; enabled: boolean; createdAt?: string
  smsType?: string; templateId?: string; paramFields?: string[]
}
interface SmsHistory {
  id: string; time: string; trigger: string; content: string; recipients?: string[]
  recipientCount?: number; status: string; error?: string | null; pointName?: string; pollutant?: string
  smsType?: string; attempts?: number; blocked?: string[]
}
interface SmsConfig {
  masUrl: string; ecName: string; apId: string; sign: string; addSerial: string
  keepSecretInBody: boolean; configured: boolean; tmpUrl?: string; retryCount?: number; retryDelayMs?: number
}
interface BlacklistItem {
  id: string; mobile: string; reason: string; createdAt?: string
}

function Input({ label, value, onChange, placeholder, type = 'text', mono }: {
  label: string; value: string | number; onChange: (v: string) => void
  placeholder?: string; type?: string; mono?: boolean
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 4 }}>{label}</label>
      <input
        type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{
          width: '100%', padding: '7px 10px', background: 'rgba(0,20,60,0.6)',
          border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3, color: '#c8e6ff',
          fontSize: 13, fontFamily: mono ? "'JetBrains Mono',monospace" : 'inherit', outline: 'none',
        }}
      />
    </div>
  )
}

const btn = (color: string, ghost = false) => ({
  padding: '6px 14px', fontSize: 12, borderRadius: 3, cursor: 'pointer',
  border: `1px solid ${color}55`, background: ghost ? 'transparent' : `${color}18`, color,
})

const TRIGGER_LABELS: Record<string, string> = { air: '空气质量超标', manual: '手动', stream: '视频流离线', device: '设备异常' }

type Tab = 'contacts' | 'templates' | 'blacklist' | 'config' | 'history'

export function SmsWarningPage() {
  const [tab, setTab] = useState<Tab>('contacts')
  const [contacts, setContacts] = useState<Contact[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [history, setHistory] = useState<SmsHistory[]>([])
  const [config, setConfig] = useState<SmsConfig | null>(null)
  const [blacklist, setBlacklist] = useState<BlacklistItem[]>([])
  const [toast, setToast] = useState('')
  const [busy, setBusy] = useState('')
  // 发送历史分页（每页 100 条）
  const HISTORY_PAGE_SIZE = 100
  const [histPage, setHistPage] = useState(1)
  const histTotalPages = Math.max(1, Math.ceil(history.length / HISTORY_PAGE_SIZE))
  const safeHistPage = Math.min(histPage, histTotalPages)
  const pagedHistory = history.slice((safeHistPage - 1) * HISTORY_PAGE_SIZE, safeHistPage * HISTORY_PAGE_SIZE)

  const flash = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 3500) }
  const hasKey = !!getApiKey()

  // ── loaders ──
  const loadContacts = useCallback(() => { authFetch('/api/sms/contacts').then(r => r.json()).then(setContacts).catch(() => {}) }, [])
  const loadTemplates = useCallback(() => { authFetch('/api/sms/templates').then(r => r.json()).then(setTemplates).catch(() => {}) }, [])
  const loadHistory = useCallback(() => { authFetch('/api/sms/history?limit=200').then(r => r.json()).then(setHistory).catch(() => {}) }, [])
  const loadConfig = useCallback(() => { authFetch('/api/sms/config').then(r => r.json()).then(setConfig).catch(() => {}) }, [])
  const loadBlacklist = useCallback(() => { authFetch('/api/sms/blacklist').then(r => r.json()).then(setBlacklist).catch(() => {}) }, [])

  useEffect(() => { loadContacts(); loadTemplates(); loadHistory(); loadConfig(); loadBlacklist() }, [loadContacts, loadTemplates, loadHistory, loadConfig, loadBlacklist])

  // ── blacklist form ──
  const [blForm, setBlForm] = useState({ mobile: '', reason: '' })
  const addBlacklist = async () => {
    if (!blForm.mobile) { flash('请填写手机号'); return }
    setBusy('bl')
    try {
      await apiFetch('/api/sms/blacklist', { method: 'POST', body: JSON.stringify(blForm) })
      flash('已加入黑名单'); setBlForm({ mobile: '', reason: '' }); loadBlacklist()
    } catch (e: any) { flash('失败: ' + (e.error || e.message)) }
    finally { setBusy('') }
  }
  const delBlacklist = async (id: string) => {
    try { await apiFetch(`/api/sms/blacklist/${id}`, { method: 'DELETE' }); flash('已移出黑名单'); loadBlacklist() }
    catch (e: any) { flash('失败: ' + (e.error || e.message)) }
  }

  // ── contact form ──
  const [cForm, setCForm] = useState({ name: '', mobile: '', group: '默认分组' })
  const [cEdit, setCEdit] = useState<string | null>(null)

  const saveContact = async () => {
    if (!cForm.name || !cForm.mobile) { flash('请填写姓名和手机号'); return }
    setBusy('contact')
    try {
      if (cEdit) {
        await apiFetch(`/api/sms/contacts/${cEdit}`, { method: 'PUT', body: JSON.stringify(cForm) })
        flash('联系人已更新')
      } else {
        await apiFetch('/api/sms/contacts', { method: 'POST', body: JSON.stringify(cForm) })
        flash('联系人已添加')
      }
      setCForm({ name: '', mobile: '', group: '默认分组' }); setCEdit(null); loadContacts()
    } catch (e: any) { flash('失败: ' + (e.error || e.message)) }
    finally { setBusy('') }
  }
  const toggleContact = async (c: Contact) => {
    try { await apiFetch(`/api/sms/contacts/${c.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !c.enabled }) }); loadContacts() }
    catch (e: any) { flash('失败: ' + (e.error || e.message)) }
  }
  const delContact = async (id: string) => {
    try { await apiFetch(`/api/sms/contacts/${id}`, { method: 'DELETE' }); flash('已删除'); loadContacts() }
    catch (e: any) { flash('失败: ' + (e.error || e.message)) }
  }

  // ── template form ──
  const [tForm, setTForm] = useState({ name: '', content: '', triggerType: 'air', smsType: 'normal', templateId: '', paramFields: '' })
  const [tEdit, setTEdit] = useState<string | null>(null)
  const [preview, setPreview] = useState('')

  const doPreview = async () => {
    if (!tForm.content) return
    try { const r = await apiFetch<{ preview: string }>('/api/sms/templates/preview', { method: 'POST', body: JSON.stringify({ content: tForm.content }) }); setPreview(r.preview) }
    catch (e: any) { flash('预览失败: ' + (e.error || e.message)) }
  }
  const saveTemplate = async () => {
    if (!tForm.name || !tForm.content) { flash('请填写模板名称和内容'); return }
    if (tForm.smsType === 'template' && !tForm.templateId) { flash('模板短信需填写平台模板ID'); return }
    setBusy('template')
    try {
      const payload: any = {
        name: tForm.name, content: tForm.content, triggerType: tForm.triggerType,
        smsType: tForm.smsType, templateId: tForm.templateId,
        paramFields: tForm.paramFields ? tForm.paramFields.split(',').map(s => s.trim()).filter(Boolean) : undefined,
      }
      if (tEdit) { await apiFetch(`/api/sms/templates/${tEdit}`, { method: 'PUT', body: JSON.stringify(payload) }); flash('模板已更新') }
      else { await apiFetch('/api/sms/templates', { method: 'POST', body: JSON.stringify(payload) }); flash('模板已添加') }
      setTForm({ name: '', content: '', triggerType: 'air', smsType: 'normal', templateId: '', paramFields: '' }); setTEdit(null); setPreview(''); loadTemplates()
    } catch (e: any) { flash('失败: ' + (e.error || e.message)) }
    finally { setBusy('') }
  }
  const toggleTemplate = async (t: Template) => {
    try { await apiFetch(`/api/sms/templates/${t.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !t.enabled }) }); loadTemplates() }
    catch (e: any) { flash('失败: ' + (e.error || e.message)) }
  }
  const delTemplate = async (id: string) => {
    try { await apiFetch(`/api/sms/templates/${id}`, { method: 'DELETE' }); flash('已删除'); loadTemplates() }
    catch (e: any) { flash('失败: ' + (e.error || e.message)) }
  }

  // ── config form ──
  const [cfgForm, setCfgForm] = useState({ masUrl: '', ecName: '', apId: '', secretKey: '', sign: '', addSerial: '' })
  useEffect(() => {
    if (config) setCfgForm(f => ({ ...f, masUrl: config.masUrl || '', ecName: config.ecName || '', apId: config.apId || '', sign: config.sign || '', addSerial: config.addSerial || '' }))
  }, [config])

  const saveConfig = async () => {
    setBusy('config')
    try {
      const payload: any = { ...cfgForm }
      if (!payload.secretKey) delete payload.secretKey // 空则不覆盖已存密钥
      await apiFetch('/api/sms/config', { method: 'POST', body: JSON.stringify(payload) })
      flash('短信配置已保存'); setCfgForm(f => ({ ...f, secretKey: '' })); loadConfig()
    } catch (e: any) { flash('失败: ' + (e.error || e.message)) }
    finally { setBusy('') }
  }
  const testConfig = async () => {
    setBusy('test')
    try { const r = await apiFetch<any>('/api/sms/test', { method: 'POST' }); flash(r.ok ? `✓ ${r.note || '网关可达'}` : `✗ ${r.error}`) }
    catch (e: any) { flash('失败: ' + (e.error || e.message)) }
    finally { setBusy('') }
  }

  // ── manual send ──
  const [sendContent, setSendContent] = useState('')
  const doManualSend = async () => {
    if (!sendContent) { flash('请填写发送内容'); return }
    setBusy('send')
    try {
      const r = await apiFetch<any>('/api/sms/send', { method: 'POST', body: JSON.stringify({ content: sendContent }) })
      flash(r.ok ? '✓ 短信已发送给全部启用联系人' : `✗ ${r.error}`); setSendContent(''); loadHistory()
    } catch (e: any) { flash('失败: ' + (e.error || e.message)) }
    finally { setBusy('') }
  }

  const TABS: { key: Tab; label: string; icon: string }[] = [
    { key: 'contacts', label: '联系人', icon: '👥' },
    { key: 'templates', label: '短信模板', icon: '📝' },
    { key: 'blacklist', label: '黑名单', icon: '🚫' },
    { key: 'config', label: '云MAS配置', icon: '⚙' },
    { key: 'history', label: '发送历史', icon: '📋' },
  ]

  const cellHead: React.CSSProperties = { color: '#5a8aaa', fontSize: 11, fontWeight: 600, padding: '8px 10px', textAlign: 'left', borderBottom: '1px solid rgba(0,80,150,0.25)' }
  const cell: React.CSSProperties = { color: '#9ec5e0', fontSize: 12, padding: '8px 10px', borderBottom: '1px solid rgba(0,60,120,0.15)' }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: '20px 24px', overflow: 'hidden' }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16, flexShrink: 0 }}>
        <div style={{ width: 3, height: 18, background: PURPLE, borderRadius: 1, marginRight: 10 }} />
        <span style={{ color: '#c8e6ff', fontSize: 16, fontWeight: 700, letterSpacing: '0.05em' }}>短信预警推送</span>
        <span style={{ color: '#3a5a70', fontSize: 12, marginLeft: 12 }}>重庆移动云MAS · 空气质量超标自动通知</span>
        {config && (
          <span style={{ marginLeft: 16, fontSize: 12, color: config.configured ? GREEN : AMBER, display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: config.configured ? GREEN : AMBER }} />
            {config.configured ? '已配置' : '未配置'}
          </span>
        )}
        {!hasKey && <span style={{ marginLeft: 'auto', color: AMBER, fontSize: 12 }}>⚠ 未设置 API Key，无法进行写操作</span>}
      </div>

      {/* tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, flexShrink: 0, borderBottom: '1px solid rgba(0,80,150,0.2)' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{ padding: '8px 18px', fontSize: 13, cursor: 'pointer', background: 'transparent', border: 'none',
              borderBottom: tab === t.key ? `2px solid ${PURPLE}` : '2px solid transparent',
              color: tab === t.key ? '#c8e6ff' : '#5a8aaa', fontWeight: tab === t.key ? 600 : 400 }}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* body */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {/* ── 联系人 ── */}
        {tab === 'contacts' && (
          <div style={{ display: 'flex', gap: 20 }}>
            <div style={{ width: 280, flexShrink: 0 }}>
              <div style={{ color: '#7ab8e0', fontSize: 13, fontWeight: 600, marginBottom: 12 }}>{cEdit ? '编辑联系人' : '新增联系人'}</div>
              <Input label="姓名" value={cForm.name} onChange={v => setCForm({ ...cForm, name: v })} placeholder="如 张三" />
              <Input label="手机号" value={cForm.mobile} onChange={v => setCForm({ ...cForm, mobile: v })} placeholder="11位手机号" mono />
              <Input label="分组" value={cForm.group} onChange={v => setCForm({ ...cForm, group: v })} placeholder="默认分组" />
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <button onClick={saveContact} disabled={busy === 'contact'} style={btn(PURPLE)}>{cEdit ? '保存修改' : '添加联系人'}</button>
                {cEdit && <button onClick={() => { setCEdit(null); setCForm({ name: '', mobile: '', group: '默认分组' }) }} style={btn('#5a8aaa', true)}>取消</button>}
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ color: '#5a8aaa', fontSize: 12, marginBottom: 8 }}>共 {contacts.length} 个联系人，启用 {contacts.filter(c => c.enabled).length} 个</div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr><th style={cellHead}>姓名</th><th style={cellHead}>手机号</th><th style={cellHead}>分组</th><th style={cellHead}>状态</th><th style={cellHead}>操作</th></tr></thead>
                <tbody>
                  {contacts.map(c => (
                    <tr key={c.id}>
                      <td style={cell}>{c.name}</td>
                      <td style={{ ...cell, fontFamily: "'JetBrains Mono',monospace" }}>{c.mobile}</td>
                      <td style={cell}>{c.group}</td>
                      <td style={cell}><span style={{ color: c.enabled ? GREEN : '#3a5a70' }}>{c.enabled ? '● 启用' : '○ 停用'}</span></td>
                      <td style={cell}>
                        <button onClick={() => toggleContact(c)} style={{ ...btn(c.enabled ? '#5a8aaa' : GREEN, true), marginRight: 6 }}>{c.enabled ? '停用' : '启用'}</button>
                        <button onClick={() => { setCEdit(c.id); setCForm({ name: c.name, mobile: c.mobile, group: c.group }) }} style={{ ...btn(CYAN, true), marginRight: 6 }}>编辑</button>
                        <button onClick={() => delContact(c.id)} style={btn(RED, true)}>删除</button>
                      </td>
                    </tr>
                  ))}
                  {!contacts.length && <tr><td colSpan={5} style={{ ...cell, textAlign: 'center', color: '#3a5a70', padding: 30 }}>暂无联系人</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── 模板 ── */}
        {tab === 'templates' && (
          <div style={{ display: 'flex', gap: 20 }}>
            <div style={{ width: 360, flexShrink: 0 }}>
              <div style={{ color: '#7ab8e0', fontSize: 13, fontWeight: 600, marginBottom: 12 }}>{tEdit ? '编辑模板' : '新增模板'}</div>
              <Input label="模板名称" value={tForm.name} onChange={v => setTForm({ ...tForm, name: v })} placeholder="如 空气质量超标通知" />
              <div style={{ marginBottom: 12 }}>
                <label style={{ color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 4 }}>触发类型</label>
                <select value={tForm.triggerType} onChange={e => setTForm({ ...tForm, triggerType: e.target.value })}
                  style={{ width: '100%', padding: '7px 10px', background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3, color: '#c8e6ff', fontSize: 13, outline: 'none' }}>
                  <option value="air">空气质量超标</option>
                  <option value="manual">手动发送</option>
                </select>
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={{ color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 4 }}>短信类型</label>
                <select value={tForm.smsType} onChange={e => setTForm({ ...tForm, smsType: e.target.value })}
                  style={{ width: '100%', padding: '7px 10px', background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3, color: '#c8e6ff', fontSize: 13, outline: 'none' }}>
                  <option value="normal">普通短信（自由内容，走 norsubmit）</option>
                  <option value="template">模板短信（平台报备模板，走 tmpsubmit）</option>
                </select>
              </div>
              {tForm.smsType === 'template' && (
                <>
                  <Input label="平台模板ID (templateId)" value={tForm.templateId} onChange={v => setTForm({ ...tForm, templateId: v })} placeholder="平台审核通过后获得" mono />
                  <Input label="变量字段顺序 (逗号分隔)" value={tForm.paramFields} onChange={v => setTForm({ ...tForm, paramFields: v })} placeholder="如 point,pollutant,value,label" mono />
                  <div style={{ color: '#3a5a70', fontSize: 11, lineHeight: 1.7, marginBottom: 10 }}>
                    模板短信发送时，按此顺序从预警数据取值填入平台模板的变量位。可选字段：point/pollutant/value/unit/label/time。下方"短信内容"仅用于本地预览和历史留痕，实际内容由平台模板生成。
                  </div>
                </>
              )}
              <div style={{ marginBottom: 8 }}>
                <label style={{ color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 4 }}>短信内容{tForm.smsType === 'template' ? '（仅本地预览/留痕）' : ''}</label>
                <textarea value={tForm.content} onChange={e => setTForm({ ...tForm, content: e.target.value })}
                  placeholder="支持变量：{point} {pollutant} {value} {unit} {label} {time}" rows={5}
                  style={{ width: '100%', padding: '8px 10px', background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3, color: '#c8e6ff', fontSize: 13, outline: 'none', resize: 'vertical', fontFamily: 'inherit' }} />
              </div>
              <div style={{ color: '#3a5a70', fontSize: 11, lineHeight: 1.7, marginBottom: 10 }}>
                可用变量：<span style={{ color: CYAN, fontFamily: 'monospace' }}>{'{point}'}</span> 点位 ·
                <span style={{ color: CYAN, fontFamily: 'monospace' }}>{'{pollutant}'}</span> 污染物 ·
                <span style={{ color: CYAN, fontFamily: 'monospace' }}>{'{value}'}</span> 数值 ·
                <span style={{ color: CYAN, fontFamily: 'monospace' }}>{'{unit}'}</span> 单位 ·
                <span style={{ color: CYAN, fontFamily: 'monospace' }}>{'{label}'}</span> 预警类型 ·
                <span style={{ color: CYAN, fontFamily: 'monospace' }}>{'{time}'}</span> 时间
              </div>
              {preview && <div style={{ background: 'rgba(0,40,80,0.4)', border: '1px solid rgba(0,150,220,0.2)', borderRadius: 4, padding: 10, marginBottom: 10, fontSize: 12, color: '#9ec5e0', lineHeight: 1.6 }}>预览：{preview}</div>}
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={saveTemplate} disabled={busy === 'template'} style={btn(PURPLE)}>{tEdit ? '保存修改' : '添加模板'}</button>
                <button onClick={doPreview} style={btn(CYAN, true)}>预览</button>
                {tEdit && <button onClick={() => { setTEdit(null); setTForm(f => ({ ...f, name: '', content: '', triggerType: 'air' })); setPreview('') }} style={btn('#5a8aaa', true)}>取消</button>}
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ color: '#5a8aaa', fontSize: 12, marginBottom: 8 }}>共 {templates.length} 个模板</div>
              {templates.map(t => (
                <div key={t.id} style={{ background: 'rgba(0,30,70,0.3)', border: '1px solid rgba(0,80,150,0.2)', borderRadius: 4, padding: 12, marginBottom: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
                    <span style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 600 }}>{t.name}</span>
                    <span style={{ marginLeft: 8, fontSize: 11, color: PURPLE, background: `${PURPLE}18`, padding: '1px 8px', borderRadius: 3 }}>{TRIGGER_LABELS[t.triggerType] || t.triggerType}</span>
                    <span style={{ marginLeft: 8, fontSize: 11, color: t.enabled ? GREEN : '#3a5a70' }}>{t.enabled ? '● 启用' : '○ 停用'}</span>
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                      <button onClick={() => toggleTemplate(t)} style={btn(t.enabled ? '#5a8aaa' : GREEN, true)}>{t.enabled ? '停用' : '启用'}</button>
                      <button onClick={() => { setTEdit(t.id); setTForm({ name: t.name, content: t.content, triggerType: t.triggerType, smsType: t.smsType || 'normal', templateId: t.templateId || '', paramFields: (t.paramFields || []).join(',') }); setPreview('') }} style={btn(CYAN, true)}>编辑</button>
                      <button onClick={() => delTemplate(t.id)} style={btn(RED, true)}>删除</button>
                    </span>
                  </div>
                  <div style={{ color: '#9ec5e0', fontSize: 12, lineHeight: 1.6 }}>{t.content}</div>
                </div>
              ))}
              {!templates.length && <div style={{ textAlign: 'center', color: '#3a5a70', padding: 30 }}>暂无模板</div>}
            </div>
          </div>
        )}

        {/* ── 黑名单 ── */}
        {tab === 'blacklist' && (
          <div style={{ display: 'flex', gap: 20 }}>
            <div style={{ width: 280, flexShrink: 0 }}>
              <div style={{ color: '#7ab8e0', fontSize: 13, fontWeight: 600, marginBottom: 12 }}>加入黑名单</div>
              <div style={{ color: '#3a5a70', fontSize: 11, lineHeight: 1.7, marginBottom: 10 }}>
                黑名单中的号码在所有发送（自动预警+手动）时都会被过滤，不会收到短信。
              </div>
              <Input label="手机号" value={blForm.mobile} onChange={v => setBlForm({ ...blForm, mobile: v })} placeholder="11位手机号" mono />
              <Input label="原因（可选）" value={blForm.reason} onChange={v => setBlForm({ ...blForm, reason: v })} placeholder="如 退订 / 错误号码" />
              <button onClick={addBlacklist} disabled={busy === 'bl'} style={{ ...btn(RED), marginTop: 6 }}>加入黑名单</button>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ color: '#5a8aaa', fontSize: 12, marginBottom: 8 }}>共 {blacklist.length} 个黑名单号码</div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr><th style={cellHead}>手机号</th><th style={cellHead}>原因</th><th style={cellHead}>加入时间</th><th style={cellHead}>操作</th></tr></thead>
                <tbody>
                  {blacklist.map(b => (
                    <tr key={b.id}>
                      <td style={{ ...cell, fontFamily: "'JetBrains Mono',monospace" }}>{b.mobile}</td>
                      <td style={cell}>{b.reason || '—'}</td>
                      <td style={cell}>{b.createdAt ? new Date(b.createdAt).toLocaleString('zh-CN', { hour12: false }) : '—'}</td>
                      <td style={cell}><button onClick={() => delBlacklist(b.id)} style={btn(GREEN, true)}>移出</button></td>
                    </tr>
                  ))}
                  {!blacklist.length && <tr><td colSpan={4} style={{ ...cell, textAlign: 'center', color: '#3a5a70', padding: 30 }}>暂无黑名单</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── 配置 ── */}
        {tab === 'config' && (
          <div style={{ maxWidth: 520 }}>
            <div style={{ color: '#7ab8e0', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>重庆移动云MAS 接口配置</div>
            <div style={{ color: '#3a5a70', fontSize: 11, lineHeight: 1.7, marginBottom: 16 }}>
              参数在中国移动云MAS平台申请。secretKey 出于安全不回显，留空表示不修改已保存的密钥。
            </div>
            <Input label="网关地址 (masUrl)" value={cfgForm.masUrl} onChange={v => setCfgForm({ ...cfgForm, masUrl: v })} placeholder="http://网关IP:端口/sms/norsubmit" mono />
            <Input label="集团名称 (ecName)" value={cfgForm.ecName} onChange={v => setCfgForm({ ...cfgForm, ecName: v })} placeholder="云MAS 集团名称" />
            <Input label="接口账号 (apId)" value={cfgForm.apId} onChange={v => setCfgForm({ ...cfgForm, apId: v })} placeholder="接口账号" mono />
            <Input label="接口密码 (secretKey)" value={cfgForm.secretKey} onChange={v => setCfgForm({ ...cfgForm, secretKey: v })} placeholder={config?.configured ? '已配置（留空不修改）' : '接口密码'} type="password" mono />
            <Input label="签名编码 (sign)" value={cfgForm.sign} onChange={v => setCfgForm({ ...cfgForm, sign: v })} placeholder="如 zHsmzt" mono />
            <Input label="拓展码 (addSerial，可空)" value={cfgForm.addSerial} onChange={v => setCfgForm({ ...cfgForm, addSerial: v })} placeholder="可留空" mono />
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button onClick={saveConfig} disabled={busy === 'config'} style={btn(PURPLE)}>保存配置</button>
              <button onClick={testConfig} disabled={busy === 'test'} style={btn(CYAN, true)}>测试网关连通</button>
            </div>
            <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid rgba(0,60,120,0.2)' }}>
              <div style={{ color: '#7ab8e0', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>频率限制说明</div>
              <div style={{ color: '#5a8aaa', fontSize: 12, lineHeight: 1.7 }}>
                同一预警（点位 + 污染物 + 预警类型）在 30 分钟内只发送一次短信，避免重复轰炸。该窗口在后端 SMS_DEDUP_WINDOW_MS 配置。
              </div>
            </div>
          </div>
        )}

        {/* ── 历史 ── */}
        {tab === 'history' && (
          <div>
            <div style={{ background: 'rgba(0,30,70,0.3)', border: '1px solid rgba(0,80,150,0.2)', borderRadius: 4, padding: 14, marginBottom: 16 }}>
              <div style={{ color: '#7ab8e0', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>手动群发（发给全部启用联系人）</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input value={sendContent} onChange={e => setSendContent(e.target.value)} placeholder="输入短信内容"
                  style={{ flex: 1, padding: '7px 10px', background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3, color: '#c8e6ff', fontSize: 13, outline: 'none' }} />
                <button onClick={doManualSend} disabled={busy === 'send'} style={btn(PURPLE)}>发送</button>
                <button onClick={loadHistory} style={btn(CYAN, true)}>刷新</button>
              </div>
            </div>
            <div style={{ color: '#5a8aaa', fontSize: 12, marginBottom: 8 }}>共 {history.length} 条发送记录</div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={cellHead}>时间</th><th style={cellHead}>触发</th><th style={cellHead}>内容</th><th style={cellHead}>收信</th><th style={cellHead}>状态</th></tr></thead>
              <tbody>
                {pagedHistory.map(h => (
                  <tr key={h.id}>
                    <td style={{ ...cell, fontFamily: "'JetBrains Mono',monospace", whiteSpace: 'nowrap' }}>{new Date(h.time).toLocaleString('zh-CN', { hour12: false })}</td>
                    <td style={cell}><span style={{ color: h.trigger === 'manual' ? CYAN : PURPLE }}>{TRIGGER_LABELS[h.trigger === 'auto-warning' ? 'air' : h.trigger] || h.trigger}</span></td>
                    <td style={{ ...cell, maxWidth: 320 }}>{h.content}</td>
                    <td style={cell}>{h.recipientCount ?? h.recipients?.length ?? 0} 人</td>
                    <td style={cell}>
                      <span style={{ color: h.status === 'success' ? GREEN : RED }}>{h.status === 'success' ? '✓ 成功' : '✗ 失败'}</span>
                      {h.error && <span style={{ color: '#5a8aaa', fontSize: 11, marginLeft: 6 }}>{h.error}</span>}
                    </td>
                  </tr>
                ))}
                {!pagedHistory.length && <tr><td colSpan={5} style={{ ...cell, textAlign: 'center', color: '#3a5a70', padding: 30 }}>暂无发送记录</td></tr>}
              </tbody>
            </table>
            {/* 历史分页 */}
            {history.length > HISTORY_PAGE_SIZE && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
                <button onClick={() => setHistPage(p => Math.max(1, p - 1))} disabled={safeHistPage <= 1} style={btn(CYAN, 'sm')}>‹ 上一页</button>
                <span style={{ color: '#7ab8e0', fontSize: 12, fontFamily: "'JetBrains Mono',monospace" }}>第 {safeHistPage} / {histTotalPages} 页</span>
                <button onClick={() => setHistPage(p => Math.min(histTotalPages, p + 1))} disabled={safeHistPage >= histTotalPages} style={btn(CYAN, 'sm')}>下一页 ›</button>
                <span style={{ color: '#3a5a70', fontSize: 11, marginLeft: 'auto' }}>每页 {HISTORY_PAGE_SIZE} 条</span>
              </div>
            )}
          </div>
        )}
      </div>

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 4000,
          background: '#061530', border: '1px solid rgba(0,150,220,0.4)', borderRadius: 4, padding: '10px 20px',
          color: '#c8e6ff', fontSize: 13, boxShadow: '0 4px 20px rgba(0,0,0,0.5)' }}>{toast}</div>
      )}
    </div>
  )
}
