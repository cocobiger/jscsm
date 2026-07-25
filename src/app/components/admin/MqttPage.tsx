import { useState } from 'react'
import { useDashboard } from '../../context/DashboardContext'
import type { MqttTopic } from '../../context/DashboardContext'

const CYAN = '#00aaff'
const GREEN = '#00e676'
const AMBER = '#ffd740'
const ORANGE = '#ff7043'
const RED = '#ff4444'
const PURPLE = '#ab47bc'

const DATA_TYPE_LABELS: Record<string, string> = {
  air_quality: '大气质量',
  water_quality: '水质数据',
  device_status: '设备状态',
  alert: '告警信息',
  custom: '自定义',
}
const DATA_TYPE_COLORS: Record<string, string> = {
  air_quality: CYAN,
  water_quality: '#00bcd4',
  device_status: GREEN,
  alert: RED,
  custom: PURPLE,
}
const DATA_TYPES = Object.keys(DATA_TYPE_LABELS) as MqttTopic['dataType'][]

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 5 }}>{label}</label>
      {children}
    </div>
  )
}

function TextInput({ value, onChange, placeholder, mono, type = 'text' }: {
  value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean; type?: string
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        width: '100%', padding: '7px 10px',
        background: 'rgba(0,20,60,0.6)',
        border: '1px solid rgba(0,150,220,0.25)',
        borderRadius: 3, color: '#c8e6ff', fontSize: 13,
        fontFamily: mono ? "'JetBrains Mono', monospace" : 'inherit',
        outline: 'none',
      }}
    />
  )
}

