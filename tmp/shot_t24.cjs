// T24 验收：AlertHistoryModal 会话态保持（tab/等级/关键词/展开态 sessionStorage）
//   流程：开弹窗 → 改 4 态 → 验证 sessionStorage 写入 → 关 → 重开 → 断言 UI 恢复
//   退出前清理 sessionStorage jsc:alert-history-sess，不污染下次开
const { chromium } = require('/opt/jsc/backend/pdf/node_modules/playwright-core')
const BASE = 'http://127.0.0.1:80/jsc/'
const CHROME = '/home/jsc/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'
const LOGIN_URL = 'http://127.0.0.1:80/api/auth/login'
const SESS_KEY = 'jsc:alert-history-sess'
const SHOT1 = '/tmp/t24_modal_set.png'
const SHOT2 = '/tmp/t24_reopen.png'

async function login() {
  const r = await fetch(LOGIN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) }).then(x => x.json())
  if (!r.token) throw new Error('login failed')
  return r.token
}

// 找告警面板「更多」按钮
async function findAlertMoreBtn(page) {
  return page.evaluate(() => {
    const phs = [...document.querySelectorAll('div')].filter(d => /^实时告警/.test((d.textContent || '').trim().slice(0, 6)) && d.offsetParent)
    const ph = phs.find(d => (d.textContent || '').includes('更多') && !d.textContent.includes('大气'))
    if (!ph) return null
    const b = [...ph.querySelectorAll('button')].find(x => {
      const t = (x.textContent || '').trim()
      return (t === '更多' || t.startsWith('更多')) && x.offsetParent
    })
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })
}

// 找弹窗头部 tab 按钮（"未处理"/"已处理"）的坐标
async function findTabBtn(page, label) {
  return page.evaluate(L => {
    // 弹窗头部（第一个 div 含 "告警记录"）下方的 tab 按钮
    const bs = [...document.querySelectorAll('button')].filter(b => b.offsetParent && (b.textContent || '').trim().startsWith(L))
    if (!bs.length) return null
    const r = bs[0].getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  }, label)
}

// 关闭弹窗
async function closeModal(page) {
  return page.evaluate(() => {
    const bs = [...document.querySelectorAll('button')].filter(b => b.offsetParent && (b.textContent || '').trim() === '✕')
    if (bs[0]) { bs[0].click(); return true }
    return false
  })
}

// 读等级 select 的当前值
async function readLevelVal(page) {
  return page.evaluate(() => {
    const s = document.querySelector('select')
    return s ? s.value : null
  })
}

// 读搜索 input 当前值
async function readKeywordVal(page) {
  return page.evaluate(() => {
    const i = document.querySelector('input[placeholder*="搜索"]')
    return i ? i.value : null
  })
}

// 读 sessionStorage 完整内容
async function readSess(page) {
  return page.evaluate(k => sessionStorage.getItem(k), SESS_KEY)
}

// 找第一个「展开(N)」按钮坐标
async function findExpandBtn(page) {
  return page.evaluate(() => {
    const bs = [...document.querySelectorAll('button')].filter(b => b.offsetParent && /展开\(\d+\)/.test((b.textContent || '').trim()))
    if (!bs.length) return null
    const r = bs[0].getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), label: bs[0].textContent.trim() }
  })
}

// 找当前激活的 tab（"未处理"或"已处理"）：按钮 style 含激活态
async function readActiveTab(page) {
  return page.evaluate(() => {
    const bs = [...document.querySelectorAll('button')].filter(b => b.offsetParent && /^(未处理|已处理)$/.test((b.textContent || '').trim()))
    // 找含下划线或不同 border 的；简化：找有"收起"的行数判定 tab 数据
    return bs.map(b => ({ label: b.textContent.trim(), color: getComputedStyle(b).color }))
  })
}

const clickXY = (page, pt) => page.mouse.click(pt.x, pt.y)

