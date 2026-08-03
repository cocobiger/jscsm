import { describe, it, expect } from 'vitest'
import { validateRows, parseDateCell, GOV_MODULE_DEFS, GOV_DEF_MAP } from './govModules'

describe('parseDateCell 日期宽容解析', () => {
  it('支持 YYYY-MM-DD / YYYY/M/D', () => {
    expect(parseDateCell('2026-08-05')).toBe('2026-08-05')
    expect(parseDateCell('2026/8/5')).toBe('2026-08-05')
    expect(parseDateCell('2026.08.05')).toBe('2026-08-05')
  })
  it('支持 Excel 日期序列号', () => {
    // (46208-25569)*86400s = 2026-07-05 UTC（1900 日期系统）
    expect(parseDateCell(46208)).toBe('2026-07-05')
  })
  it('非法输入返回 null', () => {
    expect(parseDateCell('abc')).toBeNull()
    expect(parseDateCell('')).toBeNull()
    expect(parseDateCell(null)).toBeNull()
  })
})

describe('validateRows · forecast 空气质量预报', () => {
  const goodRow = { 日期: '2026-08-05', 星期: '周三', AQI下限: 45, AQI上限: 75, 等级: '良', 'PM2.5': 32, O3: 128, 首要污染物: 'O₃' }

  it('正常行转换为 days payload', () => {
    const r = validateRows('forecast', [goodRow])
    expect(r.ok).toBe(true)
    if (r.ok) {
      const days = (r.payload as any).days
      expect(days).toHaveLength(1)
      expect(days[0]).toMatchObject({ date: '2026-08-05', aqiMin: 45, aqiMax: 75, level: '良', pm25: 32 })
    }
  })

  it('星期留空自动按日期推算', () => {
    const r = validateRows('forecast', [{ ...goodRow, 星期: '', 日期: '2026-08-05' }])
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.payload as any).days[0].weekday).toBe('周三') // 2026-08-05 是周三
  })

  it('AQI 下限大于上限报错', () => {
    const r = validateRows('forecast', [{ ...goodRow, AQI下限: 90, AQI上限: 50 }])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toContain('下限')
  })

  it('缺必需列报错并列出当前表头', () => {
    const r = validateRows('forecast', [{ 日期: '2026-08-05' }])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join()).toContain('缺少必需列')
  })

  it('超过 7 行截断并告警', () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({ ...goodRow, 日期: `2026-08-${String(i + 5).padStart(2, '0')}` }))
    const r = validateRows('forecast', rows)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect((r.payload as any).days).toHaveLength(7)
      expect(r.warnings[0]).toContain('截断')
    }
  })
})

describe('validateRows · pyramid 治理任务', () => {
  const rows = [
    { 级别: 'C', 任务类别: '专项行动', 任务数: 56, 已完成: 41 },
    { 级别: 'A', 任务类别: '市级督办', 任务数: 12, 已完成: 8 },
    { 级别: 'D', 任务类别: '日常巡查', 任务数: 120, 已完成: 97 },
    { 级别: 'B', 任务类别: '区级重点', 任务数: 28, 已完成: 19 },
  ]

  it('乱序输入按 A/B/C/D 重排', () => {
    const r = validateRows('pyramid', rows)
    expect(r.ok).toBe(true)
    if (r.ok) {
      const levels = (r.payload as any).levels
      expect(levels.map((l: any) => l.level)).toEqual(['A', 'B', 'C', 'D'])
    }
  })

  it('已完成大于任务数报错', () => {
    const r = validateRows('pyramid', [{ 级别: 'A', 任务类别: 'x', 任务数: 5, 已完成: 9 }])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toContain('大于任务数')
  })

  it('级别重复/非法报错', () => {
    const dup = validateRows('pyramid', [
      { 级别: 'A', 任务类别: 'x', 任务数: 5, 已完成: 1 },
      { 级别: 'a', 任务类别: 'y', 任务数: 6, 已完成: 2 },
    ])
    expect(dup.ok).toBe(false)
    const bad = validateRows('pyramid', [{ 级别: 'E', 任务类别: 'x', 任务数: 5, 已完成: 1 }])
    expect(bad.ok).toBe(false)
  })
})

describe('validateRows · documents 制度规范', () => {
  it('正常转换，可选字段缺省为 null', () => {
    const r = validateRows('documents', [{ 分类: '政策制度', 标题: '某方案', 发文单位: '', 日期: '', 链接: '' }])
    expect(r.ok).toBe(true)
    if (r.ok) {
      const doc = (r.payload as any).docs[0]
      expect(doc).toMatchObject({ category: '政策制度', title: '某方案', dept: null, date: null, url: null })
    }
  })

  it('分类非法报错', () => {
    const r = validateRows('documents', [{ 分类: '内部通知', 标题: 'x' }])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toContain('分类应为')
  })
})

describe('validateRows · assessment 考核评价', () => {
  const goodRow = { 指标名称: '优良天数比率', 目标值: '≥90%', 当前值: '87.5%', '进度(%)': 97, 状态: '达标' }

  it('正常转换', () => {
    const r = validateRows('assessment', [goodRow])
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.payload as any).metrics[0]).toMatchObject({ name: '优良天数比率', progress: 97, status: '达标' })
  })

  it('进度超界报错', () => {
    const r = validateRows('assessment', [{ ...goodRow, '进度(%)': 120 }])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toContain('0-100')
  })

  it('状态非法报错', () => {
    const r = validateRows('assessment', [{ ...goodRow, 状态: '完成' }])
    expect(r.ok).toBe(false)
  })
})

describe('模块定义完整性', () => {
  it('4 个模块定义齐全且 DEF_MAP 一致', () => {
    expect(GOV_MODULE_DEFS.map(d => d.key)).toEqual(['forecast', 'pyramid', 'documents', 'assessment'])
    for (const d of GOV_MODULE_DEFS) {
      expect(GOV_DEF_MAP[d.key]).toBe(d)
      expect(d.columns.some(c => c.required)).toBe(true)
      expect(d.sample.length).toBeGreaterThan(0)
    }
  })
})
