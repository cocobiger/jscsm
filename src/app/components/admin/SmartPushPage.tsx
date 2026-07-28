import { useState, useEffect, useCallback } from 'react'
import { apiFetch, authFetch } from '../../lib/apiFetch'
import BlockEditor from './BlockEditor'
import { Block, BlockType, WORKREPORT_VARS, newBlock } from './reportBlocks'
import { EvidenceGrid, type EvidenceItem, type EvidenceType } from '../EvidenceGrid'

const CYAN = '#00aaff'
const GREEN = '#00e676'
const AMBER = '#ffd740'
const RED = '#ff4444'
const PURPLE = '#ab47bc'
const ORANGE = '#ff7043'

const EVENT_TYPES = ['气体污染', '水体污染', '秸秆燃烧', '道路扬尘', '堆头未覆盖']
const TYPE_COLORS: Record<string, string> = {
  '气体污染': PURPLE, '水体污染': '#00bcd4', '秸秆燃烧': ORANGE,
  '道路扬尘': AMBER, '堆头未覆盖': '#ff8a65',
}

// 智治推送回执状态：pending(待上报) → pushed(已推送) → processing(受理中) → closed(已结案)
const STATUS_META: Record<string, { label: string; color: string }> = {
  pending: { label: '待上报', color: '#5a8aaa' },
  pushed: { label: '已推送', color: CYAN },
  processing: { label: '受理中', color: AMBER },
  closed: { label: '已结案', color: GREEN },
}

// ── 平台预设：非技术人员选中即自动填好模板与请求头 ──
// authHeader/authPrefix：填令牌后自动注入的请求头（如 Authorization: Bearer xxx）
interface PlatformPreset {
  key: string; name: string; hint: string
  api_method: string; api_url_hint: string
  headers: Record<string, string>
  authHeader?: string; authPrefix?: string
  body_template: string
  // P1：向导映射（有则可用“向导模式”一对一映射；无则该平台报文较复杂，选中自动切“高级模式”）
  wizard?: {
    format: 'json' | 'form'
    auth: 'none' | 'bearer' | 'appkey'
    authKeyName?: string
    fields: { sysKey: string; target: string }[]
  }
}
const PLATFORM_PRESETS: PlatformPreset[] = [
  {
    key: 'chengyun',
    name: '城运视频平台（城市运行中心）',
    hint: '推送到城运中心，字段与其接收接口对齐；如城运会回调处置结果，请保留 pushId/callbackUrl。',
    api_method: 'POST',
    api_url_hint: 'http://城运中心地址/api/event/receive',
    headers: { 'Content-Type': 'application/json' },
    authHeader: 'Authorization', authPrefix: 'Bearer ',
    body_template: `{
  "eventName": "{event_type}",
  "address": "{location}",
  "longitude": {lon},
  "latitude": {lat},
  "level": {level},
  "detail": "{description}",
  "monitorValue": "{value}",
  "occurTime": "{time}",
  "triggerCount": {trigger_count},
  "pushId": "{push_id}",
  "callbackUrl": "{callback_url}"
}`,
    wizard: {
      format: 'json', auth: 'bearer',
      fields: [
        { sysKey: 'event_type', target: 'eventName' },
        { sysKey: 'location', target: 'address' },
        { sysKey: 'lon', target: 'longitude' },
        { sysKey: 'lat', target: 'latitude' },
        { sysKey: 'level', target: 'level' },
        { sysKey: 'description', target: 'detail' },
        { sysKey: 'value', target: 'monitorValue' },
        { sysKey: 'time', target: 'occurTime' },
        { sysKey: 'trigger_count', target: 'triggerCount' },
        { sysKey: 'push_id', target: 'pushId' },
        { sysKey: 'callback_url', target: 'callbackUrl' },
      ],
    },
  },
  {
    key: 'hotline12345',
    name: '12345 政务服务热线',
    hint: '以工单形式上报，通常“只收不回”——推送成功即视为送达，处置结果需人工一键结案。',
    api_method: 'POST',
    api_url_hint: 'http://12345平台地址/api/order/create',
    headers: { 'Content-Type': 'application/json' },
    authHeader: 'X-App-Token', authPrefix: '',
    body_template: `{
  "title": "{event_type}告警",
  "location": "{location}",
  "content": "{description}；监测值 {value}，{time} 起累计触发 {trigger_count} 次",
  "reportTime": "{time}",
  "source": "环保驾驶舱"
}`,
  },
  {
    key: 'grid',
    name: '网格化综合管理平台',
    hint: '按网格事件上报，坐标字段常用 lng/lat；多数网格平台“只收不回”。',
    api_method: 'POST',
    api_url_hint: 'http://网格平台地址/api/grid/event',
    headers: { 'Content-Type': 'application/json' },
    authHeader: 'Authorization', authPrefix: 'Bearer ',
    body_template: `{
  "eventType": "{event_type}",
  "gridAddress": "{location}",
  "lng": {lon},
  "lat": {lat},
  "description": "{description}",
  "happenTime": "{time}"
}`,
    wizard: {
      format: 'json', auth: 'bearer',
      fields: [
        { sysKey: 'event_type', target: 'eventType' },
        { sysKey: 'location', target: 'gridAddress' },
        { sysKey: 'lon', target: 'lng' },
        { sysKey: 'lat', target: 'lat' },
        { sysKey: 'description', target: 'description' },
        { sysKey: 'time', target: 'happenTime' },
      ],
    },
  },
  {
    key: 'custom',
    name: '自定义（通用 JSON 模板）',
    hint: '通用模板，可自由编辑字段名以适配任意平台。',
    api_method: 'POST',
    api_url_hint: 'http://目标平台地址/api/report',
    headers: { 'Content-Type': 'application/json' },
    body_template: `{
  "event_type": "{event_type}",
  "location": "{location}",
  "lat": {lat},
  "lon": {lon},
  "level": {level},
  "value": "{value}",
  "standard": "{standard}",
  "time": "{time}",
  "trigger_count": {trigger_count},
  "description": "{description}"
}`,
    wizard: {
      format: 'json', auth: 'none',
      fields: [
        { sysKey: 'event_type', target: 'event_type' },
        { sysKey: 'location', target: 'location' },
        { sysKey: 'lat', target: 'lat' },
        { sysKey: 'lon', target: 'lon' },
        { sysKey: 'level', target: 'level' },
        { sysKey: 'value', target: 'value' },
        { sysKey: 'standard', target: 'standard' },
        { sysKey: 'time', target: 'time' },
        { sysKey: 'trigger_count', target: 'trigger_count' },
        { sysKey: 'description', target: 'description' },
      ],
    },
  },
]

// 报文预览用示例数据（与后端 executePush 变量一致）
const PREVIEW_SAMPLE: Record<string, string | number> = {
  event_type: '气体污染', location: '龙泗路口监测点',
  lat: 30.812, lon: 108.409, level: 2,
  value: '0.35mg/m³', standard: '0.20mg/m³',
  time: '2026-07-12 09:30:00', description: '检测到疑似超标排放',
  trigger_count: 3, event_ids: 'evt-001,evt-002,evt-003',
  spid: '50010100001180000001', deviceName: '九龙沙场球机', aiConfidence: 0.86,
  aiConfidenceMin: 0.82, aiConfidenceMax: 0.95, aiConfidenceAvg: 0.90, aiConfidenceCount: 5,
  push_id: 'PUSH-20260712-0001',
  callback_url: 'http://[驾驶舱对外地址]/api/smart-push/callback',
}
// 模板变量替换（与后端 fillTemplate 行为一致：{key} → 值）
function renderTemplate(tpl: string, vars: Record<string, string | number>): string {
  return (tpl || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
}

// ── P1：可视化字段映射 ──────────────────────────────────────
// 左列固定的系统字段（中文名），右列由用户填“对方平台字段名”，系统据此自动生成报文，全程不碰 JSON
interface SysField { sysKey: string; label: string; isNumber: boolean; note?: string; group?: string }
// 字段分组（用于向导模式分组小标题，提升可读性）：基础信息 / 位置坐标 / 媒体附件 / 回执闭环
const GROUP_ORDER = ['基础信息', 'AI置信度统计', '位置坐标', '媒体附件', '回执闭环']
const SYS_FIELDS: SysField[] = [
  { sysKey: 'event_type', label: '事件类型', isNumber: false, group: '基础信息' },
  { sysKey: 'location', label: '点位 / 地址', isNumber: false, group: '基础信息' },
  { sysKey: 'time', label: '发生时间', isNumber: false, group: '基础信息' },
  { sysKey: 'description', label: '事件描述', isNumber: false, group: '基础信息' },
  { sysKey: 'trigger_count', label: '触发次数', isNumber: true, group: '基础信息' },
  { sysKey: 'level', label: '预警级别', isNumber: true, group: '基础信息' },
  { sysKey: 'value', label: '监测值', isNumber: false, group: '基础信息' },
  { sysKey: 'standard', label: '标准值', isNumber: false, group: '基础信息' },
  { sysKey: 'spid', label: '通道ID', isNumber: false, group: '基础信息', note: '摄像头/通道编号（取自 AI分析存档）' },
  { sysKey: 'deviceName', label: '设备名称', isNumber: false, group: '基础信息', note: '设备名（取自 AI分析存档）' },
  { sysKey: 'aiConfidence', label: 'AI置信度', isNumber: true, group: '基础信息', note: '0~1，如 0.85（取自 AI分析存档）' },
  { sysKey: 'aiConfidenceMin', label: '置信度最低', isNumber: true, group: 'AI置信度统计', note: '本案多张AI分析中最低置信度（0~1）' },
  { sysKey: 'aiConfidenceMax', label: '置信度最高', isNumber: true, group: 'AI置信度统计', note: '本案多张AI分析中最高置信度（0~1）' },
  { sysKey: 'aiConfidenceAvg', label: '置信度平均', isNumber: true, group: 'AI置信度统计', note: '本案多张AI分析置信度均值（0~1）' },
  { sysKey: 'aiConfidenceCount', label: '置信度样本数', isNumber: true, group: 'AI置信度统计', note: '本案涉及的AI分析图片张数' },
  { sysKey: 'lon', label: '经度', isNumber: true, group: '位置坐标' },
  { sysKey: 'lat', label: '纬度', isNumber: true, group: '位置坐标' },
  { sysKey: 'image_url', label: '事件图片', isNumber: false, group: '媒体附件', note: '支持 /api/iot-image 代理地址' },
  { sysKey: 'push_id', label: '回执 ID', isNumber: false, group: '回执闭环', note: '城运回调关联用' },
  { sysKey: 'callback_url', label: '回调地址', isNumber: false, group: '回执闭环', note: '城运回调用' },
]
const NUMBER_KEYS = new Set(SYS_FIELDS.filter(f => f.isNumber).map(f => f.sysKey))

interface FieldMapping { sysKey: string; target: string; enabled: boolean; custom?: boolean; customValue?: string }

// 自定义字段名校验：字母/下划线开头，仅含 [a-zA-Z0-9_]，长度 ≤ 50
const CUSTOM_FIELD_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,49}$/
const CUSTOM_VALUE_MAX = 500

// 根据映射表 + 报文格式，自动生成 body_template
function buildTemplate(mappings: FieldMapping[], format: 'json' | 'form'): string {
  const active = mappings.filter(m => m.enabled && m.target.trim())
  if (active.length === 0) return format === 'json' ? '{}' : ''
  if (format === 'form') {
    return active.map(m => `${m.target.trim()}=${m.custom ? (m.customValue ?? '') : `{${m.sysKey}}`}`).join('&')
  }
  const lines = active.map(m => {
    const target = m.target.trim()
    let valExpr: string
    if (m.custom) {
      const cv = (m.customValue ?? '').trim()
      if (cv === '') valExpr = '""'
      else if (cv.includes('{')) valExpr = `"${cv}"`            // 含 {变量} 占位，运行时 fillTemplate 替换
      else if (/^-?\d+(\.\d+)?$/.test(cv)) valExpr = cv          // 纯数值字面量
      else valExpr = `"${cv}"`                                   // 文本字面量
    } else {
      valExpr = NUMBER_KEYS.has(m.sysKey) ? `{${m.sysKey}}` : `"{${m.sysKey}}"`
    }
    return `  "${target}": ${valExpr}`
  })
  return '{\n' + lines.join(',\n') + '\n}'
}

// 把已保存的 body_template 解析回映射表（向导模式编辑时回灌，含自定义字段）。
// 支持两种格式：① JSON（含 {变量} 占位，需先给未加引号的占位补引号再解析）② 表单 key=value&...
// 顶层 string/number → 字段；值为 {sysKey} 或 "{sysKey}" 识别为系统字段，否则视为自定义字段。
function parseTemplateToMappings(jsonStr: string): FieldMapping[] {
  const sysKeys = SYS_FIELDS.map(f => f.sysKey)
  const varToSysKey: Record<string, string> = {}
  for (const sk of sysKeys) { varToSysKey[`{${sk}}`] = sk; varToSysKey[`"{${sk}}"`] = sk }
  const result: FieldMapping[] = SYS_FIELDS.map(f => ({ sysKey: f.sysKey, target: f.sysKey, enabled: false }))
  const map = new Map(result.map(m => [m.sysKey, m]))
  const str = (jsonStr || '').trim()
  if (!str) return result

  // 1) 尝试 JSON：先把「未加引号的 {变量} 占位」补成 "{变量}"，使其可被 JSON.parse
  let obj: any = null
  try {
    const fixable = str.replace(/(?<!")(\{[a-zA-Z_][a-zA-Z0-9_]*\})(?!")/g, '"$1"')
    obj = JSON.parse(fixable)
  } catch { obj = null }

  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [key, val] of Object.entries(obj)) {
      if (typeof val === 'string') {
        const v = val.trim()
        if (v && varToSysKey[v] && map.has(varToSysKey[v])) {
          const m = map.get(varToSysKey[v])!; m.target = key; m.enabled = true
        } else {
          result.push({ sysKey: `custom_${key}_${Math.random().toString(36).slice(2, 7)}`, target: key, enabled: true, custom: true, customValue: val })
        }
      } else if (typeof val === 'number') {
        result.push({ sysKey: `custom_${key}_${Math.random().toString(36).slice(2, 7)}`, target: key, enabled: true, custom: true, customValue: String(val) })
      }
      // 嵌套对象/数组：向导模式不处理，保留为高级模式内容（切换向导会由 mappings 重建）
    }
    return result
  }

  // 2) 兼容表单格式 key=value&...（值形如 {event_type}，已带花括号）
  if (str.includes('=') && !str.startsWith('{')) {
    for (const pair of str.split('&')) {
      const idx = pair.indexOf('=')
      if (idx <= 0) continue
      const key = pair.slice(0, idx).trim()
      const val = pair.slice(idx + 1).trim()
      if (varToSysKey[val] && map.has(varToSysKey[val])) {
        const m = map.get(varToSysKey[val])!; m.target = key; m.enabled = true
      } else {
        result.push({ sysKey: `custom_${key}_${Math.random().toString(36).slice(2, 7)}`, target: key, enabled: true, custom: true, customValue: val })
      }
    }
    return result
  }

  return result
}

