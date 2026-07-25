const db = require('node:sqlite');
const s = new db.DatabaseSync('data/jsc.db');
const r = s.prepare("SELECT data_json FROM coll_streams ORDER BY rowid").all();
const rtsp = [];
const gb28181 = [];
r.forEach(x => {
    const j = JSON.parse(x.data_json);
    if (!j.url) return;
    if (j.url.includes('rtsp://')) rtsp.push({ name: j.name, url: j.url });
    else if (j.url.includes('rtp/') || j.url.includes(':18082')) gb28181.push({ name: j.name, host: j.url.match(/\d+\.\d+\.\d+\.\d+/)?.[0] });
});
console.log('=== RTSP 视频流 (需要转码的H.265在其中) ===');
console.log('总数: ' + rtsp.length);
rtsp.forEach(x => console.log('  -', x.name, '\n     ', x.url));
console.log('\n=== GB28181 视频流 (走国标网关推送) ===');
console.log('总数: ' + gb28181.length);
const hostSet = [...new Set(gb28181.map(x => x.host))];
console.log('推送主机:', hostSet);
