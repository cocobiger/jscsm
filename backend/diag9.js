const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/jsc/backend/data/jsc.db');
// 列出所有 id 看格式
const all = db.prepare("SELECT id, data_json FROM coll_streams").all();
const ids = all.map(r => {
  const d = JSON.parse(r.data_json);
  return { uuid: r.id.substring(0, 8), shortId: d.id ? d.id.substring(0, 12) : '-', name: d.name };
});
console.log(JSON.stringify(ids, null, 2));
