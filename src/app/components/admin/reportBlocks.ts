// 智治推送 · 工作报表区块编辑器 —— 纯函数模块（无组件）
// 区块在保存时序列化为 HTML（含 {{key}} 占位符）复用服务端 fillTemplate 管线；
// 同时存 blocks_json 供再次编辑。

// ── 区块类型 ───────────────────────────────────────────────
export type BlockType =
  | 'title'         // 标题：自由文字，允许插入变量（如 {{periodLabel}}）
  | 'unit'          // 单位名：固定渲染 {{unitName}}，无配置
  | 'summaryCards'  // 汇总卡片组：标题+显隐；渲染 total/pushed/processing/closed 四卡
  | 'byTypeTable'   // 按类型表格块：标题+显隐；渲染 {{byTypeTable}}
  | 'byStatusTable' // 按状态表格块：标题+显隐；渲染 {{byStatusTable}}
  | 'trend'         // 趋势块：标题+显隐；渲染 {{trendTable}}
  | 'records'       // 明细台账块：标题+显隐；渲染 {{recordsTable}}
  | 'footer'        // 落款：自由文字，允许插入变量（如 {{genDate}}）

export interface Block {
  id: string
  type: BlockType
  title: string      // 数据绑定块的标题（summaryCards/表格块/趋势块）
  visible: boolean
  text?: string      // 自由文字块（title/footer）的文案，可含 {{var}}
}

export interface BlockDef {
  type: BlockType
  label: string
  icon: string
  hasTitle: boolean   // 是否显示"标题"输入框
  hasText: boolean    // 是否显示"文字"输入框
  allowsVar: boolean  // 文字框是否允许插入变量
  desc: string
}

// ── 8 类区块元数据 ─────────────────────────────────────────
export const BLOCK_DEFS: BlockDef[] = [
  { type: 'title',         label: '标题',     icon: '🅣', hasTitle: false, hasText: true,  allowsVar: true,  desc: '报表大标题，可插入周期等变量' },
  { type: 'unit',          label: '单位名称', icon: '🏛', hasTitle: false, hasText: false, allowsVar: false, desc: '自动渲染单位名（万州区生态环保局）' },
  { type: 'summaryCards',  label: '汇总卡片', icon: '🃏', hasTitle: true,  hasText: false, allowsVar: false, desc: '总推送/已推送/处置中/已结案 四张卡片' },
  { type: 'byTypeTable',   label: '按类型表', icon: '📊', hasTitle: true,  hasText: false, allowsVar: false, desc: '按事件类型统计的表格' },
  { type: 'byStatusTable', label: '按状态表', icon: '📈', hasTitle: true,  hasText: false, allowsVar: false, desc: '按处置状态统计的表格' },
  { type: 'trend',         label: '趋势块',   icon: '📉', hasTitle: true,  hasText: false, allowsVar: false, desc: '按时间段的推送趋势表格' },
  { type: 'records',       label: '明细台账', icon: '📋', hasTitle: true,  hasText: false, allowsVar: false, desc: '逐条推送明细台账' },
  { type: 'footer',        label: '落款',     icon: '✍', hasTitle: false, hasText: true,  allowsVar: true,  desc: '落款文字，可插入生成日期等变量' },
]

export const BLOCK_DEF_MAP: Record<BlockType, BlockDef> =
  BLOCK_DEFS.reduce((m, d) => { m[d.type] = d; return m }, {} as Record<BlockType, BlockDef>)

// ── 工作报表标量变量（供文本块 picker 插入）──────────────────
// 表格变量（byTypeTable/byStatusTable/trendTable/recordsTable）以整块插入，不走 picker。
export const WORKREPORT_VARS = [
  { key: 'periodLabel',     label: '统计周期（如 2026年7月）' },
  { key: 'unitName',        label: '单位名称' },
  { key: 'genDate',         label: '生成日期' },
  { key: 'totalCount',      label: '总推送数' },
  { key: 'pushedCount',     label: '已推送数' },
  { key: 'processingCount', label: '处置中数' },
  { key: 'closedCount',     label: '已结案数' },
]

// ── 默认新区块工厂 ─────────────────────────────────────────
let _seq = 0
export function newBlock(type: BlockType): Block {
  const def = BLOCK_DEF_MAP[type]
  _seq += 1
  return {
    id: `b_${Date.now().toString(36)}_${_seq}`,
    type,
    title: def.hasTitle ? defaultTitle(type) : '',
    visible: true,
    text: def.hasText ? defaultText(type) : '',
  }
}

function defaultTitle(type: BlockType): string {
  switch (type) {
    case 'summaryCards':  return '一、总体情况'
    case 'byTypeTable':   return '二、按事件类型分布'
    case 'byStatusTable': return '三、按处置状态分布'
    case 'trend':         return '四、推送趋势'
    case 'records':       return '五、处置明细台账'
    default:              return ''
  }
}
function defaultText(type: BlockType): string {
  if (type === 'title') return '{{periodLabel}} 智慧治理推送处置工作报表'
  if (type === 'footer') return '生成日期：{{genDate}}'
  return ''
}

