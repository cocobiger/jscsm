const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/jsc/backend/data/jsc.db');

const rows = db.prepare("SELECT id, data_json FROM coll_streams").all();

let updated = false;
for (const row of rows) {
    try {
        const d = JSON.parse(row.data_json);
        if (d.name === '重庆华歌生物化学有限公司' && d.url) {
            const oldUrl = d.url;
            // 改为相对路径，浏览器自动使用页面origin（:81），同源无跨域
            // 无论页面在81/6080/5173等任何端口，都能正确请求
            d.url = '/jsc/smjmr1g/hls.m3u8';
            
            db.prepare("UPDATE coll_streams SET data_json = ? WHERE id = ?")
                .run(JSON.stringify(d), row.id);
            console.log('Updated:');
            console.log('  Before:', oldUrl);
            console.log('  After:', d.url);
            console.log('  Reason: 相对路径，浏览器自动使用页面origin(:81)，同源无跨域');
            updated = true;
        }
    } catch(e) {}
}

if (!updated) {
    console.log('NOT_FOUND or no change needed');
    for (const row of rows) {
        try {
            const d = JSON.parse(row.data_json);
            if (d.name === '重庆华歌生物化学有限公司') {
                console.log('Current URL:', d.url);
            }
        } catch(e) {}
    }
}
db.close();
