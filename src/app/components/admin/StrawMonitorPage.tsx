import { useState, useEffect, useCallback } from 'react'
import { StrawEnginePage, StrawReviewBoard } from './StrawEnginePage'
import { RunPipeline, LiveDetection } from './StrawLivePage'
import { StrawResultsView } from './StrawResultsView'
import { StreamPanel } from './StreamPanel'
import { SikongPanel } from './SikongPanel'
import { NegClassifyVerify } from './NegClassifyVerify'
import { PushLogPage } from './PushLogPage'
import { authFetch } from '../../lib/apiFetch'
import type { CurrentUser } from '../../lib/auth'
import type { LucideIcon } from 'lucide-react'
import { Brain, Workflow, Radar, Video, Satellite, Landmark, ClipboardList, Save, Palette, ListChecks, PenLine, Eye, ScanSearch, ScanEye, Send } from 'lucide-react'

// ── 秸秆焚烧监控 · 独立功能点（无人机视角）──
// 数据边界：source='straw-engine' 的自研推理告警，与 AI分析存档（IoTCloud）完全隔离

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

interface RespRow {
  id: number
  district: string
  town: string
  community: string
  unit: string
  person: string
  phone: string
  webhook: string
  remark: string
}

const EMPTY_FORM = { town: '', community: '', unit: '', person: '', phone: '', webhook: '', remark: '' }

interface Props {
  user: CurrentUser
}

export function StrawMonitorPage({ user }: Props) {
  const [tab, setTab] = useState<'engine' | 'pipeline' | 'live' | 'streams' | 'sikong' | 'responsibility' | 'style' | 'results' | 'negverify' | 'pushlog'>('engine')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 页头 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <div style={{ width: 3, height: 18, background: ORANGE, borderRadius: 1 }} />
        <span style={{ color: '#c8e6ff', fontSize: 16, fontWeight: 700 }}>秸秆焚烧监控</span>
        <span style={{ fontSize: 12, color: '#5a8aaa' }}>
          无人机视角 · 自研推理引擎（source=straw-engine）· 与 AI分析存档（IoTCloud）隔离
        </span>
      </div>

      {/* Tab 切换 */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {([
          ['engine', '引擎健康 / 告警工作台', Brain],
          ['results', '检测结果', ScanSearch],
          ['pipeline', '运行链路全景', Workflow],
          ['live', '实时检测过程', Radar],
          ['streams', '视频流面板', Video],
          ['sikong', '司空设备', Satellite],
          ['negverify', '抽检标注', ScanEye],
          ['responsibility', '责任映射 / 微信群推送', Landmark],
          ['style', '推送样式', ClipboardList],
          ['pushlog', '推送记录', Send],
        ] as const).map(([key, label, Icon]) => (
          <button key={key} onClick={() => setTab(key)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '6px 18px', fontSize: 13, borderRadius: 4, cursor: 'pointer', fontWeight: 600,
            border: `1px solid ${tab === key ? ORANGE : 'rgba(255,112,67,0.25)'}`,
            background: tab === key ? 'rgba(255,112,67,0.15)' : 'transparent',
            color: tab === key ? ORANGE : '#5a8aaa',
          }}>{Icon && <Icon size={14} strokeWidth={1.75} />}{label}</button>
        ))}
      </div>

      {tab === 'engine' ? <StrawEnginePage />
        : tab === 'results' ? <StrawResultsView />
        : tab === 'pipeline' ? <RunPipeline />
        : tab === 'live' ? <LiveDetection />
        : tab === 'streams' ? <StreamPanel />
        : tab === 'sikong' ? <SikongPanel />
        : tab === 'negverify' ? <NegClassifyVerify />
        : tab === 'responsibility' ? <ResponsibilityManager />
        : tab === 'pushlog' ? <PushLogPage user={user} />
        : <PushStyleEditor />}
    </div>
  )
}

