// 隔离渲染器：HTML 文件 -> PDF 文件
// 与版式完全解耦——只负责把给定 HTML 用无头 Chromium 打印成 PDF。
// 调用： node render.js <htmlPath> <pdfOutPath>
// 输出： stdout 最后一行 JSON {ok:true,path,bytes} 或 {ok:false,error}
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright-core');

// 自动定位已下载的 Chromium（优先 jsc/root 用户缓存，回退当前用户家目录）
function findChrome() {
  const home = os.homedir();
  const bases = [
    '/home/jsc/.cache/ms-playwright',
    '/root/.cache/ms-playwright',
    path.join(home, '.cache', 'ms-playwright'),
  ];
  for (const b of bases) {
    let entries;
    try { entries = fs.readdirSync(b) } catch { continue }
    const dir = entries.find(d => d.startsWith('chromium') && !d.includes('headless'));
    if (dir) {
      const p = path.join(b, dir, 'chrome-linux64', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

async function main() {
  const htmlPath = process.argv[2];
  const pdfOutPath = process.argv[3];
  if (!htmlPath || !pdfOutPath) { emit({ ok: false, error: 'usage: render.js <htmlPath> <pdfOutPath>' }); process.exit(2); }
  if (!fs.existsSync(htmlPath)) { emit({ ok: false, error: 'html file not found: ' + htmlPath }); process.exit(2); }

  const exe = findChrome();
  if (!exe) { emit({ ok: false, error: 'chromium not found in ms-playwright cache' }); process.exit(3); }

  const html = fs.readFileSync(htmlPath, 'utf8');
  fs.mkdirSync(path.dirname(pdfOutPath), { recursive: true });

  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.pdf({
      path: pdfOutPath,
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: '<div style="width:100%;text-align:center;font-size:10px;color:#888">第 <span class="pageNumber"></span> 页 / 共 <span class="totalPages"></span> 页</div>',
      margin: { top: '16mm', bottom: '18mm', left: '14mm', right: '14mm' },
    });
    const bytes = fs.statSync(pdfOutPath).size;
    emit({ ok: true, path: pdfOutPath, bytes });
  } finally {
    await browser.close();
  }
}

main().catch(e => { emit({ ok: false, error: String((e && e.message) || e) }); process.exit(1); });
