import { describe, expect, it } from 'vitest'
import { aqiColor, aqiLevel } from './airQuality'

describe('airQuality AQI 分级', () => {
  it('边界值正确映射（0/50/51/100/101/150/151/200/201/300/301）', () => {
    expect(aqiLevel(0).label).toBe('优')
    expect(aqiLevel(50).label).toBe('优')
    expect(aqiLevel(50).color).toBe('#00c853')
    expect(aqiLevel(51).label).toBe('良')
    expect(aqiLevel(100).label).toBe('良')
    expect(aqiLevel(101).label).toBe('轻度污染')
    expect(aqiLevel(150).label).toBe('轻度污染')
    expect(aqiLevel(151).label).toBe('中度污染')
    expect(aqiLevel(200).label).toBe('中度污染')
    expect(aqiLevel(201).label).toBe('重度污染')
    expect(aqiLevel(300).label).toBe('重度污染')
    expect(aqiLevel(301).label).toBe('严重污染')
    expect(aqiLevel(500).label).toBe('严重污染')
  })

  it('非法/缺失输入回退到 优', () => {
    expect(aqiLevel(null).label).toBe('优')
    expect(aqiLevel(undefined).label).toBe('优')
    expect(aqiLevel(NaN).label).toBe('优')
    expect(aqiLevel(-5).label).toBe('优')
  })

  it('aqiColor 与 aqiLevel.color 一致', () => {
    expect(aqiColor(20)).toBe('#00c853')
    expect(aqiColor(80)).toBe('#ffd740')
    expect(aqiColor(180)).toBe('#ff5252')
  })
})
