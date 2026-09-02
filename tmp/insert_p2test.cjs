// P2 验收测试数据：插入 5 条 iotcloud pending 同组记录触发聚合折叠（隔离 channelSipId，不碰真实数据）
// 用法: node insert_p2test.cjs [--clean]
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync('/opt/jsc/backend/data/jsc.db')
const PREFIX = 'p2test-0902-'
const CID = 'p2test_ch_0902'
const AI = 'P2验收测试类型'
const PIC = 'http://172.16.8.11:6882/images/detect/2026/09/02/t2_cover_inject_1788348836211_full.png'

if (process.argv.includes('--clean')) {
  const n = db.prepare("DELETE FROM warnings WHERE id LIKE ?").run(PREFIX + '%')
  console.log('cleaned', n.changes)
  process.exit(0)
}
const ins = db.prepare('INSERT OR REPLACE INTO warnings (id, created_at, status, warning_type, data_json) VALUES (?,?,?,?,?)')
for (let i = 1; i <= 5; i++) {
  const id = PREFIX + String(i).padStart(2, '0')
  const createdAt = `2026-09-02T12:0${i}:00.000Z`  // 12:01~12:05 UTC = 上海 20:01~20:05（过去 24h 窗内）
  const w = {
    id, createdAt, source: 'iotcloud', status: 'pending',
    recordId: 990000 + i, deviceSipId: '50010100001310000001', channelSipId: CID,
    channelName: 'P2验收通道', picUrl: PIC, aiType: AI,
    type: 'AI视频分析 · ' + AI, value: '置信度 82%', standard: '阈值 ≥50%',
    level: 2, aiConfidence: 0.82, lat: 30.731, lon: 108.417,
    location: 'P2验收通道 NVR', time: '20:00:00',
  }
  ins.run(id, createdAt, 'pending', 'iot-video-analysis', JSON.stringify(w))
}
console.log('inserted 5')
const c = db.prepare("SELECT count(*) c FROM warnings WHERE status='pending' AND json_extract(data_json,'$.channelSipId')=?").get(CID)
console.log('pending in test group:', c.c)
