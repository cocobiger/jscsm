/**
 * P2 政务模块定义：Excel 模板列、校验、行→payload 转换。
 * 管理后台导入页与驾驶舱展示共用；validateRows 为纯函数（node 环境可单测）。
 */

export type GovModuleKey = 'forecast' | 'pyramid' | 'documents' | 'assessment'

export interface GovColumn {
  /** Excel 中文表头（业务方填写） */
  header: string
  /** payload 字段名 */
  key: string
  /** 是否必填 */
  required?: boolean
  /** 列说明（导入页提示用） */
  desc?: string
}

export interface GovModuleDef {
  key: GovModuleKey
  label: string
  icon: string
  desc: string
  columns: GovColumn[]
  /** 模板示例行（下载模板时写入，供业务方参照） */
  sample: Record<string, string | number>[]
}

export const GOV_MODULE_DEFS: GovModuleDef[] = [
  {
    key: 'forecast',
    label: '空气质量预报',
    icon: '🌤',
    desc: '未来 6 天 AQI / PM2.5 / O3 预报（每日一行，最多 7 行）',
    columns: [
      { header: '日期', key: 'date', required: true, desc: 'YYYY-MM-DD 或 YYYY/M/D' },
      { header: '星期', key: 'weekday', desc: '如：周二（留空自动推算）' },
      { header: 'AQI下限', key: 'aqiMin', required: true },
      { header: 'AQI上限', key: 'aqiMax', required: true },
      { header: '等级', key: 'level', required: true, desc: '优/良/轻度污染/中度污染/重度污染' },
      { header: 'PM2.5', key: 'pm25' },
      { header: 'O3', key: 'o3' },
      { header: '首要污染物', key: 'primary' },
    ],
    sample: [
      { 日期: '2026-08-05', 星期: '周三', AQI下限: 45, AQI上限: 75, 等级: '良', 'PM2.5': 32, O3: 128, 首要污染物: 'O₃' },
      { 日期: '2026-08-06', 星期: '周四', AQI下限: 60, AQI上限: 90, 等级: '良', 'PM2.5': 40, O3: 142, 首要污染物: 'O₃' },
    ],
  },
  {
    key: 'pyramid',
    label: '治理任务金字塔',
    icon: '△',
    desc: 'A/B/C/D 四级治理任务量（每级一行，级别必填）',
    columns: [
      { header: '级别', key: 'level', required: true, desc: 'A（市级督办）/B（区级重点）/C（专项任务）/D（日常巡查）' },
      { header: '任务类别', key: 'name', required: true },
      { header: '任务数', key: 'total', required: true },
      { header: '已完成', key: 'done', required: true },
    ],
    sample: [
      { 级别: 'A', 任务类别: '市级督办', 任务数: 12, 已完成: 8 },
      { 级别: 'B', 任务类别: '区级重点', 任务数: 28, 已完成: 19 },
      { 级别: 'C', 任务类别: '专项行动', 任务数: 56, 已完成: 41 },
      { 级别: 'D', 任务类别: '日常巡查', 任务数: 120, 已完成: 97 },
    ],
  },
  {
    key: 'documents',
    label: '制度规范',
    icon: '📜',
    desc: '政策制度/法律法规/标准规范/改革措施 四类文档（每文档一行）',
    columns: [
      { header: '分类', key: 'category', required: true, desc: '政策制度/法律法规/标准规范/改革措施' },
      { header: '标题', key: 'title', required: true },
      { header: '发文单位', key: 'dept' },
      { header: '日期', key: 'date', desc: 'YYYY-MM-DD' },
      { header: '链接', key: 'url', desc: '可选，填写后驾驶舱可点击打开' },
    ],
    sample: [
      { 分类: '政策制度', 标题: '万州区大气污染防治攻坚行动方案', 发文单位: '区生态环境局', 日期: '2026-07-01', 链接: '' },
      { 分类: '法律法规', 标题: '中华人民共和国大气污染防治法', 发文单位: '全国人大常委会', 日期: '2018-10-26', 链接: '' },
    ],
  },
  {
    key: 'assessment',
    label: '考核评价',
    icon: '🎯',
    desc: '污染防治攻坚战考核指标（每指标一行，进度为 0-100 数字）',
    columns: [
      { header: '指标名称', key: 'name', required: true },
      { header: '目标值', key: 'target', required: true, desc: '如：≥90%、≤35μg/m³' },
      { header: '当前值', key: 'current', required: true },
      { header: '进度(%)', key: 'progress', required: true, desc: '0-100 数字' },
      { header: '状态', key: 'status', required: true, desc: '达标/预警/滞后' },
    ],
    sample: [
      { 指标名称: '优良天数比率', 目标值: '≥90%', 当前值: '87.5%', '进度(%)': 97, 状态: '达标' },
      { 指标名称: 'PM2.5 年均浓度', 目标值: '≤35μg/m³', 当前值: '33μg/m³', '进度(%)': 94, 状态: '达标' },
    ],
  },
]

export const GOV_DEF_MAP: Record<GovModuleKey, GovModuleDef> = Object.fromEntries(
  GOV_MODULE_DEFS.map(d => [d.key, d])
) as Record<GovModuleKey, GovModuleDef>

export interface ValidateOk {
  ok: true
  payload: Record<string, unknown>
  /** 非致命警告（如行数超限已截断） */
  warnings: string[]
}
export interface ValidateErr {
  ok: false
  errors: string[]
}
export type ValidateResult = ValidateOk | ValidateErr

const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六']

