'use strict'
/**
 * 驾驶舱「微信登录」后端模块 · 2026-10-13（P2）
 * ============================================================================
 * 位置：秸秆焚烧监控 → 责任映射 / 微信群推送（`StrawMonitorPage` 的 responsibility tab）
 *
 * 六个端点（**全部 adminOnly**）：
 *   GET  /api/wechat/status          在线状态（代理桥 /login-state + 本地二维码码龄 + 是否正在重置）
 *   GET  /api/wechat/qr              当前登录二维码 PNG（读本机文件；no-store；已登录时 409）
 *   POST /api/wechat/qr/refresh      请求刷新二维码（落 reset.request 标志 → 202 异步）
 *   GET  /api/wechat/targets         可推送会话清单（代理桥 /sessions + 归一化 + 服务端拼 webhook）
 *   POST /api/wechat/test-send       向指定会话发一条测试消息（复用 index.js 的 sendWechatPush）
 *   GET/PUT /api/wechat/default-target   全局默认推送对象（kv_config）
 *
 * ── 安全（改动前必读）────────────────────────────────────────────────────
 *   * **二维码 = 该微信号的登录凭据**：谁拿到谁就能登。因此本模块所有路由一律 `adminOnly`，
 *     且**绝不能**加进 index.js 的 PUBLIC_PATHS / PREFIX_PATHS。
 *   * PNG 响应必须 `no-store`，禁掉浏览器与中间代理缓存。
 *   * 不把二维码内容写进任何操作日志。
 *
 * ── 架构决策（对应评估报告 §4）──────────────────────────────────────────
 *   * 二维码下发走 **后端读本地文件**（后端与守护同在 226）：方案 A。
 *     不走「桥新增 /qr」（桥在 Windows，拿不到 Linux 上的文件，会重复实现守护的逻辑），
 *     更不走 nginx 静态暴露（那会绕过 adminOnly，等于把登录令牌放公网）。
 *   * 刷新走 **标志文件**：由 226 上的 `wx-qr-keepalive.service` 消费。
 *     ⇒ **重置动作只归守护一家**，不会出现"两处同时 taskkill 微信"的竞态；
 *       后端也不需要 root / 不需要 SSH 凭据。
 *   * 真源只有两处：**DB（kv_config）** 与 **文件系统（wxb_qr/）**。本模块只做代理与缓存，
 *     **不建第二份真源**（避免"界面显示 A、实际跑 B"）。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────────
 *   * 纯新增、最小侵入：不碰 warnings / 研判闸门 / 两条推送链路；
 *     index.js 只加 1 行 require，且**必须放在 adminOnly 定义之后**（TDZ 会崩进程）。
 *   * 时间一律上海时 UTC+8（手工换算，禁 toLocaleString / 本地时区）。
 */

const fs = require('fs')
const path = require('path')

// ── 配置（env 只作首次初始化，改了要重启；运行期配置放 DB）────────────────
const BRIDGE_BASE = (process.env.WECHAT_BRIDGE_URL || 'http://172.16.8.16:18888').replace(/\/+$/, '')
// 下发给前端的 webhook 值也用这里拼 —— 地址只在这一处写死，避免散落到前端
const WEBHOOK_BASE = (process.env.WECHAT_BRIDGE_WEBHOOK_BASE || BRIDGE_BASE).replace(/\/+$/, '')
const QR_DIR = process.env.WECHAT_QR_DIR || '/data/HBJSC/wxb_qr'
const QR_PNG = path.join(QR_DIR, 'latest.png')
const QR_META = path.join(QR_DIR, 'latest.json')
const RESET_FLAG = path.join(QR_DIR, 'reset.request')
const DEFAULT_TARGET_KEY = 'wechat_default_target'

