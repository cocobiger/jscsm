/**
 * push-caliber.js —— 「推送口径统一台」后台可配置项 · 2026-10-12
 *
 * 背景（实测，见 REF §H35.10）：现网有**三个**都叫「推送规则」的东西，是链路上串联的三道闸，
 * 而且**窗口/阈值/置信度三处口径互不一致**：
 *   ① 研判规则 `push_rules`          → 进不进驾驶舱前台   (逐通道；窗口/阈值/min_confidence)
 *   ② 送达规则 `smart_push_rules`    → 发不发城运平台     (类型级；窗口/触发次数)
 *   ③ 展示过滤 `alert_filter_rules`  → 列表显不显示       (类型级；min_confidence)
 *
 * 本模块做的是：**建一张"统一口径表"作为唯一真源，再把口径"下发"到上面三处**。
 *
 * 设计原则（与 cyzx.js / stack-exempt.js / iot-roi 同构，务必先读）：
 *   ① **纯新增、最小侵入**：本表自建、自注册路由；index.js 只加 **1 行 require**
 *      （必须放在 adminOnly 之后：const TDZ）。
 *   ② 🔴 **不在运行期改写读取路径**：`judgeWarning` / `queryWarningsAggregated` / 三个页面的读取
 *      逻辑**一律不碰**。生效方式＝**显式「下发」动作**（dry-run 预览差异 → 确认 → 批量 UPDATE）。
 *      理由：运行期覆盖会让"界面显示 A、实际跑 B"，而下发是一次性、可审计、可回滚的。
 *   ③ 🔴 **下发前先快照**：三张表的相关行整行存进 `push_caliber_apply_log`，可一键回滚。
 *   ④ 🔴 **冲突不静默**：②③ 是**类型级**（无点位维度）⇒ 若同一 aiType 下各点位口径不一致，
 *      下发会拒绝并列出冲突（这正是"统一"要解决的问题），除非显式 force（取保守值并记录）。
 *   ⑤ 时间一律**上海时 UTC+8**（getUTC* + 8h）。
 *
 * 字段映射（唯一真源 → 三处）：
 *   caliber.window_hours  → ①push_rules.time_window_hours   ②smart_push_rules.time_window_hours
 *   caliber.threshold     → ①push_rules.threshold            ②smart_push_rules.trigger_count
 *   caliber.min_confidence→ ①push_rules.min_confidence       ③alert_filter_rules.min_confidence
 *   （②③ 无对应字段的项不下发，dry-run 里显示 "—"）
 */
'use strict'

const TCAL = 'push_caliber'
const TLOG = 'push_caliber_apply_log'
const CACHE_TTL_MS = 10000

let _cache = null
let _cacheAt = 0
let _version = 0

function nowIso() { return new Date().toISOString() }
function shNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000), p = n => String(n).padStart(2, '0')
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' +
    p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds())
}
function invalidate() { _cache = null; _version++ }
function version() { return _version }

function ensureSchema(store) {
  const db = store.getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TCAL} (
      key_id          TEXT PRIMARY KEY,
      ai_type         TEXT NOT NULL,
      channel_sip_id  TEXT,
      channel_name    TEXT,
      window_hours    INTEGER,
      threshold       INTEGER,
      min_confidence  INTEGER,
      note            TEXT DEFAULT '',
      enabled         INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT, updated_at TEXT, updated_by TEXT
    );
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_${TCAL}_ai ON ${TCAL}(ai_type);`)
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TLOG} (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      at          TEXT, who TEXT, ai_type TEXT, scope TEXT,
      before_json TEXT, after_json TEXT, result TEXT
    );
  `)
}

const makeKey = (ai, sip) => String(ai || '') + '::' + String(sip || '')
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : d }

function shape(r) {
  return {
    keyId: r.key_id, aiType: r.ai_type, channelSipId: r.channel_sip_id, channelName: r.channel_name,
    windowHours: r.window_hours, threshold: r.threshold, minConfidence: r.min_confidence,
    note: r.note || '', enabled: !!r.enabled, updatedAt: r.updated_at, updatedBy: r.updated_by,
  }
}

