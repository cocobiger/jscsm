// 第二批验证：dock-guard 布防配置页 + 机场人员入侵告警高亮置顶
const pw = (() => {
  try { return require('/opt/jsc/backend/pdf/node_modules/playwright-core'); }
  catch (e) { return require('playwright-core'); }
})();
const { chromium } = pw;
const CHROME = '/home/jsc/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const TOKEN = process.argv[2];
const BASE = 'http://127.0.0.1:80/jsc/';

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
async function clickHas(page, text, opts = {}) {
  const r = await page.evaluate((t) => {
    const els = Array.from(document.querySelectorAll('button, a, [role=button], label, div[role=option], span'));
    const hit = els.find(el => el.textContent && el.textContent.includes(t) && el.offsetParent !== null && el.textContent.trim().length < 80);
    if (hit) { hit.click(); return { ok: true, tag: hit.tagName, txt: hit.textContent.slice(0, 40) }; }
    return { ok: false };
  }, text);
  if (!r.ok) throw new Error(`clickHas 未找到含「${text}」元素`);
  await page.waitForTimeout(opts.wait || 600);
  return r;
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1560, height: 980 } });
  const page = await ctx.newPage();
  await page.addInitScript((t) => localStorage.setItem('jsc:token', t), TOKEN);
  await page.route('**/*', r => {
    const u = r.request ? r.request().url() : r.url();
    if (u.includes('webapi.amap.com') || u.includes('api.map') || u.includes('tile') || u.includes('amap')) return r.abort();
    return r.continue();
  });

  const results = [];
  const ok = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });

  // ═══ A. 主屏告警高亮（先造一条 机场人员入侵 测试告警，由外部 curl 注入）═══
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000); // 等首轮告警加载

  // 断言告警面板出现「人员入侵」红色标签
  const guardTag = await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('span'));
    const hit = spans.find(s => s.textContent && s.textContent.includes('人员入侵') && s.offsetParent);
    if (!hit) return null;
    const color = getComputedStyle(hit).color;
    return { color, ok: true };
  });
  ok('A1. 人员入侵红色标签', guardTag && guardTag.ok, guardTag ? `color=${guardTag.color}` : '未找到');

  // 断言置顶：告警面板内首张 AI视频 告警卡 = 人员入侵
  const firstAiCard = await page.evaluate(() => {
    // 找到所有包含「AI视频」标签的卡片，取 DOM 顺序第一个（应为排序置顶的人员入侵）
    const cards = Array.from(document.querySelectorAll('div')).filter(d => {
      if (!d.offsetParent || d.textContent.trim().length < 20) return false;
      const spans = Array.from(d.querySelectorAll('span'));
      return spans.some(s => s.textContent && s.textContent.trim() === 'AI视频');
    });
    // 去嵌套：保留最外层卡片（不含其他 AI视频 卡片的祖先）
    const outer = cards.filter(d => !cards.some(o => o !== d && d.contains(o)));
    return outer.length ? outer[0].textContent.slice(0, 140) : null;
  });
  ok('A2. 告警首卡=人员入侵(置顶)', firstAiCard ? firstAiCard.includes('人员入侵') : false, firstAiCard ? firstAiCard.replace(/\s+/g, ' ').slice(0, 60) : '未找到 AI视频 卡');

  await page.screenshot({ path: '/tmp/dockguard_1_alert.png' });

  // ═══ B. 管理后台 → 机场布防页 ═══
  await clickExact(page, '管理后台', { wait: 1800 });
  await clickHas(page, '机场布防', { wait: 2200 });

  // 标题
  const titleOk = await page.evaluate(() =>
    Array.from(document.querySelectorAll('h2')).some(h => h.textContent && h.textContent.includes('机场人员入侵布防')));
  ok('B1. 布防页标题', titleOk);

  // 机场卡（≥4 路：name 输入框值含 "(" 或 "dock-"）
  const dockCards = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input[value]'));
    return inputs.filter(i => /\(|dock-|sikong_/.test(i.value || '')).length;
  });
  ok('B2. 机场配置卡', dockCards >= 4, `检测到 ${dockCards} 路`);

  // ROI SVG 画布（cursor:crosshair 在 style 属性）
  const svgCount = await page.evaluate(() =>
    Array.from(document.querySelectorAll('svg')).filter(s => (s.getAttribute('style') || '').includes('crosshair')).length);
  ok('B3. ROI 画布', svgCount >= 4, `${svgCount} 个画布`);

  // 布防状态条（等 status 轮询跑一次）
  await page.waitForTimeout(6000);
  const armed = await page.evaluate(() => document.body.textContent.includes('布防中'));
  ok('B4. 布防状态条', armed);

  await page.screenshot({ path: '/tmp/dockguard_2_page.png' });

  // 保存按钮存在
  const saveBtn = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button')).some(b => b.textContent && b.textContent.includes('保存并热重载')));
  ok('B5. 保存按钮', saveBtn);

  console.log(JSON.stringify(results, null, 1));
  const failed = results.filter(r => !r.pass);
  console.log(failed.length ? `✗ ${failed.length} 项失败` : '✓ 全部通过');
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e.message); process.exit(2); });
