// 驾驶舱第 9 tab「抽检标注」端到端验证（v2：先进管理后台）
const { chromium } = require('/opt/jsc/backend/pdf/node_modules/playwright-core');
const { execSync } = require('child_process');

(async () => {
  const token = execSync('cd /opt/jsc/backend && node gen_token.js 2>/dev/null').toString().trim();
  const browser = await chromium.launch({
    executablePath: '/home/jsc/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE_ERR:', m.text().slice(0, 140)); });
  page.on('pageerror', e => console.log('PAGE_ERR:', e.message));
  const failed = [], status404 = [];
  page.on('requestfailed', r => failed.push(r.url()));
  page.on('response', r => { if (r.status() === 404) status404.push(r.url()); });

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

  await page.screenshot({ path: '/tmp/shot_negverify_tab.png', fullPage: false });

  const info = await page.evaluate(() => {
    const mainImg = document.querySelector('img[src*="review/image"][src*="w=1400"]');
    const thumbs = Array.from(document.querySelectorAll('img[src*="review/image"][src*="w=180"]'));
    return {
      title: document.title,
      hasNegVerify: document.body.innerText.includes('抽检标注'),
      statTotal: (document.body.innerText.match(/总帧数\s*\d+/) || [''])[0],
      statPending: (document.body.innerText.match(/待审\s*\d+/) || [''])[0],
      statReviewed: (document.body.innerText.match(/已审\s*\d+/) || [''])[0],
      mainImgLoaded: mainImg ? mainImg.complete && mainImg.naturalWidth > 0 : false,
      mainImgSrc: mainImg ? mainImg.src.slice(0, 100) : '',
      thumbCount: thumbs.length,
      thumbsLoaded: thumbs.filter(i => i.complete && i.naturalWidth > 0).length,
      btns: ['✅ 正确', '❌ 错误', '❓ 不确定', '导出 CSV', '上一帧'].map(t => [t, document.body.innerText.includes(t)]),
      cats: (document.body.innerText.match(/VLM 判定[^\n]*/) || [''])[0],
    };
  });
  console.log('RENDER:', JSON.stringify(info));
  console.log('FAILED_REQS:', failed.length ? failed.slice(0, 6) : 'none');
  console.log('STATUS_404:', status404.length ? status404.slice(0, 6) : 'none');
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
