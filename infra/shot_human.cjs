// v5 复检页人性化改造验证：批量/自动下一张/页码跳转/排序/统计卡联动/流筛选/低置信度/键盘导航/撤销
const pw = (() => {
  try { return require('/opt/jsc/backend/pdf/node_modules/playwright-core'); }
  catch (e) { return require('playwright-core'); }
})();
const { chromium } = pw;
const CHROME = '/home/jsc/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const TOKEN = process.argv[2];
const BASE = 'http://127.0.0.1:80/jsc/';

// 精确文本点击（避开侧边栏可访问名称含完整 desc 的误命中）
async function clickExact(page, text, opts = {}) {
  const r = await page.evaluate((t) => {
    const els = Array.from(document.querySelectorAll('button, a, [role=button], .tab, [class*=tab]'));
    const hit = els.find(el => el.textContent && el.textContent.trim() === t);
    if (hit) { hit.click(); return { ok: true, tag: hit.tagName }; }
    return { ok: false, total: els.length };
  }, text);
  if (!r.ok) throw new Error(`clickExact 未找到「${text}」(共 ${r.total} 个候选)`);
  await page.waitForTimeout(opts.wait || 600);
  return r;
}

// 文本包含点击
async function clickHas(page, text, opts = {}) {
  const r = await page.evaluate((t) => {
    const els = Array.from(document.querySelectorAll('button, a, [role=button], label, div[role=option]'));
    const hit = els.find(el => el.textContent && el.textContent.includes(t) && el.offsetParent !== null);
    if (hit) { hit.click(); return { ok: true, tag: hit.tagName, txt: hit.textContent.slice(0, 40) }; }
    return { ok: false };
  }, text);
  if (!r.ok) throw new Error(`clickHas 未找到含「${text}」元素`);
  await page.waitForTimeout(opts.wait || 600);
  return r;
}

// 按精确文本点 div/span（统计卡等非按钮元素）
async function clickText(page, text, opts = {}) {
  const r = await page.evaluate((t) => {
    const els = Array.from(document.querySelectorAll('div, span')).filter(el => el.textContent && el.textContent.trim() === t && el.offsetParent !== null);
    if (els.length) { els[0].click(); return { ok: true, n: els.length }; }
    return { ok: false };
  }, text);
  if (!r.ok) throw new Error(`clickText 未找到「${text}」`);
  await page.waitForTimeout(opts.wait || 600);
  return r;
}

// 选中 select 的 option（value 匹配）
async function selectValue(page, value, opts = {}) {
  const r = await page.evaluate((v) => {
    const sels = Array.from(document.querySelectorAll('select'));
    const hit = sels.find(s => Array.from(s.options).some(o => o.value === v));
    if (!hit) return { ok: false, count: sels.length };
    hit.value = v;
    hit.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, options: hit.options.length };
  }, value);
  if (!r.ok) throw new Error(`selectValue 未找到 value=${value} (共 ${r.count} 个 select)`);
  await page.waitForTimeout(opts.wait || 900);
  return r;
}

// 按 option 文本选中 select（避开同名 value 的干扰，如 0.5 同时存在于下限/上限）
async function selectByText(page, optText, opts = {}) {
  const r = await page.evaluate((t) => {
    const sels = Array.from(document.querySelectorAll('select'));
    const hit = sels.find(s => Array.from(s.options).some(o => o.textContent.trim() === t));
    if (!hit) return { ok: false, count: sels.length };
    const opt = Array.from(hit.options).find(o => o.textContent.trim() === t);
    hit.value = opt.value;
    hit.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, val: opt.value };
  }, optText);
  if (!r.ok) throw new Error(`selectByText 未找到选项「${optText}」(共 ${r.count} 个 select)`);
  await page.waitForTimeout(opts.wait || 900);
  return r;
}

