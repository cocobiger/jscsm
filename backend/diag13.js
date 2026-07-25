const fs = require('fs');
const c = fs.readFileSync('/opt/jsc/backend/zlm.js', 'utf-8');
const lines = c.split('\n');
// 50-180 区间
for (let i = 45; i < 175; i++) {
  console.log((i+1).toString().padStart(5), '|', lines[i]);
}
