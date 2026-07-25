const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/jsc/backend/data/jsc.db', { readonly: true });

// 查询 coll_streams 中的华歌/重点企业数据
console.log('=== coll_streams (华歌/重点/smjmr1g) ===');
try {
  const stmt = db.prepare("SELECT id, data_json FROM coll_streams");
  const rows = stmt.all();
  for (const row of rows) {
    try {
      const d = JSON.parse(row.data_json);
      const name = d.name || '';
      const group = d.group || d.group_name || '';
      const url = d.url || '';
      if (name.includes('华歌') || group.includes('重点') || url.includes('smjmr1g')) {
        console.log('--- Found ---');
        console.log('Name:', name);
        console.log('Group:', group);
        console.log('Protocol:', d.protocol);
        console.log('URL:', url?.substring(0, 120));
        console.log('');
      }
    } catch(e) {}
  }
} catch(e) {
  console.log('Error:', e.message);
}

// 查询 enterprises 表
console.log('\n=== enterprises (华歌) ===');
try {
  const stmt = db.prepare("SELECT * FROM enterprises WHERE name LIKE '%华歌%'");
  const rows = stmt.all();
  rows.forEach(r => console.log(JSON.stringify(r)));
} catch(e) {
  console.log('Error:', e.message);
}

db.close();
