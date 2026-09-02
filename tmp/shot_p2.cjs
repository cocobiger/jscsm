// P2 T16-T18 验收：聚合行「研判依据」→ EvidenceModal 误报归因 → 无整页刷新 → 归因徽标 → 单行证据大图
// 前置：已插入 p2test-0902-01..05 pending（同组触发聚合折叠）
const { chromium } = require('/opt/jsc/backend/pdf/node_modules/playwright-core')
const BASE = 'http://127.0.0.1:80/jsc/'
const CHROME = '/home/jsc/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'
const LOGIN_URL = 'http://127.0.0.1:80/api/auth/login'
const SHOT1 = '/tmp/p2_agg_row.png'
const SHOT2 = '/tmp/p2_evidence_false.png'
const SHOT3 = '/tmp/p2_badge_and_viewer.png'

async function login() {
  const r = await fetch(LOGIN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) }).then(x => x.json())
  if (!r.token) throw new Error('login failed')
  return r.token
}
// 找文本含某关键字的可见按钮坐标（可选第 N 个匹配）
async function btnXY(page, keyword, nth = 0) {
  return page.evaluate(([kw, n]) => {
    const bs = [...document.querySelectorAll('button')].filter(b => b.offsetParent && (b.textContent || '').includes(kw))
    const b = bs[n] || bs[bs.length - 1]
    if (!b) return null
    b.scrollIntoView({ block: 'center' })
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  }, [keyword, nth])
}
// 找文本含关键字的可见元素文本（含/不含某字）
async function hasText(page, kw) {
  return page.evaluate(k => {
    const el = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && (e.textContent || '').includes(k) && e.offsetParent)
    return el ? el.textContent.trim().slice(0, 80) : null
  }, kw)
}
async function findAggRowBtn(page, kw, btnText) {
  return page.evaluate(([k, bt]) => {
    const rows = [...document.querySelectorAll('div')].filter(d => (d.textContent || '').includes(k) && d.offsetParent)
    let hit = null
    for (const r of rows) {
      const b = [...r.querySelectorAll('button')].find(x => (x.textContent || '').includes(bt) && x.offsetParent)
      if (b) { hit = b; break }
    }
    if (!hit) return null
    hit.scrollIntoView({ block: 'center' })
    const rect = hit.getBoundingClientRect()
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
  }, [kw, btnText])
}
async function findMoreBtn(page) {
  return page.evaluate(() => {
    const bs = [...document.querySelectorAll('button')].filter(b => (b.textContent || '').trim() === '更多' && b.offsetParent)
    const hit = bs.find(b => {
      let n = b.parentElement
      for (let i = 0; i < 4 && n; i++) {
        const t = (n.textContent || '').trim()
        if (/^实时告警\s*\d+/.test(t) && !t.includes('大气')) return true
        n = n.parentElement
      }
      return false
    })
    if (!hit) return null
    hit.scrollIntoView({ block: 'center' })
    const rect = hit.getBoundingClientRect()
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
  })
}
const clickXY = (page, pt) => page.mouse.click(pt.x, pt.y)

