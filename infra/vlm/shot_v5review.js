// v5review 页面 headless 截图验证
const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.launch({
    executablePath: '/home/jsc/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1300 } });
  const page = await ctx.newPage();
  page.on('console', m => console.log('[console]', m.type(), m.text()));
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto('http://127.0.0.1:81/v5review.html', { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('.card').length > 0, { timeout: 30000 });
  await page.waitForTimeout(1000);

  const cardCount = await page.$$eval('.card', cs => cs.length);
  const nightCount = await page.$$eval('.card.night', cs => cs.length);
  const smokeOn = await page.$$eval('.btn.smoke.on', bs => bs.length);
  console.log(JSON.stringify({ cardCount, nightCount, smokeOn }));

  await page.screenshot({ path: '/tmp/v5_top.png' });
  await page.evaluate(() => window.scrollTo(0, 2400));
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/tmp/v5_mid.png' });
  await page.evaluate(() => window.scrollTo(0, 5200));
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/tmp/v5_btm.png' });
  await browser.close();
  console.log('done');
})().catch(e => { console.error(e); process.exit(1); });
