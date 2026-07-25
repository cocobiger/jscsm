const fs = require('fs');
const c = fs.readFileSync('/opt/jsc/backend/index.js', 'utf-8');
const lines = c.split('\n');

// 输出 stream/start 相关代码（前后各5行）
console.log("=== stream/start 路由注册 ===");
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("'stream/start'") || lines[i].includes('"stream/start"') || lines[i].includes('post.*stream.*start')) {
    for (let j = Math.max(0, i-3); j < Math.min(lines.length, i+60); j++) {
      console.log((j+1).toString().padStart(5), '|', lines[j]);
    }
    console.log('---');
    break;
  }
}

// h265Sources 定义
console.log("=== h265Sources 定义 ===");
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('h265Sources')) {
    for (let j = Math.max(0, i-3); j < Math.min(lines.length, i+20); j++) {
      console.log((j+1).toString().padStart(5), '|', lines[j]);
    }
    console.log('---');
  }
}

// transcoder 相关调用
console.log("=== transcoder 调用 ===");
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('transcoder.')) {
    console.log((i+1).toString().padStart(5), '|', lines[i]);
  }
}

// addStreamProxy 相关
console.log("=== addStreamProxy 调用 ===");
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('addStreamProxy')) {
    for (let j = Math.max(0, i-3); j < Math.min(lines.length, i+15); j++) {
      console.log((j+1).toString().padStart(5), '|', lines[j]);
    }
    console.log('---');
    break;
  }
}