// 校验自定义字段：名称合法、不重名、纯单变量不与系统字段映射冲突
function validateCustomFields(mappings: FieldMapping[]): string[] {
  const errors: string[] = []
  const targets = new Set<string>()
  for (const m of mappings) {
    if (!m.enabled || !m.target.trim()) continue
    const t = m.target.trim()
    if (targets.has(t)) errors.push(`字段名「${t}」重复，请保证唯一`)
    targets.add(t)
    if (m.custom) {
      if (!CUSTOM_FIELD_NAME_RE.test(t)) errors.push(`自定义字段名「${t}」须以字母/下划线开头，仅含字母数字下划线，长度≤50`)
      if ((m.customValue ?? '').length > CUSTOM_VALUE_MAX) errors.push(`自定义字段「${t}」的值超过 ${CUSTOM_VALUE_MAX} 字`)
      // 纯单变量（如 {location}）若与某系统字段变量同名、且该系统字段已启用并映射到别的字段名 → 冲突（同一变量只能落到一个字段名）
      const singleVar = /^\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/.exec((m.customValue ?? '').trim())
      if (singleVar) {
        const vk = singleVar[1]
        const sysM = mappings.find(x => x.sysKey === vk && !x.custom)
        if (sysM && sysM.enabled && sysM.target.trim() && sysM.target.trim() !== t) {
          errors.push(`自定义字段「${t}」的值 {${vk}} 与系统字段「${vk}」冲突：同一变量只能映射到一个字段名。请改为在系统字段「${vk}」的“对方平台字段名”填写，或使用复合表达式。`)
        }
      }
    }
  }
  return errors
}