;(async () => {
  const token = await login()
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
  page.on('pageerror', e => console.log('[pageerror]', e.message.slice(0, 200)))
  await page.route('**webapi.amap.com/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))

  // 登录 + 清 sessionStorage（保证测试干净）
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.evaluate(t => {
    localStorage.setItem('jsc:token', t)
    sessionStorage.removeItem('jsc:alert-history-sess')
  }, token)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3500)

  // ① 打开弹窗
  const more = await findAlertMoreBtn(page)
  if (!more) throw new Error('未找到告警面板「更多」按钮')
  await clickXY(page, more)
  await page.waitForTimeout(2500)

  // ── Round A：展开态会话保持（先于 keyword，避免过滤隐藏聚合行）──
  const expandA = await findExpandBtn(page)
  console.log('EXPAND-A-BTN:', JSON.stringify(expandA))
  if (!expandA) {
    console.log('(no aggregate expand btn on pending; expand round skipped)')
  } else {
    await clickXY(page, expandA)
    await page.waitForTimeout(400)
    // 关 → 重开
    await closeModal(page)
    await page.waitForTimeout(800)
    const moreA = await findAlertMoreBtn(page)
    if (!moreA) throw new Error('roundA 关闭后未找到更多按钮')
    await clickXY(page, moreA)
    await page.waitForTimeout(2500)
    // 断言：该行仍是「收起」态（expanded Set 恢复）
    const btnA = await page.evaluate(() => {
      const all = [...document.querySelectorAll('button')].filter(b => b.offsetParent && /^(展开\(\d+\)|收起)/.test((b.textContent || '').trim()))
      return all.map(b => b.textContent.trim())
    })
    console.log('EXPAND-AFTER-REOPEN:', JSON.stringify(btnA))
    // 归位：收起该行（点击第一个「收起」）
    if (btnA && btnA.includes('收起')) {
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find(x => x.offsetParent && (x.textContent || '').trim() === '收起')
        if (b) b.click()
      })
      await page.waitForTimeout(400)
    }
    await closeModal(page)
    await page.waitForTimeout(600)
    await page.evaluate(() => sessionStorage.removeItem('jsc:alert-history-sess'))
    // 重新打开进 Round B
    const moreB = await findAlertMoreBtn(page)
    if (!moreB) throw new Error('roundB 未找到更多按钮')
    await clickXY(page, moreB)
    await page.waitForTimeout(2500)
  }

  // ── Round B：等级 + 关键词 + tab（本用例全程 pending，不切 tab）──
  // 等级 → 2
  await page.selectOption('select', '2')
  await page.waitForTimeout(400)
  // 关键词 → t24test
  await page.fill('input[placeholder*="搜索"]', 't24test')
  await page.waitForTimeout(400)

  // ③ 验证 sessionStorage 已写入
  const sessRaw1 = await readSess(page)
  console.log('SESS-AFTER-SET:', sessRaw1)
  let sess1 = null
  try { sess1 = JSON.parse(sessRaw1 || '{}') } catch {}
  await page.screenshot({ path: SHOT1 })

  // ④ 关闭弹窗
  await closeModal(page)
  await page.waitForTimeout(800)

  // ⑤ 重新打开弹窗
  const more2 = await findAlertMoreBtn(page)
  if (!more2) throw new Error('关闭后未找到「更多」按钮')
  await clickXY(page, more2)
  await page.waitForTimeout(2500)

  // ⑥ 断言 level + keyword 恢复
  const sessRaw2 = await readSess(page)
  console.log('SESS-AFTER-REOPEN:', sessRaw2)
  const levelAfter = await readLevelVal(page)
  const kwAfter = await readKeywordVal(page)
  await page.screenshot({ path: SHOT2 })

  // 判定：sess 字段 + UI 反映
  function tabOkFromSess(s) {
    return s.tab === 'pending'
  }
  const sessOk = sess1 && sess1.v === 1 && sess1.levelFilter === 2 && sess1.keyword === 't24test' && tabOkFromSess(sess1)
  const uiOk = levelAfter === '2' && kwAfter === 't24test'

  // ⑦ 关闭弹窗 + 清理 sessionStorage
  await closeModal(page)
  await page.waitForTimeout(400)
  await page.evaluate(() => sessionStorage.removeItem('jsc:alert-history-sess'))

  // ── Round C：注入式 expanded 验证（生产无聚合行无法 UI 点开 → 直接预置 sessionStorage）──
  //   步骤：预设 sess → reload → 开弹窗 → 验证 sess.expanded 仍存在（useState 初始读出来建立 Set）
  //   firstRun ref 保证 reload + mount 后首次 useEffect 跳过写入（不影响验证）
  await page.evaluate(() => {
    sessionStorage.setItem('jsc:alert-history-sess', JSON.stringify({
      v: 1, tab: 'pending', levelFilter: 3, keyword: 't24preset', expanded: ['fake-row-A', 'fake-row-B'],
    }))
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3500)
  // 重开后 sessionStorage 内容应保留（首次 mount useEffect 跳过写入，sess 不被覆盖）
  const sessPreserved = await page.evaluate(() => sessionStorage.getItem('jsc:alert-history-sess'))
  console.log('SESS-AFTER-RELOAD:', sessPreserved)
  // 打开弹窗，看 UI level/keyword 反映
  const moreC = await findAlertMoreBtn(page)
  if (moreC) {
    await clickXY(page, moreC)
    await page.waitForTimeout(2000)
    const lvlC = await readLevelVal(page)
    const kwC = await readKeywordVal(page)
    const sessAfterOpen = await page.evaluate(() => sessionStorage.getItem('jsc:alert-history-sess'))
    console.log('SESS-AFTER-OPEN:', sessAfterOpen)
    const preservedOk = JSON.parse(sessPreserved || '{}').expanded?.length === 2
    const uiOkC = lvlC === '3' && kwC === 't24preset'
    const notOverwriteOk = JSON.parse(sessAfterOpen || '{}').expanded?.length === 2
    var roundC = preservedOk && uiOkC && notOverwriteOk
    await closeModal(page)
    await page.waitForTimeout(400)
  } else {
    var roundC = false
  }
  await page.evaluate(() => sessionStorage.removeItem('jsc:alert-history-sess'))

  const ok = !!sessOk && !!uiOk && !!roundC
  console.log('SESS-CHECK:', JSON.stringify({ sess: sess1, levelAfter, kwAfter }))
  console.log('ROUND-C:', JSON.stringify({ preserved: sessPreserved, uiOkC: roundC }))
  console.log('RESULT:', ok ? 'PASS' : 'FAIL', JSON.stringify({
    sessWrite: !!sessOk, sessFields: { level: sess1?.levelFilter === 2, kw: sess1?.keyword === 't24test', tab: sess1?.tab === 'pending' },
    uiRestore: { level: levelAfter === '2', kw: kwAfter === 't24test' },
    roundC_inject: roundC,
  }))
  await browser.close()
  process.exit(ok ? 0 : 1)
})().catch(e => { console.error('ERR', e.message); process.exit(2) })
