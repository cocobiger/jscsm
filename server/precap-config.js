/**
 * precap-config.js —— 「视频缓存（B′ 回看）」后台配置模块（2026-10-10）
 *
 * 目标：让驾驶舱「AI分析存档 → 视频缓存」面板能直接调 B′ 回看链的参数
 *       （回看档位/锚点延迟/参与通道/写入器 fps·宽度·窗口·质量/总开关），
 *       而不必登 11 机改 systemd。
 *
 * 架构（与 stack-config.js 同构）：
 *   真源在 **11 机** `/soft/data/plate-precap/precap_config.json`（由 11 机接口渲染 drop-in/unit）。
 *   本模块只做「读 → 键名校验 → 转发 → 记账」，不保存第二份配置状态。
 *
 * 上游契约（11 机 alarm_processor :7002，X-Admin-Token 鉴权）：
 *   GET  /precap-config          → {ok, server_time, config_path, config_mtime, values, defaults,
 *                                    tunable(10 键含 type/min/max/desc), readonly(3),
 *                                    live_env, live_consistent, units{6}, channels_map, backups, apply_hint}
 *   POST /precap-config/apply    ← {values:{...}}  → {ok, changed, backups, units?, writer_restarts?,
 *                                                      self_restart_scheduled?, notes, readback, ...}
 *   POST /precap-config/rollback ← {backup:"precap_config.json.bak_YYYYmmdd_HHMMSS"} → 同 apply 结构 + from
 *
 * 🔴 为什么必须代理、不能前端直连 11 机：同 stack —— 浏览器到不了内网；token 绝不下发浏览器。
 *
 * 🔴 生效语义（与 11 机一致，UI 必须显式告知）：
 *   · A 组（回看逻辑：开关/档位/延迟/通道/陈旧判据）——保存后 5 秒自动重启 alarm-processor（≈5s 中断）；
 *   · B 组（写入器：fps/宽度/窗口/质量）——**逐路滚动重启 writer**，每路 ≈30 秒回看缓冲重建，
 *     6 路全改 ≈1 分钟。⚠️ 所以本模块的 fetch 超时上调到 180s（stack 的 20s 不够）。
 */
'use strict'
const fs = require('fs')
const path = require('path')

const BASE = (process.env.ALARM_PROCESSOR_URL || 'http://172.16.8.11:7002').replace(/\/+$/, '')
const TOKEN = process.env.ALARM_ADMIN_TOKEN || ''
const HISTORY_FILE = path.join(__dirname, 'data', 'precap_config_history.json')
// 🔴 B 组 apply 会做 6 路滚动重启（≈57s）⇒ 默认超时给足 180s
const TIMEOUT_MS = Number(process.env.PRECAP_CONFIG_TIMEOUT_MS || 180000)

/** 与 11 机 `PRECAP_TUNABLE` 严格对齐的本地白名单（双保险；值域永远由 11 机判定）。 */
const ALLOW = new Set([
  // A 组：回看逻辑
  'precap_enabled', 'back_s', 'lag_ms', 'task_lag_ms', 'channels', 'max_stale_s',
  // B 组：写入器
  'writer_fps', 'writer_width', 'writer_keep_s', 'writer_q',
])

