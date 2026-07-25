// 查index.js的transcoder相关代码
const fs = require('fs');
const c = fs.readFileSync('/opt/jsc/backend/index.js', 'utf-8');
const lines = c.split('\n');
lines.forEach((l, i) => {
  if (l.includes('transcoder') || l.includes('h265Sources') || l.includes('jsc_h264') || l.includes('rewriteStream') || l.includes('H265_SOURCE') || l.includes('stream/start') || l.includes('addStreamProxy')) {
    console.log((i+1).toString().padStart(5), '|', l);
  }
});
