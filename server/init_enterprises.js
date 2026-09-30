const Database = require('better-sqlite3')
const db = new Database('/opt/jsc/backend/data/jsc.db')

try {
  // 创建 enterprises 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS enterprises (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      industry_type TEXT,
      location TEXT,
      contact TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `)
  console.log('enterprises 表就绪')

  // 创建 pollution_events 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS pollution_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enterprise_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      description TEXT,
      reported_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (enterprise_id) REFERENCES enterprises(id)
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_pollution_events_enterprise ON pollution_events(enterprise_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_pollution_events_reported ON pollution_events(reported_at)')
  console.log('pollution_events 表就绪')

  // 插入10家重点企业
  const enterprises = [
    ['重庆湘渝盐化有限公司', '化工'],
    ['重庆市九龙万博新材料科技有限公司', '新材料'],
    ['重庆博联热电有限公司', '热电'],
    ['重庆华歌生物化学有限公司', '化工'],
    ['彼迪正天生化(重庆)有限公司', '化工'],
    ['重庆万州西南水泥有限公司', '水泥'],
    ['重庆市万州区三峰环保发电有限公司', '环保发电'],
    ['重庆长安跨越车辆有限公司', '汽车制造'],
    ['重庆市万州区万源玻璃有限公司', '建材'],
    ['三峡国际健康城施工工地-开挖区', '建筑施工'],
  ]

  const insert = db.prepare('INSERT OR IGNORE INTO enterprises (name, industry_type) VALUES (?, ?)')
  for (const row of enterprises) {
    insert.run(row)
  }
  const count = db.prepare('SELECT COUNT(*) as c FROM enterprises').get().c
  console.log('企业数量:', count)

  // 验证
  const all = db.prepare('SELECT id, name, industry_type FROM enterprises').all()
  all.forEach(e => console.log('  ID=' + e.id + '  ' + e.name + '  [' + e.industry_type + ']'))

} catch(e) {
  console.error('错误:', e.message)
  process.exit(1)
} finally {
  db.close()
}
