// P2 场景筛选视觉验证：默认列表（场景徽标列）→ 模拟流筛选 → 批量按钮
const { chromium } = require('/opt/jsc/backend/pdf/node_modules/playwright-core');

(async () => {
  const token = process.argv[2];
  const exe = '/home/jsc/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1600 } });
  await page.route('**webapi.amap.com**', r => r.abort());

  await page.goto('http://127.0.0.1/jsc/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.evaluate(t => localStorage.setItem('jsc:token', t), token);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);

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
  await page.waitForTimeout(4000); // 等列表渲染

  // 1) 默认列表：应能看到「场景」列徽标
  const sel = page.locator('select[title^="场景标签"]');
  console.log('场景下拉数量:', await sel.count());
  const optCount = await sel.first().locator('option').count();
  console.log('场景下拉 option 数:', optCount);
  await page.screenshot({ path: '/tmp/shot_p2_default.png' });

  // 2) 切「模拟流」筛选
  await sel.first().selectOption({ label: '🅼 模拟流' });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: '/tmp/shot_p2_sim.png' });

  // 3) 切「全部场景」+ 勾选前 2 行 → 批量按钮区
  await sel.first().selectOption({ label: '全部场景' });
  await page.waitForTimeout(2500);
  const checked = await page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll('input[type=checkbox]')).filter(b => b.offsetParent !== null);
    if (boxes.length >= 2) { boxes[0].click(); boxes[1].click(); return boxes.length; }
    return -1;
  });
  console.log('勾选复选框数:', checked);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: '/tmp/shot_p2_batch.png' });

  // 4) 徽标统计（当前列表页内各场景徽标出现次数）
  const badges = await page.evaluate(() => {
    const txt = document.body.innerText;
    const count = (s) => (txt.match(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    return { dock: count('🅳 机场期'), sim: count('🅼 模拟流'), night: count('🌙 夜间'), day: count('☀ 白天') };
  });
  console.log('徽标计数:', JSON.stringify(badges));

  await browser.close();
  console.log('done');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
