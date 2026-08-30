// v5ai_label_v3.html 交互冒烟测试（外链模式 · 31 帧混合）
// 运行: node test_v5ai_label_v3.js （依赖 playwright-core + chromium-1228）
const { chromium } = require('playwright-core');
const fs = require('fs');

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

  // 拦 amap 防外网请求（虽然 v3 不用，但保险）
  await page.route('**/webapi.amap.com/**', r => r.abort());

  await page.goto('http://127.0.0.1:81/v5ai_label_v3.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  // 等待 canvas 初始化
  await page.waitForFunction(() => {
    const c = document.getElementById('cv');
    return c && c.width > 0 && c.height > 0;
  }, { timeout: 30000 });
  // 等待 31 帧全部 readyCount==order.length（外链按需加载）
  await page.waitForFunction(() => {
    return window.__v5ai_v3 && window.__v5ai_v3.getOrder().length >= 31;
  }, { timeout: 60000 });
  await page.waitForTimeout(3500); // 等图片渲染稳定

  const r1 = await page.evaluate(() => ({
    thumbs: document.querySelectorAll('.thumb').length,
    badge: document.getElementById('progBadge').textContent,
    pos: document.getElementById('posText').textContent,
    boxes: document.querySelectorAll('.boxrow').length,
    curRel: document.getElementById('curRel').textContent,
    srcChips: Array.from(document.querySelectorAll('.src-chip')).map(c => c.textContent),
    total: window.__v5ai_v3.getOrder().length,
  }));

  // ① 切换到 dji_photo 批次（点击 chip）
  await page.evaluate(() => {
    const chip = Array.from(document.querySelectorAll('.src-chip')).find(c => c.textContent.startsWith('dji_photo'));
    if (chip) chip.click();
  });
  await page.waitForTimeout(500);
  const r1b = await page.evaluate(() => ({
    pos: document.getElementById('posText').textContent,
    curRel: document.getElementById('curRel').textContent,
    activeSrc: window.__v5ai_v3.getActive(),
    filterStat: document.getElementById('filterStat').textContent,
  }));

  // ② 在 dji_photo 帧上画框（第一帧应该有烟）
  const cb = await (await page.$('#cv')).boundingBox();
  // 等图片就绪
  await page.waitForFunction(() => {
    const c = document.getElementById('cv');
    const ctx = c.getContext('2d');
    return c.width > 0;
  }, { timeout: 10000 });
  const beforeBoxes = await page.evaluate(() => window.__v5ai_v3.state().frames[window.__v5ai_v3.state().current].boxes.length);
  await page.mouse.move(cb.x + cb.width * 0.30, cb.y + cb.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(cb.x + cb.width * 0.50, cb.y + cb.height * 0.75, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const r2 = await page.evaluate(() => ({
    boxesAfterDraw: document.querySelectorAll('.boxrow').length,
    hookBoxes: window.__v5ai_v3.state().frames[window.__v5ai_v3.state().current].boxes.length,
    view: window.__v5ai_v3.getView(),
  }));

  // ③ 撤销（应恢复初始 0 个框）
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  const r3 = await page.evaluate(() => ({
    boxesAfterUndo: document.querySelectorAll('.boxrow').length,
  }));

  // ④ 重做（恢复新画的框）
  await page.keyboard.press('Control+y');
  await page.waitForTimeout(300);
  const r4 = await page.evaluate(() => ({
    boxesAfterRedo: document.querySelectorAll('.boxrow').length,
  }));

  // ⑤ 切回全部，过滤再切到 v2_ai
  await page.evaluate(() => {
    const chip = Array.from(document.querySelectorAll('.src-chip')).find(c => c.textContent.startsWith('全部'));
    if (chip) chip.click();
  });
  await page.waitForTimeout(400);
  const r5a = await page.evaluate(() => ({ pos: document.getElementById('posText').textContent }));

  // ⑥ 标记已复核 + localStorage 保存
  await page.click('#markB');
  await page.waitForTimeout(300);
  const r5 = await page.evaluate(() => ({
    badge: document.getElementById('progBadge').textContent,
    saved: (localStorage.getItem('v5ai_label_v3') || '').length > 10 ? 'yes' : 'no',
  }));

  // ⑦ 导出 JSON
  let dlName = null, dlSize = 0;
  try {
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 8000 }),
      page.click('#expJson')
    ]);
    dlName = dl.suggestedFilename();
    const p = '/tmp/v3_export.json';
    await dl.saveAs(p);
    dlSize = fs.existsSync(p) ? fs.statSync(p).size : 0;
  } catch (e) { errors.push('download fail: ' + e.message); }

  // ⑧ 截全屏
  await page.screenshot({ path: '/tmp/v5ai_label_v3_shot.png', fullPage: true });

  await browser.close();
  console.log(JSON.stringify({ r1, r1b, r2, r3, r4, r5a, r5, dlName, dlSize, errors }, null, 2));
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
