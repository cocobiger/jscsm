'use strict'
/**
 * 预警规则判断引擎
 * 严格依据《市监测站气体采集预警模块》文档 2.2 污染物预警规则明细实现。
 *
 * 预警类型：
 *   'none'      不预警
 *   'fixed'     固定值预警
 *   'growth5h'  5小时增长预警（当前+前4小时共5小时窗口内最低值，增长≥40%）
 *   'cross'     跨阈值预警（前一小时在阈值下、当前跨到阈值上）
 *
 * 规则表（单位 μg/m³，CO 为 mg/m³）：
 *   PM2.5 ≤30 不预警；30<数据≤60 且 5h 增长≥40% → growth5h；跨 75/115/150 → cross
 *   PM10  ≤45 不预警；45<数据≤120 且 5h 增长≥40% → growth5h；跨 150/250/350 → cross
 *   SO₂   <20 不预警；其余无预警规则
 *   NO₂   ≤30 不预警；>30 且 5h 增长≥40% → growth5h
 *   O₃    ≤160 不预警；跨 160 → cross
 *   CO    ≤1 不预警；>1 → fixed
 */

const GROWTH_RATIO = 0.4 // 40%

// 跨阈值梯度（从高到低），命中"前值≤阈值 且 当前>阈值"即触发
const CROSS_THRESHOLDS = {
  PM25: [150, 115, 75],
  PM10: [350, 250, 150],
  O3: [160],
}

// 不预警上限
const SAFE_MAX = {
  PM25: 35,
  PM10: 50,
  SO2: 20, // <20 不预警（严格小于）
  NO2: 30,
  O3: 160,
  CO: 1,
}

// 5 小时增长预警的取值区间（左开右闭）
const GROWTH_RANGE = {
  PM25: { min: 35, max: 60 },
  PM10: { min: 50, max: 120 },
  NO2: { min: 30, max: Infinity },
}

const LABELS = {
  none: '不预警',
  fixed: '固定值预警',
  growth5h: '5小时增长预警',
  cross: '跨阈值预警',
}

/**
 * 计算 5 小时窗口（当前 + 前 4 小时）内最低值
 * @param {number} current 当前值
 * @param {number[]} prev4 前 4 小时的值（按时间任意顺序，可不足 4 个）
 */
function min5h(current, prev4) {
  const vals = [current, ...prev4.filter(v => typeof v === 'number' && !isNaN(v))]
  return Math.min(...vals)
}

/**
 * 判断单个污染物的预警类型
 * @param {string} code   污染物代码：PM25 | PM10 | SO2 | NO2 | O3 | CO
 * @param {number} value  当前监测值
 * @param {number|null} prevHour 前一小时同指标值（跨阈值判断用）
 * @param {number[]} prev4Hours  前 4 小时同指标值数组（5h 增长判断用）
 * @returns {{ type: string, label: string, reason: string }}
 */
function evaluate(code, value, prevHour = null, prev4Hours = []) {
  const c = String(code).toUpperCase().replace('.', '').replace('₂', '2').replace('₃', '3').replace('₁₀', '10')
  const v = Number(value)
  if (isNaN(v)) return { type: 'none', label: LABELS.none, reason: '无效数值' }

  // ── 跨阈值预警（优先级最高，阶跃事件）──
  if (CROSS_THRESHOLDS[c] && prevHour != null && !isNaN(Number(prevHour))) {
    const pv = Number(prevHour)
    for (const th of CROSS_THRESHOLDS[c]) {
      if (pv <= th && v > th) {
        return { type: 'cross', label: LABELS.cross, reason: `${c} 由 ${pv} 跨越阈值 ${th} 升至 ${v}` }
      }
    }
  }

  // ── CO 固定值预警 ──
  if (c === 'CO') {
    if (v > SAFE_MAX.CO) return { type: 'fixed', label: LABELS.fixed, reason: `CO=${v} 超过固定阈值 ${SAFE_MAX.CO}` }
    return { type: 'none', label: LABELS.none, reason: `CO=${v} 在安全区间` }
  }

  // ── 5 小时增长预警 ──
  if (GROWTH_RANGE[c]) {
    const { min, max } = GROWTH_RANGE[c]
    if (v > min && v <= max) {
      const lowest = min5h(v, prev4Hours)
      if (lowest > 0) {
        const growth = (v - lowest) / lowest
        if (growth >= GROWTH_RATIO) {
          return { type: 'growth5h', label: LABELS.growth5h, reason: `${c}=${v}，5小时最低值 ${lowest}，增长 ${(growth * 100).toFixed(1)}% ≥ 40%` }
        }
      }
    }
  }

  // ── 不预警判定 ──
  if (c === 'SO2') {
    if (v < SAFE_MAX.SO2) return { type: 'none', label: LABELS.none, reason: `SO₂=${v} < 20` }
    return { type: 'none', label: LABELS.none, reason: `SO₂=${v}（无预警规则）` }
  }
  if (SAFE_MAX[c] != null && v <= SAFE_MAX[c]) {
    return { type: 'none', label: LABELS.none, reason: `${c}=${v} 在安全区间` }
  }

  return { type: 'none', label: LABELS.none, reason: `${c}=${v} 未命中任何预警规则` }
}

/**
 * 对一条标准化采集数据的所有污染物逐项判断
 * @param {object} record 标准结构 { pointName, monitorTime, pollutants:[{code,value,...}] }
 * @param {object} history { [code]: { prevHour:number, prev4Hours:number[] } }
 * @returns {Array} 命中预警的污染物列表
 */
function evaluateRecord(record, history = {}) {
  const results = []
  for (const p of record.pollutants || []) {
    const h = history[p.code] || {}
    const r = evaluate(p.code, p.value, h.prevHour, h.prev4Hours || [])
    if (r.type !== 'none') {
      results.push({
        pointName: record.pointName,
        pointCode: record.pointCode,
        monitorTime: record.monitorTime,
        code: p.code,
        name: p.name,
        value: p.value,
        unit: p.unit,
        standardValue: p.standardValue,
        lat: record.lat,
        lon: record.lon,
        warningType: r.type,
        warningLabel: r.label,
        reason: r.reason,
      })
    }
  }
  return results
}

module.exports = { evaluate, evaluateRecord, LABELS, CROSS_THRESHOLDS, SAFE_MAX, GROWTH_RANGE }
