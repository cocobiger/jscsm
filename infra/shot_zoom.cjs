// 复检图放大查看器 + 画框滚轮缩放 视觉验证 v2（点击 + 按钮 + 精准百分比 selector）
const { chromium } = require('/opt/jsc/backend/pdf/node_modules/playwright-core');

(async () => {
  const token = process.argv[2];
  const exe = '/home/jsc/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1500 } });
  await page.route('**webapi.amap.com**', r => r.abort());

  await page.goto('http://127.0.0.1/jsc/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.evaluate(t => localStorage.setItem('jsc:token', t), token);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);

  const clickByText = async (text, opts = {}) => page.evaluate(({ text, exact }) => {
    const btns = Array.from(document.querySelectorAll('button'));
    for (const b of btns) { const t = (b.textContent||'').replace(/\s+/g,' ').trim(); if ((exact ? t===text : t.includes(text))) { b.scrollIntoView({block:'center'}); b.click(); return {ok:true} } }
    return {ok:false};
  }, { text, exact: opts.exact !== false });

  // 精准读 ImgViewer 工具条百分比（限定 zIndex 3200 容器内）
  const viewerPct = () => page.evaluate(() => {
    const stage = Array.from(document.querySelectorAll('div')).find(d => getComputedStyle(d).position === 'fixed' && getComputedStyle(d).zIndex === '3200');
    if (!stage) return null;
    const toolbar = stage.children[0]; // 工具条
    const s = Array.from(toolbar.querySelectorAll('span')).find(x => /^\d+%$/.test((x.textContent||'').trim()));
    return s ? s.textContent.trim() : null;
  });
  // 读画框器百分比（BoxDrawerOverlay 顶栏第一个 /^\d+%$/）
  const drawerPct = () => page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('span'));
    const s = spans.find(x => /^\d+%$/.test((x.textContent||'').trim()) && !!x.closest('[class]'));
    // BoxDrawerOverlay 顶栏的 % span 在最顶层画框弹层（zIndex 3100 容器）内
    const overlay = Array.from(document.querySelectorAll('div')).find(d => getComputedStyle(d).position === 'fixed' && getComputedStyle(d).zIndex === '3100');
    if (overlay) {
      const s2 = Array.from(overlay.querySelectorAll('span')).find(x => /^\d+%$/.test((x.textContent||'').trim()));
      if (s2) return s2.textContent.trim();
    }
    return s ? s.textContent.trim() : null;
  });

  await clickByText('管理后台'); await page.waitForTimeout(2000);
  await clickByText('秸秆焚烧监控', { exact: false }); await page.waitForTimeout(4000);
  await clickByText('检测结果'); await page.waitForTimeout(3500);
  await clickByText('查看'); await page.waitForTimeout(5000);

  // ── 1) 点击左侧原图 → 打开 ImgViewer ──
  await page.evaluate(() => {
    const s = Array.from(document.querySelectorAll('span')).find(x => (x.textContent||'').includes('原图 · 未标注'));
    s && s.closest('div').click();
  });
  await page.waitForTimeout(2500);
  console.log('1) viewer opened, pct:', await viewerPct());
  await page.screenshot({ path: '/tmp/shot_zoom_viewer.png' });

  // ── 2) 点击工具条 ＋ 按钮 2 次缩放（替代 wheel，更可靠）──
  const plusClicked = async () => page.evaluate(() => {
    const stage = Array.from(document.querySelectorAll('div')).find(d => getComputedStyle(d).position === 'fixed' && getComputedStyle(d).zIndex === '3200');
    const plus = Array.from(stage.querySelectorAll('button')).find(b => (b.textContent||'').trim() === '＋');
    if (plus) { plus.click(); return true }
    return false;
  });
  await plusClicked(); await page.waitForTimeout(500);
  await plusClicked(); await page.waitForTimeout(500);
  console.log('2) after 2x + button, pct:', await viewerPct(), '(应 > 167%)');
  await page.screenshot({ path: '/tmp/shot_zoom_viewer_zoomed.png' });

  // ── 3) 查看器打开时按 1（父层"真烟"快捷键）→ 捕获阶段应拦截 ──
  await page.keyboard.press('1');
  await page.waitForTimeout(800);
  const stillViewer = await viewerPct() !== null;
  console.log('3) viewer still open after key 1 (拦截生效):', stillViewer);

  // ── 4) Esc 关闭查看器 → 详情弹层应仍在 ──
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  const detailAlive = await page.evaluate(() => document.body.innerText.includes('检测详情 · 复检工作台'));
  console.log('4) detail modal alive after viewer Esc:', detailAlive);
  await page.screenshot({ path: '/tmp/shot_zoom_back_detail.png' });

  // ── 5) 打开画框补标 → 缩放控制 + 验证 ──
  await clickByText('画框补标', { exact: false });
  await page.waitForTimeout(4500);
  const dp0 = await drawerPct();
  console.log('5) drawer open, pct:', dp0);
  // 点击画框器顶栏 ＋ 按钮 2 次
  const drawerPlusClicked = async () => page.evaluate(() => {
    const overlay = Array.from(document.querySelectorAll('div')).find(d => getComputedStyle(d).position === 'fixed' && getComputedStyle(d).zIndex === '3100');
    if (!overlay) return false;
    // 顶栏第一个 ＋ 按钮
    const plus = Array.from(overlay.querySelectorAll('button')).find(b => (b.textContent||'').trim() === '＋');
    if (plus) { plus.click(); return true }
    return false;
  });
  await drawerPlusClicked(); await page.waitForTimeout(500);
  await drawerPlusClicked(); await page.waitForTimeout(800);
  const dp1 = await drawerPct();
  console.log('6) after 2x drawer + button, pct:', dp1, '(应 > 100%)');
  await page.screenshot({ path: '/tmp/shot_zoom_drawer.png' });

  await browser.close();
  console.log('done');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
