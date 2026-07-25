const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/jsc/backend/data/jsc.db');

console.log("=== 所有表 ===");
const tabs = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
tabs.forEach(t => console.log(t.name));

console.log("\n=== c5087b79 搜所有含uuid的表 ===");
for (const t of tabs) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${t.name})`).all();
    const colNames = cols.map(c => c.name);
    if (colNames.includes('id') || colNames.includes('stream_id')) {
      const rows = db.prepare(`SELECT * FROM ${t.name} WHERE id LIKE ? OR source_url LIKE ? LIMIT 3`).all('c5087b79%', '%c5087b79%');
      if (rows.length > 0) {
        console.log(`\n[${t.name}]`);
        console.log(JSON.stringify(rows, null, 2));
      }
    }
  } catch (e) {}
}
