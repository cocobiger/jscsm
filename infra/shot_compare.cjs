// 复检页 原图/标注图 并排比对 + 画框原图模式 视觉验证（精确匹配避开侧边栏误命中）
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

  // 找 button 助手：精确匹配（避开侧边栏"AI 检测复检"含"检测结果"误命中）
  const clickByText = async (text, opts = {}) => {
    const exact = opts.exact !== false;
    return await page.evaluate(({ text, exact }) => {
      const btns = Array.from(document.querySelectorAll('button'));
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      let target = null, targetText = '';
      for (const b of btns) {
        const t = norm(b.textContent);
        const match = exact ? t === text : t.includes(text);
        if (match) { target = b; targetText = t; break; }
      }
      if (!target) return { ok: false, reason: 'not found', text };
      target.scrollIntoView({ block: 'center' });
      target.click();
      return { ok: true, text: targetText };
    }, { text, exact });
  };

  console.log('admin:', JSON.stringify(await clickByText('管理后台')));
  await page.waitForTimeout(2000);

  console.log('straw:', JSON.stringify(await clickByText('秸秆焚烧监控', { exact: false })));
  await page.waitForTimeout(4000);

  console.log('tab results:', JSON.stringify(await clickByText('检测结果')));
  await page.waitForTimeout(3500); // 等列表 + 首屏图加载

  console.log('view first row:', JSON.stringify(await clickByText('查看')));
  await page.waitForTimeout(5000); // 等左右两张大图（原图 2942x1732 + 标注图）加载
  await page.screenshot({ path: '/tmp/shot_cmp_detail.png' });

  console.log('draw:', JSON.stringify(await clickByText('画框补标', { exact: false })));
  await page.waitForTimeout(4500); // 画布渲染全图
  await page.screenshot({ path: '/tmp/shot_cmp_draw_boxes.png' });

  console.log('hide boxes:', JSON.stringify(await clickByText('隐藏标注框', { exact: false })));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: '/tmp/shot_cmp_draw_orig.png' });

  await browser.close();
  console.log('done');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
