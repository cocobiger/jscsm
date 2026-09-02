// 无人机回传弹窗 v2 无头验收：SSE 广播→弹窗≤2→满窗折叠最新入队→队列点击拉起(折叠最新打开)→收起→提示音开关持久化
// v2 语义（dronePopupModel 纯状态机，弃 popupPromote）：
//   满窗(2)新 LIVE_ON → 折叠「最新打开窗口」入队腾位，新事件上窗（窗仍 2、队 +1）
//   队列点击 → 满窗时折叠「最新打开窗口」并打开所点项（不再是旧版「替换最旧」）
// 用法（服务器上执行）: node /tmp/shot_dronepopup.cjs <token>
const pw = (() => {
  try { return require('/opt/jsc/backend/pdf/node_modules/playwright-core'); }
  catch (e) { return require('playwright-core'); }
})();
const { chromium } = pw;
const CHROME = '/home/jsc/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const TOKEN = process.argv[2];
const BASE = 'http://127.0.0.1:80/jsc/';
const INGEST = 'http://127.0.0.1:7170/api/drone-events/ingest';
const BRIDGE_KEY = 'jsc-drone-bridge-2026';

// 真实白名单内机场 + 无人机（4 机场已配白名单；用其中 3 组做验收）
const FLIGHTS = [
  { deviceSn: '1581F8HGX258600A0S4G', dockSn: '8UUXN8N00A0LS7', name: '三峡科技大学机场' }, // A
  { deviceSn: '1581F8HGX253U00A064U', dockSn: '8UUXN7G00A0FDP', name: '环保局机场' },        // B
  { deviceSn: '1581F8HGX258600A0S4J', dockSn: '8UUXN8P00A0LZ4', name: '职教中心机场' },      // C
];