/** 仅供 UI 做"一键选档"（真正校验永远在 11 机）。 */
const PRESETS = {
  back_s: [
    { label: '0.5, 1, 1.5, 2, 3（现网 · @1s 加密）', value: [0.5, 1, 1.5, 2, 3] },
    { label: '1, 2, 3（历史档位）', value: [1, 2, 3] },
    { label: '1, 2（最早期）', value: [1, 2] },
    { label: '0.5, 1, 1.5（只打近档）', value: [0.5, 1, 1.5] },
  ],
  writer_width: [
    { label: '3840（原生 4K · 现网）', value: 3840 },
    { label: '1920', value: 1920 },
    { label: '1280（旧值）', value: 1280 },
  ],
  writer_fps: [
    { label: '3（现网）', value: 3 },
    { label: '2', value: 2 },
    { label: '5', value: 5 },
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
    try { console.error('[precap-config] 历史写入失败:', e.message) } catch { /* ignore */ }
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

function registerPrecapConfigRoutes(app, { store, log, adminOnly }) {
  const adm = adminOnly || ((req, res, next) => {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ ok: false, error: '仅管理员可操作' })
    next()
  })
  const who = (req) => ({
    by: (req.user && req.user.username) || '?',
    role: (req.user && req.user.role) || '?',
  })

  // ── 总览：现行值 + 10 键定义(含 desc) + 3 只读护栏 + live/file 对比 + 各 unit 参数 + 备份 ──
  app.get('/api/precap-config/status', adm, async (req, res) => {
    const r = await call11('GET', '/precap-config')
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

  // ── 应用：改白名单键（11 机负责校验、备份、渲染 systemd、重启、回读校验）──
  app.post('/api/precap-config/apply', adm, async (req, res) => {
    const b = req.body || {}
    const values = b.values
    if (values === undefined || values === null ||
        typeof values !== 'object' || Array.isArray(values)) {
      return res.status(400).json({ ok: false, error: 'values 需为对象' })
    }
    const vals = {}
    const stripped = []
    for (const [k, v] of Object.entries(values)) {
      // null/undefined 在本配置里没有语义（表示"未显式设置"）——剔除并显式回报，保证"整表保存"安全
      if (v === null || v === undefined) { stripped.push(k); continue }
      vals[k] = v
    }
    const vkeys = Object.keys(vals)
    const bad = vkeys.filter(k => !ALLOW.has(k))
    if (bad.length) return res.status(400).json({ ok: false, error: '不允许修改的键: ' + bad.join(',') })
    if (!vkeys.length) {
      if (stripped.length) {
        return res.status(400).json({ ok: false, error: '没有可写入的值（全部为 null）：' + stripped.join(',') })
      }
      return res.status(400).json({ ok: false, error: 'values 为空' })
    }

    const r = await call11('POST', '/precap-config/apply', { values: vals })
    if (stripped.length && r && typeof r === 'object') {
      r.stripped = stripped
      r.warnings = (r.warnings || []).concat([
        '以下键因值为 null（＝未显式设置）未提交: ' + stripped.join(','),
      ])
    }
    appendHistory(Object.assign({
      action: 'apply', requested: { values: vals }, stripped: stripped.length ? stripped : null,
      result: r.ok ? 'ok' : 'fail',
      changed: r.changed || null, readback: r.readback || null,
      backups: r.backups || null, writer_restarts: r.writer_restarts || null,
      self_restart_scheduled: r.self_restart_scheduled || null,
      error: r.error || null, note: b.note || '',
    }, who(req)))
    if (!r.ok) return res.status(502).json(r)
    if (log) {
      log.info('[precap-config] applied by %s: %s (backups=%s)',
        (req.user && req.user.username), JSON.stringify(r.changed || {}), JSON.stringify(r.backups || {}))
    }
    res.json(r)
  })

  // ── 回滚：从 11 机的某个备份恢复 ──
  app.post('/api/precap-config/rollback', adm, async (req, res) => {
    const b = req.body || {}
    const backup = String(b.backup || '').trim()
    if (!backup) return res.status(400).json({ ok: false, error: 'backup 必填' })
    const r = await call11('POST', '/precap-config/rollback', { backup })
    appendHistory(Object.assign({
      action: 'rollback', requested: { backup }, result: r.ok ? 'ok' : 'fail',
      changed: r.changed || null, readback: r.readback || null,
      backups: r.backups || null, writer_restarts: r.writer_restarts || null,
      self_restart_scheduled: r.self_restart_scheduled || null,
      from: r.from || backup, error: r.error || null, note: b.note || '',
    }, who(req)))
    if (!r.ok) return res.status(502).json(r)
    if (log) log.info('[precap-config] rollback by %s from %s', (req.user && req.user.username), backup)
    res.json(r)
  })

  // ── 备份历史（11 机的真实备份清单）+ 本地操作审计 ──
  app.get('/api/precap-config/history', adm, async (req, res) => {
    const r = await call11('GET', '/precap-config/history')
    res.json({
      ok: true,
      remote: (r && r.ok) ? r : null,
      remote_error: (r && !r.ok) ? (r.error || '上游不可用') : null,
      history: readHistory().slice(0, 50),
    })
  })

  if (log) log.info('视频缓存配置模块已启动（/api/precap-config/*，上游 ' + BASE + '，timeout=' + TIMEOUT_MS + 'ms）')
}

module.exports = { registerPrecapConfigRoutes, PRESETS, ALLOW }
