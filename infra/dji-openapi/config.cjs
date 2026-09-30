'use strict'
/**
 * dji-openapi 配置加载器 = config.json（模板/默认） + SIKONG_* 环境变量覆盖
 *
 * 为什么这样做
 *   司空2 每次重新部署后，会给出【全新的 apikey / 登录用户 / webhook 密钥 / ZLM 密钥】。
 *   若把真值写进仓库里的 config.json：① 违反 skill 红线"真实凭据不进 git"；② 每次要手改 8 处占位符，极易漏配。
 *   改为：真值放 systemd EnvironmentFile（/data/HBJSC/dji-openapi/dji-openapi.env，权限 600），
 *         本模块在启动时覆盖到 config 上 ⇒ 换 key = 改 env + 重启（用 set-sikong-key.sh 一条命令）。
 *
 * 环境变量（未设或为空 ⇒ 忽略，沿用 config.json 的值）
 *   SIKONG_BASE_URL            → openapi.baseUrl
 *   SIKONG_API_KEY             → openapi.token            ★ 司空给的 apikey（OpenAPI user token）
 *   SIKONG_WS_URL              → openapi.wsUrl
 *   SIKONG_LOGIN_USER_ID       → openapi.loginUser.id
 *   SIKONG_LOGIN_USER_TYPE     → openapi.loginUser.userType
 *   SIKONG_LOGIN_TENANT_ID     → openapi.loginUser.tenantId
 *   SIKONG_APP_ID              → openapi.appId            （webhook APP_KEY）
 *   SIKONG_SIGNATURE_SECRET    → openapi.signatureSecret  （webhook HMAC-SHA256 密钥）
 *   SIKONG_ENCRYPTION_SECRET   → openapi.encryptionSecret （AES 密钥）
 *   SIKONG_ZLM_HTTP            → sikongZlm.http
 *   SIKONG_ZLM_RTMP            → sikongZlm.rtmp
 *   SIKONG_ZLM_SECRET          → sikongZlm.secret
 *   SIKONG_ZLM_TOKEN_SECRET    → sikongZlm.tokenSecret
 * 兼容别名：DJI_OPENAPI_TOKEN → SIKONG_API_KEY
 *
 * 命名：用 .cjs 后缀 —— 本仓库根 package.json 是 "type":"module"（前端工程），
 *       同目录下的 .js 会被 Node 当 ESM（module.exports 失效、require 返回 {}）；
 *       dji-openapi 是 CJS 服务，故显式用 .cjs 使其与 package.json 的 type 无关。
 */
const base = require('./config.json')

const env = process.env
const pick = (...names) => {
  for (const n of names) {
    const v = env[n]
    if (v !== undefined && String(v).trim() !== '') return String(v).trim()
  }
  return undefined
}
const asNum = (v) => (v === undefined ? undefined : (/^-?\d+$/.test(v) ? Number(v) : v))

// 深拷贝：多个消费者共享同一份，避免相互污染
const cfg = JSON.parse(JSON.stringify(base))
const set = (obj, key, val) => { if (val !== undefined) obj[key] = val }

cfg.openapi = cfg.openapi || {}
cfg.openapi.loginUser = cfg.openapi.loginUser || {}
set(cfg.openapi, 'baseUrl', pick('SIKONG_BASE_URL'))
set(cfg.openapi, 'token', pick('SIKONG_API_KEY', 'DJI_OPENAPI_TOKEN'))
set(cfg.openapi, 'wsUrl', pick('SIKONG_WS_URL'))
set(cfg.openapi.loginUser, 'id', asNum(pick('SIKONG_LOGIN_USER_ID')))
set(cfg.openapi.loginUser, 'userType', asNum(pick('SIKONG_LOGIN_USER_TYPE')))
set(cfg.openapi.loginUser, 'tenantId', asNum(pick('SIKONG_LOGIN_TENANT_ID')))
set(cfg.openapi, 'appId', pick('SIKONG_APP_ID'))
set(cfg.openapi, 'signatureSecret', pick('SIKONG_SIGNATURE_SECRET'))
set(cfg.openapi, 'encryptionSecret', pick('SIKONG_ENCRYPTION_SECRET'))

cfg.sikongZlm = cfg.sikongZlm || {}
set(cfg.sikongZlm, 'http', pick('SIKONG_ZLM_HTTP'))
set(cfg.sikongZlm, 'rtmp', pick('SIKONG_ZLM_RTMP'))
set(cfg.sikongZlm, 'secret', pick('SIKONG_ZLM_SECRET'))
set(cfg.sikongZlm, 'tokenSecret', pick('SIKONG_ZLM_TOKEN_SECRET'))

// 启动时打印"哪些被环境变量覆盖"（只打键名，不打值），便于排障
const KEYS = [
  'SIKONG_BASE_URL', 'SIKONG_API_KEY', 'SIKONG_WS_URL',
  'SIKONG_LOGIN_USER_ID', 'SIKONG_LOGIN_USER_TYPE', 'SIKONG_LOGIN_TENANT_ID',
  'SIKONG_APP_ID', 'SIKONG_SIGNATURE_SECRET', 'SIKONG_ENCRYPTION_SECRET',
  'SIKONG_ZLM_HTTP', 'SIKONG_ZLM_RTMP', 'SIKONG_ZLM_SECRET', 'SIKONG_ZLM_TOKEN_SECRET',
]
const overridden = KEYS.filter((k) => pick(k) !== undefined)
if (overridden.length) {
  console.log(`[config] 环境变量已覆盖 ${overridden.length} 项: ${overridden.join(', ')}`)
} else {
  console.log('[config] 未检测到 SIKONG_* 环境变量，使用 config.json 内的值')
}
// 提示缺失的关键凭据（不打印值），司空重新部署后对着这里补齐即可
const missing = []
if (!cfg.openapi.token || /^REPLACE_WITH/.test(cfg.openapi.token)) missing.push('openapi.token(SIKONG_API_KEY)')
if (!cfg.openapi.loginUser.tenantId) missing.push('openapi.loginUser.tenantId(SIKONG_LOGIN_TENANT_ID)')
if (!cfg.openapi.appId || /^REPLACE_WITH/.test(cfg.openapi.appId)) missing.push('openapi.appId(SIKONG_APP_ID)')
if (missing.length) console.warn(`[config] ⚠️ 关键凭据仍是占位/缺失: ${missing.join(', ')} —— 用 set-sikong-key.sh 注入`)

module.exports = cfg
