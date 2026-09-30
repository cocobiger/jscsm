/**
 * algo-threshold.js —— 「算法阈值」模块（Phase 1 · 2026-09-17）
 *
 * 目标：把**我们自己那一层**的算法阈值做成后台可调，防止漏检、便于微调。
 *
 * 🔴 为什么只管"我方那一层"，不管 TASK：
 *   「11 机上的算法阈值」其实是三层 ——
 *     ① TASK [alarm] confidence_threshold（0.50）        厂商 TASK，无 update 接口
 *     ② TASK [cover_detector] conf_threshold（0.50）     只影响车牌门控，不影响告警
 *     ③ alarm_processor min_spill_conf（0.80）           ← **我方**，也是唯一实际生效的闸
 *   数学上：TASK 0.5→送来 [0.5,1.0]，我方 0.8 闸只留 [0.8,1.0]；把 TASK 降到 0.3 送来 [0.3,1.0]，
 *   新增的 [0.3,0.5) 全被 0.8 闸丢掉 ⇒ **净效果 0**。所以"防漏检"只能调第③层。
 *   而 TASK 侧改一个阈值要走"建新任务+启停"（启停对已运行 4K 任务会崩进程 Exited 139），
 *   且新 id 会连带 alarm_config.tasks / 快照前缀 / iot_channels 三处配置要改 ⇒ 绝不做成按钮。
 *   ⇒ 本模块：**写第③层，只读展示第①②层**。
 *
 * 架构（对照秸秆 tune.js）：注册表 → 前端 → 后端编排 → 引擎执行 → 历史/回滚。
 *   这里没有"搜索"，反过来更简单：真源在 11 机的 alarm_config.json，
 *   本模块只做「读→校验→转发→记账」，**不保存第二份状态**（避免"显示 A 实际跑 B"）。
 */
'use strict'
const fs = require('fs')
const path = require('path')

const BASE = (process.env.ALARM_PROCESSOR_URL || 'http://172.16.8.11:7002').replace(/\/+$/, '')
const TOKEN = process.env.ALARM_ADMIN_TOKEN || ''
const HISTORY_FILE = path.join(__dirname, 'data', 'algo_threshold_history.json')
const TIMEOUT_MS = Number(process.env.ALGO_THRESHOLD_TIMEOUT_MS || 20000)

// 档位预设：**下调=多检出（防漏检）、误报上升**；0.85 以上实测会漏真冒装 2/3，故设红线
const PRESETS = [
  { key: 'strict', label: '严格 0.85', value: 0.85, tone: 'danger',
    desc: '误报最少，但实测会漏掉 2/3 的真冒装 —— 仅在误报严重时临时使用' },
  { key: 'balanced', label: '平衡 0.80（现状）', value: 0.80, tone: 'ok',
    desc: '09-14 人工判定得出的最优拐点：精确率 13%→50%，真冒装 3/3 不丢' },
  { key: 'sensitive', label: '敏感 0.75', value: 0.75, tone: 'warn',
    desc: '多收一批边界样本（多为误报，但正是 v11 要的靶子数据）' },
  { key: 'loose', label: '更敏感 0.70', value: 0.70, tone: 'warn',
    desc: '明显减少漏检，误报同步上升。建议配合存档复盘观察 2–3 天' },
  { key: 'loosest', label: '最敏感 0.60', value: 0.60, tone: 'danger',
    desc: '贴近下限。仅用于「宁可错杀」的专项排查期，不建议长期运行' },
]
const RED_LINE = 0.85   // UI 侧画红线：≥ 此值会显著漏检

function readHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) } catch { return [] }
}
function appendHistory(entry) {
  const all = readHistory()
  all.unshift(Object.assign({ at: shanghaiNow() }, entry))
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true })
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(all.slice(0, 200), null, 2))
  return entry
}
function shanghaiNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

