// P3-2a 抽检工具渲染验证：http://127.0.0.1:81/neg_verify.html
const { chromium } = require('/opt/jsc/backend/pdf/node_modules/playwright-core');

(async () => {
  const browser = await chromium.launch({
    executablePath: '/home/jsc/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE_ERR:', m.text()); });
  page.on('pageerror', e => console.log('PAGE_ERR:', e.message));
  const failed = [];
  const status404 = [];
  page.on('requestfailed', r => failed.push(r.url()));
  page.on('response', r => { if (r.status() === 404) status404.push(r.url()); });

  await page.goto('http://111.10.220.226:81/neg_verify.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: '/tmp/shot_neg_verify.png', fullPage: false });

  // 统计页面渲染的样本卡数量与状态
  const info = await page.evaluate(() => ({
    frames: document.querySelectorAll('.frame').length,
    title: document.querySelector('h1')?.textContent,
    stats: document.getElementById('stats')?.textContent,
    imgLoaded: !!document.querySelector('.frame img')?.complete,
    imgSrc: document.querySelector('.frame img')?.src?.slice(0, 80),
    rel: document.querySelector('.rel')?.textContent,
  }));
  console.log('RENDER:', JSON.stringify(info));
  console.log('FAILED_REQS:', failed.length ? failed.slice(0, 8) : 'none');
  console.log('STATUS_404:', status404.length ? status404.slice(0, 8) : 'none');
  await browser.close();
})();
