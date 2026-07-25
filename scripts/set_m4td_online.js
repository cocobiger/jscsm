const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync('/opt/jsc/backend/data/jsc.db')
const target = 'M4TD | Matrice 4TD-1'
const row = db.prepare('SELECT id, data_json FROM coll_streams WHERE data_json LIKE ?').get('%' + target + '%')
if (!row) { console.error('未找到流:', target); process.exit(1) }
const s = JSON.parse(row.data_json)
console.log('找到流:', s.name, '| id:', s.id, '| 当前 offline =', s.offline)
s.offline = false
db.prepare('UPDATE coll_streams SET data_json = ? WHERE id = ?').run(JSON.stringify(s), row.id)
console.log('已设 offline=false，等待后端重启后自动启动推流')