// 读弹层"时间"行值（DetailModal 检测信息区，每帧唯一）
async function readModalSrc(page) {
  return page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('span'));
    const k = spans.find(s => s.textContent && s.textContent.trim() === '时间');
    if (k && k.parentElement) {
      const vals = Array.from(k.parentElement.querySelectorAll('span'));
      return vals.length > 1 ? vals[1].textContent.trim().slice(0, 60) : '?';
    }
    return '?';
  });
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1560, height: 980 } });
  const page = await ctx.newPage();
  await page.addInitScript((t) => {
    localStorage.setItem('jsc:token', t);
  }, TOKEN);
  // 拦截外网地图
  await page.route('**/*', r => {
    const u = r.request ? r.request().url() : r.url();
    if (u.includes('webapi.amap.com') || u.includes('api.map') || u.includes('tile')) return r.abort();
    return r.continue();
  });

  const results = [];
  const ok = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2800);

  // 1. 进入 管理后台 → 秸秆焚烧监控
  await clickExact(page, '管理后台', { wait: 1800 });
  await clickHas(page, '秸秆焚烧监控', { wait: 1800 });
  // 2. 切到 检测结果 tab（严格匹配）
  await clickExact(page, '检测结果', { wait: 2200 });
  ok('1. 进入检测结果页', await page.locator('text=检测帧总数').count() > 0);

  // 3. 统计卡存在 7 张 + 可点击
  const statCount = await page.evaluate(() => Array.from(document.querySelectorAll('div')).filter(d => d.textContent === '待复检' && d.offsetParent).length);
  ok('2. 统计卡渲染', statCount > 0);
  await page.screenshot({ path: '/tmp/human_1_list.png' });

  // 4. 勾选前两行 checkbox → 批量操作栏出现
  await page.evaluate(() => {
    const cbs = Array.from(document.querySelectorAll('tbody input[type=checkbox]'));
    if (cbs.length >= 2) { cbs[0].click(); cbs[1].click(); }
  });
  await page.waitForTimeout(500);
  const batchBar = await page.evaluate(() => Array.from(document.querySelectorAll('button')).some(b => b.textContent && b.textContent.includes('批量真烟')));
  ok('3. 勾选行 → 批量栏出现', batchBar);

  // 5. 点批量误报 → 确认弹窗
  await clickHas(page, '批量误报', { wait: 500 });
  const confirmDlg = await page.evaluate(() => Array.from(document.querySelectorAll('div')).some(d => d.textContent && d.textContent.includes('批量确认')));
  ok('4. 批量确认弹窗', confirmDlg);
  await page.screenshot({ path: '/tmp/human_2_batch_confirm.png' });
  // 6. 取消（不真改数据）
  await clickExact(page, '取消', { wait: 500 });
  await clickHas(page, '清空选择', { wait: 500 });

  // 7. 统计卡联动：点「待复检」卡 → 筛选生效（状态 select 值变 pending）
  await clickText(page, '待复检', { wait: 1600 });
  const fStatusVal = await page.evaluate(() => {
    const sels = Array.from(document.querySelectorAll('select'));
    const st = sels.find(s => Array.from(s.options).some(o => o.value === 'pending'));
    return st ? st.value : null;
  });
  ok('5. 统计卡联动筛选', fStatusVal === 'pending');

  // 8. 排序：待复核优先
  await selectValue(page, 'pending');
  await page.waitForTimeout(1600);
  const firstStatus = await page.evaluate(() => {
    const tds = Array.from(document.querySelectorAll('tbody tr td:nth-child(8)'));
    return tds.length ? tds[0].textContent.trim() : '';
  });
  ok('6. 排序=待复核优先', firstStatus.includes('待复检'), `首行=${firstStatus}`);

  // 9. 页码跳转：原生 setter 输入 2 → 跳转
  await page.evaluate(() => {
    const inp = Array.from(document.querySelectorAll('input')).find(i => i.placeholder === '页码');
    if (inp) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, '2');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await clickHas(page, '跳转', { wait: 1600 });
  const pageInfo = await page.evaluate(() => document.body.textContent.match(/第\s*2\s*\/\s*\d+\s*页/));
  ok('7. 页码跳转第2页', !!pageInfo, pageInfo ? pageInfo[0] : '未找到');

  // 10. 清除状态筛选回全部（避免影响后续）
  await selectValue(page, '');
  await page.waitForTimeout(1400);

  // 11. 行内「稍后」按钮存在
  const laterBtn = await page.evaluate(() => Array.from(document.querySelectorAll('tbody button')).some(b => b.textContent && b.textContent.trim() === '稍后'));
  ok('8. 行内稍后按钮', laterBtn);

  // 12. 打开详情 → 快捷键 2 判定 → 自动跳下一张（弹层"来源"值变化 或 本页完成关闭）
  const openDetail = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('tbody button')).find(b => b.textContent && b.textContent.trim() === '查看');
    if (btn) { btn.click(); return true; }
    return false;
  });
  await page.waitForTimeout(1200);
  const src1 = await readModalSrc(page);
  // 按 2（误报）→ 判定成功 → 应自动跳下一张
  await page.keyboard.press('2');
  await page.waitForTimeout(1600);
  const modalOpen = await page.evaluate(() => document.body.textContent.includes('复检操作'));
  const src2 = await readModalSrc(page);
  ok('9. 判定后自动下一张', src1 !== src2 && src1 !== '?' && src2 !== '?', `${src1} → ${src2} (open=${modalOpen})`);
  await page.screenshot({ path: '/tmp/human_3_advance.png' });
  // Esc 关闭
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);

  // 13. 键盘导航：ArrowDown 高亮第一行 → Enter 打开详情
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(300);
  const hl = await page.evaluate(() => {
    const tr = document.querySelector('tr[style*="background"]') || document.querySelector('tr[id^="straw-row"]');
    return tr ? (tr.id || 'styled') : 'none';
  });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);
  const dlgOpen = await page.evaluate(() => document.body.textContent.includes('复检操作'));
  ok('10. 键盘导航 ↑↓+Enter', hl !== 'none' && dlgOpen, `hl=${hl}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);

  // 14. 撤销按钮（已判定行）
  const undoBtn = await page.evaluate(() => Array.from(document.querySelectorAll('tbody button')).some(b => b.textContent && b.textContent.trim() === '↩'));
  ok('11. 行内撤销按钮', undoBtn);

  // 15. 筛选记忆：设置 低置信度上限 <0.50 → localStorage 持久化
  await selectByText(page, '只看 <0.50');
  await page.waitForTimeout(1400);
  const lsSaved = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('jsc_straw_filters_v1') || '{}'); } catch { return {}; }
  });
  ok('12. 筛选记忆持久化', lsSaved.fMaxConf === '0.5', JSON.stringify(lsSaved).slice(0, 120));

  // 16. 流筛选下拉渲染
  const streamSel = await page.evaluate(() => {
    const sels = Array.from(document.querySelectorAll('select'));
    const s = sels.find(x => Array.from(x.options).some(o => o.textContent.includes('全部流')));
    return s ? s.options.length : 0;
  });
  ok('13. 流筛选下拉', streamSel > 1, `${streamSel} 项`);

  // 17. 批量真烟真实执行（选 1 行 → 批量 → 确认）
  await selectValue(page, ''); // 恢复
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const cb = document.querySelector('tbody input[type=checkbox]');
    if (cb) cb.click();
  });
  await page.waitForTimeout(400);
  await clickHas(page, '批量真烟', { wait: 500 });
  await clickHas(page, '确认批量', { wait: 2200 });
  const batchDone = await page.evaluate(() => document.body.textContent.includes('批量 1/1 条'));
  ok('14. 批量真烟执行', batchDone);

  await page.screenshot({ path: '/tmp/human_4_final.png' });

  console.log('\n========== 验证结果 ==========');
  let pass = 0;
  for (const r of results) {
    console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.extra ? '  [' + r.extra + ']' : ''}`);
    if (r.pass) pass++;
  }
  console.log(`========== ${pass}/${results.length} 通过 ==========`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error('脚本错误:', e.message); process.exit(2); });
