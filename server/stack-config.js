/**
 * stack-config.js —— 「堆头未覆盖链」后台配置模块（批次 4 / Step 2 · 2026-09-20）
 *
 * 目标：让驾驶舱后台能直接调「堆头未覆盖」链的 调度/时段/帧来源/保留策略/逐路开关/门限，
 *       而不必登 11 机改 JSON。
 *
 * 架构（对照 algo-threshold.js）：
 *   真源在 **11 机** `/soft/data/stack-chain/stack_config.json`。
 *   本模块只做「读 → 校验 → 转发 → 记账」，**不保存第二份配置状态**
 *   （避免出现"后台显示 A、链实际跑 B"）。历史记录只记"谁在什么时候改了什么"，
 *   这是审计信息而非配置状态，所以落本地是安全的。
 *
 * 上游契约（11 机 alarm_processor，AlarmProcessor :7002，X-Admin-Token 鉴权）：
 *   GET  /stack-config            → {ok, server_time, config_path, config_mtime, values,
 *                                    defaults, tunable（18 键，含 type/min/max/desc）,
 *                                    readonly（3 个护栏，含 desc）, channels[6], backups, apply_hint}
 *   POST /stack-config/apply      ← {values?:{...}, channels_enable?:{"<spid>":bool}}
 *                                 → {ok, changed, backup, stamp, readback, readback_channels?, note}
 *   POST /stack-config/rollback   ← {backup:"stack_config.json.bak_YYYYmmdd_HHMMSS"}
 *                                 → {ok, from, changed, backup, readback, note}
 *
 * 🔴 为什么必须代理、不能前端直连 11 机：
 *   ① 浏览器在公网侧，172.16.8.11 是内网地址，前端根本路由不到；
 *   ② X-Admin-Token **绝不能下发到浏览器**（那样等于把改生产配置的钥匙发出去）。
 *      ⇒ token 只存在于 12 机进程环境变量（drop-in：ALARM_ADMIN_TOKEN）。
 *
 * 🔴 生效语义（与 11 机一致，务必在 UI 里显式告知用户）：
 *   堆头链是常驻进程（cover-stack-daemon）**每轮重读配置** ⇒ 保存后 ≤2 秒生效，
 *   **无需重启任何服务**。这与渣土车链（TASK 需重建）完全不同，别混。
 */
'use strict'
const fs = require('fs')
const path = require('path')

const BASE = (process.env.ALARM_PROCESSOR_URL || 'http://172.16.8.11:7002').replace(/\/+$/, '')
const TOKEN = process.env.ALARM_ADMIN_TOKEN || ''
const HISTORY_FILE = path.join(__dirname, 'data', 'stack_config_history.json')
const TIMEOUT_MS = Number(process.env.STACK_CONFIG_TIMEOUT_MS || 20000)

/** 与 11 机 `STACK_TUNABLE` 严格对齐的本地白名单（**双保险**：11 机收到后仍会自己再校验一次）。
 *  这里只做"键名"级别的拦截，**值域不在本地判** —— 因为值域的单一真源是 11 机的
 *  {min,max,enum} 定义，本地复制一份必然漂移。让 11 机返回它自己的报错文案更准确。 */
const ALLOW = new Set([
  // 门限类
  'min_stack_conf', 'min_sharpness', 'min_color_frac', 'min_record_interval_s',
  // 保留策略类
  'keep_days', 'keep_frames', 'min_free_gb', 'record_no_detection',
  // 门控总闸
  'infrared_enabled', 'sharpness_enabled',
  // 调度类（S3.1/S3.2 新增）
  'enabled', 'interval_s', 'daily_window', 'frame_source', 'max_frame_age_s', 'parallel_max',
  // 内容感知永久保留（S3.2d 新增）
  'keep_forever_enabled', 'keep_forever_conf',
])

/** 仅供 UI 做"一键选档"，不是白名单的一部分（真正校验永远在 11 机）。 */
const PRESETS = {
  interval_s: [5, 10, 15, 30, 60, 300],
  daily_window: [
    { label: '全天（不限制）', value: [] },
    { label: '08:00–19:00', value: [{ start: '08:00', end: '19:00' }] },
    { label: '08:00–12:00 + 14:00–19:00', value: [{ start: '08:00', end: '12:00' }, { start: '14:00', end: '19:00' }] },
  ],
}

function readHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) } catch { return [] }
}
function appendHistory(entry) {
  const all = readHistory()
  all.unshift(Object.assign({ at: shanghaiNow() }, entry))
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true })
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(all.slice(0, 200), null, 2))
  } catch (e) {
    // 记账失败不能影响主流程（配置已经写进 11 机了）
    try { console.error('[stack-config] 历史写入失败:', e.message) } catch { /* ignore */ }
  }
  return entry
}
/** 一律上海时（UTC+8），禁止用 toLocaleString/本地时区。 */
function shanghaiNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
         `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
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

function registerStackConfigRoutes(app, { store, log, adminOnly }) {
  const adm = adminOnly || ((req, res, next) => {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ ok: false, error: '仅管理员可操作' })
    next()
  })
  const who = (req) => ({
    by: (req.user && req.user.username) || '?',
    role: (req.user && req.user.role) || '?',
  })

  // ── 总览：现行值 + 18 键定义(含 desc) + 3 只读护栏 + 6 路开关 + 备份 + 历史 ──
  app.get('/api/stack-config/status', adm, async (req, res) => {
    const r = await call11('GET', '/stack-config')
    if (!r.ok) {
      return res.status(502).json({
        ok: false,
        upstream: { base: BASE, ok: false, error: r.error || null },
        error: r.error || '上游不可用',
        history: readHistory().slice(0, 20),
      })
    }
    res.json(Object.assign({}, r, {
      upstream: { base: BASE, ok: true, error: null },
      presets: PRESETS,
      history: readHistory().slice(0, 20),
    }))
  })

  // ── 应用：改白名单键 / 逐路开关（11 机负责校验、备份、原子写、回读校验）──
  app.post('/api/stack-config/apply', adm, async (req, res) => {
    const b = req.body || {}
    const values = b.values
    const chEn = b.channels_enable

    if (values !== undefined && values !== null &&
        (typeof values !== 'object' || Array.isArray(values))) {
      return res.status(400).json({ ok: false, error: 'values 需为对象' })
    }
    if (chEn !== undefined && chEn !== null &&
        (typeof chEn !== 'object' || Array.isArray(chEn))) {
      return res.status(400).json({ ok: false, error: 'channels_enable 需为 {通道号: true/false}' })
    }
    const vals = {}
    const stripped = []
    for (const [k, v] of Object.entries(values || {})) {
      // 🔴 null/undefined 在本配置里**没有语义**：它表示"该键未显式写入 ⇒ 用链内默认值"。
      //   例如 keep_forever_enabled 在文件里根本不存在，链按 cfg.get(key, True) 取默认（=开）。
      //   若把 null 原样转发，11 机的 _stack_coerce 会按 bool 解析失败并 400（"需为布尔值"）。
      //   ⇒ 这里**剔除并显式回报**（不静默），这样前端"整表保存"天然安全，同时不隐藏任何事。
      if (v === null || v === undefined) { stripped.push(k); continue }
      vals[k] = v
    }
    const chObj = chEn || {}
    const vkeys = Object.keys(vals)
    const bad = vkeys.filter(k => !ALLOW.has(k))
    if (bad.length) return res.status(400).json({ ok: false, error: '不允许修改的键: ' + bad.join(',') })
    for (const k of Object.keys(chObj)) {
      if (typeof chObj[k] !== 'boolean') {
        return res.status(400).json({ ok: false, error: 'channels_enable 的值需为布尔（通道 ' + k + '）' })
      }
    }
    if (!vkeys.length && !Object.keys(chObj).length) {
      if (stripped.length) {
        return res.status(400).json({
          ok: false,
          error: '没有可写入的值：' + stripped.join(',') + ' 当前未显式设置（用链内默认值），如需改它请给 true/false',
        })
      }
      return res.status(400).json({ ok: false, error: 'values 或 channels_enable 至少给一个' })
    }

    const payload = {}
    if (vkeys.length) payload.values = vals
    if (Object.keys(chObj).length) payload.channels_enable = chObj

    const r = await call11('POST', '/stack-config/apply', payload)
    if (stripped.length && r && typeof r === 'object') {
      r.stripped = stripped
      r.warnings = (r.warnings || []).concat([
        '以下键因值为 null（＝未显式设置、用默认值）未提交，也没有产生变更: ' + stripped.join(','),
      ])
    }
    appendHistory(Object.assign({
      action: 'apply', requested: payload, stripped: stripped.length ? stripped : null,
      result: r.ok ? 'ok' : 'fail',
      changed: r.changed || null, readback: r.readback || null,
      backup: r.backup || null, error: r.error || null, note: b.note || '',
    }, who(req)))
    if (!r.ok) return res.status(502).json(r)
    if (log) {
      log.info('[stack-config] applied by %s: %s (backup=%s)',
        (req.user && req.user.username), JSON.stringify(r.changed || {}), r.backup || '?')
    }
    res.json(r)
  })

  // ── 回滚：从 11 机的某个备份恢复（只恢复白名单键 + 逐路开关）──
  app.post('/api/stack-config/rollback', adm, async (req, res) => {
    const b = req.body || {}
    const backup = String(b.backup || '').trim()
    if (!backup) return res.status(400).json({ ok: false, error: 'backup 必填' })
    const r = await call11('POST', '/stack-config/rollback', { backup })
    appendHistory(Object.assign({
      action: 'rollback', requested: { backup }, result: r.ok ? 'ok' : 'fail',
      changed: r.changed || null, readback: r.readback || null,
      backup: r.backup || null, from: r.from || backup, error: r.error || null, note: b.note || '',
    }, who(req)))
    if (!r.ok) return res.status(502).json(r)
    if (log) log.info('[stack-config] rollback by %s from %s', (req.user && req.user.username), backup)
    res.json(r)
  })

  app.get('/api/stack-config/history', adm, (req, res) =>
    res.json({ ok: true, history: readHistory().slice(0, 50) }))

  if (log) log.info('堆头链配置模块已启动（/api/stack-config/*，上游 ' + BASE + '）')
}

module.exports = { registerStackConfigRoutes, PRESETS, ALLOW }
