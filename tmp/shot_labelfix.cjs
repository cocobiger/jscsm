// 验证驾驶舱「抽检标注」tab 补选漏判 chips UI（2026-09-01，复用 evaluate 导航模式）
const { chromium } = require('/opt/jsc/backend/pdf/node_modules/playwright-core');
const { execSync } = require('child_process');

(async () => {
  const token = execSync('cd /opt/jsc/backend && node gen_token.js 2>/dev/null').toString().trim();
  const browser = await chromium.launch({
    executablePath: '/home/jsc/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errs = [], bad = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 120)); });
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message.slice(0, 120)));
  page.on('response', r => { if (r.status() === 404 || r.status() === 500) bad.push(r.status() + ' ' + r.url().slice(0, 90)); });

  const clickExact = async (txt) => page.evaluate((t) => {
    const b = Array.from(document.querySelectorAll('button, [role="button"], a')).find(x => (x.textContent || '').trim() === t);
    if (b) { b.scrollIntoView({ block: 'center' }); b.click(); return true; }
    return false;
  }, txt);
  const clickContains = async (txt) => page.evaluate((t) => {
    const b = Array.from(document.querySelectorAll('button, [role="button"], a')).find(x => (x.textContent || '').includes(t) && (x.textContent || '').length < 60);
    if (b) { b.scrollIntoView({ block: 'center' }); b.click(); return true; }
    return false;
  }, txt);

  await page.goto('http://127.0.0.1/jsc/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.evaluate((t) => { localStorage.setItem('jsc:token', t); location.reload(); }, token);
  await page.waitForTimeout(5000);
  console.log('CLICK_ADMIN:', await clickExact('管理后台'));
  await page.waitForTimeout(2500);
  console.log('CLICK_STRAW:', await clickContains('秸秆焚烧监控'));
  await page.waitForTimeout(2500);
  console.log('CLICK_TAB:', await clickExact('抽检标注'));
  await page.waitForTimeout(6000);

  // 切「全部」筛选
  console.log('CLICK_ALL:', await clickExact('全部'));
  await page.waitForTimeout(2000);

  // 截图 1：初始状态（含 chips 行）
  await page.screenshot({ path: '/tmp/shot_labelfix_1_initial.png' });
  const hasFixRow = await page.evaluate(() => document.body.innerText.includes('补选漏判'));

  // 点补选 chips（building + concrete），提交 ✅
  const chipClick = await page.evaluate(() => {
    const out = { building: false, concrete: false };
    const btns = Array.from(document.querySelectorAll('button'));
    const b1 = btns.find(x => (x.textContent || '').trim() === 'building');
    if (b1) { b1.scrollIntoView({ block: 'center' }); b1.click(); out.building = true; }
    return out;
  });
  await page.waitForTimeout(400);
  const chip2 = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const b2 = btns.find(x => (x.textContent || '').trim() === 'concrete');
    if (b2) { b2.click(); return true; }
    return false;
  });
  await page.waitForTimeout(400);
  console.log('CHIP_BUILDING:', chipClick.building, 'CHIP_CONCRETE:', chip2);
  const fixHintBefore = await page.evaluate(() => (document.body.innerText.match(/已补 \d+ 项[^\n]*/) || [''])[0]);

  // 点 ✅ 正确提交
  console.log('CLICK_OK:', await clickExact('✅ 正确'));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: '/tmp/shot_labelfix_2_submitted.png' });

  const info = await page.evaluate(() => ({
    submitted: document.body.innerText.includes('✓ 已提交'),
    fixRowVisible: document.body.innerText.includes('补选漏判'),
    catsLine: (document.body.innerText.match(/VLM 判定[^\n]*/) || [''])[0],
    statTotal: (document.body.innerText.match(/总帧数\s*\d+/) || [''])[0],
    statOk: (document.body.innerText.match(/✅ 正确\s*\d+/) || [''])[0],
  }));
  console.log('RENDER:', JSON.stringify(info));
  console.log('FIX_HINT_BEFORE:', fixHintBefore);
  console.log('BAD:', bad.length ? bad.slice(0, 5) : 'none');
  console.log('ERRORS:', errs.length ? errs.slice(0, 5) : 'none');
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
