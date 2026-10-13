import { describe, it, expect } from 'vitest'
import { fmtShanghai, fmtShanghaiDate, parseAnyTime } from './time'

/**
 * P0-1 回归测试：时间一律按上海时（UTC+8）格式化
 * 关键回归点：ISO UTC 串不能再被 slice 成 `09-13T11:07:19.514Z`，
 *   而应显示为上海时 2026-09-13 19:07:19。
 */
describe('fmtShanghai（上海时格式化）', () => {
  it('ISO UTC 串 → +8h 上海时（这条就是线上那 636 条的问题）', () => {
    expect(fmtShanghai('2026-09-13T11:07:19.514Z')).toBe('2026-09-13 19:07:19')
    expect(fmtShanghai('2026-09-13T11:07:19.514Z', 'short')).toBe('09-13 19:07:19')
  })

  it('上海本地串（无时区标记）→ 原样视为上海时，不再二次偏移', () => {
    expect(fmtShanghai('2026-09-19 15:37:06')).toBe('2026-09-19 15:37:06')
    expect(fmtShanghai('2026-09-19T15:37:06')).toBe('2026-09-19 15:37:06')
  })

  it('6 位微秒串裁到毫秒仍能解析', () => {
    expect(fmtShanghai('2026-09-13T11:07:19.514123Z')).toBe('2026-09-13 19:07:19')
  })

  it('带 +08:00 偏移的 ISO 串不再重复加 8 小时', () => {
    expect(fmtShanghai('2026-09-13T19:07:19+08:00')).toBe('2026-09-13 19:07:19')
  })

  it('10 位秒 / 13 位毫秒时间戳', () => {
    const ms = Date.UTC(2026, 8, 13, 11, 7, 19) // 2026-09-13T11:07:19Z
    expect(fmtShanghai(ms)).toBe('2026-09-13 19:07:19')
    expect(fmtShanghai(String(Math.floor(ms / 1000)))).toBe('2026-09-13 19:07:19')
    expect(fmtShanghai(String(ms))).toBe('2026-09-13 19:07:19')
  })

  it('跨日边界：UTC 16:00 应显示为次日 00:00（上海）', () => {
    expect(fmtShanghai('2026-09-13T16:00:00Z')).toBe('2026-09-14 00:00:00')
  })

  it('空值 → 空串；无法解析 → 原样返回（不显示 Invalid Date）', () => {
    expect(fmtShanghai(null)).toBe('')
    expect(fmtShanghai(undefined)).toBe('')
    expect(fmtShanghai('')).toBe('')
    expect(fmtShanghai('不是时间')).toBe('不是时间')
  })

  it('parseAnyTime 与 fmtShanghai 口径一致', () => {
    expect(parseAnyTime('2026-09-13T11:07:19.514Z')).toBe(Date.UTC(2026, 8, 13, 11, 7, 19, 514))
    expect(Number.isNaN(parseAnyTime('bad'))).toBe(true)
  })

  it('fmtShanghaiDate 返回上海日期', () => {
    expect(fmtShanghaiDate('2026-09-13T16:30:00Z')).toBe('2026-09-14')
  })
})