function listCaliber(store, aiType, force) {
  const now = Date.now()
  if (!force && _cache && (now - _cacheAt) < CACHE_TTL_MS) {
    return aiType ? _cache.filter(x => x.aiType === aiType) : _cache
  }
  const rows = store.getDb().prepare(`SELECT * FROM ${TCAL} ORDER BY ai_type, channel_name`).all()
  _cache = rows.map(shape); _cacheAt = now
  return aiType ? _cache.filter(x => x.aiType === aiType) : _cache
}

/** 从 iot_channels 补点位名（也用于把"只在口径表里"的点位归一化） */
function resolveName(store, sip) {
  if (!sip) return null
  try {
    const r = store.getDb().prepare('SELECT channel_name FROM iot_channels WHERE channel_sip_id = ? LIMIT 1').get(String(sip))
    return r ? r.channel_name : null
  } catch { return null }
}

function upsertCaliber(store, body, who) {
  const aiType = String(body.aiType || body.ai_type || '').trim()
  let sip = String(body.channelSipId || body.channel_sip_id || '').trim()
  if (!aiType) throw new Error('aiType 必填')
  if (!sip) {
    const nm = String(body.channelName || '').trim()
    if (nm) { try { const r = store.getDb().prepare('SELECT channel_sip_id FROM iot_channels WHERE channel_name = ? LIMIT 1').get(nm); sip = r ? r.channel_sip_id : '' } catch { } }
  }
  const key = makeKey(aiType, sip)
  const name = String(body.channelName || '').trim() || resolveName(store, sip) || sip
  const db = store.getDb()
  const old = db.prepare(`SELECT created_at FROM ${TCAL} WHERE key_id = ?`).get(key)
  db.prepare(`
    INSERT INTO ${TCAL}(key_id, ai_type, channel_sip_id, channel_name, window_hours, threshold, min_confidence, note, enabled, created_at, updated_at, updated_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(key_id) DO UPDATE SET
      channel_name=excluded.channel_name, window_hours=excluded.window_hours, threshold=excluded.threshold,
      min_confidence=excluded.min_confidence, note=excluded.note, enabled=excluded.enabled,
      updated_at=excluded.updated_at, updated_by=excluded.updated_by
  `).run(key, aiType, sip || null, name,
    body.windowHours === undefined ? null : num(body.windowHours, null),
    body.threshold === undefined ? null : num(body.threshold, null),
    body.minConfidence === undefined ? null : num(body.minConfidence, null),
    String(body.note || '').slice(0, 500),
    body.enabled === undefined ? 1 : (body.enabled ? 1 : 0),
    (old && old.created_at) || nowIso(), nowIso(), String(who || '?'))
  invalidate()
  return shape(db.prepare(`SELECT * FROM ${TCAL} WHERE key_id = ?`).get(key))
}

function deleteCaliber(store, keyId) {
  const r = store.getDb().prepare(`DELETE FROM ${TCAL} WHERE key_id = ?`).run(String(keyId || ''))
  invalidate()
  return Number(r.changes || 0)
}

/** 读取三处「现网实况」，供差异比对 */
function readLive(store, aiType) {
  const db = store.getDb()
  const out = { pushRules: {}, smartRules: {}, filters: {} }
  try {
    // 🔴 生产 push_rules **没有 channel_name 列**（只有 name＝规则名，如「九龙沙场·堆头未覆盖」）
    db.prepare('SELECT channel_sip_id, name, time_window_hours, threshold, min_confidence, enabled FROM push_rules WHERE ai_type = ?')
      .all(aiType).forEach(r => { out.pushRules[r.channel_sip_id] = { name: r.name, win: r.time_window_hours, thr: r.threshold, conf: r.min_confidence, enabled: r.enabled } })
  } catch { }
  try {
    db.prepare('SELECT id, time_window_hours, trigger_count, enabled FROM smart_push_rules WHERE event_type = ?')
      .all(aiType).forEach(r => { out.smartRules[r.id] = { win: r.time_window_hours, thr: r.trigger_count, enabled: r.enabled } })
  } catch { }
  try {
    db.prepare('SELECT id, name, min_confidence, locations, enabled FROM alert_filter_rules').all()
      .forEach(r => { if (String(r.name || '').includes(aiType)) out.filters[r.id] = { name: r.name, conf: r.min_confidence, enabled: r.enabled } })
  } catch { }
  return out
}