export function MqttPage() {
  const { mqttConfig, setMqttConfig, mqttStatus, simulateMqttConnect, simulateMqttDisconnect, status } = useDashboard()
  const [showPassword, setShowPassword] = useState(false)
  const [newTopic, setNewTopic] = useState<Omit<MqttTopic, 'id'>>({ topic: '', dataType: 'alert', description: '', enabled: true })
  const [showTopicForm, setShowTopicForm] = useState(false)
  const [editTopicId, setEditTopicId] = useState<string | null>(null)

  const updateBroker = (patch: Partial<typeof mqttConfig>) =>
    setMqttConfig({ ...mqttConfig, ...patch })

  const addTopic = () => {
    if (!newTopic.topic) return
    const id = editTopicId ?? `t-${Date.now()}`
    if (editTopicId) {
      setMqttConfig({ ...mqttConfig, topics: mqttConfig.topics.map(t => t.id === editTopicId ? { ...t, ...newTopic } : t) })
    } else {
      setMqttConfig({ ...mqttConfig, topics: [...mqttConfig.topics, { ...newTopic, id }] })
    }
    setNewTopic({ topic: '', dataType: 'alert', description: '', enabled: true })
    setShowTopicForm(false)
    setEditTopicId(null)
  }

  const deleteTopic = (id: string) =>
    setMqttConfig({ ...mqttConfig, topics: mqttConfig.topics.filter(t => t.id !== id) })

  const toggleTopic = (id: string) =>
    setMqttConfig({ ...mqttConfig, topics: mqttConfig.topics.map(t => t.id === id ? { ...t, enabled: !t.enabled } : t) })

  const editTopic = (t: MqttTopic) => {
    setNewTopic({ topic: t.topic, dataType: t.dataType, description: t.description, enabled: t.enabled })
    setEditTopicId(t.id)
    setShowTopicForm(true)
  }

  const statusColor = { connected: GREEN, disconnected: '#3a5a70', connecting: AMBER, error: RED }[mqttStatus]
  const statusLabel = { connected: '已连接', disconnected: '未连接', connecting: '连接中…', error: '连接错误' }[mqttStatus]

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', gap: 0 }}>
      {/* Left: broker config */}
      <div style={{ width: 360, flexShrink: 0, borderRight: '1px solid rgba(0,80,150,0.2)', overflowY: 'auto', scrollbarWidth: 'none', padding: '20px' }}>
        <h2 style={{ color: '#c8e6ff', fontSize: 16, fontWeight: 600, marginBottom: 20 }}>MQTT 配置</h2>

        {/* Connection status banner */}
        <div style={{
          padding: '10px 14px', borderRadius: 4, marginBottom: 20,
          background: `${statusColor}15`,
          border: `1px solid ${statusColor}30`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor, boxShadow: mqttStatus === 'connected' ? `0 0 6px ${statusColor}` : 'none' }} />
            <span style={{ color: statusColor, fontSize: 13, fontWeight: 600 }}>{statusLabel}</span>
          </div>
          {mqttStatus === 'connected' && (
            <span style={{ color: '#3a5a70', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
              {status.mqttMessageCount} 条消息
            </span>
          )}
        </div>

        <Field label="连接模式">
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => updateBroker({ mode: 'real' })}
              style={{ flex: 1, padding: '7px 0', fontSize: 12, borderRadius: 3, cursor: 'pointer',
                border: `1px solid ${mqttConfig.mode === 'real' ? GREEN : 'rgba(0,100,180,0.3)'}`,
                background: mqttConfig.mode === 'real' ? `${GREEN}18` : 'transparent',
                color: mqttConfig.mode === 'real' ? GREEN : '#5a8aaa' }}>真实 Broker</button>
            <button onClick={() => updateBroker({ mode: 'mock' })}
              style={{ flex: 1, padding: '7px 0', fontSize: 12, borderRadius: 3, cursor: 'pointer',
                border: `1px solid ${mqttConfig.mode === 'mock' ? AMBER : 'rgba(0,100,180,0.3)'}`,
                background: mqttConfig.mode === 'mock' ? `${AMBER}18` : 'transparent',
                color: mqttConfig.mode === 'mock' ? AMBER : '#5a8aaa' }}>模拟数据</button>
          </div>
          <div style={{ color: '#3a5a70', fontSize: 11, marginTop: 4 }}>
            {mqttConfig.mode === 'real' ? '连接真实 broker（需开启 ws/wss，如 EMQX 8083 端口）' : '本地生成模拟数据，用于演示，无需 broker'}
          </div>
        </Field>

        <Field label="Broker 地址">
          <TextInput value={mqttConfig.brokerUrl} onChange={v => updateBroker({ brokerUrl: v })} placeholder="ws://192.168.1.x:8083/mqtt" mono />
          <div style={{ color: '#3a5a70', fontSize: 11, marginTop: 4 }}>支持 ws:// / wss:// WebSocket 协议</div>
        </Field>
        <Field label="Client ID">
          <TextInput value={mqttConfig.clientId} onChange={v => updateBroker({ clientId: v })} mono />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="用户名">
            <TextInput value={mqttConfig.username} onChange={v => updateBroker({ username: v })} />
          </Field>
          <Field label="密码">
            <div style={{ position: 'relative' }}>
              <TextInput value={mqttConfig.password} onChange={v => updateBroker({ password: v })} type={showPassword ? 'text' : 'password'} />
              <button
                onClick={() => setShowPassword(v => !v)}
                style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#3a5a70', cursor: 'pointer', fontSize: 11 }}
              >{showPassword ? '隐藏' : '显示'}</button>
            </div>
          </Field>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          {mqttStatus === 'disconnected' || mqttStatus === 'error' ? (
            <button onClick={simulateMqttConnect} style={{ flex: 1, ...btn(GREEN) }}>
              <span style={{ marginRight: 4 }}>⚡</span> 连接 Broker
            </button>
          ) : mqttStatus === 'connected' ? (
            <button onClick={simulateMqttDisconnect} style={{ flex: 1, ...btn(RED) }}>断开连接</button>
          ) : (
            <button disabled style={{ flex: 1, ...btn(AMBER), opacity: 0.5 }}>连接中…</button>
          )}
        </div>

        <div style={{ marginTop: 24, padding: '12px 14px', background: 'rgba(0,100,200,0.08)', border: '1px solid rgba(0,150,220,0.15)', borderRadius: 4 }}>
          <div style={{ color: '#5a8aaa', fontSize: 11, lineHeight: 1.8 }}>
            <div style={{ color: '#7ab8e0', marginBottom: 4 }}>数据格式说明</div>
            <div>• 告警 topic 收到 JSON 后按「告警配置」字段映射解析</div>
            <div>• 大气/水质/设备数据自动刷新驾驶舱对应面板</div>
            <div>• 支持 MQTT 5.0 / 3.1.1 协议</div>
          </div>
        </div>
      </div>

      {/* Right: topic subscriptions */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '20px 20px 14px', borderBottom: '1px solid rgba(0,80,150,0.2)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ color: '#c8e6ff', fontSize: 14, fontWeight: 600 }}>Topic 订阅</h3>
            <p style={{ color: '#3a5a70', fontSize: 12, marginTop: 2 }}>配置要订阅的 MQTT 主题及对应数据类型</p>
          </div>
          <button onClick={() => { setNewTopic({ topic: '', dataType: 'alert', description: '', enabled: true }); setEditTopicId(null); setShowTopicForm(true) }} style={btn(GREEN)}>
            + 添加 Topic
          </button>
        </div>

        {/* Topic add/edit form */}
        {showTopicForm && (
          <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(0,80,150,0.15)', background: 'rgba(0,40,100,0.1)', flexShrink: 0 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 2fr', gap: 10, alignItems: 'end' }}>
              <Field label="Topic 路径">
                <TextInput value={newTopic.topic} onChange={v => setNewTopic(t => ({ ...t, topic: v }))} placeholder="env/alerts/# 或 env/air/+" mono />
              </Field>
              <Field label="数据类型">
                <select value={newTopic.dataType} onChange={e => setNewTopic(t => ({ ...t, dataType: e.target.value as MqttTopic['dataType'] }))} style={{
                  width: '100%', padding: '7px 8px',
                  background: 'rgba(0,20,60,0.8)', border: '1px solid rgba(0,150,220,0.25)',
                  borderRadius: 3, color: '#c8e6ff', fontSize: 12, outline: 'none',
                }}>
                  {DATA_TYPES.map(d => <option key={d} value={d}>{DATA_TYPE_LABELS[d]}</option>)}
                </select>
              </Field>
              <Field label="备注">
                <TextInput value={newTopic.description} onChange={v => setNewTopic(t => ({ ...t, description: v }))} placeholder="可选说明" />
              </Field>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={addTopic} disabled={!newTopic.topic} style={{ ...btn(GREEN), opacity: !newTopic.topic ? 0.5 : 1 }}>保存</button>
              <button onClick={() => setShowTopicForm(false)} style={btn('#5a8aaa')}>取消</button>
            </div>
          </div>
        )}

        {/* Topic list */}
        <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
              <tr style={{ background: 'rgba(4,14,35,0.98)', borderBottom: '1px solid rgba(0,80,150,0.2)' }}>
                {['启用', 'Topic', '数据类型', '说明', '操作'].map(h => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', color: '#5a8aaa', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {mqttConfig.topics.map((t, i) => {
                const tc = DATA_TYPE_COLORS[t.dataType]
                return (
                  <tr key={t.id} style={{ borderBottom: '1px solid rgba(0,50,100,0.15)', background: i % 2 === 0 ? 'transparent' : 'rgba(0,20,50,0.2)' }}>
                    <td style={{ padding: '10px 14px' }}>
                      <label style={{ cursor: 'pointer' }}>
                        <input type="checkbox" checked={t.enabled} onChange={() => toggleTopic(t.id)} style={{ accentColor: GREEN }} />
                      </label>
                    </td>
                    <td style={{ padding: '10px 14px', fontFamily: "'JetBrains Mono', monospace", color: t.enabled ? CYAN : '#3a5a70' }}>{t.topic}</td>
                    <td style={{ padding: '10px 14px' }}>
                      <span style={{ padding: '2px 8px', borderRadius: 2, background: `${tc}18`, color: tc, border: `1px solid ${tc}30`, fontSize: 11 }}>
                        {DATA_TYPE_LABELS[t.dataType]}
                      </span>
                    </td>
                    <td style={{ padding: '10px 14px', color: '#5a8aaa' }}>{t.description}</td>
                    <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                      <button onClick={() => editTopic(t)} style={{ ...btn(CYAN, 'sm'), marginRight: 6 }}>编辑</button>
                      <button onClick={() => deleteTopic(t.id)} style={btn(RED, 'sm')}>删除</button>
                    </td>
                  </tr>
                )
              })}
              {mqttConfig.topics.length === 0 && (
                <tr><td colSpan={5} style={{ padding: '40px 0', textAlign: 'center', color: '#3a5a70' }}>暂无 Topic 订阅</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* MQTT data flow diagram */}
        <div style={{ padding: '14px 20px', borderTop: '1px solid rgba(0,80,150,0.2)', background: 'rgba(0,10,30,0.4)', flexShrink: 0 }}>
          <div style={{ color: '#3a5a70', fontSize: 11, display: 'flex', alignItems: 'center', gap: 16 }}>
            <span>数据流向：</span>
            {DATA_TYPES.filter(d => d !== 'custom').map((d, i, arr) => (
              <span key={d} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ padding: '1px 6px', background: `${DATA_TYPE_COLORS[d]}18`, color: DATA_TYPE_COLORS[d], borderRadius: 2, fontSize: 10 }}>{DATA_TYPE_LABELS[d]}</span>
                <span style={{ color: '#3a5a70' }}>→</span>
                <span style={{ color: '#5a8aaa', fontSize: 11 }}>
                  {d === 'air_quality' ? '大气面板' : d === 'water_quality' ? '水质面板' : d === 'device_status' ? '设备状态' : '告警面板'}
                </span>
                {i < arr.length - 1 && <span style={{ color: '#1a3a5a' }}>|</span>}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function btn(color: string, size: 'sm' | 'md' = 'md') {
  return {
    padding: size === 'sm' ? '3px 10px' : '6px 14px',
    fontSize: size === 'sm' ? 11 : 12,
    borderRadius: 3,
    border: `1px solid ${color}55`,
    background: `${color}18`,
    color,
    cursor: 'pointer' as const,
    transition: 'all 0.15s',
  }
}
