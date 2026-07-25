const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/jsc/backend/data/jsc.db');

// 1. 查 c5087b79 流
console.log("=== c5087b79 流 ===");
try {
  const rows = db.prepare("SELECT id, name, source_url, app, is_h265 FROM streams WHERE id=? OR source_url LIKE ? LIMIT 5").all('c5087b79-3beb-462d-9406-9f0570499ddc', '%c5087b79%');
  console.log(JSON.stringify(rows, null, 2));
} catch (e) { console.log("ERR:", e.message); }

// 2. 查 streams 表结构
console.log("\n=== streams 表结构 ===");
try {
  const cols = db.prepare("PRAGMA table_info(streams)").all();
  console.log(cols.map(c => c.name).join(', '));
} catch (e) { console.log("ERR:", e.message); }

// 3. 所有流
console.log("\n=== 所有流（name, app, is_h265） ===");
try {
  const rows = db.prepare("SELECT id, name, source_url, app, COALESCE(is_h265, 0) as is_h265 FROM streams").all();
  rows.forEach(r => console.log(r.id, '|', r.name, '|', r.app, '|', r.is_h265, '|', (r.source_url||'').substring(0, 80)));
} catch (e) { console.log("ERR:", e.message); }
