'use strict'
/**
 * 生产环境「研判闸门」受控自检（2026-09-19）
 * 用服务自己的 store-db 模块（= 线上同一份代码）插 3 条带唯一前缀的自检记录，覆盖三种分支：
 *   T1 九龙沙场 × 堆头未覆盖（有通道级规则，阈值 5，24h 已有 ~9 条）→ 预期 admitted
 *   T2 任意通道 × 堆场扬尘（有通配规则，阈值 20，24h 无记录）      → 预期 blocked
 *   T3 任意通道 × 渣土车冒装（无匹配规则）                        → 预期 admitted（默认放行）
 * 验完**按 id 精确删除**并做残留检查。自检记录 createdAt 设为 6 天前，避免触发前台摄像头红闪。
 */
const store = require('./store-db')

const TAG = 'SELFTEST-judge-' + Date.now()
const DIR = '/opt/jsc/backend/data'
const log = { info() {}, warn() {}, error() {} }
store.init(DIR, log)

const OLD = new Date(Date.now() - 6 * 86400000).toISOString()   // 6 天前 → 不进前台红闪窗口
const mk = (id, cid, cname, ai) => ({
  id, createdAt: OLD, status: 'pending', warningType: 'iot-video-analysis',
  source: 'iotcloud', channelSipId: cid, channelName: cname, aiType: ai,
  aiConfidence: 0.82, level: 1, picUrl: '',
})

const cases = [
  ['T1 九龙沙场×堆头未覆盖(有通道规则/阈值5/窗口内~9条)', mk(TAG + '-T1', '56331706881318000004', '九龙沙场', '堆头未覆盖'), 'admitted'],
  ['T2 任意×堆场扬尘(通配规则/阈值20/窗口内0条)', mk(TAG + '-T2', 'SELFTEST-CH', '【自检】通道', '堆场扬尘'), 'blocked'],
  ['T3 任意×渣土车冒装(无匹配规则)', mk(TAG + '-T3', 'SELFTEST-CH', '【自检】通道', '渣土车冒装'), 'admitted'],
]

let pass = 0, fail = 0
for (const [name, w, expect] of cases) {
  store.insertWarning(w)
  const back = store.getWarning(w.id)
  const got = back ? back.judgeStatus : '(未入库)'
  const ok = got === expect
  ok ? pass++ : fail++
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  console.log(`     判定=${got}  期望=${expect}  rule=${back && back.judgeRuleId}`)
  console.log(`     原因=${(back && back.judgeReason || '').slice(0, 120)}`)
}

console.log('\n=== 清理自检记录（按 id 精确删除）===')
const db = store.getDb()
for (const [, w] of cases) db.prepare('DELETE FROM warnings WHERE id = ?').run(w.id)
const residue = db.prepare("SELECT COUNT(*) c FROM warnings WHERE id LIKE 'SELFTEST-judge-%'").get().c
console.log(`  残留自检记录 = ${residue}（应为 0）`)
const ch = db.prepare("SELECT COUNT(*) c FROM iot_channels WHERE channel_sip_id = 'SELFTEST-CH'").get().c
console.log(`  残留自检通道 = ${ch}（应为 0，本脚本未建通道）`)

console.log(`\n================ 生产自检：通过 ${pass} / 失败 ${fail} ================`)
process.exit(fail === 0 && residue === 0 ? 0 : 1)
