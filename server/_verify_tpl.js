const { init, getDb } = require('/opt/jsc/backend/store-db.js');
init();
const db = getDb();
const rows = db.prepare("SELECT id,name,kind,is_default,length(content) AS len,description FROM smart_push_report_templates ORDER BY kind,id").all();
rows.forEach(function(r){
  console.log([r.id,r.name,r.kind||'(null)',r.is_default,r.len+'B',r.description].join(' | '));
});
