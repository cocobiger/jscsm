// v5review 构建脚本：从旧版 v5review.html 提取 DATA（41 帧 base64），生成新版页面 + 外部数据 json
// 用法: node infra/build_v5review.cjs
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const srcFile = path.join(root, 'outputs', 'v5review.html');
const tplFile = path.join(root, 'infra', 'v5review_template.html');
const outFile = path.join(root, 'outputs', 'v5review_new.html');
const jsonFile = path.join(root, 'outputs', 'v5review_data.json');

const html = fs.readFileSync(srcFile, 'utf8');
const lines = html.split('\n');
const li = lines.findIndex(l => l.includes('const DATA ='));
if (li < 0) { console.error('✗ 未找到 DATA 行'); process.exit(1); }
const m = lines[li].match(/const DATA = ([\s\S]*);\s*$/);
if (!m) { console.error('✗ DATA 提取失败'); process.exit(1); }
const dataJson = m[1];

// 1) 外部数据 json（为 400 帧打底）
fs.writeFileSync(jsonFile, dataJson);
console.log(`✓ v5review_data.json  ${(fs.statSync(jsonFile).size / 1048576).toFixed(2)} MB`);

// 2) 新页面（模板 + 内嵌数据兜底）
const tpl = fs.readFileSync(tplFile, 'utf8');
if (!tpl.includes('/*__V5_DATA__*/')) { console.error('✗ 模板缺少占位符'); process.exit(1); }
const out = tpl.replace('/*__V5_DATA__*/', dataJson);
fs.writeFileSync(outFile, out);
console.log(`✓ v5review_new.html    ${(fs.statSync(outFile).size / 1048576).toFixed(2)} MB`);

// 3) 校验：提取新页 script 做语法检查
const jsMatch = out.match(/<script>([\s\S]*?)<\/script>/);
if (!jsMatch) { console.error('✗ 未找到 script'); process.exit(1); }
const tmp = path.join(root, 'infra', '_v5_check.js');
fs.writeFileSync(tmp, jsMatch[1].replace(/\/\*__V5_DATA__\*\//, '{}'));
console.log('✓ script 提取完成（数据占位符已替换为 {} 供语法检查）');
console.log('构建完成，下一步 node --check 语法验证');
