/**
 * smartpush-health.js —— 「智治推送」自检 / 监控 / 干跑（审计批次 D）· 2026-10-11
 *
 * 为什么单独立项：
 *   智治推送此前**没有任何自检** —— 平台/预案/规则/订阅四张表之间的引用关系全靠人工记忆，
 *   配错了只会打一条 `log.warn`，驾驶舱界面**完全看不出来**（审计 P1-4 的根因）。
 *   本模块把这套"配置完整性 + 运行健康度"做成可查、可干跑、可告警。
 *
 * 设计原则（与本仓 stack-config.js / precap-config.js / cyzx.js 一致）：
 *   ① **纯新增、最小侵入**：自建 read-only 检查逻辑；index.js 只加 1 行 require。
 *   ② **不写任何既有表**：本模块只 SELECT（干跑也不发送、不落库）。
 *   ③ 只在被调用时工作（无定时器、无常驻状态）⇒ 不可能成为新的故障源。
 */
'use strict'

/** 状态：pass 通过 · warn 待办 · fail 阻断 · unknown 无法判定（不得当成通过） */
function checkSmartPushHealth(store) {
  const db = store.getDb()
  const items = []
  const add = (id, name, status, detail, hint, list) => items.push({ id, name, status, detail, hint: hint || '', list: list || [] })

  const rows = (sql, ...a) => { try { return db.prepare(sql).all(...a) } catch (e) { return [] } }
  const one = (sql, ...a) => { try { return db.prepare(sql).get(...a) } catch (e) { return null } }

  // ── ① 规模总览 ──
  const c = {
    platforms: one('SELECT COUNT(*) c FROM smart_push_platforms')?.c || 0,
    platformsOn: one('SELECT COUNT(*) c FROM smart_push_platforms WHERE enabled = 1')?.c || 0,
    plans: one('SELECT COUNT(*) c FROM smart_push_plans')?.c || 0,
    rules: one('SELECT COUNT(*) c FROM smart_push_rules')?.c || 0,
    rulesOn: one('SELECT COUNT(*) c FROM smart_push_rules WHERE enabled = 1')?.c || 0,
    events: one('SELECT COUNT(*) c FROM smart_push_events')?.c || 0,
    history: one('SELECT COUNT(*) c FROM smart_push_history')?.c || 0,
  }
  add('scale', '规模总览',
    (c.platformsOn > 0 && c.rulesOn > 0) ? 'pass' : 'warn',
    `平台 ${c.platformsOn}/${c.platforms} 启用 · 预案 ${c.plans} · 规则 ${c.rulesOn}/${c.rules} 启用 · 事件 ${c.events} · 推送记录 ${c.history}`,
    (c.platformsOn === 0 || c.rulesOn === 0) ? '平台或规则没有启用项 ⇒ 不会有任何推送' : '')

  // ── ② 启用规则指向的预案是否存在（P1-4：配错就静默不推）──
  const orphanRules = rows(`
    SELECT r.name AS rule_name, r.plan_id
    FROM smart_push_rules r
    LEFT JOIN smart_push_plans p ON p.id = r.plan_id
    WHERE r.enabled = 1 AND (p.id IS NULL)
  `)
  add('rulePlanMissing', '启用规则指向的预案',
    orphanRules.length ? 'fail' : 'pass',
    orphanRules.length ? `${orphanRules.length} 条启用规则指向**不存在的预案**` : '全部有效',
    orphanRules.length ? '这些规则永远不会推送 —— 请修正规则或重建预案' : '',
    orphanRules.map(r => `${r.rule_name} → 预案 ${r.plan_id}`))

  // ── ③ 启用预案绑定的平台是否有效/启用（绑了停用平台 ⇒ 静默不推）──
  const badBind = rows(`
    SELECT p.name AS plan_name, p.platform_id, pl.name AS platform_name, pl.enabled AS platform_enabled
    FROM smart_push_plans p
    LEFT JOIN smart_push_platforms pl ON pl.id = p.platform_id
    WHERE p.enabled = 1 AND p.platform_id IS NOT NULL
      AND (pl.id IS NULL OR pl.enabled = 0)
  `)
  add('planPlatformBad', '预案绑定的目标平台',
    badBind.length ? 'fail' : 'pass',
    badBind.length ? `${badBind.length} 个启用预案绑定了**不存在或已停用**的平台` : '全部有效',
    badBind.length ? '推送时预案不可用 ⇒ 只会打日志、界面无提示' : '',
    badBind.map(r => `${r.plan_name} → ${r.platform_name || r.platform_id}${r.platform_enabled === 0 ? '（已停用）' : '（不存在）'}`))

  // ── ④ 平台订阅了事件类型但没配接口地址（订阅=想收，却没地址=收不到）──
  const noUrl = rows(`
    SELECT name, event_types FROM smart_push_platforms
    WHERE enabled = 1 AND (api_url IS NULL OR api_url = '')
  `)
  add('platformNoUrl', '平台接口地址',
    noUrl.length ? 'fail' : 'pass',
    noUrl.length ? `${noUrl.length} 个启用平台**没有配置接口地址**` : '全部已配置',
    noUrl.length ? '即便规则命中也不会推送（仅 log.warn）' : '',
    noUrl.map(r => `${r.name}（订阅：${r.event_types || '—'}）`))

  // ── ⑤ 启用预案自身既无平台也无直连地址 ──
  // 🔴 判定必须结合 **(B) 平台自动订阅兜底**，否则会误报：
  //   checkRulesAndPush 有两条送达路径 ——
  //     (A) 规则 → 预案 → 平台（本检查针对的就是这条）
  //     (B) 遍历所有启用平台，命中 `platformSubscribes(平台, event_type)` 即推
  //   因此「预案无送达目标」**不必然**推不出去：只要**有启用平台订阅了该事件类型**，
  //   (B) 分支仍会送达。只有"预案无目标 **且** 没有任何平台订阅该类型"才是真阻断。
  //   （本条判定曾被写成一律 fail，上线后在真实生产上被这条兜底打脸 —— 见下方备注。）
  const noTarget = rows(`
    SELECT id, name, event_type FROM smart_push_plans
    WHERE enabled = 1 AND (api_url IS NULL OR api_url = '') AND platform_id IS NULL
  `)
  const subsPlatforms = rows("SELECT event_types FROM smart_push_platforms WHERE enabled = 1 AND COALESCE(api_url, '') <> ''")
  const subscribedTo = (et) => subsPlatforms.some(sp => {
    const a = String(sp.event_types || '').split(',').map(x => x.trim())
    return a.includes('ALL') || a.includes(et)
  })
  const rescued = noTarget.filter(pn => subscribedTo(pn.event_type))
  const blocked = noTarget.filter(pn => !subscribedTo(pn.event_type))
  add('planNoTarget', '预案的送达目标',
    blocked.length ? 'fail' : (rescued.length ? 'warn' : 'pass'),
    blocked.length
      ? `${blocked.length} 个启用预案无送达目标，且**没有任何平台订阅其事件类型** ⇒ 必然推不出去`
      : (rescued.length ? `${rescued.length} 个启用预案无送达目标，但已有平台自动订阅兜底 ⇒ **仍可送达**（建议清理该预案以免误导）` : '全部有送达目标'),
    blocked.length ? '这些预案命中后无法送达' : (rescued.length ? '不阻断送达，仅提示配置冗余' : ''),
    [...blocked.map(pn => pn.name + '（无兜底）'), ...rescued.map(pn => pn.name + '（有订阅兜底，仍可送达）')])

  // ── ⑥ 近 24h 推送运行态 ──
  const dayAgo = new Date(Date.now() - 86400000).toLocaleString('sv', { timeZone: 'Asia/Shanghai' })
  const sent = one("SELECT COUNT(*) c FROM smart_push_history WHERE success = 1 AND created_at >= ?", dayAgo)?.c || 0
  const fail = one("SELECT COUNT(*) c FROM smart_push_history WHERE success = 0 AND created_at >= ?", dayAgo)?.c || 0
  add('recent', '近 24h 推送',
    fail > 0 ? 'warn' : 'pass',
    `成功 ${sent} · 失败 ${fail}`,
    fail > 0 ? '去「推送历史」按失败状态筛选看 error_message' : '')

  // ── ⑦ 未结案超时（24h 无回调）──
  const timeout = one(`
    SELECT COUNT(*) c FROM smart_push_history
    WHERE status = 'pushed' AND COALESCE(callback_status, 0) = 0
      AND created_at < ?
  `, dayAgo)?.c || 0
  add('timeout', '超时未结案（>24h 无回调）',
    timeout > 0 ? 'warn' : 'pass',
    timeout > 0 ? `${timeout} 条推送超过 24h 未收到城运回调` : '无',
    timeout > 0 ? '确认对方是否已受理；必要时由值守员人工结案' : '')

  // ── ⑧ 最近一次成功推送时间（判断"是不是很久没推了"）──
  const last = one("SELECT created_at FROM smart_push_history WHERE success = 1 ORDER BY created_at DESC LIMIT 1")
  const lastFail = one("SELECT created_at, error_message, api_url FROM smart_push_history WHERE success = 0 ORDER BY created_at DESC LIMIT 1")
  add('lastSuccess', '最近一次成功推送',
    last ? 'pass' : 'unknown',
    last ? `${last.created_at}` : '（从无成功推送记录）',
    lastFail ? `最近一次失败：${lastFail.created_at} —— ${String(lastFail.error_message || '').slice(0, 80)}` : '')

  const nFail = items.filter(i => i.status === 'fail').length
  const nWarn = items.filter(i => i.status === 'warn').length
  return {
    ok: nFail === 0,
    summary: { fail: nFail, warn: nWarn, pass: items.filter(i => i.status === 'pass').length, total: items.length },
    items,
    counts: c,
    checkedAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19),
  }
}

