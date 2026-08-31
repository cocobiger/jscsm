// 验证 reflection 在前端显示
const { chromium } = require('/opt/jsc/backend/pdf/node_modules/playwright-core');
const { execSync } = require('child_process');
(async () => {
  const token = execSync('cd /opt/jsc/backend && node gen_token.js 2>/dev/null').toString().trim();
  const browser = await chromium.launch({
    executablePath: '/home/jsc/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-gpu']
  });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errs = [];
  page.on('pageerror', e => errs.push('PAGE: ' + e.message));
  page.on('response', r => {
    if (r.status() === 404 && r.url().includes('/api/')) errs.push('API404: ' + r.url().slice(0, 80));
  });
  await page.goto('http://127.0.0.1/jsc/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.evaluate(t => { localStorage.setItem('jsc:token', t); location.reload(); }, token);
  await page.waitForTimeout(4000);
  // 进管理后台
  await page.evaluate(() => {
    [...document.querySelectorAll('button, a, [role="button"]')]
      .find(e => /管理后台/.test(e.textContent))?.click();
  });
  await page.waitForTimeout(1200);
  // 点侧边栏秸秆焚烧监控
  const strawClicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button, a, [role="button"]')];
    const target = btns.find(b => {
      const t = b.textContent || '';
      return /秸秆/.test(t) && t.length < 60;
    });
    if (target) { target.click(); return target.textContent.trim(); }
    return null;
  });
  console.log('clicked:', strawClicked);
  await page.waitForTimeout(1500);
  // 第 9 tab「抽检标注」
  const tabClicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button, a, [role="button"]')];
    const target = btns.find(b => (b.textContent || '').includes('抽检标注'));
    if (target) { target.click(); return target.textContent.trim(); }
    return null;
  });
  console.log('tab clicked:', tabClicked);
  await page.waitForTimeout(2500);
  // 切换到「全部」筛选以便看到更多 reflection 帧（如果有）
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    btns.find(b => (b.textContent || '').trim() === '全部')?.click();
  });
  await page.waitForTimeout(1500);
  // 统计页面上 reflection 字样出现的次数
  const reflectionCount = await page.evaluate(() => {
    const txt = document.body.innerText;
    const m = txt.match(/reflection/g);
    return m ? m.length : 0;
  });
  const stats = await page.evaluate(() => {
    const txt = document.body.innerText;
    const lines = txt.split('\n').filter(l => /待审|✅|❌|❓|已审|总帧/.test(l));
    return lines.slice(0, 10);
  });
  console.log('reflection 出现次数:', reflectionCount);
  console.log('关键统计行:', stats);
  await page.screenshot({ path: '/tmp/shot_negverify_ref.png', fullPage: false });
  console.log('errs:', errs.slice(0, 5));
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