// 共享：字段映射表（系统字段 + 自定义字段 + 「+ 自定义字段」按钮）
function FieldMappingTable({ mappings, setMapping, onAddCustom, onRemoveCustom }: {
  mappings: FieldMapping[]
  setMapping: (sysKey: string, patch: Partial<FieldMapping>) => void
  onAddCustom: () => void
  onRemoveCustom: (sysKey: string) => void
}) {
  const customRows = mappings.filter(m => m.custom)
  return (
    <>
      <label style={labelStyle}>字段映射（勾选要发送的字段，右侧填“对方平台字段名”，系统自动拼报文）</label>
      <div style={{ background: 'rgba(0,10,30,0.5)', border: '1px solid rgba(0,100,180,0.2)', borderRadius: 4, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'rgba(0,20,60,0.4)' }}>
              {['发送', '系统字段 / 自定义值', '类型', '对方平台字段名'].map(h => (
                <th key={h} style={{ padding: '6px 10px', textAlign: 'left', color: '#5a8aaa', fontWeight: 400, borderBottom: '1px solid rgba(0,80,150,0.15)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(() => {
              const rows: any[] = []
              for (const g of GROUP_ORDER) {
                const gf = SYS_FIELDS.filter(f => (f.group || '基础信息') === g)
                if (!gf.length) continue
                rows.push(
                  <tr key={'grp-' + g}>
                    <td colSpan={4} style={{ padding: '6px 10px', background: 'rgba(0,40,90,0.4)', color: CYAN, fontSize: 11.5, fontWeight: 600, borderBottom: '1px solid rgba(0,100,180,0.25)', letterSpacing: 1 }}>
                      {g}
                    </td>
                  </tr>
                )
                for (const f of gf) {
                  const m = mappings.find(x => x.sysKey === f.sysKey)!
                  rows.push(
                    <tr key={f.sysKey} style={{ borderBottom: '1px solid rgba(0,40,80,0.1)', opacity: m.enabled ? 1 : 0.45 }}>
                      <td style={{ padding: '4px 10px' }}><input type="checkbox" checked={m.enabled} onChange={e => setMapping(f.sysKey, { enabled: e.target.checked })} /></td>
                      <td style={{ padding: '4px 10px', color: '#c8e6ff' }}>{f.label}{f.note && <span style={{ color: '#3a5a70', fontSize: 10, marginLeft: 4 }}>({f.note})</span>}<span style={{ color: '#3a5a70', fontFamily: "'JetBrains Mono',monospace", fontSize: 10, marginLeft: 6 }}>{'{' + f.sysKey + '}'}</span></td>
                      <td style={{ padding: '4px 10px', color: f.isNumber ? AMBER : '#5a8aaa', fontSize: 11 }}>{f.isNumber ? '数值' : '文本'}</td>
                      <td style={{ padding: '4px 10px' }}>
                        <input style={{ ...inputStyle, padding: '4px 8px', fontFamily: "'JetBrains Mono',monospace", fontSize: 12 }} value={m.target} disabled={!m.enabled} onChange={e => setMapping(f.sysKey, { target: e.target.value })} placeholder="对方字段名" />
                      </td>
                    </tr>
                  )
                }
              }
              return rows
            })()}
            {customRows.length > 0 && (
              <tr key="grp-custom">
                <td colSpan={4} style={{ padding: '6px 10px', background: 'rgba(120,90,20,0.22)', color: '#ffd591', fontSize: 11.5, fontWeight: 600, borderBottom: '1px solid rgba(180,134,11,0.25)', letterSpacing: 1 }}>
                  自定义字段
                </td>
              </tr>
            )}
            {customRows.map(m => {
              const nameInvalid = !!m.target.trim() && !CUSTOM_FIELD_NAME_RE.test(m.target.trim())
              return (
                <tr key={m.sysKey} style={{ borderBottom: '1px solid rgba(0,40,80,0.1)', background: 'rgba(120,90,20,0.14)' }}>
                  <td style={{ padding: '4px 10px' }}><input type="checkbox" checked={m.enabled} onChange={e => setMapping(m.sysKey, { enabled: e.target.checked })} /></td>
                  <td style={{ padding: '4px 10px' }}>
                    <span style={{ fontSize: 10, border: '1px solid #b8860b', borderRadius: 3, padding: '0 4px', marginRight: 6, color: '#ffd591' }}>自定义</span>
                    <input
                      style={{ ...inputStyle, padding: '4px 8px', fontFamily: "'JetBrains Mono',monospace", fontSize: 12, width: 170, display: 'inline-block', borderColor: nameInvalid ? '#ff6b6b' : undefined }}
                      value={m.customValue ?? ''}
                      onChange={e => setMapping(m.sysKey, { customValue: e.target.value.slice(0, CUSTOM_VALUE_MAX) })}
                      placeholder="固定值 如 330106 或 {location}" title="固定值，或 {系统变量} 表达式（最多 500 字）" />
                  </td>
                  <td style={{ padding: '4px 10px', color: '#5a8aaa', fontSize: 11 }}>自定义</td>
                  <td style={{ padding: '4px 10px', display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      style={{ ...inputStyle, padding: '4px 8px', fontFamily: "'JetBrains Mono',monospace", fontSize: 12, flex: 1, borderColor: nameInvalid ? '#ff6b6b' : undefined }}
                      value={m.target} onChange={e => setMapping(m.sysKey, { target: e.target.value })}
                      placeholder="对方字段名，如 districtCode" />
                    <button type="button" onClick={() => onRemoveCustom(m.sysKey)} style={{ ...btnStyle('#ff8a8a', true), padding: '4px 8px', flexShrink: 0 }} title="删除该自定义字段">✕</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
        <button type="button" onClick={onAddCustom} style={{ ...btnStyle('#9fd0ff', true), padding: '5px 12px' }}>+ 自定义字段</button>
        <span style={{ color: '#3a5a70', fontSize: 11 }}>满足非标准字段（如 districtCode、deptName）：左列填固定值或 {'{变量}'}，右列填对方字段名。</span>
      </div>
    </>
  )
}

type Tab = 'plans' | 'rules' | 'platforms' | 'history' | 'templates'

interface Plan {
  id: string; event_type: string; name: string; enabled: boolean
  api_url: string; api_method: string; api_headers: Record<string, string>
  body_template: string; description: string; created_at: string; updated_at: string
  platform_id?: string | null
  api_url_other?: string; api_method_other?: string; api_headers_other?: Record<string, string>
  body_template_other?: string
}
interface Platform {
  id: string; name: string; api_url: string; api_method: string
  api_headers: Record<string, string>; body_template: string
  auth_mode: string; auth_key_name: string; event_types: string
  enabled: boolean; description: string; created_at: string; updated_at: string
  api_url_other?: string; api_method_other?: string; api_headers_other?: Record<string, string>
  body_template_other?: string
}
interface Rule {
  id: string; name: string; event_type: string; plan_id: string; plan_name?: string
  location_match: string; time_window_hours: number; trigger_count: number
  enabled: boolean; created_at: string; platform_name?: string
}
interface PushHistory {
  id: string; rule_id: string; plan_id: string; event_type: string
  event_ids: string[]; location: string; trigger_count: number
  api_url: string; api_method: string; request_body: string
  response_status: number; response_body: string; success: boolean
  error_message: string; created_at: string
  status?: string; disposal_result?: string; disposal_operator?: string
  closed_at?: string; callback_time?: string; is_timeout?: number
  platform_name?: string; report_path?: string; report_generated_at?: string
}
interface PushEvent {
  id: string; event_type: string; location: string; lat: number; lon: number
  level: number; value: string; standard: string; description: string
  source: string; created_at: string; status?: string
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '7px 10px', background: 'rgba(0,20,60,0.6)',
  border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3, color: '#c8e6ff',
  fontSize: 13, outline: 'none', boxSizing: 'border-box',
}
const labelStyle: React.CSSProperties = { color: '#5a8aaa', fontSize: 12, display: 'block', marginBottom: 4 }
const btnStyle = (color: string, ghost = false): React.CSSProperties => ({
  padding: '6px 14px', fontSize: 12, borderRadius: 3, cursor: 'pointer',
  border: `1px solid ${color}55`,
  background: ghost ? 'transparent' : `${color}18`,
  color: ghost ? '#5a8aaa' : color,
})

const SECTION_BG = 'rgba(0,15,40,0.5)'

export function SmartPushPage() {
  const [tab, setTab] = useState<Tab>('platforms')
  const [advanced, setAdvanced] = useState(false)

  const allTabs = [
    { key: 'platforms' as Tab, label: '目标平台', icon: '\u{1F5A5}', simple: true },
    { key: 'history' as Tab, label: '推送历史', icon: '\u{1F4DD}', simple: true },
    { key: 'templates' as Tab, label: '结案模板', icon: '\u{1F4C4}', simple: true },
    { key: 'plans' as Tab, label: '处置预案', icon: '\u{1F4CB}', simple: false },
    { key: 'rules' as Tab, label: '推送规则', icon: '\u{2696}', simple: false },
  ]
  const visibleTabs = allTabs.filter(t => t.simple || advanced)

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '16px 24px 12px', borderBottom: '1px solid rgba(0,80,150,0.2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <span style={{ fontSize: 18 }}>{'\u{1F3E0}'}</span>
          <span style={{ color: '#c8e6ff', fontSize: 17, fontWeight: 700, letterSpacing: '0.04em' }}>智治推送</span>
          <span style={{ color: '#3a5a70', fontSize: 12 }}>城运中心处置预案对接</span>
        </div>
        <div style={{ color: '#5a8aaa', fontSize: 12, marginBottom: 12 }}>
          默认使用「目标平台」即可自动推送；如需按点位/阈值/时间窗控制，或需要单事件类型定制报文，请开启高级模式。
        </div>
        {/* Tabs */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {visibleTabs.map(t => (
              <button key={t.key} onClick={() => setTab(t.key)}
                style={{
                  padding: '8px 20px', fontSize: 13, borderRadius: '3px 3px 0 0',
                  border: '1px solid rgba(0,80,150,0.2)',
                  background: tab === t.key ? 'rgba(0,170,255,0.08)' : 'transparent',
                  color: tab === t.key ? CYAN : '#5a8aaa', cursor: 'pointer',
                  fontWeight: tab === t.key ? 600 : 400,
                  borderBottom: tab === t.key ? '1px solid rgba(3,10,28,0.98)' : '1px solid rgba(0,80,150,0.2)',
                }}>
                {t.icon} {t.label}
              </button>
            ))}
          </div>
          <button onClick={() => {
            setAdvanced(v => !v)
            if (!advanced) setTab('plans')
          }} style={{
            padding: '5px 12px', fontSize: 12, borderRadius: 3, cursor: 'pointer',
            border: '1px solid rgba(239,159,39,0.4)',
            background: advanced ? 'rgba(239,159,39,0.15)' : 'transparent',
            color: advanced ? '#ef9f27' : '#5a8aaa'
          }}>
            {advanced ? '收起高级模式' : '高级模式'}
          </button>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
        {tab === 'plans' && <PlansTab />}
        {tab === 'rules' && <RulesTab />}
        {tab === 'platforms' && <PlatformsTab />}
        {tab === 'history' && <HistoryTab />}
        {tab === 'templates' && <ReportTemplatesTab />}
      </div>
    </div>
  )
}

// ── 处置预案 Tab ──────────────────────────────────────────
function PlansTab() {
  const [plans, setPlans] = useState<Plan[]>([])
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Plan | null>(null)
  const [showForm, setShowForm] = useState(false)

  const load = useCallback(async () => {
    try {
      const [data, plats] = await Promise.all([
        apiFetch<Plan[]>('/api/smart-push/plans'),
        apiFetch<Platform[]>('/api/smart-push/platforms').catch(() => []),
      ])
      setPlatforms(plats || [])
      setPlans(data || [])
    } catch (e) { console.error('加载预案失败:', e) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const save = async (plan: Partial<Plan>) => {
    try {
      if (plan.id) {
        await apiFetch(`/api/smart-push/plans/${plan.id}`, { method: 'PATCH', body: JSON.stringify(plan) })
      } else {
        await apiFetch('/api/smart-push/plans', { method: 'POST', body: JSON.stringify(plan) })
      }
      setShowForm(false); setEditing(null); load()
    } catch (e: any) { alert('保存失败: ' + (e?.error || e?.message || e)) }
  }

  const del = async (id: string) => {
    if (!confirm('确认删除此预案？')) return
    try { await apiFetch(`/api/smart-push/plans/${id}`, { method: 'DELETE' }); load() }
    catch (e: any) { alert('删除失败: ' + (e?.error || e)) }
  }

  const testPush = async (plan: Plan) => {
    try {
      const result = await apiFetch<any>('/api/smart-push/test', { method: 'POST', body: JSON.stringify({ plan_id: plan.id }) })
      if (result.success) alert('推送成功！\n状态: ' + result.status + '\n响应: ' + (result.body || '').slice(0, 200))
      else alert('推送失败: ' + (result.error || `HTTP ${result.status}`))
    } catch (e: any) { alert('测试异常: ' + (e?.error || e)) }
  }

  if (loading) return <div style={{ color: '#5a8aaa', padding: 40, textAlign: 'center' }}>加载中...</div>

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ color: '#7ab8e0', fontSize: 13 }}>
          处置预案配置 — 每种事件类型对应城运中心的接口地址和报文模板
        </div>
        <button style={btnStyle(CYAN)} onClick={() => { setEditing(null); setShowForm(true) }}>+ 新增预案</button>
      </div>

      {plans.length === 0 && !showForm && (
        <div style={{ color: '#3a5a70', padding: 40, textAlign: 'center', fontSize: 13 }}>
          暂无预案配置，点击"新增预案"开始
        </div>
      )}

      {/* Plan cards */}
      {plans.map(p => (
        <div key={p.id} style={{
          background: SECTION_BG, border: `1px solid rgba(0,100,180,0.2)`, borderRadius: 4,
          padding: 16, marginBottom: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <div style={{ width: 4, height: 16, background: TYPE_COLORS[p.event_type] || CYAN, borderRadius: 1 }} />
            <span style={{ color: '#c8e6ff', fontSize: 14, fontWeight: 600 }}>{p.name}</span>
            <span style={{ padding: '1px 8px', fontSize: 11, borderRadius: 2, background: `${TYPE_COLORS[p.event_type] || CYAN}18`, color: TYPE_COLORS[p.event_type] || CYAN }}>
              {p.event_type}
            </span>
            <span style={{ padding: '1px 7px', fontSize: 11, borderRadius: 2, background: p.enabled ? `${GREEN}18` : `${RED}18`, color: p.enabled ? GREEN : RED }}>
              {p.enabled ? '启用' : '停用'}
            </span>
            {p.platform_id && (() => {
              const bp = platforms.find(x => x.id === p.platform_id)
              return <span style={{ padding: '1px 7px', fontSize: 11, borderRadius: 2, background: `${PURPLE}18`, color: PURPLE }}>{'\u{1F5A5}'} {bp ? bp.name : '已绑定平台'}</span>
            })()}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <button style={btnStyle(GREEN, true)} onClick={() => testPush(p)}>测试推送</button>
              <button style={btnStyle(CYAN, true)} onClick={() => { setEditing(p); setShowForm(true) }}>编辑</button>
              <button style={btnStyle(RED, true)} onClick={() => del(p.id)}>删除</button>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px', fontSize: 12, color: '#5a8aaa' }}>
            <div><span style={{ color: '#3a5a70' }}>接口地址: </span><span style={{ color: '#7ab8e0', fontFamily: "'JetBrains Mono',monospace" }}>{p.api_method} {p.api_url || '(未配置)'}</span></div>
            <div><span style={{ color: '#3a5a70' }}>创建时间: </span><span style={{ color: '#7ab8e0' }}>{p.created_at}</span></div>
            {p.description && <div style={{ gridColumn: '1/3' }}><span style={{ color: '#3a5a70' }}>描述: </span><span style={{ color: '#7ab8e0' }}>{p.description}</span></div>}
            {p.body_template && (
              <div style={{ gridColumn: '1/3' }}>
                <span style={{ color: '#3a5a70' }}>报文模板: </span>
                <pre style={{ color: '#5a8aaa', fontSize: 11, fontFamily: "'JetBrains Mono',monospace", background: 'rgba(0,10,30,0.6)', padding: 8, borderRadius: 3, marginTop: 4, maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{p.body_template}</pre>
              </div>
            )}
          </div>
        </div>
      ))}

      {showForm && <PlanForm plan={editing} onSave={save} onCancel={() => { setShowForm(false); setEditing(null) }} />}
    </div>
  )
}

function PlanForm({ plan, onSave, onCancel }: { plan: Plan | null; onSave: (p: Partial<Plan>) => void; onCancel: () => void }) {
  const [form, setForm] = useState({
    id: plan?.id || '',
    event_type: plan?.event_type || '气体污染',
    name: plan?.name || '',
    enabled: plan?.enabled !== false,
    api_url: plan?.api_url || '',
    api_method: plan?.api_method || 'POST',
    api_headers: JSON.stringify(plan?.api_headers || { 'Content-Type': 'application/json' }, null, 2),
    body_template: plan?.body_template || PLATFORM_PRESETS.find(p => p.key === 'custom')!.body_template,
    description: plan?.description || '',
    platform_id: plan?.platform_id || '',
    api_url_other: plan?.api_url_other || '',
    api_method_other: plan?.api_method_other || 'POST',
    api_headers_other: JSON.stringify(plan?.api_headers_other || {}, null, 2),
    body_template_other: plan?.body_template_other || '',
  })
  const [showOther, setShowOther] = useState(false)
  // P2：可选绑定“目标平台”——绑定后地址/鉴权/模板均继承自平台，无需在此重复填写
  const [platforms, setPlatforms] = useState<Platform[]>([])
  useEffect(() => { apiFetch<Platform[]>('/api/smart-push/platforms').then(setPlatforms).catch(() => {}) }, [])
  const boundPlatform = platforms.find(p => p.id === form.platform_id)
  // 平台预设与令牌（P0：让非技术人员选平台 + 填令牌即可）
  const [presetKey, setPresetKey] = useState('')
  const [token, setToken] = useState('')
  // P1：配置模式（向导=字段映射，高级=手写JSON）+ 报文格式 + 鉴权向导
  const [formMode, setFormMode] = useState<'wizard' | 'advanced'>(plan ? 'advanced' : 'wizard')
  const [bodyFormat, setBodyFormat] = useState<'json' | 'form'>('json')
  const [authMode, setAuthMode] = useState<'none' | 'bearer' | 'appkey'>('none')
  const [authKeyName, setAuthKeyName] = useState('X-App-Token')
  const [mappings, setMappings] = useState<FieldMapping[]>(() => parseTemplateToMappings(form.body_template))

  const set = (k: string, v: any) => setForm(prev => ({ ...prev, [k]: v }))

  // 向导模式：映射表 / 报文格式变化 → 实时生成 body_template
  useEffect(() => {
    if (formMode !== 'wizard') return
    setForm(prev => ({ ...prev, body_template: buildTemplate(mappings, bodyFormat) }))
  }, [mappings, bodyFormat, formMode])

  // 向导模式：鉴权方式 / 令牌 / 格式变化 → 实时生成请求头
  useEffect(() => {
    if (formMode !== 'wizard') return
    const headers: Record<string, string> = {
      'Content-Type': bodyFormat === 'json' ? 'application/json' : 'application/x-www-form-urlencoded',
    }
    if (authMode === 'bearer' && token.trim()) headers['Authorization'] = 'Bearer ' + token.trim()
    else if (authMode === 'appkey' && token.trim()) headers[(authKeyName.trim() || 'X-App-Token')] = token.trim()
    setForm(prev => ({ ...prev, api_headers: JSON.stringify(headers, null, 2) }))
  }, [authMode, authKeyName, token, bodyFormat, formMode])

  // 选择平台预设：有向导定义→应用映射走向导模式；否则（复杂报文）自动切高级模式并填模板
  const applyPreset = (key: string) => {
    setPresetKey(key)
    if (!key) return
    const preset = PLATFORM_PRESETS.find(p => p.key === key)
    if (!preset) return
    if (preset.wizard) {
      setFormMode('wizard')
      setBodyFormat(preset.wizard.format)
      setAuthMode(preset.wizard.auth)
      if (preset.wizard.authKeyName) setAuthKeyName(preset.wizard.authKeyName)
      const presetMappings = SYS_FIELDS.map(f => {
        const hit = preset.wizard!.fields.find(x => x.sysKey === f.sysKey)
        return { sysKey: f.sysKey, target: hit ? hit.target : f.sysKey, enabled: !!hit }
      })
      const existingCustom = mappings.filter(m => m.custom) // 保留用户已加的自定义字段
      setMappings([...presetMappings, ...existingCustom])
      setForm(prev => ({ ...prev, api_method: preset.api_method }))
    } else {
      setFormMode('advanced')
      setForm(prev => ({
        ...prev,
        api_method: preset.api_method,
        api_headers: JSON.stringify(preset.headers, null, 2),
        body_template: preset.body_template,
      }))
      alert(`「${preset.name}」报文含拼接字段/固定值，已切换到「高级模式」并填好模板，可直接微调后保存。`)
    }
  }

  const activePreset = PLATFORM_PRESETS.find(p => p.key === presetKey)
  const setMapping = (sysKey: string, patch: Partial<FieldMapping>) =>
    setMappings(prev => prev.map(m => m.sysKey === sysKey ? { ...m, ...patch } : m))

  // 向导模式：自定义字段增删
  const addCustomField = () => setMappings(prev => {
    const key = `custom_${Date.now().toString(36)}_${prev.filter(m => m.custom).length}`
    return [...prev, { sysKey: key, target: '', enabled: true, custom: true, customValue: '' }]
  })
  const removeCustomField = (sysKey: string) => setMappings(prev => prev.filter(m => m.sysKey !== sysKey))

  // 从高级模式切回向导模式时，把当前报文模板回灌为映射表（含自定义字段）
  useEffect(() => {
    if (formMode === 'wizard') setMappings(parseTemplateToMappings(form.body_template))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formMode])

  // 报文预览 + JSON 合法性校验（表单格式不校验 JSON）
  const isForm = formMode === 'wizard' && bodyFormat === 'form'
  const previewText = renderTemplate(form.body_template, PREVIEW_SAMPLE)
  let jsonValid = true, jsonErr = ''
  if (!isForm) {
    try { JSON.parse(previewText) } catch (e: any) { jsonValid = false; jsonErr = e?.message || 'JSON 格式错误' }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div style={{
        width: 680, maxHeight: '85vh', overflow: 'auto',
        background: '#040e25', border: '1px solid rgba(0,150,220,0.3)',
        borderRadius: 6, padding: 24,
      }}>
        <div style={{ color: '#c8e6ff', fontSize: 15, fontWeight: 600, marginBottom: 16 }}>
          {plan ? '编辑预案' : '新增预案'}
        </div>

        {/* P2：目标平台绑定（可选） */}
        <div style={{ padding: 12, background: 'rgba(171,71,188,0.08)', border: '1px solid rgba(171,71,188,0.25)', borderRadius: 4, marginBottom: 14 }}>
          <label style={{ ...labelStyle, color: PURPLE, fontWeight: 600 }}>{'\u{1F5A5}'} 绑定目标平台（可选，推荐）</label>
          <select style={inputStyle} value={form.platform_id} onChange={e => set('platform_id', e.target.value)}>
            <option value="">-- 不绑定（独立配置接口地址/模板） --</option>
            {platforms.filter(p => p.enabled).map(p => <option key={p.id} value={p.id}>{p.name}{p.event_types && p.event_types !== 'ALL' ? `（订阅 ${p.event_types.split(',').length} 类）` : ''}</option>)}
          </select>
          {boundPlatform ? (
            <div style={{ marginTop: 8, fontSize: 12, color: '#7ab8e0', lineHeight: 1.6 }}>
              <span style={{ color: GREEN }}>{'\u{2713}'}</span> 已绑定平台「{boundPlatform.name}」，接口地址 / 鉴权 / 报文模板将<span style={{ color: CYAN }}>自动继承该平台配置</span>，下方无需填写。
              <div style={{ color: '#5a8aaa', marginTop: 4 }}>
                平台接口：<span style={{ fontFamily: "'JetBrains Mono',monospace", color: '#7ab8e0' }}>{boundPlatform.api_method} {boundPlatform.api_url}</span>
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 8, fontSize: 12, color: '#3a5a70' }}>
              绑定后，新增同类型事件只需创建预案并选此平台，无需重复填地址与模板。也可不绑定，下方照常独立配置。
            </div>
          )}
        </div>

        {/* 平台预设：选中即自动填好模板与请求头（仅未绑定平台时） */}
        {!boundPlatform && (<>
        <div style={{ padding: 12, background: 'rgba(0,40,80,0.35)', border: '1px solid rgba(0,150,220,0.25)', borderRadius: 4, marginBottom: 14 }}>
          <label style={{ ...labelStyle, color: CYAN, fontWeight: 600 }}>{'\u{1F517}'} 选择目标平台（推荐先选，自动填好报文模板与请求头）</label>
          <select style={inputStyle} value={presetKey} onChange={e => applyPreset(e.target.value)}>
            <option value="">-- 请选择要推送的政府平台 --</option>
            {PLATFORM_PRESETS.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
          </select>
          {activePreset && (
            <div style={{ marginTop: 8, fontSize: 12, color: '#7ab8e0', lineHeight: 1.6 }}>
              <span style={{ color: AMBER }}>{'\u{1F4A1}'} </span>{activePreset.hint}
              <div style={{ color: '#5a8aaa', marginTop: 4 }}>
                建议接口地址格式：<span style={{ fontFamily: "'JetBrains Mono',monospace", color: '#7ab8e0' }}>{activePreset.api_url_hint}</span>
              </div>
              {activePreset.authHeader && formMode === 'advanced' && (
                <div style={{ marginTop: 8 }}>
                  <label style={labelStyle}>接口令牌 / 密钥（可选，由对方平台提供）</label>
                  <input style={inputStyle} value={token} onChange={e => setToken(e.target.value)}
                    placeholder={`填后自动写入请求头 ${activePreset.authHeader}: ${activePreset.authPrefix || ''}你的令牌`} />
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px' }}>
          <div>
            <label style={labelStyle}>预案名称 *</label>
            <input style={inputStyle} value={form.name} onChange={e => set('name', e.target.value)} placeholder="如：气体污染-城运中心推送" />
          </div>
          <div>
            <label style={labelStyle}>事件类型 *</label>
            <select style={inputStyle} value={form.event_type} onChange={e => set('event_type', e.target.value)}>
              {EVENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              <option value="custom">自定义...</option>
            </select>
          </div>
        </div>
        {!boundPlatform && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px', marginTop: 12 }}>
            <div>
              <label style={labelStyle}>HTTP 方法</label>
              <select style={inputStyle} value={form.api_method} onChange={e => set('api_method', e.target.value)}>
                <option value="POST">POST</option>
                <option value="GET">GET</option>
                <option value="PUT">PUT</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>接口地址</label>
              <input style={inputStyle} value={form.api_url} onChange={e => set('api_url', e.target.value)} placeholder={activePreset?.api_url_hint || 'http://目标平台地址/api/report'} />
            </div>
          </div>
        )}

        {/* 配置模式切换：向导（填表）/ 高级（手写JSON） */}
        <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: '#5a8aaa', fontSize: 12 }}>配置方式:</span>
          {([
            { k: 'wizard' as const, label: '\u{1F9ED} 向导模式（填表，无需懂 JSON）' },
            { k: 'advanced' as const, label: '\u{2699} 高级模式（手写 JSON）' },
          ]).map(m => (
            <button key={m.k} onClick={() => setFormMode(m.k)}
              style={{
                padding: '5px 14px', fontSize: 12, borderRadius: 3, cursor: 'pointer',
                border: `1px solid ${formMode === m.k ? CYAN : 'rgba(0,80,150,0.3)'}`,
                background: formMode === m.k ? 'rgba(0,170,255,0.12)' : 'transparent',
                color: formMode === m.k ? CYAN : '#5a8aaa', fontWeight: formMode === m.k ? 600 : 400,
              }}>{m.label}</button>
          ))}
        </div>

        {/* ── 向导模式 ── */}
        {formMode === 'wizard' && (
          <>
            {/* 鉴权向导 */}
            <div style={{ marginTop: 12, padding: 12, background: 'rgba(0,15,40,0.5)', border: '1px solid rgba(0,100,180,0.2)', borderRadius: 4 }}>
              <label style={{ ...labelStyle, color: '#7ab8e0', fontWeight: 600 }}>{'\u{1F510}'} 接口鉴权（对方平台要求带令牌时选择）</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <select style={{ ...inputStyle, width: 'auto' }} value={authMode} onChange={e => setAuthMode(e.target.value as any)}>
                  <option value="none">无需鉴权</option>
                  <option value="bearer">Bearer 令牌（Authorization）</option>
                  <option value="appkey">自定义密钥头（AppKey）</option>
                </select>
                {authMode === 'appkey' && (
                  <input style={{ ...inputStyle, width: 160 }} value={authKeyName} onChange={e => setAuthKeyName(e.target.value)} placeholder="请求头名，如 X-App-Token" />
                )}
                {authMode !== 'none' && (
                  <input style={{ ...inputStyle, flex: 1, minWidth: 200 }} value={token} onChange={e => setToken(e.target.value)} placeholder="粘贴对方平台提供的令牌 / 密钥" />
                )}
              </div>
              {authMode !== 'none' && (
                <div style={{ color: '#3a5a70', fontSize: 11, marginTop: 6 }}>
                  将自动写入请求头：<span style={{ color: '#7ab8e0', fontFamily: "'JetBrains Mono',monospace" }}>
                    {authMode === 'bearer' ? `Authorization: Bearer ${token.trim() || '你的令牌'}` : `${authKeyName.trim() || 'X-App-Token'}: ${token.trim() || '你的令牌'}`}
                  </span>
                </div>
              )}
            </div>

            {/* 报文格式 */}
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: '#5a8aaa', fontSize: 12 }}>报文格式:</span>
              {([{ k: 'json' as const, label: 'JSON（大多数平台）' }, { k: 'form' as const, label: '表单（key=value&...）' }]).map(f => (
                <label key={f.k} style={{ color: bodyFormat === f.k ? CYAN : '#5a8aaa', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input type="radio" checked={bodyFormat === f.k} onChange={() => setBodyFormat(f.k)} />{f.label}
                </label>
              ))}
            </div>

            {/* 字段映射表（含自定义字段） */}
            <div style={{ marginTop: 12 }}>
              <FieldMappingTable mappings={mappings} setMapping={setMapping} onAddCustom={addCustomField} onRemoveCustom={removeCustomField} />
              <div style={{ color: '#3a5a70', fontSize: 11, marginTop: 4 }}>
                提示：不同平台字段名不同（如城运用 <span style={{ fontFamily: "'JetBrains Mono',monospace" }}>longitude</span>，网格用 <span style={{ fontFamily: "'JetBrains Mono',monospace" }}>lng</span>）。只需照对方接口文档填右列即可，无需改 JSON。
              </div>
            </div>
          </>
        )}

        {/* ── 高级模式 ── */}
        {formMode === 'advanced' && (
          <>
            <div style={{ marginTop: 12 }}>
              <label style={labelStyle}>请求头 (JSON)</label>
              <textarea style={{ ...inputStyle, minHeight: 70, fontFamily: "'JetBrains Mono',monospace", fontSize: 12 }} value={form.api_headers} onChange={e => set('api_headers', e.target.value)} />
            </div>

            <div style={{ marginTop: 12 }}>
              <label style={labelStyle}>
                报文模板 (JSON, 支持变量: {SYS_FIELDS.map(f => '{' + f.sysKey + '}').join(' ')})
              </label>
              <textarea style={{ ...inputStyle, minHeight: 160, fontFamily: "'JetBrains Mono',monospace", fontSize: 12 }} value={form.body_template} onChange={e => set('body_template', e.target.value)} />
            </div>
          </>
        )}

        {/* 报文预览：用示例数据渲染真实报文 + JSON 合法性校验 */}
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <label style={{ ...labelStyle, marginBottom: 0 }}>{'\u{1F441}'} 报文预览（用示例数据渲染，即实际发送内容）</label>
            {isForm
              ? <span style={{ color: CYAN, fontSize: 11 }}>{'\u2713'} 表单格式（key=value&...）</span>
              : jsonValid
                ? <span style={{ color: GREEN, fontSize: 11 }}>{'\u2713'} JSON 格式合法</span>
                : <span style={{ color: RED, fontSize: 11 }}>{'\u2717'} JSON 格式错误：{jsonErr}</span>}
          </div>
          <pre style={{
            color: jsonValid ? '#8fd6a0' : '#ffb0b0', fontSize: 11.5, fontFamily: "'JetBrains Mono',monospace",
            background: 'rgba(0,10,30,0.6)', border: `1px solid ${jsonValid ? 'rgba(0,150,80,0.3)' : 'rgba(220,60,60,0.4)'}`,
            padding: 10, borderRadius: 3, maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap', margin: 0,
          }}>{previewText}</pre>
          <div style={{ color: '#3a5a70', fontSize: 11, marginTop: 4 }}>
            示例数据：气体污染 · 龙泗路口监测点 · 触发3次（真实推送时自动替换为实际告警数据）
          </div>
        </div>
        {/* 副接口（附件/补充信息接口，如城运中心 /client/handle_event_other）：主接口推送后顺序调用 */}
        <div style={{ marginTop: 16, border: '1px solid rgba(0,150,220,0.2)', borderRadius: 6, overflow: 'hidden' }}>
          <button type="button" onClick={() => setShowOther(!showOther)} style={{ width: '100%', textAlign: 'left', padding: '10px 14px', background: 'rgba(0,30,70,0.4)', border: 'none', color: '#c8e6ff', fontSize: 13, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>{'\u{1F4CE}'} 附件接口（副接口，可选）</span>
            <span style={{ color: '#5a8aaa', fontSize: 11 }}>{showOther ? '收起 ▲' : '展开 ▼'}</span>
          </button>
          {showOther && (
            <div style={{ padding: 14 }}>
              <div style={{ color: '#3a5a70', fontSize: 11, lineHeight: 1.6, marginBottom: 12 }}>
                部分平台（如城运中心）要求主接口推事件基本信息后，再用第二个接口推附件/图片。留空表示不启用。副接口支持 <code>{'{image_url}'}</code> 等变量，用于回传事件图片。
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={labelStyle}>接口地址（如 /client/handle_event_other）</label>
                  <input style={inputStyle} value={form.api_url_other} onChange={e => set('api_url_other', e.target.value)} placeholder="http://平台地址/api/xxx" />
                </div>
                <div>
                  <label style={labelStyle}>HTTP 方法</label>
                  <select style={inputStyle} value={form.api_method_other} onChange={e => set('api_method_other', e.target.value)}>
                    {['POST', 'PUT', 'GET', 'PATCH'].map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={labelStyle}>请求头（JSON）</label>
                <textarea style={{ ...inputStyle, minHeight: 60, fontFamily: "'JetBrains Mono',monospace", fontSize: 12 }} value={form.api_headers_other} onChange={e => set('api_headers_other', e.target.value)} placeholder='{"Content-Type":"application/json"}' />
              </div>
              <div>
                <label style={labelStyle}>报文模板（JSON，支持变量）</label>
                <textarea style={{ ...inputStyle, minHeight: 90, fontFamily: "'JetBrains Mono',monospace", fontSize: 12 }} value={form.body_template_other} onChange={e => set('body_template_other', e.target.value)} placeholder={'{"event_id":"{push_id}","attachments":[{"url":"{image_url}"}]'} />
              </div>
            </div>
          )}
        </div>
        </>)}

        <div style={{ marginTop: 12 }}>
          <label style={labelStyle}>描述</label>
          <input style={inputStyle} value={form.description} onChange={e => set('description', e.target.value)} placeholder="预案说明" />
        </div>

        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ color: '#5a8aaa', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} />
            启用此预案
          </label>
        </div>

        <div style={{ marginTop: 20, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button style={btnStyle('#5a8aaa', true)} onClick={onCancel}>取消</button>
          <button style={btnStyle(CYAN)} onClick={() => {
            let headers: Record<string, string> = {}
            try { headers = JSON.parse(form.api_headers) } catch { alert('请求头 JSON 格式错误'); return }
            // 高级模式：兼容 P0 的“预设令牌注入”；向导模式令牌已由鉴权向导写入请求头
            if (formMode === 'advanced' && token.trim() && activePreset?.authHeader) {
              headers[activePreset.authHeader] = (activePreset.authPrefix || '') + token.trim()
            }
            // 报文合法性拦截（表单格式不校验 JSON）
            if (!isForm && !jsonValid) {
              if (!confirm('报文预览显示模板不是合法 JSON（' + jsonErr + '）。\n若目标平台要求 JSON 格式，推送会失败。仍要保存吗？')) return
            }
            // 向导模式：自定义字段名校验（高级模式直接编辑 JSON，由 JSON 校验兜底）
            if (formMode === 'wizard') {
              const customErrs = validateCustomFields(mappings)
              if (customErrs.length) { alert('自定义字段有误：\n' + customErrs.join('\n')); return }
            }
            let headersOther: Record<string, string> = {}
            try { headersOther = JSON.parse(form.api_headers_other || '{}') } catch { alert('副接口请求头 JSON 格式错误'); return }
            onSave({ ...form, api_headers: headers, api_headers_other: headersOther })
          }}>保存</button>
        </div>
      </div>
    </div>
  )
}

// ── 目标平台 Tab（P2：可复用的推送连接配置，消除预案组合爆炸）──────────
function PlatformsTab() {
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Platform | null>(null)
  const [showForm, setShowForm] = useState(false)

  const load = useCallback(async () => {
    try { const data = await apiFetch<Platform[]>('/api/smart-push/platforms'); setPlatforms(data || []) }
    catch (e) { console.error('加载平台失败:', e) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const save = async (p: Partial<Platform>) => {
    try {
      if (p.id) await apiFetch(`/api/smart-push/platforms/${p.id}`, { method: 'PATCH', body: JSON.stringify(p) })
      else await apiFetch('/api/smart-push/platforms', { method: 'POST', body: JSON.stringify(p) })
      setShowForm(false); setEditing(null); load()
    } catch (e: any) { alert('保存失败: ' + (e?.error || e?.message || e)) }
  }
  const del = async (id: string) => {
    if (!confirm('确认删除此目标平台？已绑定该平台的预案会自动解绑（恢复独立配置）。')) return
    try { await apiFetch(`/api/smart-push/platforms/${id}`, { method: 'DELETE' }); load() }
    catch (e: any) { alert('删除失败: ' + (e?.error || e)) }
  }
  const testPush = async (p: Platform) => {
    try {
      const result = await apiFetch<any>('/api/smart-push/test', { method: 'POST', body: JSON.stringify({ platform_id: p.id }) })
      if (result.success) alert('推送成功！\n状态: ' + result.status + '\n响应: ' + (result.body || '').slice(0, 200))
      else alert('推送失败: ' + (result.error || `HTTP ${result.status}`))
    } catch (e: any) { alert('测试异常: ' + (e?.error || e)) }
  }

  if (loading) return <div style={{ color: '#5a8aaa', padding: 40, textAlign: 'center' }}>加载中...</div>

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ color: '#7ab8e0', fontSize: 13 }}>
          目标平台 — 配置一次可复用到所有事件类型；设“订阅事件类型”后无需建预案即可自动送达
        </div>
        <button style={btnStyle(CYAN)} onClick={() => { setEditing(null); setShowForm(true) }}>+ 新增平台</button>
      </div>

      {platforms.length === 0 && !showForm && (
        <div style={{ color: '#3a5a70', padding: 40, textAlign: 'center', fontSize: 13 }}>
          暂无目标平台。新增一个平台并勾选“订阅全部事件类型”，即可让所有告警自动推送到该平台，无需逐类建预案。
        </div>
      )}

      {platforms.map(p => {
        const ets = (p.event_types || '').split(',').map(s => s.trim()).filter(Boolean)
        const all = ets.includes('ALL')
        return (
          <div key={p.id} style={{ background: SECTION_BG, border: `1px solid rgba(0,100,180,0.2)`, borderRadius: 4, padding: 16, marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <span style={{ fontSize: 16 }}>{'\u{1F5A5}'}</span>
              <span style={{ color: '#c8e6ff', fontSize: 14, fontWeight: 600 }}>{p.name}</span>
              <span style={{ padding: '1px 7px', fontSize: 11, borderRadius: 2, background: p.enabled ? `${GREEN}18` : `${RED}18`, color: p.enabled ? GREEN : RED }}>
                {p.enabled ? '启用' : '停用'}
              </span>
              {all
                ? <span style={{ padding: '1px 7px', fontSize: 11, borderRadius: 2, background: `${PURPLE}18`, color: PURPLE }}>订阅全部事件类型</span>
                : ets.length > 0
                  ? <span style={{ padding: '1px 7px', fontSize: 11, borderRadius: 2, background: `${CYAN}18`, color: CYAN }}>订阅 {ets.length} 类</span>
                  : <span style={{ padding: '1px 7px', fontSize: 11, borderRadius: 2, background: 'rgba(90,138,170,0.15)', color: '#5a8aaa' }}>仅被预案引用</span>}
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button style={btnStyle(GREEN, true)} onClick={() => testPush(p)}>测试推送</button>
                <button style={btnStyle(CYAN, true)} onClick={() => { setEditing(p); setShowForm(true) }}>编辑</button>
                <button style={btnStyle(RED, true)} onClick={() => del(p.id)}>删除</button>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px', fontSize: 12, color: '#5a8aaa' }}>
              <div><span style={{ color: '#3a5a70' }}>接口地址: </span><span style={{ color: '#7ab8e0', fontFamily: "'JetBrains Mono',monospace" }}>{p.api_method} {p.api_url || '(未配置)'}</span></div>
              <div><span style={{ color: '#3a5a70' }}>鉴权: </span><span style={{ color: '#7ab8e0' }}>{p.auth_mode === 'none' ? '无需' : p.auth_mode === 'bearer' ? 'Bearer 令牌' : '密钥头(' + (p.auth_key_name || 'X-App-Token') + ')'}</span></div>
              <div style={{ gridColumn: '1/3' }}><span style={{ color: '#3a5a70' }}>订阅事件: </span><span style={{ color: '#7ab8e0' }}>{all ? '全部（ALL）' : ets.join('、') || '—'}</span></div>
              {p.description && <div style={{ gridColumn: '1/3' }}><span style={{ color: '#3a5a70' }}>描述: </span><span style={{ color: '#7ab8e0' }}>{p.description}</span></div>}
            </div>
          </div>
        )
      })}

      {showForm && <PlatformForm platform={editing} onSave={save} onCancel={() => { setShowForm(false); setEditing(null) }} />}
    </div>
  )
}

function PlatformForm({ platform, onSave, onCancel }: { platform: Platform | null; onSave: (p: Partial<Platform>) => void; onCancel: () => void }) {
  const [form, setForm] = useState({
    id: platform?.id || '',
    name: platform?.name || '',
    enabled: platform?.enabled !== false,
    api_url: platform?.api_url || '',
    api_method: platform?.api_method || 'POST',
    api_headers: JSON.stringify(platform?.api_headers || { 'Content-Type': 'application/json' }, null, 2),
    body_template: platform?.body_template || PLATFORM_PRESETS.find(p => p.key === 'custom')!.body_template,
    auth_mode: platform?.auth_mode || 'none',
    auth_key_name: platform?.auth_key_name || 'X-App-Token',
    event_types: platform?.event_types || '',
    description: platform?.description || '',
    api_url_other: platform?.api_url_other || '',
    api_method_other: platform?.api_method_other || 'POST',
    api_headers_other: JSON.stringify(platform?.api_headers_other || {}, null, 2),
    body_template_other: platform?.body_template_other || '',
  })
  const [showOther, setShowOther] = useState(false)
  // 鉴权向导 + 字段映射（复用 P1 机制）
  const [token, setToken] = useState('')
  const [formMode, setFormMode] = useState<'wizard' | 'advanced'>(platform ? 'advanced' : 'wizard')
  const [bodyFormat, setBodyFormat] = useState<'json' | 'form'>('json')
  const [authMode, setAuthMode] = useState<'none' | 'bearer' | 'appkey'>((platform?.auth_mode as 'none' | 'bearer' | 'appkey') || 'none')
  const [authKeyName, setAuthKeyName] = useState(platform?.auth_key_name || 'X-App-Token')
  const [mappings, setMappings] = useState<FieldMapping[]>(() => parseTemplateToMappings(form.body_template))
  // 订阅事件类型：'ALL' 或若干 EVENT_TYPES
  const [etAll, setEtAll] = useState((platform?.event_types || '').split(',').map(s => s.trim()).includes('ALL'))
  const [etSelected, setEtSelected] = useState<string[]>((platform?.event_types || '').split(',').map(s => s.trim()).filter(s => s && s !== 'ALL'))

  const set = (k: string, v: any) => setForm(prev => ({ ...prev, [k]: v }))

  useEffect(() => {
    if (formMode !== 'wizard') return
    setForm(prev => ({ ...prev, body_template: buildTemplate(mappings, bodyFormat), auth_mode: authMode, auth_key_name: authMode === 'appkey' ? authKeyName : '' }))
  }, [mappings, bodyFormat, formMode, authMode, authKeyName])

  useEffect(() => {
    if (formMode !== 'wizard') return
    const headers: Record<string, string> = { 'Content-Type': bodyFormat === 'json' ? 'application/json' : 'application/x-www-form-urlencoded' }
    if (authMode === 'bearer' && token.trim()) headers['Authorization'] = 'Bearer ' + token.trim()
    else if (authMode === 'appkey' && token.trim()) headers[(authKeyName.trim() || 'X-App-Token')] = token.trim()
    setForm(prev => ({ ...prev, api_headers: JSON.stringify(headers, null, 2) }))
  }, [authMode, authKeyName, token, bodyFormat, formMode])

  const setMapping = (sysKey: string, patch: Partial<FieldMapping>) =>
    setMappings(prev => prev.map(m => m.sysKey === sysKey ? { ...m, ...patch } : m))

  // 向导模式：自定义字段增删
  const addCustomField = () => setMappings(prev => {
    const key = `custom_${Date.now().toString(36)}_${prev.filter(m => m.custom).length}`
    return [...prev, { sysKey: key, target: '', enabled: true, custom: true, customValue: '' }]
  })
  const removeCustomField = (sysKey: string) => setMappings(prev => prev.filter(m => m.sysKey !== sysKey))

  // 从高级模式切回向导模式时，把当前报文模板回灌为映射表（含自定义字段）
  useEffect(() => {
    if (formMode === 'wizard') setMappings(parseTemplateToMappings(form.body_template))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formMode])

  const toggleEt = (t: string) => {
    setEtAll(false)
    setEtSelected(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])
  }
  const eventTypesValue = etAll ? 'ALL' : etSelected.join(',')

  const isForm = formMode === 'wizard' && bodyFormat === 'form'
  const previewText = renderTemplate(form.body_template, PREVIEW_SAMPLE)
  let jsonValid = true, jsonErr = ''
  if (!isForm) { try { JSON.parse(previewText) } catch (e: any) { jsonValid = false; jsonErr = e?.message || 'JSON 格式错误' } }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div style={{ width: 680, maxHeight: '85vh', overflow: 'auto', background: '#040e25', border: '1px solid rgba(0,150,220,0.3)', borderRadius: 6, padding: 24 }}>
        <div style={{ color: '#c8e6ff', fontSize: 15, fontWeight: 600, marginBottom: 16 }}>{platform ? '编辑平台' : '新增平台'}</div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px' }}>
          <div>
            <label style={labelStyle}>平台名称 *</label>
            <input style={inputStyle} value={form.name} onChange={e => set('name', e.target.value)} placeholder="如：城运视频平台 / 12345热线" />
          </div>
          <div>
            <label style={labelStyle}>HTTP 方法</label>
            <select style={inputStyle} value={form.api_method} onChange={e => set('api_method', e.target.value)}>
              <option value="POST">POST</option><option value="GET">GET</option><option value="PUT">PUT</option>
            </select>
          </div>
          <div style={{ gridColumn: '1/3' }}>
            <label style={labelStyle}>接口地址 *</label>
            <input style={inputStyle} value={form.api_url} onChange={e => set('api_url', e.target.value)} placeholder="http://平台地址/api/event/receive" />
          </div>
        </div>

        {/* 订阅事件类型（核心：选“全部”即零预案自动送达） */}
        <div style={{ marginTop: 14, padding: 12, background: 'rgba(171,71,188,0.08)', border: '1px solid rgba(171,71,188,0.25)', borderRadius: 4 }}>
          <label style={{ ...labelStyle, color: PURPLE, fontWeight: 600 }}>{'\u{1F4E1}'} 订阅事件类型（勾选后，这些类型的告警触发规则即自动推送到本平台，无需逐类建预案）</label>
          <label style={{ color: etAll ? PURPLE : '#5a8aaa', fontSize: 12, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 16 }}>
            <input type="checkbox" checked={etAll} onChange={e => { setEtAll(e.target.checked); if (e.target.checked) setEtSelected([]) }} /> 全部事件类型（ALL）
          </label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            {EVENT_TYPES.map(t => (
              <label key={t} style={{ color: etSelected.includes(t) ? CYAN : '#5a8aaa', fontSize: 12, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, opacity: etAll ? 0.4 : 1 }}>
                <input type="checkbox" checked={etSelected.includes(t)} disabled={etAll} onChange={() => toggleEt(t)} />
                {t}
              </label>
            ))}
          </div>
          <div style={{ color: '#3a5a70', fontSize: 11, marginTop: 4 }}>当前将订阅：<span style={{ color: '#7ab8e0' }}>{etAll ? '全部（ALL）' : (eventTypesValue || '（仅被预案引用时送达）')}</span></div>
        </div>

        {/* 配置方式切换 */}
        <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: '#5a8aaa', fontSize: 12 }}>配置方式:</span>
          {([{ k: 'wizard' as const, label: '\u{1F9ED} 向导模式（填表，无需懂 JSON）' }, { k: 'advanced' as const, label: '\u{2699} 高级模式（手写 JSON）' }]).map(m => (
            <button key={m.k} onClick={() => setFormMode(m.k)}
              style={{ padding: '5px 14px', fontSize: 12, borderRadius: 3, cursor: 'pointer', border: `1px solid ${formMode === m.k ? CYAN : 'rgba(0,80,150,0.3)'}`, background: formMode === m.k ? 'rgba(0,170,255,0.12)' : 'transparent', color: formMode === m.k ? CYAN : '#5a8aaa', fontWeight: formMode === m.k ? 600 : 400 }}>{m.label}</button>
          ))}
        </div>

        {formMode === 'wizard' && (
          <>
            <div style={{ marginTop: 12, padding: 12, background: 'rgba(0,15,40,0.5)', border: '1px solid rgba(0,100,180,0.2)', borderRadius: 4 }}>
              <label style={{ ...labelStyle, color: '#7ab8e0', fontWeight: 600 }}>{'\u{1F510}'} 接口鉴权（对方平台要求带令牌时选择）</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <select style={{ ...inputStyle, width: 'auto' }} value={authMode} onChange={e => setAuthMode(e.target.value as any)}>
                  <option value="none">无需鉴权</option>
                  <option value="bearer">Bearer 令牌（Authorization）</option>
                  <option value="appkey">自定义密钥头（AppKey）</option>
                </select>
                {authMode === 'appkey' && <input style={{ ...inputStyle, width: 160 }} value={authKeyName} onChange={e => setAuthKeyName(e.target.value)} placeholder="请求头名，如 X-App-Token" />}
                {authMode !== 'none' && <input style={{ ...inputStyle, flex: 1, minWidth: 200 }} value={token} onChange={e => setToken(e.target.value)} placeholder="粘贴对方平台提供的令牌 / 密钥" />}
              </div>
              {authMode !== 'none' && (
                <div style={{ color: '#3a5a70', fontSize: 11, marginTop: 6 }}>
                  将自动写入请求头：<span style={{ color: '#7ab8e0', fontFamily: "'JetBrains Mono',monospace" }}>{authMode === 'bearer' ? `Authorization: Bearer ${token.trim() || '你的令牌'}` : `${authKeyName.trim() || 'X-App-Token'}: ${token.trim() || '你的令牌'}`}</span>
                </div>
              )}
            </div>

            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: '#5a8aaa', fontSize: 12 }}>报文格式:</span>
              {([{ k: 'json' as const, label: 'JSON（大多数平台）' }, { k: 'form' as const, label: '表单（key=value&...）' }]).map(f => (
                <label key={f.k} style={{ color: bodyFormat === f.k ? CYAN : '#5a8aaa', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input type="radio" checked={bodyFormat === f.k} onChange={() => setBodyFormat(f.k)} />{f.label}
                </label>
              ))}
            </div>

            <div style={{ marginTop: 12 }}>
              <FieldMappingTable mappings={mappings} setMapping={setMapping} onAddCustom={addCustomField} onRemoveCustom={removeCustomField} />
            </div>
          </>
        )}

        {formMode === 'advanced' && (
          <>
            <div style={{ marginTop: 12 }}>
              <label style={labelStyle}>请求头 (JSON)</label>
              <textarea style={{ ...inputStyle, minHeight: 70, fontFamily: "'JetBrains Mono',monospace", fontSize: 12 }} value={form.api_headers} onChange={e => set('api_headers', e.target.value)} />
            </div>
            <div style={{ marginTop: 12 }}>
              <label style={labelStyle}>报文模板 (JSON, 支持变量: {'{event_type} {location} {lat} {lon} {level} {value} {standard} {time} {description} {trigger_count} {event_ids}'})</label>
              <textarea style={{ ...inputStyle, minHeight: 150, fontFamily: "'JetBrains Mono',monospace", fontSize: 12 }} value={form.body_template} onChange={e => set('body_template', e.target.value)} />
            </div>
          </>
        )}

        {/* 报文预览 */}
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <label style={{ ...labelStyle, marginBottom: 0 }}>{'\u{1F441}'} 报文预览（用示例数据渲染，即实际发送内容）</label>
            {isForm ? <span style={{ color: CYAN, fontSize: 11 }}>{'\u2713'} 表单格式（key=value&...）</span>
              : jsonValid ? <span style={{ color: GREEN, fontSize: 11 }}>{'\u2713'} JSON 格式合法</span>
                : <span style={{ color: RED, fontSize: 11 }}>{'\u2717'} JSON 格式错误：{jsonErr}</span>}
          </div>
          <pre style={{ color: jsonValid ? '#8fd6a0' : '#ffb0b0', fontSize: 11.5, fontFamily: "'JetBrains Mono',monospace", background: 'rgba(0,10,30,0.6)', border: `1px solid ${jsonValid ? 'rgba(0,150,80,0.3)' : 'rgba(220,60,60,0.4)'}`, padding: 10, borderRadius: 3, maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap', margin: 0           }}>{previewText}</pre>
        </div>
        {/* 副接口（附件/补充信息接口，如城运中心 /client/handle_event_other）：主接口推送后顺序调用 */}
        <div style={{ marginTop: 16, border: '1px solid rgba(0,150,220,0.2)', borderRadius: 6, overflow: 'hidden' }}>
          <button type="button" onClick={() => setShowOther(!showOther)} style={{ width: '100%', textAlign: 'left', padding: '10px 14px', background: 'rgba(0,30,70,0.4)', border: 'none', color: '#c8e6ff', fontSize: 13, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>{'\u{1F4CE}'} 附件接口（副接口，可选）</span>
            <span style={{ color: '#5a8aaa', fontSize: 11 }}>{showOther ? '收起 ▲' : '展开 ▼'}</span>
          </button>
          {showOther && (
            <div style={{ padding: 14 }}>
              <div style={{ color: '#3a5a70', fontSize: 11, lineHeight: 1.6, marginBottom: 12 }}>
                部分平台（如城运中心）要求主接口推事件基本信息后，再用第二个接口推附件/图片。留空表示不启用。副接口支持 <code>{'{image_url}'}</code> 等变量，用于回传事件图片。
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={labelStyle}>接口地址（如 /client/handle_event_other）</label>
                  <input style={inputStyle} value={form.api_url_other} onChange={e => set('api_url_other', e.target.value)} placeholder="http://平台地址/api/xxx" />
                </div>
                <div>
                  <label style={labelStyle}>HTTP 方法</label>
                  <select style={inputStyle} value={form.api_method_other} onChange={e => set('api_method_other', e.target.value)}>
                    {['POST', 'PUT', 'GET', 'PATCH'].map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={labelStyle}>请求头（JSON）</label>
                <textarea style={{ ...inputStyle, minHeight: 60, fontFamily: "'JetBrains Mono',monospace", fontSize: 12 }} value={form.api_headers_other} onChange={e => set('api_headers_other', e.target.value)} placeholder='{"Content-Type":"application/json"}' />
              </div>
              <div>
                <label style={labelStyle}>报文模板（JSON，支持变量）</label>
                <textarea style={{ ...inputStyle, minHeight: 90, fontFamily: "'JetBrains Mono',monospace", fontSize: 12 }} value={form.body_template_other} onChange={e => set('body_template_other', e.target.value)} placeholder={'{"event_id":"{push_id}","attachments":[{"url":"{image_url}"}]'} />
              </div>
            </div>
          )}
        </div>

        <div style={{ marginTop: 12 }}>
          <label style={labelStyle}>描述</label>
          <input style={inputStyle} value={form.description} onChange={e => set('description', e.target.value)} placeholder="平台说明" />
        </div>
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ color: '#5a8aaa', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} />启用此平台
          </label>
        </div>

        <div style={{ marginTop: 20, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button style={btnStyle('#5a8aaa', true)} onClick={onCancel}>取消</button>
          <button style={btnStyle(CYAN)} onClick={() => {
            let headers: Record<string, string> = {}
            try { headers = JSON.parse(form.api_headers) } catch { alert('请求头 JSON 格式错误'); return }
            let headersOther: Record<string, string> = {}
            try { headersOther = JSON.parse(form.api_headers_other || '{}') } catch { alert('副接口请求头 JSON 格式错误'); return }
            if (!form.name.trim()) { alert('请填写平台名称'); return }
            if (!form.api_url.trim()) { alert('请填写接口地址'); return }
            if (formMode === 'wizard') {
              const customErrs = validateCustomFields(mappings)
              if (customErrs.length) { alert('自定义字段有误：\n' + customErrs.join('\n')); return }
            }
            if (!isForm && !jsonValid) { if (!confirm('报文模板不是合法 JSON，推送可能失败。仍要保存吗？')) return }
            onSave({ ...form, api_headers: headers, api_headers_other: headersOther, event_types: eventTypesValue, auth_mode: authMode, auth_key_name: authMode === 'appkey' ? authKeyName : '' })
          }}>保存</button>
        </div>
      </div>
    </div>
  )
}

// ── 推送规则 Tab ──────────────────────────────────────────
function RulesTab() {
  const [rules, setRules] = useState<Rule[]>([])
  const [plans, setPlans] = useState<Plan[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Rule | null>(null)

  const load = useCallback(async () => {
    try {
      const [r, p] = await Promise.all([
        apiFetch<Rule[]>('/api/smart-push/rules'),
        apiFetch<Plan[]>('/api/smart-push/plans'),
      ])
      setRules(r || []); setPlans(p || [])
    } catch (e) { console.error('加载规则失败:', e) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const save = async (rule: Partial<Rule>) => {
    try {
      if (rule.id) {
        await apiFetch(`/api/smart-push/rules/${rule.id}`, { method: 'PATCH', body: JSON.stringify(rule) })
      } else {
        await apiFetch('/api/smart-push/rules', { method: 'POST', body: JSON.stringify(rule) })
      }
      setShowForm(false); setEditing(null); load()
    } catch (e: any) { alert('保存失败: ' + (e?.error || e?.message || e)) }
  }

  const del = async (id: string) => {
    if (!confirm('确认删除此规则？')) return
    try { await apiFetch(`/api/smart-push/rules/${id}`, { method: 'DELETE' }); load() }
    catch (e: any) { alert('删除失败: ' + (e?.error || e)) }
  }

  const toggle = async (rule: Rule) => {
    try { await apiFetch(`/api/smart-push/rules/${rule.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !rule.enabled }) }); load() }
    catch (e: any) { alert('操作失败: ' + (e?.error || e)) }
  }

  if (loading) return <div style={{ color: '#5a8aaa', padding: 40, textAlign: 'center' }}>加载中...</div>

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ color: '#7ab8e0', fontSize: 13 }}>
          推送规则 — 设置自动推送条件（同点位 + 时间窗口 + 累计次数）
        </div>
        <button style={btnStyle(CYAN)} onClick={() => { setEditing(null); setShowForm(true) }}>+ 新增规则</button>
      </div>

      {rules.length === 0 && !showForm && (
        <div style={{ color: '#3a5a70', padding: 40, textAlign: 'center', fontSize: 13 }}>
          暂无推送规则，点击"新增规则"开始
        </div>
      )}

      {rules.map(r => (
        <div key={r.id} style={{
          background: SECTION_BG, border: `1px solid rgba(0,100,180,0.2)`, borderRadius: 4,
          padding: 16, marginBottom: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <div style={{ width: 4, height: 16, background: TYPE_COLORS[r.event_type] || CYAN, borderRadius: 1 }} />
            <span style={{ color: '#c8e6ff', fontSize: 14, fontWeight: 600 }}>{r.name}</span>
            <span style={{ padding: '1px 8px', fontSize: 11, borderRadius: 2, background: `${TYPE_COLORS[r.event_type] || CYAN}18`, color: TYPE_COLORS[r.event_type] || CYAN }}>
              {r.event_type}
            </span>
            <span style={{ padding: '1px 7px', fontSize: 11, borderRadius: 2, background: r.enabled ? `${GREEN}18` : `${RED}18`, color: r.enabled ? GREEN : RED, cursor: 'pointer' }}
              onClick={() => toggle(r)}>
              {r.enabled ? '启用' : '停用'}
            </span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <button style={btnStyle(CYAN, true)} onClick={() => { setEditing(r); setShowForm(true) }}>编辑</button>
              <button style={btnStyle(RED, true)} onClick={() => del(r.id)}>删除</button>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 24, fontSize: 12, color: '#5a8aaa', flexWrap: 'wrap' }}>
            <div><span style={{ color: '#3a5a70' }}>关联预案: </span><span style={{ color: '#7ab8e0' }}>{r.plan_name || '(未关联)'}</span>{r.platform_name && <span style={{ color: PURPLE, fontSize: 11 }}> · 平台「{r.platform_name}」</span>}</div>
            <div><span style={{ color: '#3a5a70' }}>点位匹配: </span><span style={{ color: '#7ab8e0' }}>{r.location_match || '所有点位'}</span></div>
            <div><span style={{ color: '#3a5a70' }}>时间窗口: </span><span style={{ color: '#7ab8e0' }}>{r.time_window_hours} 小时</span></div>
            <div><span style={{ color: '#3a5a70' }}>触发阈值: </span><span style={{ color: AMBER, fontWeight: 600 }}>{r.trigger_count} 次</span></div>
          </div>
          <div style={{ marginTop: 6, fontSize: 12, color: '#3a5a70' }}>
            规则：当 <span style={{ color: TYPE_COLORS[r.event_type] || CYAN }}>{r.event_type}</span> 事件在点位
            {r.location_match ? `含"${r.location_match}"` : '（任意）'}
            的 {r.time_window_hours} 小时内累计触发 {r.trigger_count} 次 → 自动推送到城运中心
          </div>
        </div>
      ))}

      {showForm && <RuleForm rule={editing} plans={plans} onSave={save} onCancel={() => { setShowForm(false); setEditing(null) }} />}
    </div>
  )
}

function RuleForm({ rule, plans, onSave, onCancel }: { rule: Rule | null; plans: Plan[]; onSave: (r: Partial<Rule>) => void; onCancel: () => void }) {
  const [form, setForm] = useState({
    id: rule?.id || '',
    name: rule?.name || '',
    event_type: rule?.event_type || '堆头未覆盖',
    plan_id: rule?.plan_id || '',
    location_match: rule?.location_match || '',
    time_window_hours: rule?.time_window_hours || 48,
    trigger_count: rule?.trigger_count || 5,
    enabled: rule?.enabled !== false,
  })
  const set = (k: string, v: any) => setForm(prev => ({ ...prev, [k]: v }))

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div style={{
        width: 560, background: '#040e25', border: '1px solid rgba(0,150,220,0.3)',
        borderRadius: 6, padding: 24,
      }}>
        <div style={{ color: '#c8e6ff', fontSize: 15, fontWeight: 600, marginBottom: 16 }}>
          {rule ? '编辑规则' : '新增规则'}
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>规则名称 *</label>
          <input style={inputStyle} value={form.name} onChange={e => set('name', e.target.value)} placeholder="如：堆头未覆盖-48h-5次推送" />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px', marginBottom: 12 }}>
          <div>
            <label style={labelStyle}>事件类型 *</label>
            <select style={inputStyle} value={form.event_type} onChange={e => set('event_type', e.target.value)}>
              {EVENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>关联预案</label>
            <select style={inputStyle} value={form.plan_id} onChange={e => set('plan_id', e.target.value)}>
              <option value="">-- 未关联 --</option>
              {plans.filter(p => p.enabled).map(p => (
                <option key={p.id} value={p.id}>{p.name} ({p.event_type})</option>
              ))}
            </select>
          </div>
          <div>
            <label style={labelStyle}>点位匹配 (模糊)</label>
            <input style={inputStyle} value={form.location_match} onChange={e => set('location_match', e.target.value)} placeholder="留空=所有点位" />
          </div>
          <div>
            <label style={labelStyle}>时间窗口 (小时)</label>
            <input type="number" style={inputStyle} value={form.time_window_hours} onChange={e => set('time_window_hours', parseInt(e.target.value) || 48)} />
          </div>
          <div>
            <label style={labelStyle}>触发次数阈值</label>
            <input type="number" style={inputStyle} value={form.trigger_count} onChange={e => set('trigger_count', parseInt(e.target.value) || 5)} />
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <label style={{ color: '#5a8aaa', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} />
              启用此规则
            </label>
          </div>
        </div>

        <div style={{ padding: 12, background: 'rgba(0,10,30,0.5)', borderRadius: 3, fontSize: 12, color: '#5a8aaa', marginBottom: 16 }}>
          <span style={{ color: AMBER }}>规则说明：</span>
          当 <span style={{ color: TYPE_COLORS[form.event_type] || CYAN }}>{form.event_type}</span> 事件在点位
          {form.location_match ? `含"${form.location_match}"` : '（任意）'}
          的 <span style={{ color: '#7ab8e0' }}>{form.time_window_hours}</span> 小时内累计触发
          <span style={{ color: AMBER, fontWeight: 600 }}> {form.trigger_count} </span>次
          → 自动推送{form.plan_id ? '到关联预案配置的城运中心接口' : '（未关联预案，无法推送）'}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button style={btnStyle('#5a8aaa', true)} onClick={onCancel}>取消</button>
          <button style={btnStyle(CYAN)} onClick={() => onSave(form)}>保存</button>
        </div>
      </div>
    </div>
  )
}

// ── 推送历史 Tab ──────────────────────────────────────────
function HistoryTab() {
  const [history, setHistory] = useState<PushHistory[]>([])
  const [events, setEvents] = useState<PushEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [filterType, setFilterType] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterLocation, setFilterLocation] = useState('')
  const [filterStart, setFilterStart] = useState('')
  const [filterEnd, setFilterEnd] = useState('')
  const [filterPlatform, setFilterPlatform] = useState('')
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [detail, setDetail] = useState<PushHistory | null>(null)
  const [page, setPage] = useState(1)
  const PAGE_SIZE = 10
  const [jump, setJump] = useState('')

  // 目标平台列表（供筛选下拉使用）
  useEffect(() => {
    apiFetch<Platform[]>('/api/smart-push/platforms').then(setPlatforms).catch(() => {})
  }, [])

  // 关联证据（推送历史的 AI 分析图片 + 置信度），由详情弹窗触发加载
  const [evidences, setEvidences] = useState<EvidenceItem[]>([])
  const [evidenceType, setEvidenceType] = useState<EvidenceType>('no_events')
  const [evidenceMessage, setEvidenceMessage] = useState<string | null>(null)
  const [evidenceLoading, setEvidenceLoading] = useState(false)

  // 详情打开时拉取该推送的关联证据
  useEffect(() => {
    if (!detail?.id) {
      setEvidences([]); setEvidenceType('no_events'); setEvidenceMessage(null); setEvidenceLoading(false)
      return
    }
    let cancelled = false
    setEvidenceLoading(true)
    ;(async () => {
      try {
        const data = await apiFetch(`/api/smart-push/history/${detail.id}/evidence`)
        if (!cancelled && data?.ok) {
          setEvidences(data.evidences || [])
          setEvidenceType((data.evidenceType as EvidenceType) || 'no_events')
          setEvidenceMessage(data.message ?? null)
        }
      } catch {
        if (!cancelled) { setEvidenceType('no_events'); setEvidenceMessage('加载关联证据失败') }
      } finally { if (!cancelled) setEvidenceLoading(false) }
    })()
    return () => { cancelled = true }
  }, [detail?.id])

  const closePush = async (id: string) => {
    if (!confirm('确认将该推送记录标记为「已结案」？关联告警事件将同步结案。')) return
    try { await apiFetch(`/api/smart-push/history/${id}/close`, { method: 'POST' }); load() }
    catch (e: any) { alert('结案失败: ' + (e?.error || e)) }
  }

  // 生成/重生成结案报告 PDF（operator+），成功后触发下载
  const [reportBusy, setReportBusy] = useState<string | null>(null)
  const exportReport = async (id: string) => {
    setReportBusy(id)
    try {
      await apiFetch(`/api/smart-push/history/${id}/report`, { method: 'POST' })
      // 下载
      const resp = await authFetch(`/api/smart-push/history/${id}/report`)
      if (!resp.ok) throw new Error('下载失败')
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = `closure-report-${id}.pdf`; a.click()
      URL.revokeObjectURL(url)
      load()
    } catch (e: any) { alert('导出结案报告失败: ' + (e?.error || e?.message || e)) }
    finally { setReportBusy(null) }
  }

  const load = useCallback(async () => {
    try {
      const url = '/api/smart-push/history?limit=200'
        + (filterType ? `&event_type=${encodeURIComponent(filterType)}` : '')
        + (filterStatus ? `&status=${filterStatus}` : '')
        + (filterLocation.trim() ? `&location=${encodeURIComponent(filterLocation.trim())}` : '')
        + (filterStart ? `&start=${encodeURIComponent(filterStart + ' 00:00:00')}` : '')
        + (filterEnd ? `&end=${encodeURIComponent(filterEnd + ' 23:59:59')}` : '')
        + (filterPlatform ? `&platform_id=${encodeURIComponent(filterPlatform)}` : '')
      const [h, e] = await Promise.all([
        apiFetch<PushHistory[]>(url),
        apiFetch<PushEvent[]>('/api/smart-push/events?limit=200'),
      ])
      setHistory(h || []); setEvents(e || [])
    } catch (e) { console.error('加载历史失败:', e) }
    finally { setLoading(false) }
  }, [filterType, filterStatus, filterLocation, filterStart, filterEnd, filterPlatform])

  useEffect(() => { load() }, [load])

  // 前端分页：每页 10 条
  const totalPages = Math.max(1, Math.ceil(history.length / PAGE_SIZE))
  const safePage = Math.min(Math.max(1, page), totalPages)
  const pagedHistory = history.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
  useEffect(() => { setPage(1) }, [filterType, filterStatus, filterLocation, filterStart, filterEnd, filterPlatform])

  if (loading) return <div style={{ color: '#5a8aaa', padding: 40, textAlign: 'center' }}>加载中...</div>

  const stats = {
    total: history.length,
    success: history.filter(h => h.success).length,
    fail: history.filter(h => !h.success).length,
    eventTotal: events.length,
  }

  return (
    <div>
      {/* Stats */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
        <div style={{ background: SECTION_BG, border: '1px solid rgba(0,100,180,0.2)', borderRadius: 4, padding: '10px 20px', minWidth: 120 }}>
          <div style={{ color: '#3a5a70', fontSize: 11 }}>推送总数</div>
          <div style={{ color: '#c8e6ff', fontSize: 22, fontFamily: "'JetBrains Mono',monospace" }}>{stats.total}</div>
        </div>
        <div style={{ background: SECTION_BG, border: `1px solid ${GREEN}33`, borderRadius: 4, padding: '10px 20px', minWidth: 120 }}>
          <div style={{ color: '#3a5a70', fontSize: 11 }}>成功</div>
          <div style={{ color: GREEN, fontSize: 22, fontFamily: "'JetBrains Mono',monospace" }}>{stats.success}</div>
        </div>
        <div style={{ background: SECTION_BG, border: `1px solid ${RED}33`, borderRadius: 4, padding: '10px 20px', minWidth: 120 }}>
          <div style={{ color: '#3a5a70', fontSize: 11 }}>失败</div>
          <div style={{ color: RED, fontSize: 22, fontFamily: "'JetBrains Mono',monospace" }}>{stats.fail}</div>
        </div>
        <div style={{ background: SECTION_BG, border: '1px solid rgba(0,100,180,0.2)', borderRadius: 4, padding: '10px 20px', minWidth: 120 }}>
          <div style={{ color: '#3a5a70', fontSize: 11 }}>告警事件总数</div>
          <div style={{ color: AMBER, fontSize: 22, fontFamily: "'JetBrains Mono',monospace" }}>{stats.eventTotal}</div>
        </div>
      </div>

      {/* Filter */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ color: '#5a8aaa', fontSize: 12 }}>事件类型:</span>
        <select style={{ ...inputStyle, width: 'auto' }} value={filterType} onChange={e => setFilterType(e.target.value)}>
          <option value="">全部</option>
          {EVENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <span style={{ color: '#5a8aaa', fontSize: 12 }}>回执状态:</span>
        <select style={{ ...inputStyle, width: 'auto' }} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
          <option value="">全部</option>
          <option value="pushed">已推送(待回执)</option>
          <option value="processing">受理中</option>
          <option value="closed">已结案</option>
          <option value="timeout">超时未回执</option>
        </select>

        <span style={{ color: '#5a8aaa', fontSize: 12 }}>点位:</span>
        <input
          style={{ ...inputStyle, width: 160 }}
          value={filterLocation}
          placeholder="模糊匹配"
          onChange={e => setFilterLocation(e.target.value)}
        />

        <span style={{ color: '#5a8aaa', fontSize: 12 }}>时间段:</span>
        <input type="date" style={{ ...inputStyle, width: 'auto' }} value={filterStart} onChange={e => setFilterStart(e.target.value)} />
        <span style={{ color: '#5a8aaa', fontSize: 12 }}>~</span>
        <input type="date" style={{ ...inputStyle, width: 'auto' }} value={filterEnd} onChange={e => setFilterEnd(e.target.value)} />

        <span style={{ color: '#5a8aaa', fontSize: 12 }}>目标平台:</span>
        <select style={{ ...inputStyle, width: 'auto' }} value={filterPlatform} onChange={e => setFilterPlatform(e.target.value)}>
          <option value="">全部</option>
          {platforms.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>

        {(filterType || filterStatus || filterLocation.trim() || filterStart || filterEnd || filterPlatform) && (
          <button
            onClick={() => { setFilterType(''); setFilterStatus(''); setFilterLocation(''); setFilterStart(''); setFilterEnd(''); setFilterPlatform('') }}
            style={{ padding: '5px 12px', fontSize: 12, borderRadius: 3, cursor: 'pointer', border: `1px solid ${RED}55`, background: 'transparent', color: RED }}
          >重置</button>
        )}
      </div>

      {/* History table */}
      <div style={{ background: SECTION_BG, border: '1px solid rgba(0,100,180,0.2)', borderRadius: 4, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'rgba(0,20,60,0.4)' }}>
              {['时间', '事件类型', '点位', '触发次数', '接口', '状态', '回执状态', '操作'].map(h => (
                <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: '#5a8aaa', fontWeight: 400, borderBottom: '1px solid rgba(0,80,150,0.15)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {history.length === 0 && (
              <tr><td colSpan={7} style={{ padding: 32, textAlign: 'center', color: '#3a5a70' }}>暂无推送记录</td></tr>
            )}
            {pagedHistory.map(h => (
              <tr key={h.id} style={{ borderBottom: '1px solid rgba(0,40,80,0.1)' }}>
                <td style={{ padding: '8px 12px', color: '#7ab8e0', fontFamily: "'JetBrains Mono',monospace", fontSize: 11 }}>{h.created_at}</td>
                <td style={{ padding: '8px 12px' }}>
                  <span style={{ padding: '1px 6px', borderRadius: 2, fontSize: 11, background: `${TYPE_COLORS[h.event_type] || CYAN}18`, color: TYPE_COLORS[h.event_type] || CYAN }}>{h.event_type}</span>
                </td>
                <td style={{ padding: '8px 12px', color: '#7ab8e0' }}>{h.location || '-'}</td>
                <td style={{ padding: '8px 12px', color: AMBER, fontFamily: "'JetBrains Mono',monospace" }}>{h.trigger_count}</td>
                <td style={{ padding: '8px 12px', color: '#5a8aaa', fontFamily: "'JetBrains Mono',monospace", fontSize: 11, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.api_method} {h.api_url}{h.platform_name ? ` · [${h.platform_name}]` : ''}</td>
                <td style={{ padding: '8px 12px' }}>
                  {h.success
                    ? <span style={{ color: GREEN }}>✓ 成功 ({h.response_status})</span>
                    : <span style={{ color: RED }}>✗ {h.error_message || `失败 (${h.response_status})`}</span>}
                </td>
                <td style={{ padding: '8px 12px' }}>
                  {(() => {
                    const st = h.status || 'pushed'
                    const stMeta = STATUS_META[st] || STATUS_META.pushed
                    const label = h.is_timeout ? '超时未回执' : stMeta.label
                    const color = h.is_timeout ? RED : stMeta.color
                    return <span style={{ color, fontSize: 11 }}>{label}</span>
                  })()}
                </td>
                <td style={{ padding: '8px 12px' }}>
                  {h.status !== 'closed' && (
                    <button style={btnStyle(GREEN, true)} onClick={() => closePush(h.id)}>结案</button>
                  )}
                  <button style={btnStyle(CYAN, true)} onClick={() => setDetail(h)}>详情</button>
                  <button
                    style={{ ...btnStyle(AMBER, true), marginLeft: 4 }}
                    disabled={reportBusy === h.id}
                    title={h.report_generated_at ? `已生成于 ${h.report_generated_at}，点击重新生成并下载` : '生成结案报告 PDF 并下载'}
                    onClick={() => exportReport(h.id)}
                  >{reportBusy === h.id ? '生成中…' : '导出报告'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 分页栏 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
        <span style={{ color: '#3a5a70', fontSize: 12 }}>
          第 <span style={{ color: '#7ab8e0' }}>{safePage}</span> / {totalPages} 页 · 每页 {PAGE_SIZE} 条 · 共 {history.length} 条
        </span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} style={btnStyle(CYAN, true)}>上一页</button>
          <input
            value={jump}
            onChange={e => setJump(e.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const n = parseInt(jump)
                if (n >= 1 && n <= totalPages) setPage(n)
                setJump('')
              }
            }}
            placeholder="跳页"
            style={{ ...inputStyle, width: 56, fontSize: 12 }}
          />
          <button
            disabled={!jump}
            onClick={() => {
              const n = parseInt(jump)
              if (n >= 1 && n <= totalPages) setPage(n)
              setJump('')
            }}
            style={btnStyle(CYAN, true)}
          >跳转</button>
          <button disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)} style={btnStyle(CYAN, true)}>下一页</button>
        </div>
      </div>

      {/* Recent events */}
      <div style={{ marginTop: 20 }}>
        <div style={{ color: '#7ab8e0', fontSize: 13, marginBottom: 10 }}>最近告警事件（{events.length} 条）</div>
        <div style={{ background: SECTION_BG, border: '1px solid rgba(0,100,180,0.2)', borderRadius: 4, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'rgba(0,20,60,0.4)' }}>
                {['时间', '类型', '点位', '级别', '值', '状态', '来源'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: '#5a8aaa', fontWeight: 400, borderBottom: '1px solid rgba(0,80,150,0.15)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {events.length === 0 && (
                <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: '#3a5a70' }}>暂无告警事件</td></tr>
              )}
              {events.slice(0, 30).map(e => (
                <tr key={e.id} style={{ borderBottom: '1px solid rgba(0,40,80,0.1)' }}>
                  <td style={{ padding: '6px 12px', color: '#7ab8e0', fontFamily: "'JetBrains Mono',monospace", fontSize: 11 }}>{e.created_at}</td>
                  <td style={{ padding: '6px 12px' }}>
                    <span style={{ padding: '1px 6px', borderRadius: 2, fontSize: 11, background: `${TYPE_COLORS[e.event_type] || CYAN}18`, color: TYPE_COLORS[e.event_type] || CYAN }}>{e.event_type}</span>
                  </td>
                  <td style={{ padding: '6px 12px', color: '#7ab8e0' }}>{e.location || '-'}</td>
                  <td style={{ padding: '6px 12px', color: ['#3a5a70', '#00aaff', AMBER, ORANGE, RED][e.level] || '#7ab8e0' }}>L{e.level || '-'}</td>
                  <td style={{ padding: '6px 12px', color: '#7ab8e0' }}>{e.value || '-'}</td>
                  <td style={{ padding: '6px 12px' }}>
                    <span style={{ padding: '1px 6px', borderRadius: 2, fontSize: 11, background: `${(STATUS_META[e.status || 'pending'] || STATUS_META.pending).color}18`, color: (STATUS_META[e.status || 'pending'] || STATUS_META.pending).color }}>{(STATUS_META[e.status || 'pending'] || STATUS_META.pending).label}</span>
                  </td>
                  <td style={{ padding: '6px 12px', color: '#3a5a70', fontSize: 11 }}>{e.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detail modal */}
      {detail && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={e => { if (e.target === e.currentTarget) setDetail(null) }}>
          <div style={{
            width: 680, maxHeight: '80vh', overflow: 'auto',
            background: '#040e25', border: '1px solid rgba(0,150,220,0.3)',
            borderRadius: 6, padding: 24,
          }}>
            <div style={{ color: '#c8e6ff', fontSize: 15, fontWeight: 600, marginBottom: 16 }}>推送详情</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px', fontSize: 12, marginBottom: 16 }}>
              <div><span style={{ color: '#3a5a70' }}>时间: </span><span style={{ color: '#7ab8e0' }}>{detail.created_at}</span></div>
              <div><span style={{ color: '#3a5a70' }}>事件类型: </span><span style={{ color: TYPE_COLORS[detail.event_type] || CYAN }}>{detail.event_type}</span></div>
              <div><span style={{ color: '#3a5a70' }}>点位: </span><span style={{ color: '#7ab8e0' }}>{detail.location || '-'}</span></div>
              <div><span style={{ color: '#3a5a70' }}>触发次数: </span><span style={{ color: AMBER }}>{detail.trigger_count}</span></div>
              <div><span style={{ color: '#3a5a70' }}>接口: </span><span style={{ color: '#7ab8e0', fontFamily: "'JetBrains Mono',monospace" }}>{detail.api_method} {detail.api_url}</span></div>
              <div><span style={{ color: '#3a5a70' }}>状态: </span><span style={{ color: detail.success ? GREEN : RED }}>{detail.success ? '成功' : '失败'} ({detail.response_status})</span></div>
              {detail.error_message && <div style={{ gridColumn: '1/3' }}><span style={{ color: '#3a5a70' }}>错误: </span><span style={{ color: RED }}>{detail.error_message}</span></div>}
              <div style={{ gridColumn: '1/3' }}><span style={{ color: '#3a5a70' }}>事件 ID: </span><span style={{ color: '#5a8aaa', fontFamily: "'JetBrains Mono',monospace", fontSize: 11 }}>            {detail.event_ids?.join(', ')}</span></div>
            </div>

            {/* 回执 / 处置状态 */}
            <div style={{ background: 'rgba(0,30,60,0.4)', border: '1px solid rgba(0,120,200,0.2)', borderRadius: 4, padding: 12, marginBottom: 14 }}>
              <div style={{ color: '#7ab8e0', fontSize: 13, marginBottom: 8, fontWeight: 600 }}>回执与处置状态</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px', fontSize: 12 }}>
                <div><span style={{ color: '#3a5a70' }}>回执状态: </span>
                  <span style={{ color: detail.is_timeout ? RED : (STATUS_META[detail.status || 'pushed'] || STATUS_META.pushed).color }}>
                    {detail.is_timeout ? '超时未回执' : (STATUS_META[detail.status || 'pushed'] || STATUS_META.pushed).label}
                  </span>
                </div>
                <div><span style={{ color: '#3a5a70' }}>处置结论: </span><span style={{ color: '#7ab8e0' }}>{detail.disposal_result || (detail.status === 'closed' ? '已结案' : '—')}</span></div>
                <div><span style={{ color: '#3a5a70' }}>处置人: </span><span style={{ color: '#7ab8e0' }}>{detail.disposal_operator || '—'}</span></div>
                <div><span style={{ color: '#3a5a70' }}>结案时间: </span><span style={{ color: '#7ab8e0', fontFamily: "'JetBrains Mono',monospace", fontSize: 11 }}>{detail.closed_at || '—'}</span></div>
                {detail.callback_time && <div style={{ gridColumn: '1/3' }}><span style={{ color: '#3a5a70' }}>最近回调时间: </span><span style={{ color: '#7ab8e0', fontFamily: "'JetBrains Mono',monospace", fontSize: 11 }}>{detail.callback_time}</span></div>}
              </div>
              {detail.status !== 'closed' && (
                <button style={{ ...btnStyle(GREEN, true), marginTop: 10 }} onClick={() => { closePush(detail.id); setDetail(null) }}>一键结案</button>
              )}
            </div>

            {/* 关联证据（AI 分析图片 + 置信度 + 通道 + AI类型） */}
            <div style={{ background: 'rgba(0,30,60,0.4)', border: '1px solid rgba(124,58,237,0.2)', borderRadius: 4, padding: 12, marginBottom: 14 }}>
              <div style={{ color: '#a78bfa', fontSize: 13, marginBottom: 8, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2">
                  <path d="M21 19V5a2 0 0 0-2-2H5a2 0 0 0-2 2v14a2 0 0 0 2 2h14a2 0 0 0 2-2z" /><path d="M3 9h18M9 3v18" />
                </svg>
                关联证据
              </div>
              <EvidenceGrid
                evidences={evidences}
                evidenceType={evidenceType}
                message={evidenceMessage}
                loading={evidenceLoading}
                compact
              />
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ color: '#3a5a70', fontSize: 12, marginBottom: 4 }}>请求报文:</div>
              <pre style={{ color: '#5a8aaa', fontSize: 11, fontFamily: "'JetBrains Mono',monospace", background: 'rgba(0,10,30,0.6)', padding: 8, borderRadius: 3, maxHeight: 150, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{detail.request_body}</pre>
            </div>
            <div>
              <div style={{ color: '#3a5a70', fontSize: 12, marginBottom: 4 }}>响应内容:</div>
              <pre style={{ color: detail.success ? GREEN : RED, fontSize: 11, fontFamily: "'JetBrains Mono',monospace", background: 'rgba(0,10,30,0.6)', padding: 8, borderRadius: 3, maxHeight: 150, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{detail.response_body || '(空)'}</pre>
            </div>
            <div style={{ marginTop: 16, textAlign: 'right' }}>
              <button style={btnStyle('#5a8aaa', true)} onClick={() => setDetail(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── 结案报告模板 Tab（第③环 PDF：版式存库可编辑）──
interface ReportTemplate {
  id: string; name: string; engine: string; content: string
  is_default: boolean; description?: string
  created_at?: string; updated_at?: string; content_len?: number
  blocks_json?: string | null   // 区块编辑器结构（工作报表类），结案类/旧模板为 null
  kind?: string                 // 模板用途：closure=结案报告 / workreport=工作报表
}
const REPORT_VARS = ['reportNo', 'genDate', 'eventType', 'occurTime', 'location', 'lon', 'lat', 'level', 'value', 'standard', 'triggerCount', 'eventCount', 'platformName', 'planName', 'disposalResult', 'disposalOperator', 'closedAt', 'description', 'aiConfidenceMin', 'aiConfidenceMax', 'aiConfidenceAvg', 'aiConfidenceCount']

function ReportTemplatesTab() {
  const [kind, setKind] = useState<'closure' | 'workreport'>('closure')
  const [templates, setTemplates] = useState<ReportTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Partial<ReportTemplate> | null>(null)   // 结案/预设：HTML 文本域
  const [previewing, setPreviewing] = useState(false)
  const [blockEditing, setBlockEditing] = useState<{ id?: string; name: string; description: string; blocks: Block[] } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try { setTemplates((await apiFetch<ReportTemplate[]>(`/api/smart-push/report-templates?kind=${kind}`)) || []) }
    catch (e) { console.error(e) } finally { setLoading(false) }
  }, [kind])
  useEffect(() => { load() }, [load])

  const switchKind = (k: 'closure' | 'workreport') => {
    if (editing) setEditing(null)
    if (blockEditing) setBlockEditing(null)
    setKind(k)
  }

  const save = async () => {
    if (!editing) return
    if (!editing.name || !editing.content) { alert('名称和模板内容必填'); return }
    try {
      if (editing.id) {
        await apiFetch(`/api/smart-push/report-templates/${editing.id}`, { method: 'PATCH', body: JSON.stringify({ name: editing.name, content: editing.content, description: editing.description }) })
      } else {
        await apiFetch('/api/smart-push/report-templates', { method: 'POST', body: JSON.stringify({ name: editing.name, content: editing.content, description: editing.description, kind: editing.kind || 'closure' }) })
      }
      setEditing(null); load()
    } catch (e: any) { alert('保存失败: ' + (e?.error || e)) }
  }

  const setDefault = async (id: string) => {
    try { await apiFetch(`/api/smart-push/report-templates/${id}/default`, { method: 'POST' }); load() }
    catch (e: any) { alert('设默认失败: ' + (e?.error || e)) }
  }

  const del = async (id: string) => {
    if (!confirm('确认删除该模板？')) return
    try { await apiFetch(`/api/smart-push/report-templates/${id}`, { method: 'DELETE' }); load() }
    catch (e: any) { alert('删除失败: ' + (e?.error || e)) }
  }

  const editTemplate = async (id: string) => {
    try {
      const r = await apiFetch<{ template: ReportTemplate }>(`/api/smart-push/report-templates/${id}`)
      if (r?.template) setEditing(r.template)
      else alert('读取模板失败')
    } catch (e: any) { alert('读取模板失败: ' + (e?.error || e)) }
  }

  // 工作报表模板：有 blocks_json 才进区块编辑器；预设（无 blocks_json）走 HTML 文本域
  const blockEdit = async (id: string) => {
    try {
      const r = await apiFetch<{ template: ReportTemplate }>(`/api/smart-push/report-templates/${id}`)
      const full = r?.template
      if (!full) { alert('读取模板失败'); return }
      let blocks: Block[] = []
      if (full.blocks_json) { try { blocks = JSON.parse(full.blocks_json) } catch { blocks = [] } }
      if (!blocks || !blocks.length) { alert('该预设模板无可编辑区块结构，将用 HTML 文本域打开微调。'); editTemplate(id); return }
      setBlockEditing({ id: full.id, name: full.name, description: full.description || '', blocks })
    } catch (e: any) { alert('读取模板失败: ' + (e?.error || e)) }
  }

  const blockNew = () => {
    const scaffold: Block[] = (['title', 'unit', 'summaryCards', 'byTypeTable', 'byStatusTable', 'records', 'footer'] as BlockType[])
      .map(t => newBlock(t))
    setBlockEditing({ name: '', description: '', blocks: scaffold })
  }

  const preview = async () => {
    if (!editing?.content) { alert('模板内容为空'); return }
    setPreviewing(true)
    try {
      const resp = await authFetch('/api/smart-push/report-templates/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: editing.content })
      })
      if (!resp.ok) { const j = await resp.json().catch(() => ({})); throw new Error(j.error || `HTTP ${resp.status}`) }
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank')
      setTimeout(() => URL.revokeObjectURL(url), 60000)
    } catch (e: any) { alert('预览失败: ' + (e?.error || e?.message || e)) }
    finally { setPreviewing(false) }
  }

  const varsToShow = kind === 'workreport' ? WORKREPORT_VARS.map(v => v.key) : REPORT_VARS

  if (loading) return <div style={{ color: '#5a8aaa', padding: 40, textAlign: 'center' }}>加载中...</div>

  return (
    <div>
      {/* kind 切换 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {([['closure', '结案报告模板'], ['workreport', '工作报表模板']] as const).map(([k, label]) => (
          <button key={k} onClick={() => switchKind(k)}
            style={{ ...btnStyle(k === kind ? CYAN : '#1c3a5c', k !== kind), fontSize: 12 }}>
            {label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {kind === 'workreport'
          ? <button style={btnStyle(GREEN, false)} onClick={blockNew}>+ 新建工作报表模板（区块编辑器）</button>
          : <button style={btnStyle(GREEN, false)} onClick={() => setEditing({ name: '', content: '', description: '', kind: 'closure' })}>+ 新建结案模板</button>}
      </div>

      <div style={{ background: SECTION_BG, border: '1px solid rgba(0,100,180,0.2)', borderRadius: 4, padding: 12, marginBottom: 12, fontSize: 11, color: '#5a8aaa', lineHeight: 1.8 }}>
        {kind === 'workreport'
          ? <><b style={{ color: '#7ab8e0' }}>提示：</b>新建请使用「区块编辑器」（选区块→填标题/文字→拖拽排序→实时预览）。现有预设模板可点「编辑」以 HTML 微调。可用变量：
            {WORKREPORT_VARS.map(v => <code key={v.key} style={{ color: CYAN, margin: '0 4px', display: 'inline-block' }}>{`{{${v.key}}}`}</code>)}</>
          : <><b style={{ color: '#7ab8e0' }}>可用变量：</b>
            {varsToShow.map(v => <code key={v} style={{ color: CYAN, margin: '0 4px', display: 'inline-block' }}>{`{{${v}}}`}</code>)}</>}
      </div>

      <div style={{ background: SECTION_BG, border: '1px solid rgba(0,100,180,0.2)', borderRadius: 4, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead><tr style={{ background: 'rgba(0,20,60,0.4)' }}>
            {['名称', '默认', '说明', '更新时间', '操作'].map(h => <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: '#5a8aaa', fontWeight: 400, borderBottom: '1px solid rgba(0,80,150,0.15)' }}>{h}</th>)}
          </tr></thead>
          <tbody>
            {templates.length === 0 && <tr><td colSpan={5} style={{ padding: 24, textAlign: 'center', color: '#3a5a70' }}>暂无模板</td></tr>}
            {templates.map(t => {
              const isWorkBlock = t.kind === 'workreport' && !!t.blocks_json
              return (
                <tr key={t.id} style={{ borderBottom: '1px solid rgba(0,40,80,0.1)' }}>
                  <td style={{ padding: '8px 12px', color: '#c8e6ff' }}>{t.name}</td>
                  <td style={{ padding: '8px 12px' }}>{t.is_default ? <span style={{ color: GREEN }}>★ 默认</span> : <span style={{ color: '#3a5a70' }}>-</span>}</td>
                  <td style={{ padding: '8px 12px', color: '#5a8aaa' }}>{t.description || '-'}</td>
                  <td style={{ padding: '8px 12px', color: '#7ab8e0', fontFamily: "'JetBrains Mono',monospace", fontSize: 11 }}>{t.updated_at || '-'}</td>
                  <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
                    <button style={btnStyle(CYAN, true)} onClick={() => isWorkBlock ? blockEdit(t.id) : editTemplate(t.id)}>编辑</button>
                    {!t.is_default && <button style={{ ...btnStyle(GREEN, true), marginLeft: 4 }} onClick={() => setDefault(t.id)}>设默认</button>}
                    <button style={{ ...btnStyle(RED, true), marginLeft: 4 }} onClick={() => del(t.id)}>删除</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* 结案/预设：HTML 文本域编辑器 */}
      {editing && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={e => { if (e.target === e.currentTarget) setEditing(null) }}>
          <div style={{ width: 920, maxHeight: '88vh', overflow: 'auto', background: '#040e25', border: '1px solid rgba(0,150,220,0.3)', borderRadius: 6, padding: 20 }}>
            <div style={{ color: '#c8e6ff', fontSize: 15, fontWeight: 600, marginBottom: 14 }}>{editing.id ? '编辑模板' : '新建模板'}</div>
            <div style={{ display: 'flex', gap: 12, marginBottom: 10 }}>
              <input style={{ ...inputStyle, flex: 1 }} placeholder="模板名称" value={editing.name || ''} onChange={e => setEditing({ ...editing, name: e.target.value })} />
              <input style={{ ...inputStyle, flex: 1 }} placeholder="说明（可选）" value={editing.description || ''} onChange={e => setEditing({ ...editing, description: e.target.value })} />
            </div>
            <textarea style={{ ...inputStyle, width: '100%', minHeight: 380, fontFamily: "'JetBrains Mono',monospace", fontSize: 11, whiteSpace: 'pre', resize: 'vertical' }} placeholder="HTML 模板，支持 {{key}} 占位符" value={editing.content || ''} onChange={e => setEditing({ ...editing, content: e.target.value })} />
            <div style={{ marginTop: 12, textAlign: 'right', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button style={btnStyle('#5a8aaa', true)} onClick={preview} disabled={previewing}>{previewing ? '渲染中…' : '预览 PDF'}</button>
              <button style={btnStyle(GREEN, false)} onClick={save}>保存</button>
              <button style={btnStyle('#5a8aaa', true)} onClick={() => setEditing(null)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {/* 工作报表：区块编辑器 */}
      {blockEditing && (
        <BlockEditor
          initial={blockEditing}
          onClose={() => setBlockEditing(null)}
          onSaved={() => { setBlockEditing(null); load() }}
        />
      )}
    </div>
  )
}
