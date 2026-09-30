// POC: 用 playwright-core + 已下载的 Chromium 生成「结案报告」PDF
// 仅做能力验证，真实字段后续由后端 closureReportData(historyId) 注入
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

// 自动定位已下载的 chromium（优先 jsc 用户缓存，回退 root 缓存）
function findChrome() {
  const bases = ['/home/jsc/.cache/ms-playwright', '/root/.cache/ms-playwright'];
  for (const b of bases) {
    if (!fs.existsSync(b)) continue;
    const dir = fs.readdirSync(b).find(d => d.startsWith('chromium') && !d.includes('headless'));
    if (dir) {
      const p = path.join(b, dir, 'chrome-linux64', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// —— 样例结案数据（真实环境由 smart_push_history + events 聚合）——
const data = {
  reportNo: 'JSC-CLOSE-2026-000123',
  genDate: '2026-07-12',
  eventType: '堆头未覆盖',
  occurTime: '2026-07-11 14:32:05',
  location: 'XX区XX街道XX路XX号路口',
  lon: '119.123456',
  lat: '32.654321',
  level: '二级（较重）',
  platformName: '区城运中心',
  planName: '堆头未覆盖24小时推送规则',
  disposalResult: '现场堆头已清理完毕，路面恢复通畅；已通知属地网格员加强日常巡查，防止问题反复。处置过程符合闭环要求。',
  disposalOperator: '王建国（城运中心坐席）',
  closedAt: '2026-07-11 18:05:42',
};

// —— 结案报告 HTML 模板（甲方版式可在此 1:1 复刻，占位符 {{key}}）——
const template = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { font-family:"Noto Sans CJK SC","WenQuanYi Zen Hei",sans-serif; color:#1a1a1a; font-size:12.5px; line-height:1.7; margin:0; }
  .redhead { text-align:center; color:#c0392b; font-weight:700; font-size:22px; letter-spacing:2px; margin-top:6px; }
  .sub { text-align:center; color:#c0392b; font-size:12px; margin-top:2px; }
  .redline { border-top:3px solid #c0392b; margin:8px 0 14px; }
  .meta { text-align:right; color:#555; font-size:11px; margin-bottom:10px; }
  h2 { font-size:14px; border-left:4px solid #c0392b; padding-left:8px; margin:16px 0 8px; }
  table.info { width:100%; border-collapse:collapse; }
  table.info td { border:1px solid #b9c2cc; padding:6px 9px; vertical-align:top; }
  table.info td.k { background:#f2f5f8; width:22%; font-weight:600; color:#333; }
  table.info td.v { width:28%; }
  .block { border:1px solid #b9c2cc; padding:9px 11px; border-radius:4px; min-height:60px; }
  .sign { margin-top:34px; text-align:right; }
  .sign .unit { font-weight:600; }
  .stamp { display:inline-block; border:2px solid #c0392b; color:#c0392b; border-radius:50%; width:90px; height:90px; line-height:90px; text-align:center; font-size:13px; transform:rotate(-12deg); margin-top:6px; }
  .note { color:#888; font-size:11px; }
</style></head>
<body>
  <div class="redhead">智慧治理事件结案报告</div>
  <div class="sub">（城运中心处置回执闭环）</div>
  <div class="redline"></div>
  <div class="meta">报告编号：{{reportNo}}　|　生成日期：{{genDate}}</div>

  <h2>一、事件基本信息</h2>
  <table class="info">
    <tr><td class="k">事件类型</td><td class="v">{{eventType}}</td><td class="k">预警级别</td><td class="v">{{level}}</td></tr>
    <tr><td class="k">发生时间</td><td class="v" colspan="3">{{occurTime}}</td></tr>
    <tr><td class="k">发生地点</td><td class="v" colspan="3">{{location}}</td></tr>
    <tr><td class="k">经纬度</td><td class="v" colspan="3">经度 {{lon}}　纬度 {{lat}}</td></tr>
    <tr><td class="k">推送平台</td><td class="v">{{platformName}}</td><td class="k">关联预案</td><td class="v">{{planName}}</td></tr>
  </table>

  <h2>二、处置情况</h2>
  <div class="block">{{disposalResult}}</div>
  <table class="info" style="margin-top:8px;">
    <tr><td class="k" style="width:22%">处置人</td><td class="v" style="width:28%">{{disposalOperator}}</td><td class="k" style="width:22%">结案时间</td><td class="v" style="width:28%">{{closedAt}}</td></tr>
  </table>

  <h2>三、证据附件</h2>
  <div class="block note">（此处附现场处置前/后照片、城运中心截图等，由系统自动嵌入）</div>

  <div class="sign">
    <div class="unit">XX区智慧治理中心</div>
    <div>{{genDate}}</div>
    <div class="stamp">已结案</div>
  </div>
</body></html>`;

function render(html, d) {
  return html.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in d ? d[k] : m));
}

(async () => {
  const exe = findChrome();
  if (!exe) { console.error('ERROR: chromium not found'); process.exit(2); }
  console.log('Using chromium:', exe);
  const outDir = '/opt/jsc/backend/data/reports';
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'sample-closure-report.pdf');
  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });
  const page = await browser.newPage();
  await page.setContent(render(template, data), { waitUntil: 'networkidle0' });
  await page.pdf({
    path: outFile,
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: '<div style="width:100%;text-align:center;font-size:10px;color:#888">第 <span class="pageNumber"></span> 页 / 共 <span class="totalPages"></span> 页　智慧治理事件结案报告</div>',
    margin: { top: '16mm', bottom: '18mm', left: '14mm', right: '14mm' },
  });
  await browser.close();
  console.log('PDF generated:', outFile, fs.statSync(outFile).size, 'bytes');
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