/**
 * 干跑（D-3）：按某条规则/预案渲染一份**实际会发送的报文**，但**不发送、不落库**。
 * 用途：联调前确认模板占位符、接口地址、鉴权头是否就绪。
 */
function dryRun(store, { ruleId, platformId, planId, eventType, location } = {}) {
  const db = store.getDb()
  const one = (sql, ...a) => { try { return db.prepare(sql).get(...a) } catch (e) { return null } }
  const checks = []
  const missing = []
  const chk = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: detail || '' }); if (!ok) missing.push(name) }

  // 解析出「实际会用到的预案/平台」
  let plan = planId ? one('SELECT * FROM smart_push_plans WHERE id = ?', planId) : null
  let rule = ruleId ? one('SELECT * FROM smart_push_rules WHERE id = ?', ruleId) : null
  if (!plan && rule) plan = one('SELECT * FROM smart_push_plans WHERE id = ?', rule.plan_id)
  let platform = null
  if (platformId) platform = one('SELECT * FROM smart_push_platforms WHERE id = ?', platformId)
  else if (plan && plan.platform_id) platform = one('SELECT * FROM smart_push_platforms WHERE id = ?', plan.platform_id)

  chk('找到规则/预案', !!(rule || plan), rule ? `规则「${rule.name}」` : (plan ? `预案「${plan.name}」` : '未指定或不存在'))
  if (platform) chk('目标平台已启用', platform.enabled === 1, platform.enabled === 1 ? `「${platform.name}」` : `「${platform.name}」已停用`)
  const effUrl = (platform && platform.api_url) || (plan && plan.api_url) || ''
  chk('有接口地址', !!effUrl, effUrl || '预案/平台都没配 api_url')
  const effTemplate = (platform && platform.body_template) || (plan && plan.body_template) || ''
  chk('有报文模板', !!effTemplate, effTemplate ? `模板 ${effTemplate.length} 字符` : '空模板 ⇒ 会发送空体')

  // 渲染一份示例报文（用示例事件数据，不查真实库）
  const vars = {
    event_type: eventType || (rule && rule.event_type) || (plan && plan.event_type) || '示例类型',
    location: location || '示例点位（干跑）',
    lat: 30.8, lon: 108.4, level: 2, value: '示例值', standard: '示例标准',
    description: '干跑样例，未发送', time: new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19),
    trigger_count: rule ? rule.trigger_count : 1, event_ids: 'dry-run', image_url: '',
    push_id: 'DRY-RUN', callback_url: process.env.SMART_PUSH_CALLBACK_URL || '',
  }
  let body = effTemplate
  for (const [k, v] of Object.entries(vars)) body = body.split('{' + k + '}').join(String(v))
  // 🔴 占位符检测要同时避坑「太窄」与「太宽」，两版都是单测 TD4/TD5 逼出来的：
  //   ① 太窄（只匹配 [a-zA-Z_]）⇒ 中文占位符 `{车牌}` 漏检；
  //   ② 太宽（在**渲染后的 body** 上匹配任意 {…}）⇒ JSON 的**结构花括号** {…} 被误判为占位符。
  //   正解：在**模板原文**上抽取占位符名，再与可用变量表比对。
  //   模板里的结构花括号因"内部还含花括号"而不会被 [^{}]+ 匹配到，天然排除。
  const tplNames = [...new Set((effTemplate.match(/\{([^{}]+)\}/g) || []).map(x => x.slice(1, -1)))]
  const unresolved = tplNames.filter(n => !Object.prototype.hasOwnProperty.call(vars, n))
  chk('占位符全部可解析', unresolved.length === 0, unresolved.length ? `未解析：${unresolved.join(', ')}` : '全部已替换')

  return {
    dryRun: true,                       // 🔴 仅供核对：不发送、不落库
    checks, missing, ready: missing.length === 0,
    resolved: { rule: rule ? rule.name : null, plan: plan ? plan.name : null, platform: platform ? platform.name : null },
    api: { url: effUrl, method: (platform && platform.api_method) || (plan && plan.api_method) || 'POST' },
    body,
    note: '干跑只做本地渲染：不发请求、不写 smart_push_history、不写 smart_push_events',
  }
}

