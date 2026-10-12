/**
 * stack-exempt.js —— 「堆头未覆盖 · 点位豁免名单」后台可配置项 · 2026-10-11
 *
 * 背景（口径）：
 *   用户裁定 —— **靠近江边的作业区（码头作业面 / 装卸区 / 施工堆料作业面）不受
 *   「防尘网未覆盖 > 40% 即违规」的规则约束**。作业区是**点位属性**，不是逐帧判断，
 *   所以做成后台可配置的**豁免名单**，填完即生效、无需改代码重启。
 *
 * 设计原则（与 cyzx.js / iot-roi 同构，务必先读）：
 *   ① **纯新增、最小侵入**：本文件自建表、自管配置、自注册路由；
 *      index.js 只加 **2 行**（1 行 require + 1 个 PUBLIC_PATHS 路径）。
 *      require 必须放在 `adminOnly` 定义之后 —— adminOnly 是 const（TDZ），提前引用会 ReferenceError 崩进程。
 *   ② **不动研判闸门**：`judgeWarning` / `isGateExemptWarning` / `queryWarningsAggregated` **一律不碰**。
 *      改它们会同时改变前台实时告警量与 SSOT 口径（铁律）。
 *   ③ **真源在 DB**：表 `stack_exempt_points` 是唯一真源；env 只作首次初始化。
 *      列表带 10s 缓存 + **写即失效**。
 *   ④ **内网端点安全全靠 token**：`/api/internal/stack-exempt` 在 PUBLIC_PATHS 放行 session 鉴权，
 *      由路由内自校验 `X-Admin-Token`（复用 ALARM_ADMIN_TOKEN，与 /api/internal/iot-roi 同一个）。
 *   ⑤ 时间一律**上海时 UTC+8**（getUTC* + 8h），禁用 toLocaleString / 本地时区。
 *
 * 生效路径（分两层，互不耦合）：
 *   · **12 机（本模块）**：名单可查、可算影响（dry-run）；提供给前端标注与统计口径使用。
 *   · **11 机堆头链（后续）**：与 `roi_config_url` 同构，拉 `/api/internal/stack-exempt`，
 *     对豁免点位的产出打标 / 不计入违规。**本批先只提供端点，不改链**。
 */
'use strict'

const TABLE = 'stack_exempt_points'
const ALGO_DEFAULT = '堆头未覆盖'
const CACHE_TTL_MS = 10000

let _cache = null
let _cacheAt = 0
let _version = 0

function nowIso() { return new Date().toISOString() }
/** 上海时（UTC+8）字符串，与项目口径一致 */
function shNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' +
    p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds())
}

