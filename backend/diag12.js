// 看 zlm.addStreamProxy
const fs = require('fs');
const c = fs.readFileSync('/opt/jsc/backend/zlm.js', 'utf-8');
const lines = c.split('\n');
// addStreamProxy/playUrls 全部打印
for (let i = 0; i < lines.length; i++) {
  if (lines[i].match(/addStreamProxy|playUrls|getConfig|getRtpInfo/)) {
    console.log((i+1).toString().padStart(5), '|', lines[i]);
  }
}
