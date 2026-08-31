// P3 报告 headless 截图（v5_balance_report + thermal_eval）
// 风格参考 shot_p2_scene.cjs：chromium-1228 + page.route 拦 webapi.amap.com + domcontentloaded+固定等待
const { chromium } = require('/opt/jsc/backend/pdf/node_modules/playwright-core');
const path = require('path');
const fs = require('fs');

const ROUTES = [
  { name: 'shot_p3_balance.png', url: 'http://127.0.0.1/v5_balance_report.html' },
  { name: 'shot_p3_thermal.png', url: 'http://127.0.0.1/thermal_eval_20260901.html' },
];

(async () => {
  const browser = await chromium.launch({
    executablePath: '/home/jsc/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 1700 },
    deviceScaleFactor: 1,
  });
  await ctx.route('**/webapi.amap.com/**', r => r.abort());
  await ctx.route('**/api.amap.com/**', r => r.abort());

  for (const r of ROUTES) {
    const page = await ctx.newPage();
    try {
      await page.goto(r.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      console.log(`[${r.name}] goto ERR ${e.message}; retry http://127.0.0.1:81/...`);
      await page.goto(r.url.replace('127.0.0.1', '127.0.0.1:81'), { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    await page.waitForTimeout(2000);
    // 等所有图片加载（热成像报告里有 T/V 图）
    await page.evaluate(() => Promise.all(Array.from(document.images).map(img => img.complete ? Promise.resolve() : new Promise(r => { img.onload = r; img.onerror = r; }))));
    await page.waitForTimeout(800);
    await page.screenshot({ path: '/tmp/' + r.name, fullPage: true });
    console.log(`[OK] ${r.name} -> /tmp/${r.name}`);
    await page.close();
  }

  await browser.close();
  console.log('done');
})();