function ensureSchema(store) {
  const db = store.getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      key_id          TEXT PRIMARY KEY,
      algo            TEXT NOT NULL DEFAULT '${ALGO_DEFAULT}',
      channel_sip_id  TEXT,
      channel_name    TEXT,
      scope           TEXT NOT NULL DEFAULT 'point',
      reason          TEXT DEFAULT '',
      enabled         INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT,
      updated_at      TEXT,
      updated_by      TEXT
    );
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_algo ON ${TABLE}(algo);`)
}

function makeKey(algo, sip, name) {
  return String(algo || ALGO_DEFAULT) + '::' + String(sip || name || '').trim()
}

/** 把通道名解析成 channel_sip_id（命中 iot_channels 时补齐，便于链路按 sip 精确匹配） */
function resolveSip(store, name) {
  if (!name) return null
  try {
    const r = store.getDb().prepare(
      'SELECT channel_sip_id FROM iot_channels WHERE channel_name = ? LIMIT 1').get(String(name).trim())
    return r ? r.channel_sip_id : null
  } catch { return null }
}

/** 由 sip 反查点位名（①模式需要：push_rules 只存 channel_sip_id） */
function resolveName(store, sip) {
  if (!sip) return null
  try {
    const r = store.getDb().prepare('SELECT channel_name FROM iot_channels WHERE channel_sip_id = ? LIMIT 1').get(String(sip))
    return r ? r.channel_name : null
  } catch { return null }
}

function shape(r) {
  return {
    keyId: r.key_id, algo: r.algo, channelSipId: r.channel_sip_id, channelName: r.channel_name,
    scope: r.scope, reason: r.reason || '', enabled: !!r.enabled,
    createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by,
  }
}

function invalidate() { _cache = null; _version++ }
function version() { return _version }

// ── 🆕 S3（2026-10-12）：豁免名单的「真源」可切换 ────────────────────────────────
//   背景：④「作业区豁免」(stack_exempt_points) 与①「事件研判逻辑」(push_rules) 是两处配同一件事
//   （"该点位是否不计违规"）。S3 把④的能力并入①的 `exempt` 字段（S1 已建）。
//   🔴 输出形状**完全一致** ⇒ /api/internal/stack-exempt 契约不变 ⇒ 11 机链路零改动。
const KV_SRC = 'stack_exempt_source'

/** 真源：'table'(默认，＝现行为) ｜ 'push_rule'(①的 exempt 字段) */
function exemptSource(store) {
  try { return (store.kvGet(KV_SRC, null) === 'push_rule') ? 'push_rule' : 'table' } catch (e) { return 'table' }
}
function setExemptSource(store, v) {
  const val = (v === 'push_rule') ? 'push_rule' : 'table'
  try { store.kvSet(KV_SRC, val) } catch (e) { }
  return val
}

/** 表模式（原逻辑，原样保留） */
function listFromTable(store, algo, force) {
  const now = Date.now()
  if (!force && _cache && (now - _cacheAt) < CACHE_TTL_MS) {
    const a = algo || ALGO_DEFAULT
    return _cache.filter(x => x.algo === a)
  }
  const rows = store.getDb().prepare(`SELECT * FROM ${TABLE} ORDER BY algo, channel_name`).all()
  _cache = rows.map(shape)
  _cacheAt = now
  const a = algo || ALGO_DEFAULT
  return _cache.filter(x => x.algo === a)
}

/** ①模式：读 push_rules.exempt=1，**映射成与表模式逐字相同的形状**
 *  · reason 用①的规则名承载（说明性字段；11 机链路只读 sips/names，不读 reason）
 *  · scope 固定 'point'（①的粒度就是「通道×算法」） */
function listFromPushRules(store, algo) {
  const a = algo || ALGO_DEFAULT
  let rows = []
  try {
    rows = store.getDb().prepare(
      'SELECT id, name, channel_sip_id, enabled, updated_at, ai_type, ai_types FROM push_rules WHERE exempt = 1').all()
  } catch (e) { return [] }
  return rows.filter(r => {
    const t = String(r.ai_type || '')
    let arr = []
    try { arr = JSON.parse(r.ai_types || '[]') } catch (e) { }
    return t === a || (Array.isArray(arr) && arr.includes(a))
  }).map(r => ({
    keyId: 'push_rule::' + r.id,
    algo: a,
    channelSipId: r.channel_sip_id || null,
    channelName: resolveName(store, r.channel_sip_id) || r.channel_sip_id || null,
    scope: 'point',
    reason: String(r.name || ''),
    enabled: r.enabled === 1,
    createdAt: null,
    updatedAt: r.updated_at || null,
    updatedBy: null,
    source: 'push_rule',
  }))
}

/** 🆕 S3 分派器：默认走表（**零行为变化**）；切开关后走① */
function listExempt(store, algo, force) {
  return exemptSource(store) === 'push_rule' ? listFromPushRules(store, algo) : listFromTable(store, algo, force)
}

/** 🆕 S3：把表里的条目写成①的 `exempt=1`（幂等；无对应①规则则跳过并说明） */
function migrateExemptToPushRules(store, who) {
  const items = listFromTable(store, null, true)
  const out = { scanned: items.length, updated: [], skipped: [] }
  const db = store.getDb()
  for (const it of items) {
    let rule = null
    try {
      rule = db.prepare("SELECT id, name, exempt FROM push_rules WHERE channel_sip_id = ? AND (ai_type = ? OR ai_types LIKE ?) LIMIT 1")
        .get(it.channelSipId, it.algo, '%' + it.algo + '%')
    } catch (e) { }
    if (!rule) { out.skipped.push({ channelName: it.channelName, algo: it.algo, why: '①中无对应规则（该通道×算法没有研判规则）' }); continue }
    if (Number(rule.exempt) === 1) { out.skipped.push({ channelName: it.channelName, algo: it.algo, why: '①中已是豁免（幂等跳过）' }); continue }
    db.prepare('UPDATE push_rules SET exempt = 1, updated_at = ? WHERE id = ?').run(nowIso(), rule.id)
    out.updated.push({ channelName: it.channelName, algo: it.algo, ruleId: rule.id, ruleName: rule.name, by: String(who || '?') })
  }
  return out
}

function upsertExempt(store, body, who) {
  const algo = String(body.algo || ALGO_DEFAULT).trim() || ALGO_DEFAULT
  const name = String(body.channelName || body.channel_name || '').trim()
  let sip = String(body.channelSipId || body.channel_sip_id || '').trim()
  if (!name && !sip) throw new Error('channelName 与 channelSipId 至少填一个')
  if (!sip && name) sip = resolveSip(store, name) || ''
  const key = makeKey(algo, sip, name)
  const scope = ['point', 'area'].includes(String(body.scope)) ? String(body.scope) : 'point'
  const enabled = body.enabled === undefined ? 1 : (body.enabled ? 1 : 0)
  const reason = String(body.reason || '').slice(0, 500)
  const db = store.getDb()
  const old = db.prepare(`SELECT created_at FROM ${TABLE} WHERE key_id = ?`).get(key)
  db.prepare(`
    INSERT INTO ${TABLE}(key_id, algo, channel_sip_id, channel_name, scope, reason, enabled, created_at, updated_at, updated_by)
    VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(key_id) DO UPDATE SET
      channel_sip_id=excluded.channel_sip_id, channel_name=excluded.channel_name,
      scope=excluded.scope, reason=excluded.reason, enabled=excluded.enabled,
      updated_at=excluded.updated_at, updated_by=excluded.updated_by
  `).run(key, algo, sip || null, name || null, scope, reason, enabled,
    (old && old.created_at) || nowIso(), nowIso(), String(who || '?'))
  invalidate()
  const got = db.prepare(`SELECT * FROM ${TABLE} WHERE key_id = ?`).get(key)
  return shape(got)
}

function deleteExempt(store, keyId) {
  const db = store.getDb()
  const r = db.prepare(`DELETE FROM ${TABLE} WHERE key_id = ?`).run(String(keyId || ''))
  invalidate()
  return Number(r.changes || 0)
}

/** 批量：接受 [{channelName,...}] 或纯文本（每行一个通道名，可带 # 注释） */
function bulkExempt(store, body, who) {
  let items = Array.isArray(body.items) ? body.items.slice() : []
  if (!items.length && typeof body.text === 'string') {
    items = body.text.split(/\r?\n/).map(s => s.split('#')[0].trim()).filter(Boolean)
      .map(channelName => ({ channelName }))
  }
  if (items.length > 500) throw new Error('单次最多 500 条')
  const out = []
  for (const it of items) {
    try {
      out.push(upsertExempt(store, Object.assign({ algo: body.algo, reason: body.reason, scope: body.scope }, it), who))
    } catch (e) { out.push({ error: String(e.message), raw: it }) }
  }
  return out
}

/** 名单生效影响预演：按名单算「近 N 天有多少条告警属于豁免点位」。只读。 */
function exemptDryRun(store, opts) {
  const algo = String((opts && opts.algo) || ALGO_DEFAULT)
  const days = Math.min(Math.max(Number((opts && opts.days) || 30) || 30, 1), 365)
  const since = new Date(Date.now() - days * 86400000)
  const p = (n) => String(n).padStart(2, '0')
  const sinceSh = since.getUTCFullYear() + '-' + p(since.getUTCMonth() + 1) + '-' + p(since.getUTCDate()) +
    ' ' + p(since.getUTCHours()) + ':' + p(since.getUTCMinutes()) + ':' + p(since.getUTCSeconds())
  const names = listExempt(store, algo, true).filter(x => x.enabled).map(x => x.channelName).filter(Boolean)
  const nameSet = new Set(names)
  const db = store.getDb()
  // 🔴 字段口径（2026-10-11 实测 jsc.db）：
  //   `warnings.warning_type` 存的是**类别码**（iot-video-analysis / growth5h / …），**不是**中文 AI 类型；
  //   中文 AI 类型在 `data_json.aiType`，点位名在 `data_json.channelName`，sip 在 `data_json.channelSipId`；
  //   `created_at` 是**上海时**字符串（YYYY-MM-DD HH:MM:SS），可直接与上海时 since 做字符串比较。
  const row = db.prepare(
    `SELECT COALESCE(json_extract(data_json,'$.channelName'),'') AS ch, count(*) AS n
     FROM warnings WHERE json_extract(data_json,'$.aiType') = ? AND created_at >= ?
     GROUP BY ch ORDER BY n DESC`).all(algo, sinceSh)
  const total = row.reduce((a, b) => a + Number(b.n), 0)
  const hit = row.filter(r => nameSet.has(r.ch)).reduce((a, b) => a + Number(b.n), 0)
  return {
    algo, days, since: sinceSh, now: shNow(),
    total, exempted: hit, kept: total - hit,
    exemptedPct: total ? Math.round(hit / total * 1000) / 10 : null,
    byChannel: row.map(r => ({
      channelName: r.ch || '(空)', count: Number(r.n), exempt: nameSet.has(r.ch),
    })),
    appliedNames: names,
    note: '只读预演：按当前名单计算「哪些点位的告警会被豁免」。不含任何写操作。',
  }
}

/** 自检：名单本身 + 名称能否解析到 sip + 是否有重名 */
function healthCheck(store, algo) {
  const items = listExempt(store, algo, true)
  const items2 = items.map(x => ({
    channelName: x.channelName, enabled: x.enabled,
    sip: x.channelSipId || null,
    sipOk: !!x.channelSipId,
    inIotChannels: x.channelName ? !!resolveSip(store, x.channelName) : false,
  }))
  return {
    algo: algo || ALGO_DEFAULT,
    count: items.length, enabledCount: items.filter(x => x.enabled).length,
    noSip: items2.filter(x => !x.sipOk).map(x => x.channelName),
    notInChannels: items2.filter(x => !x.inIotChannels).map(x => x.channelName),
    items: items2,
  }
}

function registerStackExemptRoutes(app, { store, log, adminOnly } = {}) {
  const adm = adminOnly || ((req, res, next) => {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ ok: false, error: '仅管理员可操作' })
    next()
  })
  const who = (req) => (req.user && req.user.username) || '?'

  // ── 初始化（建表）；失败不得阻断后端启动 ──
  try {
    ensureSchema(store)
    listExempt(store, null, true)
    if (log) log.info('[stack-exempt] 表已就绪：' + TABLE)
  } catch (e) {
    if (log) log.error(`[stack-exempt] 初始化失败（模块已禁用，后端继续启动）: ${e.message}`)
  }

  // ── ① 名单：读 ──
  app.get('/api/stack-exempt', adm, (req, res) => {
    try {
      const algo = String(req.query.algo || ALGO_DEFAULT)
      res.json({ ok: true, algo, items: listExempt(store, algo), version: version(),
                 defaults: { algo: ALGO_DEFAULT, scope: 'point', enabled: true } })
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  // ── ② 候选点位（方便后台勾选：来自 iot_channels，仅含该算法的通道）──
  app.get('/api/stack-exempt/candidates', adm, (req, res) => {
    try {
      const algo = String(req.query.algo || ALGO_DEFAULT)
      const db = store.getDb()
      let rows = []
      try {
        rows = db.prepare('SELECT channel_sip_id, channel_name, ai_types FROM iot_channels ORDER BY channel_name').all()
      } catch { rows = [] }
      const hit = rows.filter(r => {
        const a = String(r.ai_types || '')
        return a.includes(algo) || a === '[]' || a === ''
      }).map(r => ({ channelSipId: r.channel_sip_id, channelName: r.channel_name }))
      let obs = []
      try {
        // 同上：中文 AI 类型在 data_json.aiType（不是 warning_type）
        obs = db.prepare(
          `SELECT COALESCE(json_extract(data_json,'$.channelName'),'') AS channelName, count(*) AS n
           FROM warnings WHERE json_extract(data_json,'$.aiType') = ?
           GROUP BY channelName ORDER BY n DESC LIMIT 50`).all(algo)
          .filter(x => x.channelName)
          .map(x => ({ channelName: x.channelName, observed: Number(x.n) }))
      } catch { obs = [] }
      res.json({ ok: true, algo, channels: hit, observed: obs })
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  // ── ③ 名单：写（单条 upsert）──
  app.put('/api/stack-exempt', adm, (req, res) => {
    try {
      const item = upsertExempt(store, req.body || {}, who(req))
      if (log) log.info(`[stack-exempt] upsert by ${who(req)}：${item.algo} / ${item.channelName || item.channelSipId} enabled=${item.enabled}`)
      res.json({ ok: true, item, items: listExempt(store, item.algo), version: version() })
    } catch (e) { res.status(400).json({ ok: false, error: e.message }) }
  })

  // ── ④ 名单：批量（勾选 or 粘贴文本）──
  app.post('/api/stack-exempt/bulk', adm, (req, res) => {
    try {
      const r = bulkExempt(store, req.body || {}, who(req))
      if (log) log.info(`[stack-exempt] bulk by ${who(req)}：${r.length} 条`)
      res.json({ ok: true, results: r, items: listExempt(store, (req.body || {}).algo), version: version() })
    } catch (e) { res.status(400).json({ ok: false, error: e.message }) }
  })

  // ── ⑤ 名单：删 ──
  app.delete('/api/stack-exempt/:keyId', adm, (req, res) => {
    try {
      const n = deleteExempt(store, decodeURIComponent(req.params.keyId || ''))
      if (log) log.info(`[stack-exempt] delete by ${who(req)}：${req.params.keyId} → ${n}`)
      res.json({ ok: true, deleted: n, items: listExempt(store, null), version: version() })
    } catch (e) { res.status(400).json({ ok: false, error: e.message }) }
  })

  // ── ⑥ 影响预演（只读）：按名单算近 N 天有多少条告警会被豁免 ──
  app.post('/api/stack-exempt/dry-run', adm, (req, res) => {
    try { res.json(Object.assign({ ok: true }, exemptDryRun(store, req.body || {}))) }
    catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  // ── 🆕 S3：真源切换 + 迁移（管理员）──
  app.get('/api/stack-exempt/source', adm, (req, res) => {
    try {
      const src = exemptSource(store)
      const nTable = listFromTable(store, null, true).length
      const nRule = listFromPushRules(store, null).length
      res.json({ ok: true, source: src, tableCount: nTable, pushRuleCount: nRule,
                 note: "source='table'＝读 stack_exempt_points（现行为）；'push_rule'＝读①的 push_rules.exempt" })
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })
  app.post('/api/stack-exempt/source', adm, (req, res) => {
    try {
      const v = setExemptSource(store, (req.body || {}).source)
      if (log) log.info(`[stack-exempt] 真源切换 by ${who(req)} → ${v}`)
      res.json({ ok: true, source: v })
    } catch (e) { res.status(400).json({ ok: false, error: e.message }) }
  })
  app.post('/api/stack-exempt/migrate', adm, (req, res) => {
    try {
      const r = migrateExemptToPushRules(store, who(req))
      if (log) log.info(`[stack-exempt] 迁移到① by ${who(req)}：updated=${r.updated.length} skipped=${r.skipped.length}`)
      res.json(Object.assign({ ok: true }, r))
    } catch (e) { res.status(400).json({ ok: false, error: e.message }) }
  })

  // ── ⑦ 自检 ──
  app.get('/api/stack-exempt/health', adm, (req, res) => {
    try { res.json(Object.assign({ ok: true, version: version(), now: shNow() }, healthCheck(store, req.query.algo))) }
    catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  // ── ⑧ 内网拉取端点（供 11 机堆头链，X-Admin-Token 鉴权）──
  //   与 /api/internal/iot-roi 同构：路径已加进 PUBLIC_PATHS（免 session），安全全靠下面的 token。
  app.get('/api/internal/stack-exempt', (req, res) => {
    const expect = process.env.ALARM_ADMIN_TOKEN || ''
    if (!expect) return res.status(500).json({ ok: false, error: 'server ALARM_ADMIN_TOKEN 未配置' })
    if ((req.get('X-Admin-Token') || '') !== expect) return res.status(403).json({ ok: false, error: 'token 不匹配' })
    try {
      const algo = String(req.query.algo || ALGO_DEFAULT)
      let list = listExempt(store, algo).filter(x => x.enabled)
      const sip = String(req.query.spid || '').trim()
      if (sip) list = list.filter(x => x.channelSipId === sip || x.channelName === sip)
      res.json({
        ok: true, algo, updatedAt: nowIso(), count: list.length,
        // 同时给 sip 与名称两个键：链路按 sip 优先、名称兜底
        items: list.map(x => ({ channelSipId: x.channelSipId, channelName: x.channelName, scope: x.scope, reason: x.reason })),
        sips: list.map(x => x.channelSipId).filter(Boolean),
        names: list.map(x => x.channelName).filter(Boolean),
      })
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  // ── ⑨ 判定函数（供 index.js 其它路由/统计按需调用）──
  return {
    isExempt(algo, sipOrName) {
      const a = String(algo || ALGO_DEFAULT)
      return listExempt(store, a).some(x => x.enabled &&
        (x.channelSipId === sipOrName || x.channelName === sipOrName))
    },
    list: (algo) => listExempt(store, algo),
    dryRun: (opts) => exemptDryRun(store, opts || {}),
  }
}

module.exports = { registerStackExemptRoutes, listExempt, exemptDryRun,
  exemptSource, setExemptSource, listFromPushRules, listFromTable, migrateExemptToPushRules }
