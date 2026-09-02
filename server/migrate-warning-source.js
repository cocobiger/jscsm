'use strict'
/* T13: 历史告警 source 归一化（一次性幂等迁移）
 * 目标：8023 条 warnings 中 253 条无 source 的历史气体告警（cq_api）补写 data_json.source，
 *       使 source 成为可服务端过滤的稳定字段（导出接口 T14 依赖）。
 *
 * 判定规则与 store-db.resolveSourceKey / 前端 AlertHistoryModal.resolveSource 同源（C2 防漂移）：
 *   - pointName/code/standardValue 存在 → 气体监测 cq_api
 *   - aiType/channelSipId/picUrl 存在 → AI 视频 iotcloud（本库存量 iotcloud/straw/chengyun 均已显式带 source，无需回写）
 * 幂等：仅处理 source 为空/缺失的记录；straw-zu0822 等异常 source 不动。
 * 用法：node migrate-warning-source.js [--dry-run]
 */
const { DatabaseSync } = require('node:sqlite')
const DB = '/opt/jsc/backend/data/jsc.db'
const dryRun = process.argv.includes('--dry-run')

function inferSourceKey(w) {
  if (!w) return null
  if (w.source && String(w.source).trim()) return w.source
  if (w.pointName || w.code || w.standardValue != null) return 'cq_api'
  if (w.aiType || w.channelSipId || w.picUrl) return 'iotcloud'
  return null
}

const db = new DatabaseSync(DB)
const rows = db.prepare(
  "SELECT id, data_json FROM warnings WHERE json_extract(data_json, '$.source') IS NULL OR json_extract(data_json, '$.source') = ''"
).all()
console.log(`[T13] 无 source 记录: ${rows.length} 条`)

const bySrc = {}
const upd = db.prepare('UPDATE warnings SET data_json = ? WHERE id = ?')
let updated = 0, unclassified = 0
db.exec('BEGIN')
try {
  for (const r of rows) {
    const w = JSON.parse(r.data_json)
    const src = inferSourceKey(w)
    if (!src) { unclassified++; continue }
    w.source = src
    bySrc[src] = (bySrc[src] || 0) + 1
    if (!dryRun) upd.run(JSON.stringify(w), r.id)
    updated++
  }
  db.exec('COMMIT')
} catch (e) { db.exec('ROLLBACK'); throw e }

console.log(`[T13] ${dryRun ? '[DRY-RUN] 将更新' : '已更新'} ${updated} 条, 未分类 ${unclassified} 条`)
for (const [k, v] of Object.entries(bySrc)) console.log(`  ${k}: ${v}`)
if (dryRun) console.log('[T13] 未写入（--dry-run）')
else {
  const remain = db.prepare("SELECT COUNT(*) c FROM warnings WHERE json_extract(data_json, '$.source') IS NULL OR json_extract(data_json, '$.source') = ''").get().c
  console.log(`[T13] 迁移后剩余无 source: ${remain} 条`)
}
db.close()