async function call11(method, p, body) {
  if (!TOKEN) return { ok: false, error: 'server ALARM_ADMIN_TOKEN 未配置，无法调用 11 机' }
  try {
    const r = await fetch(BASE + p, {
      method,
      headers: Object.assign({ 'X-Admin-Token': TOKEN }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const txt = await r.text()
    let j = null
    try { j = JSON.parse(txt) } catch { /* 非 JSON */ }
    if (!r.ok) return { ok: false, httpStatus: r.status, error: (j && j.error) || txt.slice(0, 200) }
    return j || { ok: false, error: '响应非 JSON' }
  } catch (e) {
    return { ok: false, error: '连接 11 机失败 (' + BASE + '): ' + String(e.message || e).slice(0, 160) }
  }
}

/** 基于 11 机返回的「真实到达事件分布」（来自 alarm_processor 日志里门限**之前**的
 *  `spill event: conf=X` 行）构建估算曲线。
 *
 *  🔴 为什么不用 jsc.db 的历史分布：实测它会算成 0.80 档 652 条/天，而真实只有几~几十条/天
 *     —— 因为历史里混着 09-05~09-10 的 E2E 注入期、且受当时门限影响。**宁可不给数，也不给错数**：
 *     样本不足时返回 available=false，前端只显示"样本不足"，不显示任何数字。 */
function buildEstimate(hist) {
  if (!hist || !Array.isArray(hist.curve) || hist.curve.length === 0) {
    return { available: false, sample: 0, reason: '11 机未返回事件分布' + (hist && hist.error ? '：' + hist.error : '') }
  }
  const MIN = 50
  const sample = Number(hist.sample || 0)
  if (sample < MIN) {
    return { available: false, sample, need: MIN, source: hist.source,
             days_covered: hist.days_covered, reason:
      '真实事件样本不足（' + sample + ' 条，需 ≥' + MIN + ' 条），暂不估算以免给出误导性数字。' +
      'alarm_processor 日志会持续累积，样本够后本功能自动可用。' }
  }
  return { available: true, source: hist.source, days: hist.days, days_covered: hist.days_covered,
           sample, curve: hist.curve, per_day_total: hist.per_day_total }
}

function registerAlgoThresholdRoutes(app, { store, log, adminOnly }) {
  const adm = adminOnly || ((req, res, next) => {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ ok: false, error: '仅管理员可操作' })
    next()
  })

  // ── 总览：我方阈值 + 估算 + TASK 只读实况 ──────────────────────────
  app.get('/api/algo-threshold/status', adm, async (req, res) => {
    const [th, tk] = await Promise.all([
      call11('GET', '/threshold'),
      call11('GET', '/task-thresholds'),
    ])
    const est = buildEstimate(th.ok ? th.event_hist : null)
    res.json({
      ok: !!th.ok,
      upstream: { base: BASE, ok: !!th.ok, error: th.error || null },
      threshold: th.ok ? th : null,
      task: tk.ok ? tk : { ok: false, error: tk.error || null },
      estimate: est,
      presets: PRESETS,
      redLine: RED_LINE,
      history: readHistory().slice(0, 20),
    })
  })

  // ── 应用：改我方阈值（11 机负责校验/备份/写/热加载/回读）──────────
  app.post('/api/algo-threshold/apply', adm, async (req, res) => {
    const b = req.body || {}
    const values = b.values || {}
    if (!values || typeof values !== 'object' || Object.keys(values).length === 0) {
      return res.status(400).json({ ok: false, error: 'values 必填' })
    }
    // 只允许 min_spill_conf 与 dedup_window_s / plate_enabled（与 11 机白名单一致，双保险）
    const ALLOW = new Set(['min_spill_conf', 'dedup_window_s', 'plate_enabled'])
    const bad = Object.keys(values).filter(k => !ALLOW.has(k))
    if (bad.length) return res.status(400).json({ ok: false, error: '不允许修改的键: ' + bad.join(',') })

    const r = await call11('POST', '/threshold/apply', { values })
    appendHistory({
      action: 'apply', by: (req.user && req.user.username) || '?', role: (req.user && req.user.role) || '?',
      requested: values, result: r.ok ? 'ok' : 'fail',
      changed: r.changed || null, readback: r.readback || null,
      backup: r.backup || null, error: r.error || null, note: b.note || '',
      estimateSample: (b.estimateSample !== undefined ? b.estimateSample : null),
    })
    if (!r.ok) return res.status(502).json(r)
    if (log) log.info('[algo-threshold] applied by %s: %s', (req.user && req.user.username), JSON.stringify(r.changed || {}))
    res.json(r)
  })

  // ── 回滚：从 11 机的某个备份恢复 ─────────────────────────────────
  app.post('/api/algo-threshold/rollback', adm, async (req, res) => {
    const b = req.body || {}
    const backup = String(b.backup || '').trim()
    if (!backup) return res.status(400).json({ ok: false, error: 'backup 必填' })
    const r = await call11('POST', '/threshold/rollback', { backup })
    appendHistory({
      action: 'rollback', by: (req.user && req.user.username) || '?', role: (req.user && req.user.role) || '?',
      requested: { backup }, result: r.ok ? 'ok' : 'fail',
      changed: r.changed || null, readback: r.readback || null,
      backup: r.backup || null, error: r.error || null, note: b.note || '',
    })
    if (!r.ok) return res.status(502).json(r)
    if (log) log.info('[algo-threshold] rollback by %s from %s', (req.user && req.user.username), backup)
    res.json(r)
  })

  app.get('/api/algo-threshold/history', adm, (req, res) => res.json({ ok: true, history: readHistory().slice(0, 50) }))

  // ── 仅热加载配置（用于"文件被手工改过、让服务重读"的场景）────────
  app.post('/api/algo-threshold/reload', adm, async (req, res) => {
    const r = await call11('POST', '/reload')
    appendHistory({
      action: 'reload', by: (req.user && req.user.username) || '?', role: (req.user && req.user.role) || '?',
      requested: {}, result: r.ok ? 'ok' : 'fail', readback: r.values || null, error: r.error || null,
    })
    if (!r.ok) return res.status(502).json(r)
    res.json(r)
  })

  if (log) log.info('算法阈值模块已启动（/api/algo-threshold/*，上游 ' + BASE + '）')
}

module.exports = { registerAlgoThresholdRoutes, PRESETS, RED_LINE }