// ── 区块 → HTML 序列化（含共享 <style> 骨架）────────────────
const STYLE = `<style>
  *{box-sizing:border-box}
  body{font-family:"Noto Sans CJK SC","WenQuanYi Zen Hei",sans-serif;color:#1a1a1a;font-size:12.5px;line-height:1.7;margin:0;padding:18px 22px}
  .wr-title{font-size:20px;font-weight:700;text-align:center;margin:4px 0 2px}
  .wr-unit{text-align:center;color:#555;font-size:12px;margin-bottom:10px}
  h2{font-size:14px;border-left:4px solid #2b6cb0;padding-left:8px;margin:16px 0 8px}
  .wr-cards{display:flex;gap:10px;margin:6px 0}
  .wr-card{flex:1;border:1px solid #cbd5e0;border-radius:6px;padding:10px;text-align:center;background:#f7fafc}
  .wr-card .n{font-size:22px;font-weight:700;color:#2b6cb0}
  .wr-card .l{font-size:11px;color:#64748b;margin-top:2px}
  .wr-footer{margin-top:28px;text-align:right;color:#555;font-size:11px}
  table.grid{width:100%;border-collapse:collapse;font-size:11.5px;margin:4px 0}
  table.grid th,table.grid td{border:1px solid #cbd5e0;padding:5px 8px}
  table.grid th{background:#eef2f7}
</style>`

function blockToHtml(b: Block): string {
  switch (b.type) {
    case 'title':
      return `<div class="wr-title">${b.text || ''}</div>`
    case 'unit':
      return `<div class="wr-unit">{{unitName}}</div>`
    case 'summaryCards':
      return `<h2>${b.title}</h2><div class="wr-cards">` +
        `<div class="wr-card"><div class="n">{{totalCount}}</div><div class="l">总推送</div></div>` +
        `<div class="wr-card"><div class="n">{{pushedCount}}</div><div class="l">已推送</div></div>` +
        `<div class="wr-card"><div class="n">{{processingCount}}</div><div class="l">处置中</div></div>` +
        `<div class="wr-card"><div class="n">{{closedCount}}</div><div class="l">已结案</div></div>` +
        `</div>`
    case 'byTypeTable':
      return `<h2>${b.title}</h2>{{byTypeTable}}`
    case 'byStatusTable':
      return `<h2>${b.title}</h2>{{byStatusTable}}`
    case 'trend':
      return `<h2>${b.title}</h2>{{trendTable}}`
    case 'records':
      return `<h2>${b.title}</h2>{{recordsTable}}`
    case 'footer':
      return `<div class="wr-footer">${b.text || ''}</div>`
    default:
      return ''
  }
}

export function blocksToHtml(blocks: Block[]): string {
  const body = (blocks || [])
    .filter(b => b.visible)
    .map(blockToHtml)
    .join('\n')
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">${STYLE}</head><body>\n${body}\n</body></html>`
}

// ── 预览样例数据（仅前端实时预览用，与服务端聚合形状一致）──
export const WR_SAMPLE_DATA: Record<string, unknown> = {
  periodLabel: '2026年7月',
  unitName: '万州区生态环保局',
  genDate: '2026-07-12',
  totalCount: 128,
  pushedCount: 120,
  processingCount: 5,
  closedCount: 123,
  byTypeTable: `<table class="grid"><tr><th>事件类型</th><th>推送数</th></tr>` +
    `<tr><td>气体污染</td><td>42</td></tr><tr><td>水体污染</td><td>31</td></tr>` +
    `<tr><td>道路扬尘</td><td>28</td></tr><tr><td>秸秆焚烧</td><td>27</td></tr></table>`,
  byStatusTable: `<table class="grid"><tr><th>处置状态</th><th>推送数</th></tr>` +
    `<tr><td>已推送</td><td>120</td></tr><tr><td>处置中</td><td>5</td></tr><tr><td>已结案</td><td>123</td></tr></table>`,
  trendTable: `<table class="grid"><tr><th>日期</th><th>推送数</th></tr>` +
    `<tr><td>07-01</td><td>6</td></tr><tr><td>07-02</td><td>4</td></tr>` +
    `<tr><td>07-03</td><td>7</td></tr><tr><td>07-04</td><td>5</td></tr>` +
    `<tr><td>07-05</td><td>8</td></tr></table>`,
  recordsTable: `<table class="grid"><tr><th>推送时间</th><th>事件类型</th><th>地点</th><th>平台</th><th>状态</th></tr>` +
    `<tr><td>07-01 09:12</td><td>气体污染</td><td>XX路</td><td>城运平台</td><td>已结案</td></tr>` +
    `<tr><td>07-02 14:30</td><td>水体污染</td><td>YY河</td><td>城运平台</td><td>处置中</td></tr>` +
    `<tr><td>07-03 08:05</td><td>道路扬尘</td><td>ZZ大道</td><td>城运平台</td><td>已结案</td></tr></table>`,
}

// ── 客户端 {{key}} 替换（含 {__html} 不转义，与服务端一致）──
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function fillTemplateClient(html: string, data: Record<string, unknown>): string {
  return html.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => {
    const v = (data as any)[key]
    if (v && typeof v === 'object' && '__html' in (v as any)) return (v as any).__html
    if (v === undefined || v === null) return ''
    if (typeof v === 'object') return escapeHtml(JSON.stringify(v))
    return escapeHtml(String(v))
  })
}
