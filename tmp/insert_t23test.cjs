// T23 测试数据：插入 1 条 iotcloud pending（用于触发弹窗内 10s 轮询 diff）
//   CID 隔离 t23test_ch_0902，AI 类型 T23验收测试类型（永不与真实数据撞），--clean 删除
const { DatabaseSync } = require('node:sqlite')
const DB = '/opt/jsc/backend/data/jsc.db'
const CID = 't23test_ch_0902'
const AI_TYPE = 'T23验收测试类型'
const TZ_OFFSET = '+08:00'  // 上海时区

const PREFIX = 't23test-0902'
const now = new Date()
const createdAt = new Date(now.getTime() + 8 * 3600 * 1000).toISOString().replace('Z', '+08:00')

const db = new DatabaseSync(DB)
const ins = db.prepare(`INSERT OR REPLACE INTO warnings (id, created_at, status, warning_type, data_json) VALUES (?,?,?,?,?)`)
const data = JSON.stringify({
  id: PREFIX + '-01',  // 必须写 id 字段，前端按 w.id diff
  type: AI_TYPE,
  aiType: AI_TYPE,
  channelName: 'T23测试通道',
  channelSipId: CID,
  deviceName: 'T23测试设备',
  pointName: 'T23测试点位',
  picUrl: '',
  aiConfidence: 0.85,
  source: 'iotcloud',
})

if (process.argv.includes('--clean')) {
  const r = db.prepare("DELETE FROM warnings WHERE id LIKE ?").run(PREFIX + '%')
  console.log(`cleaned ${r.changes}`)
  process.exit(0)
}

ins.run(PREFIX + '-01', createdAt, 'pending', 'iot-video-analysis', data)
console.log('inserted:', PREFIX + '-01', 'at', createdAt)