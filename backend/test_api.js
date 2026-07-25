const https = require('https');

function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

(async () => {
  try {
    const raw = await post('https://hbyw.sthjj.cq.gov.cn/shouye/BatchDataController/getThirtySixHourAQI', 'stationname=周家坝');
    const arr = JSON.parse(raw);
    const data = arr.ThirtySixHourAQI || arr.data || arr.list || (Array.isArray(arr) ? arr : null);
    if (Array.isArray(data) && data.length > 0) {
      console.log('返回', data.length, '条');
      console.log('字段:', Object.keys(data[0]).join(', '));
      console.log('第1条 monitortime =', JSON.stringify(data[0].monitortime));
      console.log('第2条 monitortime =', JSON.stringify(data[1]?.monitortime));
      console.log('第3条 monitortime =', JSON.stringify(data[2]?.monitortime));
      console.log('完整第1条:', JSON.stringify(data[0]).substring(0, 600));
    } else {
      console.log('非数组:', raw.substring(0, 500));
    }
  } catch (e) {
    console.error('ERR:', e.message);
  }
})();