;(async () => {
  const token = await login()
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
  page.on('pageerror', e => console.log('[pageerror]', e.message.slice(0, 200)))
  page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)) })
  await page.route('**webapi.amap.com/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
  const reloads = []
  page.on('framenavigated', f => { if (f === page.mainFrame()) reloads.push(Date.now()) })

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.evaluate(t => localStorage.setItem('jsc:token', t), token)
  await page.evaluate(() => { window.__p2marker = 'alive' })  // 在 reload 前注入会丢——reload 后再设
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6500)
  await page.evaluate(() => { window.__p2marker = 'alive' })
  reloads.length = 0  // 忽略前面加载帧

  const more = await findMoreBtn(page)
  console.log('MORE:', JSON.stringify(more))
  if (!more) throw new Error('更多按钮未找到')
  await clickXY(page, more)
  await page.waitForTimeout(5500)

  // ① 聚合行存在 + 研判依据按钮
  const jyBtn = await findAggRowBtn(page, 'P2验收测试类型', '研判依据')
  console.log('AGG-JY-BTN:', JSON.stringify(jyBtn))
  if (!jyBtn) { await page.screenshot({ path: '/tmp/p2_debug_nolist.png' }); throw new Error('聚合行/研判依据按钮未找到（debug 截图已存）') }
  await page.screenshot({ path: SHOT1 })
  console.log('SHOT1(agg row):', SHOT1)

  // ② 打开研判依据弹窗
  await clickXY(page, jyBtn)
  await page.waitForTimeout(1800)
  const evTitle = await hasText(page, '事件研判逻辑')
  console.log('EVIDENCE-TITLE:', JSON.stringify(evTitle))
  const evValidBtn = await btnXY(page, '有效')
  console.log('VALID-BTN:', JSON.stringify(evValidBtn))
  const evFalseBtn = await btnXY(page, '误报')
  console.log('FALSE-BTN:', JSON.stringify(evFalseBtn))
  if (!evValidBtn || !evFalseBtn) throw new Error('EvidenceModal 处置按钮缺失')

  // ③ 误报归因：点「❌ 误报 · 标记」→ 面板（晨雾默认）→ 确认
  const falseBtn2 = await btnXY(page, '误报 · 标记')
  await clickXY(page, falseBtn2)
  await page.waitForTimeout(600)
  const panelTitle = await hasText(page, '误报归因')
  console.log('FALSE-PANEL:', JSON.stringify(panelTitle))
  if (!panelTitle) throw new Error('误报归因面板未出现')
  const confirmBtn = await btnXY(page, '确认误报')
  await clickXY(page, confirmBtn)
  await page.waitForTimeout(2500)

  // ④ 断言：处置成功消息 + 弹窗保持打开 + 无整页刷新
  const msg = await hasText(page, '已标记处置')
  console.log('HANDLE-MSG:', JSON.stringify(msg))
  const stillOpen = await hasText(page, '事件研判逻辑')
  console.log('MODAL-STILL-OPEN:', JSON.stringify(stillOpen))
  const marker = await page.evaluate(() => window.__p2marker)
  console.log('RELOAD-MARKER:', marker, 'framenavigated:', reloads.length)
  await page.screenshot({ path: SHOT2 })
  console.log('SHOT2(false reason):', SHOT2)

  // ⑤ 关闭 EvidenceModal → 聚合行应已从列表消失（refresh 重拉）
  const closeBtns = await page.evaluate(() => {
    const bs = [...document.querySelectorAll('button')].filter(b => b.offsetParent && (b.textContent || '').trim() === '×')
    const last = bs[bs.length - 1]
    if (!last) return null
    const r = last.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })
  if (closeBtns) await clickXY(page, closeBtns)
  await page.waitForTimeout(3000)
  const aggGone = await page.evaluate(k => ![...document.querySelectorAll('*')].some(e => e.children.length === 0 && (e.textContent || '').includes(k) && e.offsetParent), 'P2验收测试类型')
  console.log('AGG-GONE-AFTER-HANDLE:', aggGone)

  // ⑥ 切「已处理」→ 归因徽标 + 证据按钮
  const handledTab = await btnXY(page, '已处理', 0)
  if (handledTab) await clickXY(page, handledTab)
  await page.waitForTimeout(2500)
  const badgeText = await page.evaluate(() => {
    const els = [...document.querySelectorAll('span')].filter(e => e.offsetParent && (e.textContent || '').includes('误报') && (e.textContent || '').length < 20)
    return els.map(e => e.textContent.trim()).slice(0, 5)
  })
  console.log('BADGES:', JSON.stringify(badgeText))
  const hasBadge = badgeText.some(t => t.includes('误报·晨雾'))
  // 找 p2test 行内的「证据」按钮
  const eviBtn = await findAggRowBtn(page, 'P2验收测试类型', '证据')
  console.log('EVI-BTN(handled row):', JSON.stringify(eviBtn))
  if (eviBtn) {
    await clickXY(page, eviBtn)
    await page.waitForTimeout(2200)
    const viewerOpen = await hasText(page, '置信度')
    console.log('VIEWER-OPEN:', JSON.stringify(viewerOpen))
    await page.screenshot({ path: SHOT3 })
    console.log('SHOT3(badge+viewer):', SHOT3)
  }
  const ok = msg && stillOpen && marker === 'alive' && reloads.length === 0 && aggGone && hasBadge
  console.log('RESULT:', ok ? 'PASS' : 'FAIL', JSON.stringify({ msg: !!msg, stillOpen: !!stillOpen, marker, navCount: reloads.length, aggGone, hasBadge }))
  await browser.close()
  process.exit(ok ? 0 : 1)
})().catch(e => { console.error('ERR', e.message); process.exit(2) })
