'use strict'
/**
 * 登录鉴权 + 角色权限（替代原 API Key 模式）
 *
 * - 用户名/密码登录，密码用 Node 自带 crypto.scrypt 加盐哈希（零原生依赖）
 * - 会话 token 存数据库（重启不掉线）；默认有效期 7 天
 * - 三级角色：admin（管理员）/ operator（值守员）/ viewer（访客）
 * - 首次启动若无用户，种默认管理员 admin/admin123（force_change=1）
 *
 * 角色权限矩阵由 index.js 的中间件按路由套用；本模块只负责
 * 用户/会话的增删查与密码校验。
 */
const crypto = require('crypto')
const store = require('./store-db')

const ROLES = ['admin', 'operator', 'viewer']
const ROLE_LEVEL = { viewer: 1, operator: 2, admin: 3 }
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000  // 7 天

let log = { info(){}, warn(){}, error(){}, debug(){} }

// ── 密码哈希（scrypt 加盐）──
function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(String(password), s, 64).toString('hex')
  return { hash, salt: s }
}
// 防时序攻击的比较
function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt)
  const a = Buffer.from(hash, 'hex')
  const b = Buffer.from(expectedHash, 'hex')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function init(logger) {
  if (logger) log = logger
  // 首次启动种默认管理员
  if (store.userCount() === 0) {
    const { hash, salt } = hashPassword('admin123')
    store.insertUser({
      id: crypto.randomUUID(), username: 'admin',
      password_hash: hash, salt, role: 'admin',
      enabled: true, force_change: 1, created_at: new Date().toISOString(),
    })
    log.info('========================================')
    log.info('  已创建默认管理员账号：')
    log.info('    用户名: admin')
    log.info('    密码:   admin123')
    log.info('  首次登录后请立即修改密码！')
    log.info('========================================')
  }
  // 清理过期会话
  try { store.purgeExpiredSessions() } catch {}
}

// ── 登录：校验用户名密码，成功返回 { token, user } ──
function login(username, password) {
  const u = store.userByName(String(username || '').trim())
  if (!u) return { ok: false, error: '用户名或密码错误' }
  if (u.enabled === 0) return { ok: false, error: '该账号已被禁用' }
  if (!verifyPassword(password, u.salt, u.password_hash)) {
    return { ok: false, error: '用户名或密码错误' }
  }
  const token = crypto.randomBytes(32).toString('hex')
  const expires_at = Date.now() + SESSION_TTL_MS
  store.createSession({ token, user_id: u.id, username: u.username, role: u.role, expires_at })
  store.updateUser(u.id, { last_login_at: new Date().toISOString() })
  return {
    ok: true, token,
    user: { id: u.id, username: u.username, role: u.role, forceChange: u.force_change === 1 },
  }
}

function logout(token) { if (token) store.deleteSession(token) }

// 从请求取 token（Authorization: Bearer / X-Auth-Token / ?token= 供 <img> 直链使用）
function extractToken(req) {
  const auth = req.headers['authorization'] || ''
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim()
  const hdr = (req.headers['x-auth-token'] || '').trim()
  if (hdr) return hdr
  const q = req.query && typeof req.query.token === 'string' ? req.query.token.trim() : ''
  return q
}

// 校验 token，返回会话（含 role）或 null
function verify(token) {
  if (!token) return null
  return store.getSession(token)
}

// 改密：校验旧密码后更新；并清除 force_change
function changePassword(userId, oldPassword, newPassword) {
  const u = store.userById(userId)
  if (!u) return { ok: false, error: '用户不存在' }
  if (!verifyPassword(oldPassword, u.salt, u.password_hash)) {
    return { ok: false, error: '原密码错误' }
  }
  if (!newPassword || String(newPassword).length < 6) {
    return { ok: false, error: '新密码至少 6 位' }
  }
  const { hash, salt } = hashPassword(newPassword)
  store.updateUser(userId, { password_hash: hash, salt, force_change: 0 })
  return { ok: true }
}

// 管理员重置某用户密码（无需旧密码）
function adminSetPassword(userId, newPassword, forceChange = true) {
  if (!newPassword || String(newPassword).length < 6) return { ok: false, error: '密码至少 6 位' }
  const { hash, salt } = hashPassword(newPassword)
  const u = store.updateUser(userId, { password_hash: hash, salt, force_change: forceChange ? 1 : 0 })
  if (!u) return { ok: false, error: '用户不存在' }
  // 重置密码后踢掉该用户所有会话
  store.deleteUserSessions(userId)
  return { ok: true }
}

// 创建用户
function createUser({ username, password, role }) {
  username = String(username || '').trim()
  if (!username) return { ok: false, error: '缺少用户名' }
  if (!ROLES.includes(role)) return { ok: false, error: '角色非法' }
  if (!password || String(password).length < 6) return { ok: false, error: '密码至少 6 位' }
  if (store.userByName(username)) return { ok: false, error: '用户名已存在' }
  const { hash, salt } = hashPassword(password)
  const id = crypto.randomUUID()
  store.insertUser({ id, username, password_hash: hash, salt, role, enabled: true, force_change: 0 })
  return { ok: true, user: { id, username, role, enabled: true } }
}

// 角色等级比较：actual 是否 >= required
function roleAtLeast(actual, required) {
  return (ROLE_LEVEL[actual] || 0) >= (ROLE_LEVEL[required] || 99)
}

module.exports = {
  init, login, logout, extractToken, verify, changePassword,
  adminSetPassword, createUser, roleAtLeast, hashPassword, verifyPassword,
  ROLES, ROLE_LEVEL,
}
