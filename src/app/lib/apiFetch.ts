/**
 * 统一 API 请求工具（会话登录版，替代原 API Key 模式）
 * - 登录后存会话 token 到 localStorage，请求自动附带 Authorization: Bearer <token>
 * - 统一解析后端 { ok, code, error } 错误结构
 * - 401（未登录/会话过期）触发回调，前端跳回登录页
 */

const TOKEN_STORAGE = 'jsc:token'

export function getToken(): string {
  try { return localStorage.getItem(TOKEN_STORAGE) || '' } catch { return '' }
}
export function setToken(token: string) {
  try { localStorage.setItem(TOKEN_STORAGE, token) } catch {}
}
export function clearToken() {
  try { localStorage.removeItem(TOKEN_STORAGE) } catch {}
}

// 向后兼容别名：旧组件用 getApiKey() 取凭证拼 Authorization 头；现统一返回会话 token。
export const getApiKey = getToken

/**
 * 带会话 token 的 fetch 包装：自动附加 Authorization 头，返回原生 Response。
 * 签名与 fetch 完全一致，用于替换裸 fetch('/api/...')，
 * 这样现有 `.then(r => r.json())` 写法无需改动。
 */
export function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = getToken()
  const headers: Record<string, string> = { ...(options.headers as Record<string, string> || {}) }
  if (token) headers['Authorization'] = 'Bearer ' + token
  return fetch(url, { ...options, headers })
}

// 401 回调（由 App 注册，用于跳回登录页）
let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn }

export interface ApiError {
  ok: false
  code?: string
  error: string
  status: number
}

/**
 * 封装 fetch：自动加会话 token 头，返回解析后的 JSON。
 * 失败时抛出 ApiError（含后端的 error 文案）。
 */
export async function apiFetch<T = any>(url: string, options: RequestInit = {}): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  }
  if (token) headers['Authorization'] = 'Bearer ' + token
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json'

  let resp: Response
  try {
    resp = await fetch(url, { ...options, headers })
  } catch (e) {
    throw { ok: false, error: '无法连接后端服务，请确认服务已启动', status: 0 } as ApiError
  }

  if (resp.status === 401) {
    if (onUnauthorized) onUnauthorized()
    let msg = '未登录或会话已过期，请重新登录'
    try { const j = await resp.json(); if (j?.error) msg = j.error } catch {}
    throw { ok: false, code: 'UNAUTHORIZED', error: msg, status: 401 } as ApiError
  }

  if (resp.status === 403) {
    let msg = '权限不足'
    try { const j = await resp.json(); if (j?.error) msg = j.error } catch {}
    throw { ok: false, code: 'FORBIDDEN', error: msg, status: 403 } as ApiError
  }

  if (!resp.ok) {
    let msg = `请求失败 (HTTP ${resp.status})`
    let code
    try { const j = await resp.json(); if (j?.error) msg = j.error; code = j?.code } catch {}
    throw { ok: false, code, error: msg, status: resp.status } as ApiError
  }

  if (resp.status === 204) return undefined as T
  try { return await resp.json() } catch { return undefined as T }
}