let evtSeq = 0;
async function ingest(deviceSn, dockSn, status) {
  evtSeq++;
  const eventId = `t2test_${Date.now()}_${evtSeq}`;
  const r = await fetch(INGEST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-drone-bridge-key': BRIDGE_KEY },
    body: JSON.stringify({ eventId, deviceSn, dockSn, status, changeReason: status === 'LIVE_ON' ? 'STARTED' : 'STOPPED', eventTime: Date.now() }),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1560, height: 980 } });
  const page = await ctx.newPage();
  await page.addInitScript((t) => localStorage.setItem('jsc:token', t), TOKEN);
  await page.route('**/*', r => {
    const u = r.request ? r.request().url() : r.url();
    if (u.includes('webapi.amap.com') || u.includes('api.map') || u.includes('tile') || u.includes('amap') || u.includes('googleapis')) return r.abort();
    return r.continue();
  });

  const results = [];
  const ok = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });
  const shot = (n) => page.screenshot({ path: `/tmp/dronepopup_${n}.png` });

  // 统计口径：窗口 = 「收起至队列」按钮数（每个弹窗 1 个 ✕）；排队数 = 角标按钮文字（展开/收起态都包含 "⏸ 排队 N"）
  const winCount = () => page.evaluate(() =>
    Array.from(document.querySelectorAll('button')).filter(b => (b.title || '').startsWith('收起至队列')).length);
  const queueCount = () => page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('排队') && (b.textContent || '').match(/⏸/));
    if (!b) return 0;
    const m = (b.textContent || '').match(/排队\s*(\d+)/);
    return m ? Number(m[1]) : 0;
  });
  const soundBtn = () => page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(b => (b.title || '').startsWith('声音提示'));
    return b ? { title: b.title, text: b.textContent.trim() } : null;
  });
  const queuedCardTitle = () => page.evaluate(() => {
    const d = Array.from(document.querySelectorAll('div')).find(d => (d.title || '').startsWith('点击拉起播放'));
    return d ? d.textContent.replace(/\s+/g, ' ').slice(0, 40) : null;
  });
  const waitWin = (n, ms = 20000) => page.waitForFunction((x) =>
    Array.from(document.querySelectorAll('button')).filter(b => (b.title || '').startsWith('收起至队列')).length === x, n, { timeout: ms });
  const waitBadge = (n, ms = 15000) => page.waitForFunction((x) => {
    const b = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('⏸') && (b.textContent || '').includes('排队'));
    if (!b) return x === 0;
    const m = (b.textContent || '').match(/排队\s*(\d+)/);
    return m ? Number(m[1]) === x : x === 0;
  }, n, { timeout: ms });
  const clickByTitle = (prefix) => page.evaluate((p) => {
    const b = Array.from(document.querySelectorAll('button, div')).find(el => (el.title || '').startsWith(p) && el.offsetParent !== null);
    if (!b) return false;
    (b.closest('button') || b).click();
    return true;
  }, prefix);

  try {
    // ═══ 1. 驾驶舱加载 + 弹窗宿主挂载（提示音开关按钮出现）═══
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('button')).some(b => (b.title || '').startsWith('声音提示')), null, { timeout: 40000 });
    ok('1. 弹窗宿主挂载(提示音按钮)', true);
    // SSE 连接建立需要数百 ms（后端日志实测 ~280ms 竞态窗口），先等 SSE 就绪再注入，避免事件先于连接广播而丢失
    await page.waitForTimeout(2500);

    // ═══ 2. 白名单机场 A 起飞 → 1 个弹窗 ═══
    const a1 = await ingest(FLIGHTS[0].deviceSn, FLIGHTS[0].dockSn, 'LIVE_ON');
    ok('2a. ingest A 入库广播', a1.ok && a1.broadcast, `id=${a1.id} zlm=${a1.zlm_online}`);
    await waitWin(1);
    ok('2b. A 弹窗出现', (await winCount()) === 1);

    // ═══ 3. B 起飞 → 2 个弹窗（上限内）═══
    await ingest(FLIGHTS[1].deviceSn, FLIGHTS[1].dockSn, 'LIVE_ON');
    await waitWin(2);
    ok('3. 同屏 2 弹窗(上限)', (await winCount()) === 2);
    await shot('1_two_windows');

    // ═══ 4. C 起飞 → 满窗(2) → 折叠「最新打开」B 入队，C 上窗（窗口仍 2、队列 1）═══
    await ingest(FLIGHTS[2].deviceSn, FLIGHTS[2].dockSn, 'LIVE_ON');
    await page.waitForTimeout(1500);
    ok('4a. 窗口不超 2', (await winCount()) === 2);
    await waitBadge(1);
    ok('4b. 满窗折叠最新(B)入队(⏸ 排队 1)', (await queueCount()) === 1);
    await shot('2_queue_badge');

    // ═══ 5. 展开队列 → 缩略图卡片 ═══
    await clickByTitle('展开队列');
    await page.waitForTimeout(900);
    const qTitle = await queuedCardTitle();
    ok('5. 队列缩略图卡片', !!qTitle, qTitle || '');
    await shot('3_queue_open');

    // ═══ 6. 点队列卡片拉起 B（满窗 → 折叠「最新打开」C 入队，B 上窗）═══
    await clickByTitle('点击拉起播放');
    await page.waitForTimeout(1200);
    ok('6a. 拉起后仍 ≤2 窗口', (await winCount()) === 2);
    await waitBadge(1);
    // v2 语义：被折叠的是「最新打开窗口」= C（职教中心机场，dockSn 前缀 8UUXN8P0），不是最旧 A
    const qTitle2 = await queuedCardTitle();
    const dockC = FLIGHTS[2].dockSn.slice(0, 8); // "8UUXN8P0"
    ok('6b. 最新打开(C)被折叠回队列', qTitle2 && qTitle2.includes(dockC), qTitle2 ? qTitle2 : '队列卡片为空');
    await shot('4_after_click_queue');

    // ═══ 7. 手动收起一个窗口（×）→ 进队列 ═══
    await clickByTitle('收起至队列');
    await page.waitForTimeout(1000);
    ok('7a. 收起后窗口=1', (await winCount()) === 1);
    await waitBadge(2);
    ok('7b. 队列=2(收起非销毁)', (await queueCount()) === 2);
    await shot('5_after_fold');

    // ═══ 8. 提示音开关 → localStorage 持久化 → 刷新仍生效 ═══
    const sb0 = await soundBtn();
    ok('8a. 初始提示音开', sb0 && sb0.text.includes('🔊'), sb0 ? sb0.text : '');
    await clickByTitle('声音提示');
    await page.waitForTimeout(400);
    const sb1 = await soundBtn();
    const ls = await page.evaluate(() => localStorage.getItem('jsc:drone-popup-sound'));
    ok('8b. 点击后静音+落盘', sb1 && sb1.text.includes('🔇') && ls === 'off', `text=${sb1 && sb1.text} ls=${ls}`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('button')).some(b => (b.title || '').startsWith('声音提示')), null, { timeout: 40000 });
    await page.waitForTimeout(800);
    const sb2 = await soundBtn();
    ok('8c. 刷新后持久化(仍静音)', sb2 && sb2.text.includes('🔇'), sb2 ? sb2.text : '');
    ok('8d. 刷新后无残留弹窗(仅回灌在线镜像)', (await winCount()) === 0, `win=${await winCount()}`);
    await shot('6_sound_off_reload');

    // ── 清理：LIVE_OFF 三路（避免最新事件停留在 LIVE_ON）──
    const offs = [];
    for (const f of FLIGHTS) offs.push(await ingest(f.deviceSn, f.dockSn, 'LIVE_OFF'));

    console.log(JSON.stringify(results, null, 1));
    const failed = results.filter(r => !r.pass);
    console.log(failed.length ? `✗ ${failed.length} 项失败: ${failed.map(f => f.name).join(', ')}` : '✓ 全部通过');
    console.log('cleanup LIVE_OFF:', offs.map(o => `${o.status}${o.ok ? '' : ':' + (o.error || '')}`).join(' | '));
    await browser.close();
    process.exit(failed.length ? 1 : 0);
  } catch (e) {
    console.error('脚本异常:', e.message);
    for (const f of FLIGHTS) { try { await ingest(f.deviceSn, f.dockSn, 'LIVE_OFF'); } catch {} }
    try { await shot('err'); } catch {}
    await browser.close();
    process.exit(2);
  }
})().catch(e => { console.error('致命异常:', e.message); process.exit(3); });