// ── 责任映射管理：乡镇 → 责任单位 → 微信群 webhook ──
function ResponsibilityManager() {
  const [rows, setRows] = useState<RespRow[]>([])
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    authFetch('/api/straw/area-responsibility')
      .then(r => r.json())
      .then(d => setRows(Array.isArray(d) ? d : []))
      .catch(() => {})
  }, [])

  useEffect(() => { load() }, [load])

  const submit = async () => {
    if (!form.town || !form.unit) { setMsg('乡镇与责任单位必填'); return }
    setBusy(true)
    setMsg('')
    try {
      const r = await authFetch('/api/straw/area-responsibility/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: [{
          town: form.town, community: form.community, unit: form.unit,
          person: form.person, phone: form.phone, webhook: form.webhook, remark: form.remark,
        }] }),
      })
      const d = await r.json()
      if (d.ok) {
        setMsg(`✓ 已保存（${form.town} ${form.community || '(乡镇兜底)'} → ${form.unit}）`)
        setShowForm(false)
        setForm(EMPTY_FORM)
        load()
      } else {
        setMsg('失败: ' + (d.error || ''))
      }
    } catch (e: any) {
      setMsg('失败: ' + (e?.message || e))
    }
    setBusy(false)
    setTimeout(() => setMsg(''), 4000)
  }

  const remove = async (row: RespRow) => {
    if (!confirm(`删除责任映射：${row.town} ${row.community || ''} → ${row.unit}？`)) return
    try {
      await authFetch(`/api/straw/area-responsibility/${row.id}`, { method: 'DELETE' })
      load()
    } catch {}
  }

  const edit = (row: RespRow) => {
    setForm({ town: row.town, community: row.community, unit: row.unit, person: row.person, phone: row.phone, webhook: row.webhook, remark: row.remark })
    setShowForm(true)
  }

  const inputStyle: React.CSSProperties = {
    background: 'rgba(0,20,60,0.6)', color: '#c8e6ff', border: '1px solid rgba(0,150,220,0.3)',
    borderRadius: 3, padding: '5px 8px', fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 统计卡 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        <div style={{ ...card }}>
          <div style={{ fontSize: 12, color: '#5a8aaa' }}>责任映射总数</div>
          <div style={{ color: '#c8e6ff', fontSize: 20, fontWeight: 700 }}>{rows.length}</div>
        </div>
        <div style={{ ...card }}>
          <div style={{ fontSize: 12, color: '#5a8aaa' }}>已配置微信群</div>
          <div style={{ color: rows.filter(r => r.webhook).length > 0 ? GREEN : AMBER, fontSize: 20, fontWeight: 700 }}>
            {rows.filter(r => r.webhook).length}
          </div>
        </div>
        <div style={{ ...card }}>
          <div style={{ fontSize: 12, color: '#5a8aaa' }}>覆盖乡镇/街道</div>
          <div style={{ color: CYAN, fontSize: 20, fontWeight: 700 }}>{new Set(rows.map(r => r.town)).size}</div>
        </div>
      </div>

      {/* 操作栏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={() => { setForm(EMPTY_FORM); setShowForm(!showForm) }} style={{
          padding: '6px 16px', fontSize: 12, fontWeight: 700, cursor: 'pointer', borderRadius: 4,
          border: 'none', color: '#fff', background: 'linear-gradient(90deg, #0080d0, #00aaff)',
        }}>{showForm ? '取消' : '+ 新增责任映射'}</button>
        <button onClick={load} style={{
          padding: '6px 14px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
          border: '1px solid rgba(0,150,220,0.3)', background: 'rgba(0,80,180,0.12)', color: '#7ab8e0',
        }}>刷新</button>
        {msg && <span style={{ fontSize: 12, color: msg.startsWith('✓') ? GREEN : RED }}>{msg}</span>}
      </div>

      {/* 新增/编辑表单 */}
      {showForm && (
        <div style={{ ...card, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
          {([
            ['town', '乡镇/街道*'], ['community', '社区/村（可选）'], ['unit', '责任单位*'],
            ['person', '责任人'], ['phone', '电话'], ['webhook', '微信群 Webhook'], ['remark', '备注'],
          ] as const).map(([key, label]) => (
            <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ color: '#5a8aaa', fontSize: 11 }}>{label}</span>
              <input value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} style={inputStyle} />
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button onClick={submit} disabled={busy} style={{
              padding: '7px 20px', fontSize: 12, fontWeight: 700, cursor: busy ? 'wait' : 'pointer', borderRadius: 4,
              border: 'none', color: '#fff', background: busy ? '#3a5a70' : 'linear-gradient(90deg, #0e8f4a, #1fb96a)',
            }}>{busy ? '保存中…' : '保存'}</button>
          </div>
        </div>
      )}

      {/* 列表 */}
      <div style={{ overflowX: 'auto', ...card, padding: 0 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'rgba(4,14,35,0.98)', borderBottom: '1px solid rgba(0,80,150,0.2)' }}>
              {['乡镇/街道', '社区/村', '责任单位', '责任人', '微信群 Webhook', '操作'].map(h => (
                <th key={h} style={{ padding: '8px 10px', textAlign: 'left', color: '#5a8aaa', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={6} style={{ padding: '30px 0', textAlign: 'center', color: '#3a5a70' }}>暂无责任映射，点击"+ 新增责任映射"导入</td></tr>
            )}
            {rows.map((r, i) => (
              <tr key={r.id} style={{ borderBottom: '1px solid rgba(0,50,100,0.15)', background: i % 2 ? 'rgba(0,20,50,0.2)' : 'transparent' }}>
                <td style={{ padding: '7px 10px', color: '#c8e6ff', fontWeight: 600 }}>{r.town}</td>
                <td style={{ padding: '7px 10px', color: '#5a8aaa' }}>{r.community || '—'}</td>
                <td style={{ padding: '7px 10px', color: '#7ab8e0' }}>{r.unit || '—'}</td>
                <td style={{ padding: '7px 10px', color: '#c8e6ff' }}>{r.person || '—'}{r.phone ? `（${r.phone}）` : ''}</td>
                <td style={{ padding: '7px 10px', fontSize: 11 }}>
                  {r.webhook ? (
                    <span style={{ color: GREEN, fontFamily: "'JetBrains Mono', monospace", fontSize: 10 }}>
                      ✓ {r.webhook.replace(/^https?:\/\//, '').slice(0, 34)}…
                    </span>
                  ) : (
                    <span style={{ color: AMBER }}>未配置</span>
                  )}
                </td>
                <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>
                  <button onClick={() => edit(r)} style={{
                    padding: '2px 10px', fontSize: 11, cursor: 'pointer', marginRight: 6, borderRadius: 3,
                    border: '1px solid rgba(0,150,220,0.3)', background: 'rgba(0,80,180,0.12)', color: '#7ab8e0',
                  }}>编辑</button>
                  <button onClick={() => remove(r)} style={{
                    padding: '2px 10px', fontSize: 11, cursor: 'pointer', borderRadius: 3,
                    border: '1px solid rgba(255,80,80,0.3)', background: 'rgba(255,60,60,0.1)', color: RED,
                  }}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize: 11, color: '#3a5a70', lineHeight: 1.8 }}>
        <b style={{ color: '#5a8aaa' }}>说明</b>：告警触发后按 乡镇/街道 → 社区/村 匹配责任单位（社区级优先，无则乡镇兜底），再推送到对应微信群。
        微信 Webhook 为 <code style={{ color: AMBER }}>企业微信群机器人</code> 地址（https://qyapi.weixin.qq.com/...）。demo 环境使用模拟 key，真实 key 由客户提供后即可实战推送。
      </div>
    </div>
  )
}

// ── 推送样式配置：主题色 / 标题模板 / 字段开关排序 / 落款（保存即热生效）──
const FIELD_OPTIONS: { key: string; label: string }[] = [
  { key: 'district', label: '行政区划' },
  { key: 'unit', label: '责任单位' },
  { key: 'person', label: '责任人' },
  { key: 'confidence', label: '置信度' },
  { key: 'coord', label: '坐标' },
  { key: 'map', label: '地图链接' },
]
const DEFAULT_STYLE = {
  accent: '#37c8ff', bg: '#101e33', panel: '#16283f', border: '#2a4a70',
  titleTemplate: '{emoji} {label}告警 · {town}',
  fields: ['district', 'unit', 'person', 'confidence', 'coord', 'map'],
  footer: '【万州区生态环境局】请及时处置并反馈',
  msgTitle: '🚨 秸秆焚烧告警 · {town}',
  // T20：markdown 尾部可选追加（卡片渲染失败自动降级 markdown 时同样生效）
  msgFooter: '',                    // 落款行（纯文本，追加在消息末尾）
  reviewLinkBase: '',               // 复核直达链接前缀（默认 http://PUBLIC_HOST:81/jsc/）
  appendReviewLink: true,           // 是否在消息尾追加「复核直达」链接
  fallbackToMarkdown: true,         // news 卡片渲染失败/禁用时降级 markdown 仍推送
  // T21：推送失败自动重试（webhook 返回失败/超时自动重发；默认关闭）
  autoRetry: false,                 // 失败自动重试开关
  retryTimes: 1,                    // 重试次数
  retryDelayMs: 5000,               // 重试间隔（毫秒）
}

function PushStyleEditor() {
  const [style, setStyle] = useState<any>(DEFAULT_STYLE)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    authFetch('/api/straw/push-style').then(r => r.json()).then(d => {
      if (d && typeof d === 'object') setStyle({ ...DEFAULT_STYLE, ...d })
    }).catch(() => {})
  }, [])
  useEffect(() => { load() }, [load])

  const set = (k: string, v: any) => setStyle((s: any) => ({ ...s, [k]: v }))

  const moveField = (i: number, dir: number) => {
    const fields = [...style.fields]
    const j = i + dir
    if (j < 0 || j >= fields.length) return
    ;[fields[i], fields[j]] = [fields[j], fields[i]]
    set('fields', fields)
  }

  const save = async () => {
    setBusy(true); setMsg('')
    try {
      const r = await authFetch('/api/straw/push-style', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(style),
      })
      const d = await r.json()
      setMsg(d.ok ? '✓ 已保存 · 下次推送立即生效' : '保存失败: ' + (d.error || r.status))
    } catch (e: any) { setMsg('保存失败: ' + (e?.message || e)) }
    setBusy(false)
    setTimeout(() => setMsg(''), 4000)
  }

  const reset = () => {
    if (!confirm('恢复默认样式？')) return
    setStyle(DEFAULT_STYLE)
  }

  const inputStyle: React.CSSProperties = {
    background: 'rgba(0,20,60,0.6)', color: '#c8e6ff', border: '1px solid rgba(0,150,220,0.3)',
    borderRadius: 3, padding: '5px 8px', fontSize: 12, fontFamily: "'JetBrains Mono',monospace",
  }
  const colorBtn = (k: string) => (
    <input type="color" value={style[k] || '#000000'} onChange={e => set(k, e.target.value)} style={{
      width: 44, height: 28, padding: 0, border: '1px solid rgba(0,150,220,0.3)', borderRadius: 3,
      background: 'transparent', cursor: 'pointer',
    }} />
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 操作栏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={save} disabled={busy} style={{
          padding: '6px 18px', fontSize: 12, fontWeight: 700, cursor: busy ? 'wait' : 'pointer', borderRadius: 4,
          border: 'none', color: '#fff', background: busy ? '#3a5a70' : 'linear-gradient(90deg, #0e8f4a, #1fb96a)',
        }}>{busy ? '保存中…' : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Save size={13} strokeWidth={1.75} />保存样式
          </span>
        )}</button>
        <button onClick={reset} style={{
          padding: '6px 12px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
          border: '1px solid rgba(255,170,60,0.4)', background: 'rgba(255,170,60,0.1)', color: AMBER,
        }}>恢复默认</button>
        <button onClick={load} style={{
          padding: '6px 12px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
          border: '1px solid rgba(0,150,220,0.3)', background: 'rgba(0,80,180,0.12)', color: '#7ab8e0',
        }}>重新加载</button>
        {msg && <span style={{ fontSize: 12, color: msg.startsWith('✓') ? GREEN : RED }}>{msg}</span>}
        <span style={{ fontSize: 11, color: '#3a5a70', marginLeft: 'auto' }}>保存后立即生效 · 未配置时使用默认样式</span>
      </div>

      {/* 样式配置 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
        {/* 卡片主题色 */}
        <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ color: '#7ab8e0', fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Palette size={14} strokeWidth={1.75} />卡片主题色
          </div>
          {([
            ['accent', '主色（强调/标题条）'], ['bg', '背景色'],
            ['panel', '面板色'], ['border', '边框色'],
          ] as const).map(([k, label]) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ color: '#5a8aaa', fontSize: 12, width: 130 }}>{label}</span>
              {colorBtn(k)}
              <input value={style[k] || ''} onChange={e => set(k, e.target.value)} style={{ ...inputStyle, width: 110 }} />
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: '#5a8aaa', fontSize: 12, width: 130 }}>卡片标题模板</span>
            <input value={style.titleTemplate || ''} onChange={e => set('titleTemplate', e.target.value)} style={{ ...inputStyle, flex: 1 }} />
          </div>
          <div style={{ fontSize: 11, color: '#3a5a70' }}>变量：{'<' + '{emoji}>'} 火/烟图标 · {`{label}`} fire/smoke · {`{town}`} 乡镇名（例：{`{emoji} {label}告警 · {town}`}）</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: '#5a8aaa', fontSize: 12, width: 130 }}>消息标题模板</span>
            <input value={style.msgTitle || ''} onChange={e => set('msgTitle', e.target.value)} style={{ ...inputStyle, flex: 1 }} />
          </div>
          <div style={{ fontSize: 11, color: '#3a5a70' }}>markdown 首行标题：{`{town}`}/{`{label}`} 占位（例：🚨 秸秆焚烧告警 · {`{town}`}）</div>
        </div>

        {/* 字段配置 */}
        <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ color: '#7ab8e0', fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
            <ListChecks size={14} strokeWidth={1.75} />卡片显示字段（勾选 + 排序）
          </div>
          {FIELD_OPTIONS.map((f, i) => {
            const enabled = (style.fields || []).includes(f.key)
            return (
              <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                <input type="checkbox" checked={enabled}
                  onChange={e => {
                    const fields = e.target.checked
                      ? [...(style.fields || []), f.key]
                      : (style.fields || []).filter((k: string) => k !== f.key)
                    set('fields', fields)
                  }}
                  style={{ cursor: 'pointer' }} />
                <span style={{ color: enabled ? '#c8e6ff' : '#3a5a70', fontSize: 12, width: 80 }}>{f.label}</span>
                {enabled && (
                  <span style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
                    <button onClick={() => moveField(i, -1)} disabled={i === 0} style={arrowBtn}>↑</button>
                    <button onClick={() => moveField(i, 1)} disabled={i === style.fields.length - 1} style={arrowBtn}>↓</button>
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* 落款 */}
      <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ color: '#7ab8e0', fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
          <PenLine size={14} strokeWidth={1.75} />卡片落款文案
        </div>
        <input value={style.footer || ''} onChange={e => set('footer', e.target.value)} placeholder="如：请及时处置并反馈" style={inputStyle} />
      </div>

      {/* T20 消息高级选项：落款 / 复核直达 / 降级策略 */}
      <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ color: '#7ab8e0', fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Send size={14} strokeWidth={1.75} />消息高级选项（markdown / 降级 / 重试）
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: '#5a8aaa', fontSize: 12, width: 130 }}>消息尾部落款</span>
          <input value={style.msgFooter || ''} onChange={e => set('msgFooter', e.target.value)} placeholder="如：请及时处置并反馈（markdown 尾行，可留空）" style={{ ...inputStyle, flex: 1 }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: '#5a8aaa', fontSize: 12, width: 130 }}>复核链接地址</span>
          <input value={style.reviewLinkBase || ''} onChange={e => set('reviewLinkBase', e.target.value)} placeholder="留空=驾驶舱默认地址（http://外网IP:81/jsc/）" style={{ ...inputStyle, flex: 1 }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: '#7ab8e0', fontSize: 12 }}>
            <input type="checkbox" checked={style.appendReviewLink !== false} onChange={e => set('appendReviewLink', e.target.checked)} style={{ cursor: 'pointer' }} />
            消息尾追加「复核直达」链接
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: '#7ab8e0', fontSize: 12 }}>
            <input type="checkbox" checked={style.fallbackToMarkdown !== false} onChange={e => set('fallbackToMarkdown', e.target.checked)} style={{ cursor: 'pointer' }} />
            news 卡片失败自动降级 markdown
          </label>
        </div>
        <div style={{ fontSize: 11, color: '#3a5a70' }}>复核直达：消息尾自动追加「🔎 复核直达 · 告警ID」链接（{`?openAlert=`}），打开驾驶舱自动定位该告警。取消勾选仅去链接，不影响卡片推送。</div>
        {/* T21 推送失败自动重试 */}
        <div style={{ borderTop: '1px dashed rgba(0,150,220,0.2)', paddingTop: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: '#7ab8e0', fontSize: 12 }}>
            <input type="checkbox" checked={style.autoRetry === true} onChange={e => set('autoRetry', e.target.checked)} style={{ cursor: 'pointer' }} />
            推送失败自动重试
          </label>
          {style.autoRetry === true && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#5a8aaa' }}>
              重试
              <input type="number" min={1} max={5} value={Number(style.retryTimes) || 1}
                onChange={e => set('retryTimes', Math.max(1, Math.min(5, Number(e.target.value) || 1)))}
                style={{ ...inputStyle, width: 52 }} />
              次 · 间隔
              <input type="number" min={1} max={60} value={Math.round((Number(style.retryDelayMs) || 5000) / 1000)}
                onChange={e => set('retryDelayMs', Math.max(1, Math.min(60, Number(e.target.value) || 5)) * 1000)}
                style={{ ...inputStyle, width: 52 }} />
              秒
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: '#3a5a70' }}>失败重试：webhook 返回失败或请求超时时自动重发（默认关闭，主推与复核更正均生效）。全部重试仍失败才最终落失败态，推送记录会标注重试次数。</div>
      </div>

      {/* 预览 */}
      <div style={{ ...card }}>
        <div style={{ color: '#7ab8e0', fontSize: 13, fontWeight: 700, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Eye size={14} strokeWidth={1.75} />样式预览
        </div>
        <div style={{ borderRadius: 6, overflow: 'hidden', maxWidth: 480, border: `1px solid ${style.border || '#2a4a70'}` }}>
          {/* 标题条 */}
          <div style={{ background: style.panel, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 4, alignSelf: 'stretch', background: style.accent }} />
            <div style={{ color: '#fff', fontSize: 15, fontWeight: 700 }}>
              {(style.titleTemplate || '').replace('{emoji}', '🔥').replace('{label}', '秸秆燃烧').replace('{town}', '高笋塘街道')}
            </div>
            <div style={{ marginLeft: 'auto', color: '#7f9bb8', fontSize: 11 }}>2026-08-22 18:00</div>
          </div>
          {/* 图片占位 */}
          <div style={{ height: 100, background: style.panel, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3a5a70', fontSize: 12 }}>
            [ 现场检测图 ]
          </div>
          {/* 字段区 */}
          <div style={{ background: style.bg, borderTop: `1px solid ${style.border || '#2a4a70'}` }}>
            {(style.fields || []).map((key: string) => {
              const opt = FIELD_OPTIONS.find(o => o.key === key)
              if (!opt) return null
              return (
                <div key={key} style={{ display: 'flex', gap: 12, padding: '7px 16px', borderBottom: `1px solid ${style.border || '#2a4a70'}33` }}>
                  <span style={{ color: style.accent, width: 70, fontSize: 12 }}>{opt.label}</span>
                  <span style={{ color: '#e8f1ff', fontSize: 12 }}>
                    {key === 'district' ? '万州区 · 高笋塘街道' : key === 'unit' ? '高笋塘街道办事处' : key === 'person' ? '王主任' : key === 'confidence' ? '93.5% (fire)' : key === 'coord' ? '108.384,30.816' : '腾讯地图'}
                  </span>
                </div>
              )
            })}
            {style.footer && (
              <div style={{ padding: '8px 16px', color: '#7f9bb8', fontSize: 11 }}>{style.footer}</div>
            )}
            {/* T20 预览：markdown 尾行（msgFooter + 复核直达），与真实推送一致 */}
            <div style={{ borderTop: `1px dashed ${style.border || '#2a4a70'}55`, padding: '8px 16px 4px', color: '#7f9bb8', fontSize: 11, lineHeight: 1.8 }}>
              {style.msgFooter && <div>{style.msgFooter}</div>}
              {style.appendReviewLink !== false && <div style={{ color: '#37c8ff' }}>🔎 复核直达 · JSC20260903xxxx（打开驾驶舱定位）</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
const arrowBtn: React.CSSProperties = {
  padding: '1px 8px', fontSize: 11, cursor: 'pointer', borderRadius: 3,
  border: '1px solid rgba(0,150,220,0.3)', background: 'rgba(0,80,180,0.12)', color: '#7ab8e0',
}