/** 宽容解析日期：支持 YYYY-MM-DD / YYYY/M/D / Excel 序列号 */
export function parseDateCell(v: unknown): string | null {
  if (v == null || v === '') return null
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    // Excel 日期序列号（1900 日期系统）
    const d = new Date(Math.round((v - 25569) * 86400 * 1000))
    if (isNaN(d.getTime())) return null
    return d.toISOString().slice(0, 10)
  }
  const s = String(v).trim()
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s)
  if (!m) return null
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && isFinite(v)) return v
  const n = Number(String(v ?? '').trim())
  return isFinite(n) && String(v).trim() !== '' ? n : null
}

function str(v: unknown): string {
  return String(v ?? '').trim()
}

/**
 * 校验 Excel 行（sheet_to_json 产物）并转换为模块 payload。
 * rows 的键为中文表头。
 */
export function validateRows(moduleKey: GovModuleKey, rows: Record<string, unknown>[]): ValidateResult {
  const def = GOV_DEF_MAP[moduleKey]
  if (!def) return { ok: false, errors: [`未知模块: ${moduleKey}`] }
  const errors: string[] = []
  const warnings: string[] = []
  if (!Array.isArray(rows) || rows.length === 0) return { ok: false, errors: ['表格为空：未读到任何数据行'] }

  // 必填列表头存在性检查（用第一行键判断）
  const headers = Object.keys(rows[0])
  for (const col of def.columns) {
    if (col.required && !headers.includes(col.header)) {
      errors.push(`缺少必需列「${col.header}」（当前表头: ${headers.join('、') || '空'}）`)
    }
  }
  if (errors.length) return { ok: false, errors }

  switch (moduleKey) {
    case 'forecast': {
      const days = rows.slice(0, 7).map((r, i) => {
        const line = i + 2 // Excel 行号（含表头）
        const date = parseDateCell(r['日期'])
        if (!date) { errors.push(`第${line}行：日期无法解析（应为 YYYY-MM-DD）`); return null }
        const aqiMin = num(r['AQI下限'])
        const aqiMax = num(r['AQI上限'])
        if (aqiMin == null || aqiMax == null) { errors.push(`第${line}行：AQI下限/上限应为数字`); return null }
        if (aqiMin > aqiMax) { errors.push(`第${line}行：AQI下限(${aqiMin}) 大于上限(${aqiMax})`); return null }
        const level = str(r['等级'])
        if (!level) { errors.push(`第${line}行：等级不能为空`); return null }
        let weekday = str(r['星期'])
        if (!weekday) weekday = `周${WEEK_CN[new Date(date + 'T00:00:00+08:00').getDay()]}`
        return {
          date, weekday, aqiMin, aqiMax, level,
          pm25: num(r['PM2.5']), o3: num(r['O3']),
          primary: str(r['首要污染物']) || null,
        }
      })
      if (rows.length > 7) warnings.push(`预报最多展示 7 天，已截断（共 ${rows.length} 行）`)
      if (errors.length) return { ok: false, errors }
      return { ok: true, payload: { days }, warnings }
    }
    case 'pyramid': {
      const seen = new Set<string>()
      const levels = rows.map((r, i) => {
        const line = i + 2
        const level = str(r['级别']).toUpperCase()
        if (!['A', 'B', 'C', 'D'].includes(level)) { errors.push(`第${line}行：级别应为 A/B/C/D（当前「${str(r['级别'])}」）`); return null }
        if (seen.has(level)) { errors.push(`第${line}行：级别 ${level} 重复`); return null }
        seen.add(level)
        const name = str(r['任务类别'])
        if (!name) { errors.push(`第${line}行：任务类别不能为空`); return null }
        const total = num(r['任务数'])
        const done = num(r['已完成'])
        if (total == null || done == null) { errors.push(`第${line}行：任务数/已完成应为数字`); return null }
        if (done > total) { errors.push(`第${line}行：已完成(${done}) 大于任务数(${total})`); return null }
        return { level, name, total, done }
      })
      if (errors.length) return { ok: false, errors }
      const order = ['A', 'B', 'C', 'D']
      ;(levels as { level: string }[]).sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level))
      return { ok: true, payload: { levels }, warnings }
    }
    case 'documents': {
      const CATS = ['政策制度', '法律法规', '标准规范', '改革措施']
      const docs = rows.map((r, i) => {
        const line = i + 2
        const category = str(r['分类'])
        if (!CATS.includes(category)) { errors.push(`第${line}行：分类应为 ${CATS.join('/')}（当前「${category}」）`); return null }
        const title = str(r['标题'])
        if (!title) { errors.push(`第${line}行：标题不能为空`); return null }
        return {
          category, title,
          dept: str(r['发文单位']) || null,
          date: parseDateCell(r['日期']),
          url: str(r['链接']) || null,
        }
      })
      if (errors.length) return { ok: false, errors }
      return { ok: true, payload: { docs }, warnings }
    }
    case 'assessment': {
      const STATS = ['达标', '预警', '滞后']
      const metrics = rows.map((r, i) => {
        const line = i + 2
        const name = str(r['指标名称'])
        if (!name) { errors.push(`第${line}行：指标名称不能为空`); return null }
        const target = str(r['目标值'])
        const current = str(r['当前值'])
        if (!target || !current) { errors.push(`第${line}行：目标值/当前值不能为空`); return null }
        const progress = num(r['进度(%)'])
        if (progress == null || progress < 0 || progress > 100) { errors.push(`第${line}行：进度(%) 应为 0-100 数字`); return null }
        const status = str(r['状态'])
        if (!STATS.includes(status)) { errors.push(`第${line}行：状态应为 ${STATS.join('/')}（当前「${status}」）`); return null }
        return { name, target, current, progress, status }
      })
      if (errors.length) return { ok: false, errors }
      return { ok: true, payload: { metrics }, warnings }
    }
  }
}
