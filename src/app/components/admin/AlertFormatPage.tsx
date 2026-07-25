import { useState } from 'react'
import { useDashboard } from '../../context/DashboardContext'

const CYAN = '#00aaff'
const GREEN = '#00e676'
const AMBER = '#ffd740'
const ORANGE = '#ff7043'
const RED = '#ff4444'

const LEVEL_COLORS: Record<number, string> = { 1: '#64b5f6', 2: AMBER, 3: ORANGE, 4: RED }
const LEVEL_LABELS: Record<number, string> = { 1: '注意', 2: '轻度', 3: '中度', 4: '重度' }

const ALERT_TYPE_CATEGORIES = ['气体污染', '水体污染', '秸秆燃烧', '道路扬尘', '堆头未覆盖'] as const
const ALERT_TYPE_COLORS: Record<string, string> = {
  '气体污染': '#ab47bc',
  '水体污染': '#00bcd4',
  '秸秆燃烧': ORANGE,
  '道路扬尘': AMBER,
  '堆头未覆盖': '#ff7043',
}

export function AlertFormatPage() {
  const { alertFormatConfig, setAlertFormatConfig, pushAlert, pushAlertDirect } = useDashboard()
  const [testJson, setTestJson] = useState(alertFormatConfig.samplePayload)
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string; preview?: Record<string, unknown> } | null>(null)
  const [manualAlert, setManualAlert] = useState({
    type: 'PM2.5超标', level: '2', location: '周家坝监测站',
    value: '82 μg/m³', standard: '75 μg/m³',
  })
  const [activeTab, setActiveTab] = useState<'format' | 'test' | 'manual'>('format')

  const fm = alertFormatConfig.fieldMap

  const updateField = (key: keyof typeof fm, v: string) =>
    setAlertFormatConfig({ ...alertFormatConfig, fieldMap: { ...fm, [key]: v } })

  const updateTypeMap = (oldKey: string, newKey: string, category: string) => {
    const nm = { ...(alertFormatConfig.typeMap ?? {}) }
    if (oldKey !== newKey) delete nm[oldKey]
    nm[newKey] = category
    setAlertFormatConfig({ ...alertFormatConfig, typeMap: nm })
  }

  const deleteTypeEntry = (key: string) => {
    const nm = { ...(alertFormatConfig.typeMap ?? {}) }
    delete nm[key]
    setAlertFormatConfig({ ...alertFormatConfig, typeMap: nm })
  }

  const addTypeEntry = () => {
    setAlertFormatConfig({ ...alertFormatConfig, typeMap: { ...(alertFormatConfig.typeMap ?? {}), '': '气体污染' } })
  }

  const updateLevelMap = (raw: string, val: string) => {
    const parsed = parseInt(val)
    if (parsed < 1 || parsed > 4 || isNaN(parsed)) return
    setAlertFormatConfig({
      ...alertFormatConfig,
      levelMap: { ...alertFormatConfig.levelMap, [raw]: parsed as 1 | 2 | 3 | 4 },
    })
  }

  const addLevelEntry = () => {
    setAlertFormatConfig({ ...alertFormatConfig, levelMap: { ...alertFormatConfig.levelMap, '': 1 } })
  }

  const runTest = () => {
    try {
      const raw = JSON.parse(testJson) as Record<string, unknown>
      const preview: Record<string, unknown> = {
        type: raw[fm.type] ?? '(未找到)',
        level: raw[fm.level] ?? '(未找到)',
        location: raw[fm.location] ?? '(未找到)',
        deviceName: raw[fm.deviceName] ?? '(未找到)',
        value: raw[fm.value] ?? '(未找到)',
        standard: raw[fm.standard] ?? '(未找到)',
        time: raw[fm.time] ?? '(未找到)',
      }
      setTestResult({ ok: true, msg: '解析成功', preview })
    } catch {
      setTestResult({ ok: false, msg: '无效的 JSON 格式' })
    }
  }

  const sendTest = () => {
    try {
      const raw = JSON.parse(testJson) as Record<string, unknown>
      pushAlert(raw)
      setTestResult({ ok: true, msg: '✓ 已推送到驾驶舱告警面板' })
    } catch {
      setTestResult({ ok: false, msg: 'JSON 解析失败，无法推送' })
    }
  }

  const sendManual = () => {
    const level = parseInt(manualAlert.level) as 1 | 2 | 3 | 4
    pushAlertDirect({
      type: manualAlert.type,
      level: Math.min(4, Math.max(1, level)) as 1 | 2 | 3 | 4,
      location: manualAlert.location,
      value: manualAlert.value,
      standard: manualAlert.standard,
      time: new Date().toTimeString().slice(0, 8),
      lat: 30.857213 + (Math.random() - 0.5) * 0.1,
      lon: 108.380078 + (Math.random() - 0.5) * 0.1,
    })
    setTestResult({ ok: true, msg: '✓ 告警已直接推送到驾驶舱' })
  }

  const tabs = [
    { key: 'format' as const, label: '字段映射配置' },
    { key: 'test' as const, label: 'JSON 测试推送' },
    { key: 'manual' as const, label: '手动告警推送' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header + tabs */}
      <div style={{ padding: '16px 24px 0', borderBottom: '1px solid rgba(0,80,150,0.2)', flexShrink: 0 }}>
        <h2 style={{ color: '#c8e6ff', fontSize: 16, fontWeight: 600, marginBottom: 14 }}>告警接入配置</h2>
        <div style={{ display: 'flex', gap: 4 }}>
          {tabs.map(t => (
            <button key={t.key} onClick={() => setActiveTab(t.key)} style={{
              padding: '7px 18px', fontSize: 12, borderRadius: '3px 3px 0 0',
              border: `1px solid ${activeTab === t.key ? 'rgba(0,170,255,0.3)' : 'transparent'}`,
              borderBottom: activeTab === t.key ? '1px solid rgba(2,12,32,1)' : '1px solid transparent',
              background: activeTab === t.key ? 'rgba(0,170,255,0.08)' : 'transparent',
              color: activeTab === t.key ? CYAN : '#5a8aaa',
              cursor: 'pointer', marginBottom: -1,
            }}>{t.label}</button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'hidden' }}>
        {/* Tab: field mapping */}
        {activeTab === 'format' && (
          <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
            <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none', padding: '20px 24px' }}>
              <p style={{ color: '#5a8aaa', fontSize: 13, marginBottom: 20, lineHeight: 1.6 }}>
                配置外部系统推送的 JSON 告警数据中，各字段名到驾驶舱告警字段的映射关系。
                支持 MQTT topic 和 HTTP API 两种接入方式。
              </p>

              <div style={{ background: 'rgba(0,20,50,0.4)', border: '1px solid rgba(0,150,220,0.15)', borderRadius: 6, marginBottom: 20 }}>
                <div style={{ padding: '10px 16px', borderBottom: '1px solid rgba(0,80,150,0.15)', color: '#7ab8e0', fontSize: 12, fontWeight: 600 }}>
                  字段名映射（JSON Key → 驾驶舱字段）
                </div>
                <div style={{ padding: '16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                  {([
                    { key: 'type',         label: '告警类型', eg: '"alarm_type"' },
                    { key: 'level',        label: '告警级别', eg: '"severity"' },
                    { key: 'location',     label: '告警位置', eg: '"site_name"' },
                    { key: 'deviceName',   label: '设备名称', eg: '"device_name"' },
                    { key: 'licensePlate', label: '车牌号',   eg: '"plate_no"' },
                    { key: 'value',        label: '测量值',   eg: '"measured_value"' },
                    { key: 'standard',     label: '限制标准', eg: '"threshold"' },
                    { key: 'time',         label: '告警时间', eg: '"timestamp"' },
                    { key: 'lat',          label: '纬度',     eg: '"latitude"' },
                    { key: 'lon',          label: '经度',     eg: '"longitude"' },
                  ] as const).map(({ key, label, eg }) => (
                    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ color: '#5a8aaa', fontSize: 12, width: 72, flexShrink: 0 }}>{label}</span>
                      <span style={{ color: '#3a5a70', fontSize: 11 }}>←</span>
                      <input
                        value={fm[key]}
                        onChange={e => updateField(key, e.target.value)}
                        placeholder={eg}
                        style={{
                          flex: 1, padding: '5px 8px',
                          background: 'rgba(0,20,60,0.6)',
                          border: '1px solid rgba(0,150,220,0.2)',
                          borderRadius: 3, color: CYAN, fontSize: 12,
                          fontFamily: "'JetBrains Mono', monospace",
                          outline: 'none',
                        }}
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Level mapping */}
              <div style={{ background: 'rgba(0,20,50,0.4)', border: '1px solid rgba(0,150,220,0.15)', borderRadius: 6, marginBottom: 20 }}>
                <div style={{ padding: '10px 16px', borderBottom: '1px solid rgba(0,80,150,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ color: '#7ab8e0', fontSize: 12, fontWeight: 600 }}>级别值映射（原始值 → 告警级别 1-4）</span>
                  <button onClick={addLevelEntry} style={{ ...sBtn(GREEN) }}>+ 添加</button>
                </div>
                <div style={{ padding: '14px 16px', display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                  {Object.entries(alertFormatConfig.levelMap).map(([raw, lvl]) => (
                    <div key={raw} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input
                        value={raw}
                        onChange={e => {
                          const nm = { ...alertFormatConfig.levelMap }
                          delete nm[raw]
                          nm[e.target.value] = lvl
                          setAlertFormatConfig({ ...alertFormatConfig, levelMap: nm })
                        }}
                        style={{ width: 80, padding: '4px 6px', background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.2)', borderRadius: 2, color: AMBER, fontSize: 11, fontFamily: "'JetBrains Mono', monospace", outline: 'none' }}
                      />
                      <span style={{ color: '#3a5a70', fontSize: 11 }}>→</span>
                      <select
                        value={lvl}
                        onChange={e => updateLevelMap(raw, e.target.value)}
                        style={{ padding: '4px 6px', background: 'rgba(0,20,60,0.8)', border: `1px solid ${LEVEL_COLORS[lvl]}44`, borderRadius: 2, color: LEVEL_COLORS[lvl], fontSize: 11, outline: 'none' }}
                      >
                        {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n} - {LEVEL_LABELS[n]}</option>)}
                      </select>
                      <button onClick={() => {
                        const nm = { ...alertFormatConfig.levelMap }
                        delete nm[raw]
                        setAlertFormatConfig({ ...alertFormatConfig, levelMap: nm })
                      }} style={{ color: '#ff6060', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12 }}>×</button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Alert type mapping */}
              <div style={{ background: 'rgba(0,20,50,0.4)', border: '1px solid rgba(0,150,220,0.15)', borderRadius: 6 }}>
                <div style={{ padding: '10px 16px', borderBottom: '1px solid rgba(0,80,150,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ color: '#7ab8e0', fontSize: 12, fontWeight: 600 }}>告警类型映射（原始值 → 标准分类）</span>
                  <button onClick={addTypeEntry} style={{ ...sBtn(GREEN) }}>+ 添加</button>
                </div>

                {/* Category legend */}
                <div style={{ padding: '10px 16px 0', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {ALERT_TYPE_CATEGORIES.map(cat => (
                    <span key={cat} style={{
                      padding: '2px 9px', borderRadius: 2, fontSize: 11,
                      background: `${ALERT_TYPE_COLORS[cat]}18`,
                      border: `1px solid ${ALERT_TYPE_COLORS[cat]}40`,
                      color: ALERT_TYPE_COLORS[cat],
                    }}>{cat}</span>
                  ))}
                </div>

                <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {Object.entries(alertFormatConfig.typeMap ?? {}).map(([raw, category]) => {
                    const catColor = ALERT_TYPE_COLORS[category] ?? CYAN
                    return (
                      <div key={raw} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                          value={raw}
                          onChange={e => updateTypeMap(raw, e.target.value, category)}
                          placeholder="原始 JSON 值"
                          style={{ width: 160, padding: '4px 8px', background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.2)', borderRadius: 2, color: AMBER, fontSize: 11, fontFamily: "'JetBrains Mono', monospace", outline: 'none' }}
                        />
                        <span style={{ color: '#3a5a70', fontSize: 11 }}>→</span>
                        <select
                          value={category}
                          onChange={e => updateTypeMap(raw, raw, e.target.value)}
                          style={{ padding: '4px 8px', background: 'rgba(0,20,60,0.8)', border: `1px solid ${catColor}44`, borderRadius: 2, color: catColor, fontSize: 11, outline: 'none', minWidth: 110 }}
                        >
                          {ALERT_TYPE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <button onClick={() => deleteTypeEntry(raw)} style={{ color: '#ff6060', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, marginLeft: 2 }}>×</button>
                      </div>
                    )
                  })}
                  {Object.keys(alertFormatConfig.typeMap ?? {}).length === 0 && (
                    <div style={{ color: '#3a5a70', fontSize: 12, padding: '4px 0' }}>暂无映射规则，点击「+ 添加」新增</div>
                  )}
                </div>
              </div>
            </div>

            {/* Right: JSON schema example */}
            <div style={{ width: 300, borderLeft: '1px solid rgba(0,80,150,0.2)', padding: '20px 16px', overflowY: 'auto', scrollbarWidth: 'none', flexShrink: 0 }}>
              <div style={{ color: '#7ab8e0', fontSize: 12, fontWeight: 600, marginBottom: 10 }}>期望的 JSON 格式</div>
              <pre style={{
                background: 'rgba(0,10,30,0.8)', border: '1px solid rgba(0,80,150,0.2)',
                borderRadius: 4, padding: '12px', fontSize: 11,
                color: '#c8e6ff', fontFamily: "'JetBrains Mono', monospace",
                lineHeight: 1.8, overflow: 'auto', scrollbarWidth: 'none',
              }}>
                {`{\n  "${fm.type}": "PM2.5超标",\n  "${fm.level}": "warning",\n  "${fm.location}": "周家坝站",\n  "${fm.deviceName}": "大气监测仪-01",\n  "${fm.value}": "82 μg/m³",\n  "${fm.standard}": "75 μg/m³",\n  "${fm.time}": "14:32:01",\n  "${fm.lat}": 30.857,\n  "${fm.lon}": 108.380\n}`}
              </pre>
              <div style={{ marginTop: 12, color: '#3a5a70', fontSize: 11, lineHeight: 1.7 }}>
                <div style={{ color: '#5a8aaa', marginBottom: 4 }}>HTTP API 接入</div>
                <div>POST /api/alert</div>
                <div>Content-Type: application/json</div>
                <div style={{ marginTop: 8 }}>发送上述格式数据，系统自动解析并显示在驾驶舱告警面板。</div>
                <div style={{ marginTop: 10, padding: '8px 10px', background: 'rgba(255,112,67,0.08)', border: '1px solid rgba(255,112,67,0.25)', borderRadius: 3 }}>
                  <div style={{ color: '#ff7043', marginBottom: 3 }}>车牌号字段说明</div>
                  <div>仅当告警类型为「道路扬尘」时车牌号才会在前台显示，其他类型即使有值也不予展示。</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab: JSON test */}
        {activeTab === 'test' && (
          <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
            <div style={{ flex: 1, padding: '20px 24px', overflowY: 'auto', scrollbarWidth: 'none' }}>
              <p style={{ color: '#5a8aaa', fontSize: 13, marginBottom: 16, lineHeight: 1.6 }}>
                粘贴一条从物联网平台接收到的 JSON 告警数据，验证字段映射是否正确，然后推送到驾驶舱。
              </p>
              <textarea
                value={testJson}
                onChange={e => setTestJson(e.target.value)}
                rows={14}
                style={{
                  width: '100%', padding: '12px',
                  background: 'rgba(0,10,30,0.8)',
                  border: '1px solid rgba(0,150,220,0.2)',
                  borderRadius: 4, color: '#c8e6ff', fontSize: 12,
                  fontFamily: "'JetBrains Mono', monospace",
                  resize: 'vertical', outline: 'none', lineHeight: 1.7,
                  marginBottom: 12,
                }}
              />
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={runTest} style={btn(CYAN)}>解析测试</button>
                <button onClick={sendTest} style={btn(GREEN)}>推送到驾驶舱</button>
                <button onClick={() => setTestJson(alertFormatConfig.samplePayload)} style={btn('#5a8aaa')}>重置示例</button>
              </div>

              {testResult && (
                <div style={{
                  marginTop: 16, padding: '12px 16px',
                  background: testResult.ok ? 'rgba(0,230,118,0.08)' : 'rgba(255,68,68,0.08)',
                  border: `1px solid ${testResult.ok ? 'rgba(0,230,118,0.25)' : 'rgba(255,68,68,0.25)'}`,
                  borderRadius: 4,
                }}>
                  <div style={{ color: testResult.ok ? GREEN : RED, fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{testResult.msg}</div>
                  {testResult.preview && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      {Object.entries(testResult.preview).map(([k, v]) => (
                        <div key={k} style={{ display: 'flex', gap: 6, fontSize: 12 }}>
                          <span style={{ color: '#5a8aaa', width: 60, flexShrink: 0 }}>{k}:</span>
                          <span style={{ color: '#c8e6ff', fontFamily: "'JetBrains Mono', monospace" }}>{String(v)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tab: manual push */}
        {activeTab === 'manual' && (
          <div style={{ padding: '24px', overflowY: 'auto', height: '100%', scrollbarWidth: 'none' }}>
            <p style={{ color: '#5a8aaa', fontSize: 13, marginBottom: 24, lineHeight: 1.6 }}>
              手动填写告警内容并直接推送到驾驶舱，无需经过字段映射。适合调试和演示。
            </p>
            <div style={{ maxWidth: 560 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
                <div>
                  <label style={{ color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 5 }}>告警类型</label>
                  <input value={manualAlert.type} onChange={e => setManualAlert(a => ({ ...a, type: e.target.value }))}
                    style={inputStyle} list="alert-types" />
                  <datalist id="alert-types">
                    {['PM2.5超标', 'PM10超标', 'SO₂超标', 'NO₂超标', 'O₃超标', '扬尘超标 AI识别', '违规车辆 AI识别', '水质异常', '违规排污 AI识别'].map(t => (
                      <option key={t} value={t} />
                    ))}
                  </datalist>
                </div>
                <div>
                  <label style={{ color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 5 }}>告警级别</label>
                  <select value={manualAlert.level} onChange={e => setManualAlert(a => ({ ...a, level: e.target.value }))} style={{ ...inputStyle, background: 'rgba(0,20,60,0.8)' }}>
                    {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n} — {LEVEL_LABELS[n]}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 5 }}>告警位置</label>
                  <input value={manualAlert.location} onChange={e => setManualAlert(a => ({ ...a, location: e.target.value }))} style={inputStyle} list="locations" />
                  <datalist id="locations">
                    {['周家坝监测站', '百安坝监测站', '万州港北堆场', '沿江大道监控', '高笋塘路口', '龙头化工厂', '苎溪河口'].map(l => <option key={l} value={l} />)}
                  </datalist>
                </div>
                <div>
                  <label style={{ color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 5 }}>测量值</label>
                  <input value={manualAlert.value} onChange={e => setManualAlert(a => ({ ...a, value: e.target.value }))} style={inputStyle} placeholder="如：82 μg/m³" />
                </div>
                <div>
                  <label style={{ color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 5 }}>限制标准</label>
                  <input value={manualAlert.standard} onChange={e => setManualAlert(a => ({ ...a, standard: e.target.value }))} style={inputStyle} placeholder="如：75 μg/m³" />
                </div>
              </div>

              {/* Level preview */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
                {[1, 2, 3, 4].map(n => {
                  const isActive = parseInt(manualAlert.level) === n
                  const c = LEVEL_COLORS[n]
                  return (
                    <button key={n} onClick={() => setManualAlert(a => ({ ...a, level: String(n) }))} style={{
                      padding: '6px 16px', fontSize: 12, borderRadius: 3,
                      border: `1px solid ${isActive ? c : c + '40'}`,
                      background: isActive ? `${c}20` : 'transparent',
                      color: isActive ? c : c + '80',
                      cursor: 'pointer',
                    }}>{LEVEL_LABELS[n]}</button>
                  )
                })}
              </div>

              <button onClick={sendManual} style={{ ...btn(RED), fontSize: 13, padding: '9px 28px' }}>
                ⚡ 立即推送到驾驶舱
              </button>

              {testResult && (
                <div style={{
                  marginTop: 14, padding: '10px 14px',
                  background: testResult.ok ? 'rgba(0,230,118,0.08)' : 'rgba(255,68,68,0.08)',
                  border: `1px solid ${testResult.ok ? GREEN + '40' : RED + '40'}`,
                  borderRadius: 4, color: testResult.ok ? GREEN : RED, fontSize: 13,
                }}>{testResult.msg}</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '7px 10px',
  background: 'rgba(0,20,60,0.6)',
  border: '1px solid rgba(0,150,220,0.25)',
  borderRadius: 3, color: '#c8e6ff', fontSize: 13,
  outline: 'none',
}

function btn(color: string) {
  return {
    padding: '7px 18px', fontSize: 12, borderRadius: 3,
    border: `1px solid ${color}55`,
    background: `${color}18`, color,
    cursor: 'pointer' as const,
  }
}

function sBtn(color: string) {
  return {
    padding: '3px 10px', fontSize: 11, borderRadius: 2,
    border: `1px solid ${color}44`,
    background: `${color}14`, color,
    cursor: 'pointer' as const,
  }
}