const PROXY_TIMEOUT_MS = Number(process.env.WECHAT_PROXY_TIMEOUT_MS || 60000)
const STATUS_TTL_MS = Number(process.env.WECHAT_STATUS_TTL_MS || 3000)
const TARGETS_TTL_MS = Number(process.env.WECHAT_TARGETS_TTL_MS || 30000)
const RESET_PENDING_MS = Number(process.env.WECHAT_RESET_PENDING_MS || 120000)

/** 上海时 UTC+8 格式化（项目约定：不用 toLocaleString / 不用本地时区） */
function shTime(d) {
  const t = new Date((d ? d.getTime() : Date.now()) + 8 * 3600 * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ` +
         `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`
}

/** 会话名 → 推送地址。与后端 sendWechatPush 的桥识别正则 /:18888(\/|$|\?)/ 一致 */
function webhookFor(name) {
  return WEBHOOK_BASE + '/send?group=' + encodeURIComponent(String(name || ''))
}

function errMsg(e) {
  return (e && e.message) ? e.message : String(e)
}

/** 读守护产出的 latest.json（拿二维码码龄）；读不到就返回 null */
function readQrMeta() {
  try {
    const m = JSON.parse(fs.readFileSync(QR_META, 'utf8'))
    const changedAt = Number(m.changed_at) || null
    return {
      changedAt,
      changedAtText: changedAt ? shTime(new Date(changedAt * 1000)) : null,
      ageSec: changedAt ? Math.max(0, Math.round(Date.now() / 1000 - changedAt)) : null,
      md5: m.md5 || null,
      bytes: m.bytes || null,
    }
  } catch (e) {
    return null
  }
}

function qrPngExists() {
  try { return fs.statSync(QR_PNG).isFile() && fs.statSync(QR_PNG).size > 0 } catch (e) { return false }
}

/** 透传桥的 GET；桥挂掉/超时都收敛成可读错误，不把异常抛给调用方 */
async function bridgeGet(pathname, timeoutMs) {
  const url = BRIDGE_BASE + pathname
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs || PROXY_TIMEOUT_MS) })
  const txt = await resp.text()
  let json
  try { json = JSON.parse(txt) } catch (e) { json = null }
  return { httpStatus: resp.status, json, raw: json ? null : txt.slice(0, 300) }
}

function registerWechatLoginRoutes(app, { store, log, adminOnly, sendWechatPush }) {
  // 与其它新模块同构：adminOnly 缺失时自兜底（保证独立可测）
  const adm = adminOnly || ((req, res, next) => {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ ok: false, error: '仅管理员可操作' })
    next()
  })

  // ── 桥状态：3s 结果缓存 + 并发去重（前端 5s 轮询，不能把请求全压到桥上）──
  let statusCache = { at: 0, data: null }
  let statusInflight = null

  async function getBridgeStatus(force) {
    const now = Date.now()
    if (!force && statusCache.data && now - statusCache.at < STATUS_TTL_MS) {
      return { ...statusCache.data, cacheAgeMs: now - statusCache.at }
    }
    if (statusInflight) return statusInflight     // 去重：并发轮询共用同一次请求
    statusInflight = (async () => {
      try {
        const r = await bridgeGet('/login-state' + (force ? '?force=1' : ''), PROXY_TIMEOUT_MS)
        const d = (r.json && typeof r.json === 'object') ? r.json : {}
        const out = {
          reachable: true,
          httpStatus: r.httpStatus,
          loggedIn: !!d.logged_in,
          via: d.via || null,
          driver: d.driver || null,
          self: d.self || null,
          wechatVersion: d.wechat_version || null,
          sessionsCount: (d.sessions_count === undefined ? null : d.sessions_count),
          groupsCount: (d.groups_count === undefined ? null : d.groups_count),
          loginWindow: !!d.login_window,
          mainWindow: !!d.main_window,
          windows: Array.isArray(d.windows) ? d.windows : [],
          error: d.error || '',
        }
        statusCache = { at: Date.now(), data: out }
        return out
      } catch (e) {
        const out = { reachable: false, loggedIn: false, error: '桥不可达: ' + errMsg(e) }
        statusCache = { at: Date.now(), data: null }
        return out
      } finally {
        statusInflight = null
      }
    })()
    return statusInflight
  }

  // ── ① 在线状态 ────────────────────────────────────────────────────────
  app.get('/api/wechat/status', adm, async (req, res) => {
    try {
      const force = ['1', 'true', 'yes'].includes(String(req.query.force || ''))
      const st = await getBridgeStatus(force)
      const meta = readQrMeta()
      let resetting = false
      let resetAgeSec = null
      try {
        const s = fs.statSync(RESET_FLAG)
        resetting = true
        resetAgeSec = Math.max(0, Math.round((Date.now() - s.mtimeMs) / 1000))
      } catch (e) { /* 无标志文件 = 不在重置中 */ }
      res.json({
        ok: true,
        loggedIn: st.loggedIn,
        via: st.via,
        driver: st.driver,
        self: st.self,
        wechatVersion: st.wechatVersion,
        sessionsCount: st.sessionsCount,
        groupsCount: st.groupsCount,
        loginWindow: st.loginWindow,
        mainWindow: st.mainWindow,
        bridge: { reachable: st.reachable, httpStatus: st.httpStatus || null, error: st.error || '' },
        qr: {
          available: qrPngExists(),
          ageSec: meta ? meta.ageSec : null,
          changedAtText: meta ? meta.changedAtText : null,
          md5: meta ? meta.md5 : null,
        },
        resetting,
        resetAgeSec,
        // 「码龄」超这个值就该提示用户刷新（二维码实测 2–5 分钟有效期）
        qrStaleSec: Number(process.env.WECHAT_QR_STALE_SEC || 150),
        defaultTarget: store.kvGet(DEFAULT_TARGET_KEY, null),
      })
    } catch (e) {
      res.status(500).json({ ok: false, error: errMsg(e) })
    }
  })

  // ── ② 二维码 PNG ──────────────────────────────────────────────────────
  // ⚠️ 这是**登录令牌**：adminOnly + no-store；已在服务端挡住"已登录还要码"的情况。
  app.get('/api/wechat/qr', adm, (req, res) => {
    try {
      const st = statusCache.data
      // 只在「确定已登录」（有缓存且为真）时拒绝，避免桥不可达时把正常功能也挡掉
      if (st && st.loggedIn === true) {
        return res.status(409).json({ ok: false, error: '微信已登录，当前无二维码可显示' })
      }
      if (!qrPngExists()) {
        return res.status(404).json({ ok: false, error: '二维码尚未生成（保活守护可能未运行）' })
      }
      res.setHeader('Content-Type', 'image/png')
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
      res.setHeader('Pragma', 'no-cache')
      res.setHeader('Expires', '0')
      const s = fs.createReadStream(QR_PNG)
      s.on('error', (e) => {
        if (log) log.warn(`[微信登录] 读二维码失败: ${errMsg(e)}`)
        if (!res.headersSent) res.status(500).json({ ok: false, error: errMsg(e) })
        else res.destroy()
      })
      s.pipe(res)
    } catch (e) {
      res.status(500).json({ ok: false, error: errMsg(e) })
    }
  })

  // ── ③ 请求刷新二维码（异步）────────────────────────────────────────────
  // 实现：只落一个标志文件，真正的重置由 226 上的 wx-qr-keepalive 执行。
  //   为什么不在这里直接 taskkill：后端跑在 User=jsc 下，杀 Windows 进程需要 SSH 凭据
  //   （在 /root 下，600）；而且两处同时重置会互相打架。
  app.post('/api/wechat/qr/refresh', adm, (req, res) => {
    try {
      let existed = null
      try {
        const s = fs.statSync(RESET_FLAG)
        existed = Math.max(0, Math.round((Date.now() - s.mtimeMs) / 1000))
      } catch (e) { /* 不存在 */ }

      if (existed !== null && existed * 1000 < RESET_PENDING_MS) {
        return res.status(202).json({
          ok: true, status: 'resetting', alreadyPending: true, pendingSec: existed,
          hint: '已在重置中，请稍候（守护最迟 30 秒内动手，约 1 分钟出新的二维码）',
        })
      }
      fs.writeFileSync(RESET_FLAG, JSON.stringify({
        at: Date.now(), atText: shTime(), by: (req.user && (req.user.username || req.user.name)) || 'admin',
      }))
      if (log) log.info(`[微信登录] 收到手动刷新二维码请求（by=${(req.user && req.user.username) || 'admin'}）`)
      res.status(202).json({
        ok: true, status: 'resetting',
        hint: '已请求重置；守护最迟 30 秒内动手，约 1 分钟出新码',
      })
    } catch (e) {
      res.status(500).json({ ok: false, error: '无法写入重置标志（检查 ' + QR_DIR + ' 权限）: ' + errMsg(e) })
    }
  })

  // ── ④ 可推送会话清单 ──────────────────────────────────────────────────
  let targetsCache = { at: 0, data: null }
  let targetsInflight = null

  async function getTargets(force) {
    const now = Date.now()
    if (!force && targetsCache.data && now - targetsCache.at < TARGETS_TTL_MS) {
      return { ...targetsCache.data, cacheAgeMs: now - targetsCache.at }
    }
    if (targetsInflight) return targetsInflight
    targetsInflight = (async () => {
      try {
        const r = await bridgeGet('/sessions' + (force ? '?force=1' : ''), PROXY_TIMEOUT_MS)
        const d = (r.json && typeof r.json === 'object') ? r.json : {}
        const norm = (arr, kind) => (Array.isArray(arr) ? arr : [])
          .map((x) => ({
            name: String(x && x.name || '').trim(),
            wxid: (x && x.wxid) || '',
            memberCount: (x && x.member_count !== undefined) ? x.member_count : null,
            kind,
            webhook: webhookFor(x && x.name),
          }))
          .filter((x) => x.name)
        const out = {
          reachable: true,
          loggedIn: !!d.logged_in,
          driver: d.driver || null,
          error: d.error || '',
          groups: norm(d.groups, 'group'),
          contacts: norm(d.contacts, 'contact'),
        }
        out.counts = { groups: out.groups.length, contacts: out.contacts.length }
        targetsCache = { at: Date.now(), data: out }
        return out
      } catch (e) {
        const out = { reachable: false, loggedIn: false, error: '桥不可达: ' + errMsg(e), groups: [], contacts: [], counts: { groups: 0, contacts: 0 } }
        targetsCache = { at: Date.now(), data: null }
        return out
      } finally {
        targetsInflight = null
      }
    })()
    return targetsInflight
  }

  app.get('/api/wechat/targets', adm, async (req, res) => {
    try {
      const force = ['1', 'true', 'yes'].includes(String(req.query.force || ''))
      const q = String(req.query.q || '').trim().toLowerCase()
      const d = await getTargets(force)
      const hit = (x) => !q || (x.name + ' ' + x.wxid).toLowerCase().includes(q)
      const groups = d.groups.filter(hit)
      const contacts = d.contacts.filter(hit)
      res.json({
        ok: true,
        loggedIn: d.loggedIn,
        driver: d.driver,
        error: d.error,
        bridge: { reachable: d.reachable },
        groups,
        contacts,
        counts: { groups: groups.length, contacts: contacts.length },
        total: d.counts || { groups: d.groups.length, contacts: d.contacts.length },
        cacheAgeMs: d.cacheAgeMs || 0,
        // ⚠️ "列得出来" ≠ "发得出去"：发送走桥的 resolve_group()，它是在**最近会话**里
        //    按关键字匹配的。对"从未在微信里打开过"的群能否发送，需要实测确认。
        caveat: '未在微信「最近会话」出现过的群/人，可能无法发送；请先在该微信号上打开一次目标会话',
      })
    } catch (e) {
      res.status(500).json({ ok: false, error: errMsg(e) })
    }
  })

  // ── ⑤ 发测试消息 ──────────────────────────────────────────────────────
  app.post('/api/wechat/test-send', adm, async (req, res) => {
    try {
      if (typeof sendWechatPush !== 'function') {
        return res.status(500).json({ ok: false, error: 'sendWechatPush 未注入，模块注册有误' })
      }
      const body = req.body || {}
      const name = String(body.target || '').trim()
      let webhook = String(body.webhook || '').trim()
      if (!webhook) {
        if (!name) return res.status(400).json({ ok: false, error: '需要 target（会话名）或 webhook' })
        webhook = webhookFor(name)
      }
      if (!/^https?:\/\//i.test(webhook)) {
        return res.status(400).json({ ok: false, error: 'webhook 必须是 http(s) 地址' })
      }

      const who = (req.user && (req.user.username || req.user.name)) || 'admin'
      const content = [
        `**🔔 微信推送测试 · ${name || '自定义地址'}**`,
        `- 来源：驾驶舱「微信登录」功能点`,
        `- 时间：${shTime()}`,
        `- 操作人：${who}`,
        `> 收到本条即表示该会话可用于秸秆告警推送。`,
      ].join('\n')

      const r = await sendWechatPush(webhook, { msgtype: 'markdown', markdown: { content } },
        { retries: 1, retryDelayMs: 3000, timeout: 30000, label: 'wechat-test-send' })

      // 落一条审计日志（不含二维码；只记目标与结果）
      if (log) log.info(`[微信登录] 测试发送 → ${name || webhook} ok=${r.ok} errcode=${r.errcode} attempts=${r.attempts}`)
      if (targetsCache.data) targetsCache.at = 0       // 发送成功与否都可能改变会话顺序，下次强制刷新

      res.json({
        ok: !!r.ok,
        errcode: r.errcode,
        errmsg: r.errmsg || '',
        isVerifyFP: !!r.isVerifyFP,
        attempts: r.attempts,
        target: name || null,
        // 桥的已知误报：errcode=-1 且 errmsg 含 verify/target= —— 消息其实已发出
        note: r.isVerifyFP ? '桥返回的失败是已知误报（verify 校验误判），消息通常已实际发出' : '',
      })
    } catch (e) {
      res.status(500).json({ ok: false, error: errMsg(e) })
    }
  })

  // ── ⑥ 全局默认推送对象（方案 C：逐行为主、全局兜底）──────────────────────
  // ⚠️ 本阶段只提供"读写配置"。真正让推送链路回落到它，属于 P3 的 T16
  //    （要改 index.js 的 strawWorkflow，需单独一步 + 单独验收）。
  app.get('/api/wechat/default-target', adm, (req, res) => {
    try { res.json({ ok: true, target: store.kvGet(DEFAULT_TARGET_KEY, null) }) }
    catch (e) { res.status(500).json({ ok: false, error: errMsg(e) }) }
  })

  app.put('/api/wechat/default-target', adm, (req, res) => {
    try {
      const b = req.body || {}
      const name = String(b.target || '').trim()
      if (!name && !b.clear) {
        return res.status(400).json({ ok: false, error: '需要 target（会话名），或传 clear=true 清空' })
      }
      const value = (!name || b.clear) ? null : {
        name,
        kind: (b.kind === 'contact') ? 'contact' : 'group',
        webhook: webhookFor(name),
        setBy: (req.user && (req.user.username || req.user.name)) || 'admin',
        setAt: shTime(),
      }
      store.kvSet(DEFAULT_TARGET_KEY, value)
      res.json({ ok: true, target: value })
    } catch (e) {
      res.status(500).json({ ok: false, error: errMsg(e) })
    }
  })

  if (log) {
    log.info('[微信登录] 路由已注册: /api/wechat/{status,qr,qr/refresh,targets,test-send,default-target}')
  }
}

module.exports = { registerWechatLoginRoutes, webhookFor }
