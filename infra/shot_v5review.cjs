// v5 复核页改造验证：分页 / 筛选 / 弹层 / 快捷键 / 缩放 / localStorage 兼容
// 用法: node /tmp/shot_v5review.cjs
const pw = (() => {
  try { return require('/opt/jsc/backend/pdf/node_modules/playwright-core'); }
  catch (e) { return require('/opt/jsc/backend/poc/node_modules/playwright-core'); }
})();
const CHROME = '/home/jsc/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';

(async () => {
  const browser = await pw.chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const log = m => console.log(m);

  // v5review_data.json 外部请求 404 → 验证内嵌兜底；高德等外网拦截
  await page.route('**/*', r => {
    const u = (r.request ? r.request().url() : r.url()) || '';
    if (u.includes('v5review_data.json')) return r.fulfill({ status: 404, body: '' });
    if (u.includes('webapi.amap.com') || u.includes('api.map')) return r.abort();
    return r.continue();
  });

  await page.goto('http://127.0.0.1:81/v5review.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);   // 等 fetch 404 兜底 + init

  const read = sel => page.evaluate(s => { const el = document.querySelector(s); return el ? el.textContent.trim() : null; }, sel);
  const count = sel => page.evaluate(s => document.querySelectorAll(s).length, sel);
  const ovShow = () => page.evaluate(() => document.getElementById('ov').classList.contains('show'));

  // 1) 分页
  log('1) 分页信息: ' + (await read('.pg-info')));                    // 期望: 共 41 帧 · 5 页
  log('2) 首页卡片数: ' + (await count('#cards .card')));             // 期望: 10
  log('3) 页码按钮数: ' + (await count('#pager .pg')));               // 期望: 7（上一页+5页+下一页）
  log('4) 首页待复核标记: ' + (await count('#cards .badge.todo')));   // 期望: 10（全未复核）

  // 2) 筛选下拉
  await page.selectOption('#fStatus', 'todo');
  await page.waitForTimeout(350);
  log('5) 只看未复核: ' + (await read('#filterInfo')));
  await page.selectOption('#fScene', 'night');
  await page.waitForTimeout(350);
  log('6) 夜场筛选: ' + (await read('#filterInfo')));
  await page.selectOption('#fScene', 'all');
  await page.selectOption('#fStatus', 'all');
  await page.waitForTimeout(350);

  // 3) 弹层打开
  await page.evaluate(() => { document.querySelector('#cards .card .shot').click(); });
  await page.waitForTimeout(500);
  log('7) 弹层打开: ' + (await ovShow()));
  log('8) 弹层 cap: ' + (await read('#ovCap')));
  await page.screenshot({ path: '/tmp/v5_ov_open.png' });

  // 4) 快捷键 1 判定有烟 → 自动下一张
  await page.keyboard.press('1');
  await page.waitForTimeout(400);
  log('9) 判定后有烟高亮: ' + (await page.evaluate(() => document.getElementById('ovJsmoke').classList.contains('on'))));
  log('10) 自动下一张 cap: ' + (await read('#ovCap')));

  // 5) 滚轮缩放（以鼠标为中心）
  const stage = await page.$('#ovStage');
  const box = await stage.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(300);
  log('11) 滚轮缩放后: ' + (await read('#ovZoom')));
  await page.screenshot({ path: '/tmp/v5_ov_zoom.png' });

  // 6) ←/→ 相邻帧
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300);
  log('12) → 相邻帧 cap: ' + (await read('#ovCap')));

  // 7) Esc 关闭
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  log('13) Esc 关闭弹层: ' + (!(await ovShow())));
  log('14) 首页有烟选中卡: ' + (await count('#cards .card .btn.smoke.on')));  // 已复核的沉底，首页应显示"有烟"选中卡片
  await page.screenshot({ path: '/tmp/v5_back_list.png' });

  // 8) 页码跳转第 2 页
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#pager .pg')];
    const b = btns.find(x => x.textContent.trim() === '2');
    if (b) b.click();
  });
  await page.waitForTimeout(400);
  log('15) 第 2 页: ' + (await read('#filterInfo')));

  // 9) 弹层判定 no
  await page.evaluate(() => { document.querySelector('#cards .card .shot').click(); });
  await page.waitForTimeout(400);
  await page.keyboard.press('2');
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // 10) localStorage 持久化 + 刷新保留
  const nSaved = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('v5review_v1') || '{}')).length);
  log('16) localStorage 记录: ' + nSaved);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  log('17) 刷新后已复核: ' + (await read('#sDone')));
  log('18) 刷新后有烟/无烟: ' + (await read('#sSmoke')) + ' / ' + (await read('#sNo')));

  // 11) 批量判定按钮（本页全标有烟）— 弹窗确认自动接受
  page.once('dialog', d => d.accept());
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.tools .btn2')];
    const b = btns.find(x => x.textContent.includes('本页全标有烟'));
    if (b) b.click();
  });
  await page.waitForTimeout(400);
  log('19) 批量后有烟数: ' + (await read('#sSmoke')));

  await browser.close();
  console.log('=== ALL DONE ===');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
