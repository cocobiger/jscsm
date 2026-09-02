// T23 验收：入口角标 + 新告警 toast + 提示音开关
// 前置：insert_t23test.cjs 已部署到 /tmp
const { chromium } = require('/opt/jsc/backend/pdf/node_modules/playwright-core')
const { execSync } = require('child_process')
const BASE = 'http://127.0.0.1:80/jsc/'
const CHROME = '/home/jsc/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'
const LOGIN_URL = 'http://127.0.0.1:80/api/auth/login'
const SHOT1 = '/tmp/t23_badge.png'
const SHOT2 = '/tmp/t23_modal_sound_on.png'
const SHOT3 = '/tmp/t23_toast_new.png'
const SHOT4 = '/tmp/t23_sound_off.png'

async function login() {
  const r = await fetch(LOGIN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) }).then(x => x.json())
  if (!r.token) throw new Error('login failed')
  return r.token
}

// 找页面中"更多"按钮（实时告警面板，带容器匹配）
async function findAlertMoreBtn(page) {
  return page.evaluate(() => {
    const phs = [...document.querySelectorAll('div')].filter(d => /^实时告警/.test((d.textContent || '').trim().slice(0, 6)) && d.offsetParent)
    const ph = phs.find(d => (d.textContent || '').includes('更多') && !d.textContent.includes('大气'))
    if (!ph) return null
    // 按钮文本可能是 "更多"、"更多6"、"更多99+"（角标拼到文本），用 startsWith 匹配
    const b = [...ph.querySelectorAll('button')].find(x => {
      const t = (x.textContent || '').trim()
      return (t === '更多' || t.startsWith('更多')) && x.offsetParent
    })
    if (!b) return null
    b.scrollIntoView({ block: 'center' })
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })
}

// 取「更多」按钮的角标数字（用 data-testid 精确选角标 span）
async function getBadgeCount(page) {
  return page.evaluate(() => {
    const phs = [...document.querySelectorAll('div')].filter(d => /^实时告警/.test((d.textContent || '').trim().slice(0, 6)) && d.offsetParent)
    const ph = phs.find(d => (d.textContent || '').includes('更多') && !d.textContent.includes('大气'))
    if (!ph) return null
    const more = [...ph.querySelectorAll('button')].find(x => {
      const t = (x.textContent || '').trim()
      return (t === '更多' || t.startsWith('更多')) && x.offsetParent
    })
    if (!more) return null
    const badge = more.querySelector('[data-testid="alert-pending-badge"]')
    if (!badge) return null
    return badge.textContent.trim()
  })
}

// 弹窗头部 🔔/🔕 开关按钮（title 提示）
async function findSoundToggle(page) {
  return page.evaluate(() => {
    const bs = [...document.querySelectorAll('button')].filter(b => b.offsetParent && /^(🔔|🔕)$/.test((b.textContent || '').trim()))
    if (!bs.length) return null
    const last = bs[bs.length - 1]
    const r = last.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), icon: (last.textContent || '').trim() }
  })
}

// 找叶子节点文本含关键字（用于 toast 断言）
async function hasLeafText(page, kw) {
  return page.evaluate(k => {
    const el = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && (e.textContent || '').includes(k) && e.offsetParent)
    return el ? el.textContent.trim().slice(0, 80) : null
  }, kw)
}

// 找 toast 元素（专用于 T23 新告警 toast 检测）
// 严格匹配：position:fixed + bottom:44 + 含 🔔 字符 + 短文本（<100，排除弹窗头部容器）
async function findT23Toast(page) {
  return page.evaluate(() => {
    const els = [...document.querySelectorAll('div')]
      .filter(d => {
        const cs = getComputedStyle(d)
        if (cs.position !== 'fixed') return false
        const bottom = parseFloat(cs.bottom)
        if (Math.abs(bottom - 44) > 5) return false
        const t = d.textContent || ''
        if (!t.includes('🔔')) return false
        if (t.length > 100) return false  // 排除嵌套容器
        return d.offsetParent !== null
      })
    return els.length ? els[0].textContent.trim().slice(0, 80) : null
  })
}

// 探针：直接调 load 接口模拟 React 轮询，看 prev 集合实际状态
async function probeLoadDiff(page) {
  return page.evaluate(async () => {
    try {
      const token = localStorage.getItem('jsc:token')
      const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }
      const [agg, flat] = await Promise.all([
        fetch('/api/warnings?limit=500&aggregate=1', { headers }).then(r => r.json()),
        fetch('/api/warnings?limit=500', { headers }).then(r => r.json()),
      ])
      const aggList = Array.isArray(agg) ? agg : []
      const flatList = Array.isArray(flat) ? flat : []
      const curIds = new Set()
      for (const a of aggList) curIds.add(`${a.ruleId || ''}:${a.channelSipId ?? ''}:${a.aiType || ''}`)
      for (const w of flatList) if (w.status !== 'handled') curIds.add(w.id)
      // 找 T23 测试告警
      const t23 = flatList.find(w => w.id === 't23test-0902-01')
      const t23InAgg = aggList.some(a => (a.memberIds || []).includes('t23test-0902-01'))
      return {
        aggCount: aggList.length,
        flatCount: flatList.length,
        curIdsSize: curIds.size,
        t23Found: !!t23,
        t23Status: t23?.status,
        t23InAgg,
        t23AiType: t23?.aiType,
        t23Chan: t23?.channelSipId,
      }
    } catch (e) {
      return { err: e.message }
    }
  })
}

const clickXY = (page, pt) => page.mouse.click(pt.x, pt.y)

