const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/jsc/backend/data/jsc.db');

console.log("=== coll_streams 表结构 ===");
const cols = db.prepare("PRAGMA table_info(coll_streams)").all();
console.log(cols.map(c => c.name).join(', '));

console.log("\n=== c5087b79 详情 ===");
const rows = db.prepare("SELECT * FROM coll_streams WHERE id=? OR source_url LIKE ? LIMIT 3").all('c5087b79-3beb-462d-9406-9f0570499ddc', '%c5087b79%');
console.log(JSON.stringify(rows, null, 2));

console.log("\n=== 所有 coll_streams (id, name, app, is_h265) ===");
const all = db.prepare("SELECT * FROM coll_streams").all();
all.forEach(r => {
  const url = (r.source_url || r.rtsp_url || r.url || '').toString();
  console.log((r.id || r.stream_id || '').toString().substring(0, 20), '|', (r.name || '').toString().substring(0, 30), '|', r.app || '-', '|', r.is_h265 || 0, '|', url.substring(0, 90));
});
