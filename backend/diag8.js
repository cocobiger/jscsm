const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/jsc/backend/data/jsc.db');

console.log("=== c5087b79 详情 ===");
const rows = db.prepare("SELECT id, data_json FROM coll_streams WHERE id LIKE 'c5087b79%'").all();
rows.forEach(r => {
  console.log("ID:", r.id);
  try {
    const d = JSON.parse(r.data_json);
    console.log(JSON.stringify(d, null, 2));
  } catch (e) {
    console.log("raw:", r.data_json.substring(0, 500));
  }
});

console.log("\n=== 所有流（id, name, app, is_h265, source） ===");
const all = db.prepare("SELECT id, data_json FROM coll_streams").all();
all.forEach(r => {
  try {
    const d = JSON.parse(r.data_json);
    const url = d.source_url || d.rtsp_url || d.url || '';
    console.log(r.id.substring(0, 36), '|', (d.name || '').substring(0, 30), '|', d.app || '-', '|', d.is_h265 || 0, '|', url.substring(0, 90));
  } catch (e) {}
});
