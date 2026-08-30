// v5ai_label.html 交互冒烟测试（headless 真浏览器）
// 运行: node test_v5ai_label.js （在 /opt/jsc/backend/pdf/ 下，依赖 playwright-core）
const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.launch({
    executablePath: '/home/jsc/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto('http://127.0.0.1:81/v5ai_label.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => {
    const c = document.getElementById('cv');
    return c && c.width > 0 && c.height > 0;
  }, { timeout: 30000 });
  await page.waitForTimeout(2500); // 等 27 图加载渲染

  const r1 = await page.evaluate(() => ({
    thumbs: document.querySelectorAll('.thumb').length,
    badge: document.getElementById('progBadge').textContent,
    pos: document.getElementById('posText').textContent,
    boxes: document.querySelectorAll('.boxrow').length,
    curRel: document.getElementById('curRel').textContent,
    initBoxes: window.__test ? window.__test : 'n/a'
  }));

  // ① 画新框（拖拽矩形）
  const cb = await (await page.$('#cv')).boundingBox();
  const before = await page.evaluate(() => window.__v5ai.getBoxes().length);
  await page.mouse.move(cb.x + cb.width * 0.45, cb.y + cb.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(cb.x + cb.width * 0.62, cb.y + cb.height * 0.60, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const r2 = await page.evaluate(() => ({
    boxesAfterDraw: document.querySelectorAll('.boxrow').length,
    hookBoxes: window.__v5ai.getBoxes().length,
    tool: window.__v5ai.getTool(),
    mode: window.__v5ai.getMode(),
    view: window.__v5ai.getView()
  }));

  // ② 删除最后（新画的）框
  await page.evaluate(() => {
    const rows = document.querySelectorAll('.boxrow');
    rows[rows.length - 1].querySelector('.del').click();
  });
  await page.waitForTimeout(300);
  const r3 = await page.evaluate(() => ({ boxesAfterDel: document.querySelectorAll('.boxrow').length }));

  // ③ 撤销（应恢复被删的框）
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  const r4 = await page.evaluate(() => ({ boxesAfterUndo: document.querySelectorAll('.boxrow').length }));

  // ④ 标记已复核 + localStorage 保存
  await page.click('#markB');
  await page.waitForTimeout(300);
  const r5 = await page.evaluate(() => ({
    badge: document.getElementById('progBadge').textContent,
    saved: (localStorage.getItem('v5ai_label_v1') || '').length > 10 ? 'yes' : 'no'
  }));

  // ⑤ 导出 JSON（触发下载）
  let dlName = null;
  try {
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 8000 }),
      page.click('#expJson')
    ]);
    dlName = dl.suggestedFilename();
  } catch (e) { errors.push('download fail: ' + e.message); }

  // ⑥ 下一帧导航
  await page.click('#nextB');
  await page.waitForTimeout(300);
  const r6 = await page.evaluate(() => ({ curRel2: document.getElementById('curRel').textContent }));

  // ⑦ 截图（首帧已切到第2帧，切回第1帧截图）
  await page.click('#prevB');
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/tmp/v5ai_label_shot.png' });

  await browser.close();
  console.log(JSON.stringify({ r1, r2, r3, r4, r5, r6, dlName, errors }, null, 2));
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