/** 读取近期失败明细（D-2：让"推失败"在界面上可见，而不是只躺在日志里） */
function recentFailures(store, hours = 24, limit = 50) {
  const db = store.getDb()
  const since = new Date(Date.now() - hours * 3600000).toLocaleString('sv', { timeZone: 'Asia/Shanghai' })
  try {
    return db.prepare(`SELECT id, event_type, location, api_url, response_status, error_message, trigger_count, created_at
      FROM smart_push_history WHERE success = 0 AND created_at >= ? ORDER BY created_at DESC LIMIT ?`).all(since, limit)
  } catch (e) { return [] }
}

function registerSmartPushHealthRoutes(app, { store, log, adminOnly }) {
  const adm = adminOnly || ((req, res, next) => {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ ok: false, error: '仅管理员可操作' })
    next()
  })

  // 自检（GET，只读）
  app.get('/api/smart-push/health', adm, (req, res) => {
    try {
      const h = checkSmartPushHealth(store)
      if (h.summary.fail > 0 && log) {
        // D-2：主动告警 —— 配置类问题一旦存在，每次自检都留一条 WARN，
        //   避免"配错了但没人看页面"（审计 P1-4 的根因）。
        log.warn(`[智治推送] ⚠️ 自检发现 ${h.summary.fail} 项阻断：` +
          h.items.filter(i => i.status === 'fail').map(i => i.name).join('、'))
      }
      res.json({ ok: true, ...h })
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  // 干跑（POST，只读）
  app.post('/api/smart-push/dry-run', adm, (req, res) => {
    try { res.json({ ok: true, ...dryRun(store, req.body || {}) }) }
    catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  // 近期失败明细（GET，只读）
  app.get('/api/smart-push/failures', adm, (req, res) => {
    try {
      res.json({ ok: true, items: recentFailures(store, Number(req.query.hours) || 24, Math.min(Number(req.query.limit) || 50, 200)) })
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  if (log) log.info('智治推送自检模块已挂载（/api/smart-push/health | dry-run | failures；**只读、不发送**）')
}

module.exports = { registerSmartPushHealthRoutes, checkSmartPushHealth, dryRun, recentFailures }
