const fs = require('fs');
const c = fs.readFileSync('/opt/jsc/backend/index.js', 'utf-8');
const lines = c.split('\n');
// 关键代码段：319-340  + 1545-1570
for (let i = 315; i < 345; i++) console.log((i+1).toString().padStart(5), '|', lines[i]);
console.log('---');
for (let i = 1545; i < 1570; i++) console.log((i+1).toString().padStart(5), '|', lines[i]);