/** 逐通道差异预览 + 类型级冲突检测 */
function dryRunCaliber(store, opts) {
  const aiType = String((opts && opts.aiType) || '').trim()
  if (!aiType) throw new Error('aiType 必填')
  const cal = listCaliber(store, aiType, true).filter(x => x.enabled)
  const live = readLive(store, aiType)
  const rows = cal.map(c => {
    const l1 = live.pushRules[c.channelSipId] || null
    const d = []
    if (c.windowHours != null && l1 && l1.win !== c.windowHours) d.push(`①窗口 ${l1.win}→${c.windowHours}`)
    if (c.threshold != null && l1 && l1.thr !== c.threshold) d.push(`①阈值 ${l1.thr}→${c.threshold}`)
    if (c.minConfidence != null && l1 && l1.conf !== c.minConfidence) d.push(`①置信 ${l1.conf}→${c.minConfidence}`)
    return {
      channelSipId: c.channelSipId, channelName: c.channelName,
      caliber: { win: c.windowHours, thr: c.threshold, conf: c.minConfidence },
      live1: l1 ? { win: l1.win, thr: l1.thr, conf: l1.conf } : null,
      hasRule1: !!l1,
      diffs: d,
    }
  })
  // ②③ 是类型级 ⇒ 要求该类型下口径唯一
  const conflicts = []
  for (const [field, label] of [['windowHours', '窗口'], ['threshold', '阈值'], ['minConfidence', '置信度']]) {
    const vs = Array.from(new Set(cal.map(x => x[field]).filter(v => v != null)))
    if (vs.length > 1) conflicts.push({ field, label, values: vs.map(v => ({ value: v, at: cal.filter(x => x[field] === v).map(x => x.channelName) })) })
  }
  const smart = live.smartRules, filt = live.filters
  const target = {}
  const uniqOrNull = f => { const vs = Array.from(new Set(cal.map(f).filter(v => v != null))); return vs.length === 1 ? vs[0] : null }
  if (Object.keys(smart).length) target.smartRules = { win: uniqOrNull(x => x.windowHours), thr: uniqOrNull(x => x.threshold) }
  if (Object.keys(filt).length) target.filters = { conf: uniqOrNull(x => x.minConfidence) }
  return {
    aiType, rows, conflicts,
    // 🔴 保持"按 id 索引的对象"——apply 侧要用 Object.keys() 拿真实 id（数组会被当 "0","1" 用）
    liveTarget: { smartRules: smart, filters: filt },
    willApply: target,
    ok: conflicts.length === 0,
    note: '只读预演：有 diffs 即需下发。②③ 无点位维度 ⇒ 同类型口径不一致时会报冲突、拒绝下发（除非 force 取保守值）。',
  }
}

