/**
 * 登录/会话相关封装
 */
import { apiFetch, setToken, clearToken, getToken } from './apiFetch'

export type Role = 'admin' | 'operator' | 'viewer'

export interface CurrentUser {
  id: string
  username: string
  role: Role
  forceChange?: boolean
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: '管理员',
  operator: '值守员',
  viewer: '访客',
}

const ROLE_LEVEL: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 }
export function roleAtLeast(actual: Role | undefined, required: Role): boolean {
  if (!actual) return false
  return ROLE_LEVEL[actual] >= ROLE_LEVEL[required]
}

/** 登录：成功后存 token，返回用户信息 */
export async function login(username: string, password: string): Promise<CurrentUser> {
  const r = await apiFetch<{ ok: boolean; token: string; user: CurrentUser }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  if (r?.token) setToken(r.token)
  return r.user
}

/** 登出：清后端会话 + 本地 token */
export async function logout(): Promise<void> {
  try { await apiFetch('/api/auth/logout', { method: 'POST' }) } catch {}
  clearToken()
}

/** 用当前 token 取登录用户；无效返回 null */
export async function fetchMe(): Promise<CurrentUser | null> {
  if (!getToken()) return null
  try {
    const r = await apiFetch<{ ok: boolean; user: CurrentUser }>('/api/auth/me')
    return r?.user || null
  } catch { return null }
}

/** 改自己密码 */
export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  await apiFetch('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ oldPassword, newPassword }),
  })
}
