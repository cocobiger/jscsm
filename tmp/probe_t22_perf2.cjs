// T22 性能探针 v2：修正滚动容器选择（找 scrollHeight 最大的 auto 容器）
const { chromium } = require('/opt/jsc/backend/pdf/node_modules/playwright-core')
const BASE = 'http://127.0.0.1:80/jsc/'
const CHROME = '/home/jsc/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'

async function login() {
  const r = await fetch('http://127.0.0.1:80/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) }).then(x => x.json())
  return r.token
}
async function findMoreBtn(page) {
  return page.evaluate(() => {
    const phs = [...document.querySelectorAll('div')].filter(d => /^实时告警/.test((d.textContent || '').trim().slice(0, 6)) && d.offsetParent)
    const ph = phs.find(d => (d.textContent || '').includes('更多') && !d.textContent.includes('大气'))
    if (!ph) return null
    const b = [...ph.querySelectorAll('button')].find(x => ((x.textContent || '').trim() === '更多' || (x.textContent || '').trim().startsWith('更多')) && x.offsetParent)
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })
}
;(async () => {
  const token = await login()
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('webapi.amap')) console.log('[console.error]', m.text().slice(0, 150)) })
  await page.route('**webapi.amap.com/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.evaluate(t => { localStorage.setItem('jsc:token', t); sessionStorage.clear() }, token)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4000)
  const more = await findMoreBtn(page)
  await page.mouse.click(more.x, more.y)
  await page.waitForTimeout(2500)

  // 切「已处理」tab → 等 React 渲染完成（用文本探测"导出CSV"出现 + 稳定）
  await page.evaluate(() => {
    const tabBtn = [...document.querySelectorAll('button')].find(b => b.offsetParent && (b.textContent || '').trim().startsWith('已处理'))
    if (tabBtn) tabBtn.click()
  })
  await page.waitForTimeout(1500)

  // ① 定位真实主列表容器：overflowY auto + scrollHeight 最大 + 高度显著
  const listInfo = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('div')]
      .filter(d => {
        const cs = getComputedStyle(d)
        return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && d.scrollHeight > d.clientHeight + 50 && d.offsetParent
      })
      .map(d => ({ sh: d.scrollHeight, ch: d.clientHeight, w: d.getBoundingClientRect().width, x: Math.round(d.getBoundingClientRect().x), y: Math.round(d.getBoundingClientRect().y) }))
      .sort((a, b) => b.sh - a.sh)
    return { count: candidates.length, top: candidates.slice(0, 5) }
  })
  console.log('LIST-CANDIDATES:', JSON.stringify(listInfo))

  // ② 滚动测试：对最大容器滚轮滚动 5s，测 FPS + scrollTop 推进
  const scrollPerf = await page.evaluate(async () => {
    const candidates = [...document.querySelectorAll('div')]
      .filter(d => {
        const cs = getComputedStyle(d)
        return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && d.scrollHeight > d.clientHeight + 50 && d.offsetParent
      })
      .sort((a, b) => b.scrollHeight - a.scrollHeight)
    if (!candidates.length) return { err: 'no big scroll container' }
    const list = candidates[0]
    const target = list.scrollHeight - list.clientHeight
    const start = performance.now()
    let lastFrameTime = start
    const frames = []
    let count = 0
    return new Promise(resolve => {
      function tick(t) {
        const dt = t - lastFrameTime
        lastFrameTime = t
        frames.push(dt)
        count++
        const elapsed = t - start
        if (elapsed < 5000) {
          // 模拟惯性滚轮：匀速推进 1000px 起步，每帧 +60px
          if (list.scrollTop < target) list.scrollTop = Math.min(target, list.scrollTop + 60)
          requestAnimationFrame(tick)
        } else {
          const drops = frames.filter(dt => dt > 33.3).length  // >30fps 的帧数
          const janks = frames.filter(dt => dt > 100).length   // >10fps 长卡顿
          resolve({
            containerScrollHeight: list.scrollHeight,
            containerClientHeight: list.clientHeight,
            scrollable: target,
            finalScrollTop: list.scrollTop,
            frames: count,
            avgFrameMs: frames.reduce((a, b) => a + b, 0) / frames.length,
            maxFrameMs: Math.max(...frames),
            fps: count / 5,
            over30msDrops: drops,
            over100msJanks: janks,
          })
        }
      }
      requestAnimationFrame(tick)
    })
  })
  console.log('SCROLL-5S:', JSON.stringify(scrollPerf))

  // ③ 渲染耗点：tab 切换重测——切回未处理再切已处理，测到列表首屏稳定（导出CSV 按钮文本在且列表行数稳定）
  const switchPerf = await page.evaluate(async () => {
    // 回未处理
    const pendBtn = [...document.querySelectorAll('button')].find(b => b.offsetParent && (b.textContent || '').trim().startsWith('未处理'))
    if (pendBtn) pendBtn.click()
    await new Promise(r => setTimeout(r, 300))
    // 切已处理并计时
    const t0 = performance.now()
    const hBtn = [...document.querySelectorAll('button')].find(b => b.offsetParent && (b.textContent || '').trim().startsWith('已处理'))
    hBtn.click()
    // 轮询直到 DOM 行数稳定（连续 3 次相同）或超时 6s
    let stableAt = -1
    let prev = -1
    let same = 0
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 100))
      const rows = document.querySelectorAll('div').length
      if (rows === prev) same++
      else same = 0
      prev = rows
      if (same >= 2) { stableAt = performance.now() - t0; break }
    }
    return { switchMs: stableAt > 0 ? Math.round(stableAt) : -1, domDivs: prev }
  })
  console.log('TAB-SWITCH:', JSON.stringify(switchPerf))

  await browser.close()
  process.exit(0)
})().catch(e => { console.error('ERR', e.message); process.exit(2) })