/** 下发：先快照三表相关行，再 UPDATE，并记录日志 */
function applyCaliber(store, opts, who) {
  const aiType = String((opts && opts.aiType) || '').trim()
  if (!aiType) throw new Error('aiType 必填')
  if (!opts || opts.confirm !== true) throw new Error('需显式 confirm=true 才执行下发')
  const dry = dryRunCaliber(store, { aiType })
  const force = opts.force === true
  if (!dry.ok && !force) {
    return { ok: false, applied: null, conflicts: dry.conflicts, error: '同类型下口径不一致，请先统一（或 force=true 取保守值）' }
  }
  const db = store.getDb()
  const before = JSON.stringify(readLive(store, aiType))
  let n1 = 0, n2 = 0, n3 = 0
  db.exec('BEGIN')
  try {
    for (const r of dry.rows) {
      if (!r.channelSipId) continue
      const sets = [], vals = []
      if (r.caliber.win != null) { sets.push('time_window_hours = ?'); vals.push(r.caliber.win) }
      if (r.caliber.thr != null) { sets.push('threshold = ?'); vals.push(r.caliber.thr) }
      if (r.caliber.conf != null) { sets.push('min_confidence = ?'); vals.push(r.caliber.conf) }
      if (!sets.length) continue
      vals.push(aiType, r.channelSipId)
      n1 += Number(db.prepare(`UPDATE push_rules SET ${sets.join(', ')} WHERE ai_type = ? AND channel_sip_id = ?`).run(...vals).changes || 0)
    }
    const cWin = dry.willApply.smartRules ? dry.willApply.smartRules.win : null
    const cThr = dry.willApply.smartRules ? dry.willApply.smartRules.thr : null
    if (cWin != null || cThr != null) {
      const sets = [], vals = []
      if (cWin != null) { sets.push('time_window_hours = ?'); vals.push(cWin) }
      if (cThr != null) { sets.push('trigger_count = ?'); vals.push(cThr) }
      vals.push(aiType)
      n2 = Number(db.prepare(`UPDATE smart_push_rules SET ${sets.join(', ')} WHERE event_type = ?`).run(...vals).changes || 0)
    }
    const cConf = dry.willApply.filters ? dry.willApply.filters.conf : null
    if (cConf != null) {
      const ids = Object.keys(dry.liveTarget.filters || {})
      for (const id of ids) n3 += Number(db.prepare('UPDATE alert_filter_rules SET min_confidence = ? WHERE id = ?').run(cConf, id).changes || 0)
    }
    const applied = { pushRules: n1, smartPushRules: n2, alertFilterRules: n3 }
    db.prepare(`INSERT INTO ${TLOG}(at, who, ai_type, scope, before_json, after_json, result) VALUES(?,?,?,?,?,?,?)`)
      .run(shNow(), String(who || '?'), aiType, 'all', before, JSON.stringify(readLive(store, aiType)), JSON.stringify({ applied, force }))
    db.exec('COMMIT')
    return { ok: true, applied, conflicts: dry.conflicts, forced: force && !dry.ok }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { }
    return { ok: false, applied: null, error: String(e.message) }
  }
}

function applyLog(store, limit) {
  try {
    return store.getDb().prepare(`SELECT id, at, who, ai_type, result FROM ${TLOG} ORDER BY id DESC LIMIT ?`).all(Math.min(num(limit, 20), 200))
      .map(r => ({ id: r.id, at: r.at, who: r.who, aiType: r.ai_type, result: (() => { try { return JSON.parse(r.result) } catch { return r.result } })() }))
  } catch { return [] }
}

function healthCheck(store, aiType) {
  const items = listCaliber(store, aiType, true)
  const live = readLive(store, aiType || (items[0] && items[0].aiType) || '堆头未覆盖')
  const missing = items.filter(x => x.enabled && !live.pushRules[x.channelSipId])
    .map(x => ({ channelName: x.channelName, channelSipId: x.channelSipId }))
  const noLive = Object.keys(live.pushRules).filter(sp => !items.some(x => x.channelSipId === sp))
  return { count: items.length, enabled: items.filter(x => x.enabled).length, aiTypes: Array.from(new Set(items.map(x => x.aiType))), caliberWithoutRule: missing, ruleWithoutCaliber: noLive, items }
}

