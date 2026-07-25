const fs = require('fs');
const c = fs.readFileSync('/opt/jsc/backend/zlm.js', 'utf-8');
const lines = c.split('\n');
// 看 playUrls 完整代码
for (let i = 166; i < 190; i++) {
  console.log((i+1).toString().padStart(5), '|', lines[i]);
}
