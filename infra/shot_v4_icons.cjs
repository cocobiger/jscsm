// v4 图标改造视觉验证：管理后台 → 秸秆焚烧监控（Tab/链路/样式 三张截图）
const { chromium } = require('/opt/jsc/backend/pdf/node_modules/playwright-core');

(async () => {
  const token = process.argv[2];
  const exe = '/home/jsc/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.route('**webapi.amap.com**', r => r.abort());

  await page.goto('http://127.0.0.1/jsc/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.evaluate(t => localStorage.setItem('jsc:token', t), token);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);

  await page.getByText('管理后台').first().click().catch(e => console.log('admin btn:', e.message));
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: '秸秆焚烧监控' }).first().click().catch(e => console.log('straw nav:', e.message));
  await page.waitForTimeout(3000);
  await page.screenshot({ path: '/tmp/shot_v4icons_engine.png' });

  await page.getByText('运行链路全景').first().click().catch(e => console.log('tab pipeline:', e.message));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: '/tmp/shot_v4icons_pipeline.png' });

  await page.getByText('推送样式').first().click().catch(e => console.log('tab style:', e.message));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: '/tmp/shot_v4icons_style.png' });

  await browser.close();
  console.log('done');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