function registerPushCaliberRoutes(app, { store, log, adminOnly } = {}) {
  const adm = adminOnly || ((req, res, next) => {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ ok: false, error: '仅管理员可操作' })
    next()
  })
  const who = req => (req.user && req.user.username) || '?'

  try {
    ensureSchema(store)
    listCaliber(store, null, true)
    if (log) log.info('[push-caliber] 表已就绪：' + TCAL)
  } catch (e) {
    if (log) log.error(`[push-caliber] 初始化失败（模块已禁用，后端继续启动）: ${e.message}`)
  }

  app.get('/api/push-caliber', adm, (req, res) => {
    try {
      const aiType = String(req.query.aiType || '').trim() || null
      res.json({ ok: true, aiType, items: listCaliber(store, aiType), version: version(),
                 live: aiType ? readLive(store, aiType) : null,
                 note: 'caliber=统一口径（唯一真源）；live=①push_rules/②smart_push_rules/③alert_filter_rules 的现网实况' })
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  app.put('/api/push-caliber', adm, (req, res) => {
    try {
      const item = upsertCaliber(store, req.body || {}, who(req))
      if (log) log.info(`[push-caliber] upsert by ${who(req)}：${item.aiType} / ${item.channelName}`)
      res.json({ ok: true, item, items: listCaliber(store, item.aiType), version: version() })
    } catch (e) { res.status(400).json({ ok: false, error: e.message }) }
  })

  app.post('/api/push-caliber/bulk', adm, (req, res) => {
    try {
      const b = req.body || {}
      let items = Array.isArray(b.items) ? b.items.slice() : []
      if (!items.length && typeof b.text === 'string') {
        // 文本行：点位名,窗口,阈值,置信度   （后三项可省，用 body 级默认）
        items = b.text.split(/\r?\n/).map(s => s.split('#')[0].trim()).filter(Boolean).map(line => {
          const [name, win, thr, conf] = line.split(/[,\t]/).map(s => (s || '').trim())
          return { channelName: name, windowHours: win || b.windowHours, threshold: thr || b.threshold, minConfidence: conf || b.minConfidence, note: b.note }
        })
      }
      const out = items.map(it => {
        try { return upsertCaliber(store, Object.assign({ aiType: b.aiType }, it), who(req)) }
        catch (e) { return { error: String(e.message), raw: it } }
      })
      res.json({ ok: true, results: out, items: listCaliber(store, b.aiType), version: version() })
    } catch (e) { res.status(400).json({ ok: false, error: e.message }) }
  })

  app.delete('/api/push-caliber/:keyId', adm, (req, res) => {
    try {
      const n = deleteCaliber(store, decodeURIComponent(req.params.keyId || ''))
      res.json({ ok: true, deleted: n, items: listCaliber(store, null), version: version() })
    } catch (e) { res.status(400).json({ ok: false, error: e.message }) }
  })

  app.post('/api/push-caliber/dry-run', adm, (req, res) => {
    try { res.json(Object.assign({ ok: true }, dryRunCaliber(store, req.body || {}))) }
    catch (e) { res.status(400).json({ ok: false, error: e.message }) }
  })

  app.post('/api/push-caliber/apply', adm, (req, res) => {
    try {
      const r = applyCaliber(store, req.body || {}, who(req))
      if (log) log.info(`[push-caliber] apply by ${who(req)}：aiType=${(req.body || {}).aiType} → ${JSON.stringify(r.applied || r.error)}`)
      res.status(r.ok ? 200 : 400).json(r)
    } catch (e) { res.status(400).json({ ok: false, error: e.message }) }
  })

  app.get('/api/push-caliber/log', adm, (req, res) => {
    try { res.json({ ok: true, items: applyLog(store, req.query.limit) }) }
    catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  app.get('/api/push-caliber/health', adm, (req, res) => {
    try { res.json(Object.assign({ ok: true, version: version(), now: shNow() }, healthCheck(store, req.query.aiType))) }
    catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  return { list: a => listCaliber(store, a), dryRun: o => dryRunCaliber(store, o), apply: (o, w) => applyCaliber(store, o, w) }
}

module.exports = { registerPushCaliberRoutes, listCaliber, dryRunCaliber, applyCaliber }
