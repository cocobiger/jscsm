// ============================================================================
// 图片故障修复验收（2026-09-03 批1+批2+批3 部署后复测）
// 统计: 实时告警面板可见 img 元素加载结果 imgOk/imgFail + 失败分类 + X-Img-Source 分布
//       evidence 相对路径直链验证（straw 证据图不再 400）
// 用法: scp 到 root@111.10.220.226:/tmp/ 后按 skill 铁律执行
// ============================================================================
const { chromium } = require('playwright-core')

const BASE = 'http://127.0.0.1:80/jsc/'
const CHROME = '/home/jsc/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'
const LOGIN_URL = 'http://127.0.0.1:80/api/auth/login'
const SHOT = '/tmp/pic_diag_after.png'

async function login() {
  const r = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  }).then(x => x.json())
  if (!r.token) throw new Error('login failed: ' + JSON.stringify(r).slice(0, 200))
  return r.token
}

async function findAlertPanelMore(page) {
  return page.evaluate(() => {
    const bs = [...document.querySelectorAll('button')]
      .filter(b => (b.textContent || '').trim() === '更多' && b.offsetParent)
    const hit = bs.find(b => {
      let n = b.parentElement
      for (let i = 0; i < 4 && n; i++) {
        const t = (n.textContent || '').trim()
        if (/^实时告警\s+\d+/.test(t) && !t.includes('大气')) return true
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

;(async () => {
  const token = await login()
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.on('pageerror', e => console.log('[pageerror]', e.message.slice(0, 300)))

  // 逐 img 响应捕获：状态码 + content-type + X-Img-Source
  const imgResp = [] // { url, status, ct, src }
  page.on('response', r => {
    const u = r.url()
    if (u.includes('/api/iot-image') || u.includes('/api/thumb') || u.includes('/api/evidence')) {
      imgResp.push({
        u: decodeURIComponent(u).slice(0, 160),
        s: r.status(),
        ct: (r.headers()['content-type'] || '').slice(0, 30),
        src: (r.headers()['x-img-source'] || ''),
      })
    }
  })

  await page.route('**webapi.amap.com/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.evaluate(t => localStorage.setItem('jsc:token', t), token)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6500)

  // 点「实时告警」更多 → 弹窗加载历史告警列表（含大量图）
  const btn = await findAlertPanelMore(page)
  console.log('MORE-BTN:', JSON.stringify(btn))
  if (btn) {
    await page.mouse.click(btn.x, btn.y)
    await page.waitForTimeout(6000)
  }

  // DOM 统计：所有可见 img（含面板卡片 + 弹窗缩略图）
  const stat = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img')].filter(i => i.offsetParent)
    const noPic = [...document.querySelectorAll('*')]
      .filter(el => el.offsetParent && (el.textContent || '').includes('暂无图片') && el.children.length === 0)
    return {
      imgTotal: imgs.length,
      // naturalWidth>0 = 已成功解码出图；naturalWidth=0 且 complete=true = 失败
      imgOk: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
      imgFail: imgs.filter(i => i.complete && i.naturalWidth === 0).length,
      imgPending: imgs.filter(i => !i.complete).length,
      noPicPlaceholders: noPic.length,
      sampleSrcs: imgs.slice(0, 12).map(i => decodeURIComponent(i.currentSrc || i.src).slice(0, 130)),
    }
  })
  console.log('STAT:', JSON.stringify(stat, null, 1))

  // 响应分类
  const byStatus = {}
  for (const r of imgResp) {
    const k = `${r.s} ${r.ct}` + (r.src ? ` [src=${r.src}]` : '')
    byStatus[k] = (byStatus[k] || 0) + 1
  }
  console.log('IMG-RESP-DIST:')
  for (const [k, v] of Object.entries(byStatus)) console.log('  ', v, 'x', k)
  console.log('IMG-RESP-TOTAL:', imgResp.length)
  console.log('EVIDENCE-REQ:', imgResp.filter(r => r.u.includes('/api/evidence')).length)
  console.log('THUMB-REQ:', imgResp.filter(r => r.u.includes('/api/thumb')).length)
  console.log('IOTIMAGE-REQ:', imgResp.filter(r => r.u.includes('/api/iot-image')).length)

  await page.screenshot({ path: SHOT, fullPage: false })
  console.log('SHOT-SAVED:', SHOT)
  await browser.close()
})().catch(e => { console.error('FATAL', e.message); process.exit(1) })
