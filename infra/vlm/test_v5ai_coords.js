// 画框坐标合法性验证 + 截图
const { chromium } = require('playwright-core');
(async () => {
  const b = await chromium.launch({ executablePath: '/home/jsc/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox'] });
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await p.goto('http://127.0.0.1:81/v5ai_label.html', { waitUntil: 'load', timeout: 60000 });
  await p.waitForFunction(() => window.__v5ai && window.__v5ai.getView().fitW > 0, { timeout: 30000 });
  await p.waitForTimeout(1000);
  const cb = await (await p.$('#cv')).boundingBox();
  await p.mouse.move(cb.x + cb.width * 0.30, cb.y + cb.height * 0.55);
  await p.mouse.down();
  await p.mouse.move(cb.x + cb.width * 0.44, cb.y + cb.height * 0.68, { steps: 6 });
  await p.mouse.up();
  await p.waitForTimeout(300);
  const res = await p.evaluate(() => ({
    boxes: window.__v5ai.getBoxes(),
    allValid: window.__v5ai.getBoxes().every(b => b.slice(1).every(v => v >= 0 && v <= 1))
  }));
  await p.screenshot({ path: '/tmp/v5ai_label_shot2.png' });
  console.log(JSON.stringify(res, null, 2));
  await b.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