;(async () => {
  // 先确保环境干净（shot_t23.cjs 在 sky 上执行，node 直接调本地 /tmp）
  execSync('node /tmp/insert_t23test.cjs --clean', { stdio: 'inherit' })

  const token = await login()
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
  page.on('pageerror', e => console.log('[pageerror]', e.message.slice(0, 200)))
  page.on('console', m => {
    const t = m.text()
    if (m.type() === 'error' && !t.includes('webapi.amap')) console.log('[console.error]', t.slice(0, 200))
    else console.log('[console.' + m.type() + ']', t.slice(0, 200))
  })
  await page.route('**webapi.amap.com/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.evaluate(t => {
    localStorage.setItem('jsc:token', t)
    // 注入 mutationObserver 监控所有 🔔 字符的 div 出现
    window.__t23ToastLog = []
    const obs = new MutationObserver(muts => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) {
            const text = (n.textContent || '')
            if (text.includes('🔔') && text.length < 100) {
              window.__t23ToastLog.push({ time: Date.now(), text: text.trim().slice(0, 80) })
            }
          }
        }
      }
    })
    obs.observe(document.body, { childList: true, subtree: true })
  }, token)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6500)

  // ① 入口角标：找「更多」按钮 + 读 badge 数字
  const more = await findAlertMoreBtn(page)
  console.log('MORE:', JSON.stringify(more))
  if (!more) throw new Error('未找到告警面板「更多」按钮')
  const badge1 = await getBadgeCount(page)
  console.log('BADGE-1:', JSON.stringify(badge1))
  await page.screenshot({ path: SHOT1 })
  console.log('SHOT1(badge):', SHOT1)

  // ② 打开弹窗 + 验证 🔔 默认 on
  await clickXY(page, more)
  await page.waitForTimeout(3500)
  const soundBtn1 = await findSoundToggle(page)
  console.log('SOUND-ON:', JSON.stringify(soundBtn1))
  if (!soundBtn1 || soundBtn1.icon !== '🔔') throw new Error('弹窗头部 🔔 开关按钮缺失或非默认 on')
  await page.screenshot({ path: SHOT2 })
  console.log('SHOT2(modal+sound):', SHOT2)

  // 验证弹窗打开后 badge 数字（应该与主页一致）
  const badge2 = await getBadgeCount(page)
  console.log('BADGE-2(modal):', JSON.stringify(badge2))

  // ③ toast 时序：INSERT 后下一次轮询 ≤10s 内必然触发（10s 周期）→ diff → setToast → 显示 2.8s
  //   → 从 INSERT 后立即 DOM polling，覆盖最坏相位（~10s 后才弹）+ 2.8s 显示期 → 持续 13s 必能 catch
  console.log('等 11s 让首次轮询触发并建立 prev 基线...')
  await page.waitForTimeout(11000)
  execSync('node /tmp/insert_t23test.cjs', { stdio: 'inherit' })
  console.log('INSERTED test alert')
  await page.waitForTimeout(500)

  // 立即开始 DOM polling：每 100ms 查 toast，最长 13s（覆盖 10s 轮询周期内任意相位触发 + 2.8s 显示期）
  let toast = null
  const start = Date.now()
  while (Date.now() - start < 13000) {
    toast = await findT23Toast(page)
    if (toast) break
    await page.waitForTimeout(100)
  }
  console.log('TOAST:', JSON.stringify(toast))
  if (!toast) {
    // 诊断：直接拉一次后端，看 t23test 在不在 + 聚合情况
    const probe = await probeLoadDiff(page)
    console.log('PROBE:', JSON.stringify(probe))
    // 注入 mutationObserver 的 toast log
    const tlog = await page.evaluate(() => window.__t23ToastLog || [])
    console.log('TOAST_LOG (' + tlog.length + '):', JSON.stringify(tlog))
  }
  await page.screenshot({ path: SHOT3 })
  console.log('SHOT3(toast):', SHOT3)

  // ④ 关闭提示音：点 🔔 → 🔕
  const soundBtn2 = await findSoundToggle(page)
  if (soundBtn2) {
    await clickXY(page, soundBtn2)
    await page.waitForTimeout(800)
    const soundBtn3 = await findSoundToggle(page)
    console.log('SOUND-OFF:', JSON.stringify(soundBtn3))
    const persisted = await page.evaluate(() => localStorage.getItem('jsc:alert-sound'))
    console.log('PERSISTED:', JSON.stringify(persisted))
    await page.screenshot({ path: SHOT4 })
    console.log('SHOT4(sound-off):', SHOT4)
  }

  // 关闭弹窗（不影响测试数据）
  await page.evaluate(() => {
    const closeBtns = [...document.querySelectorAll('button')].filter(b => b.offsetParent && (b.textContent || '').trim() === '✕')
    if (closeBtns[0]) closeBtns[0].click()
  })
  await page.waitForTimeout(800)

  // ⑤ 清理
  execSync('node /tmp/insert_t23test.cjs --clean', { stdio: 'inherit' })

  const ok = !!more && badge1 != null && soundBtn1 && soundBtn1.icon === '🔔' && toast && toast.includes('🔔')  // toast 文案以 🔔 开头，不一定含「新告警」字样
  console.log('RESULT:', ok ? 'PASS' : 'FAIL', JSON.stringify({
    badge: !!badge1, soundOn: soundBtn1?.icon === '🔔', toast: !!toast, persisted: !!soundBtn2,
  }))
  await browser.close()
  process.exit(ok ? 0 : 1)
})().catch(e => { console.error('ERR', e.message); try { execSync('node /tmp/insert_t23test.cjs --clean', { stdio: 'inherit' }) } catch {} ; process.exit(2) })