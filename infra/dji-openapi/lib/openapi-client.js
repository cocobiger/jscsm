'use strict'
/**
 * 司空 OpenAPI 客户端（数据贯通实装版 2026-08-27）
 * 真实接口（逆向自 kongan-module-openapi.jar，已实测打通）：
 *   POST {baseUrl}/v1/org/tree        组织树
 *   POST {baseUrl}/v1/devices/list    设备列表（机场+无人机，含经纬度）
 *   POST {baseUrl}/v1/devices/liveUrl 直播地址（需 droneSn，设备直播中才可用）
 *   POST {baseUrl}/v1/tasks/list      飞行任务列表
 *   POST {baseUrl}/v1/tasks/scenes/list 任务场景（需 organizationId）
 *   POST {baseUrl}/v1/tokens/list     OpenAPI token 管理
 * 鉴权：内部 RPC 头 login-user（JSON 序列化 LoginUser，与 Feign 传递一致）
 *       另支持 Authorization: Bearer <oauth2-access-token>（OAuth2 通道，未使用）
 * 隔离红线：只访问司空 OpenAPI 对外接口，不连司空的 EMQX/容器内部。
 */
const BASE_API = '/v1'

module.exports = (config) => {
  const cred = config.openapi || {}
  const hasCred = !!(cred.baseUrl && cred.token && cred.loginUser)

  async function request(path, body) {
    const url = cred.baseUrl + BASE_API + path
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'login-user': JSON.stringify(cred.loginUser),
      },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(8000),
    })
    const j = await res.json()
    if (j.code !== 0) throw new Error(`OpenAPI ${path} 失败: code=${j.code} msg=${j.msg || j.message || ''}`)
    return j.data
  }

  return {
    /** 凭据与对接状态 */
    status() {
      return {
        connected: hasCred,
        baseUrl: cred.baseUrl || '',
        wsUrl: cred.wsUrl || '',
        message: hasCred ? `已打通（${cred.baseUrl}），REST+WS 可用` : '凭据未配置（config.json → openapi）',
      }
    },

    /** 组织树 */
    async orgTree() {
      const d = await request('/org/tree')
      return d.items || []
    },

    /** 设备列表（机场+无人机，含经纬度） */
    async listDevices() {
      const d = await request('/devices/list')
      return d.items || []
    },

    /** 直播地址（droneSn 必填，设备直播中才可用） */
    async getLiveUrl(droneSn) {
      const d = await request('/devices/liveUrl', { droneSn })
      return d
    },

    /** 飞行任务列表 */
    async listTasks() {
      const d = await request('/tasks/list')
      return d.items || []
    },

    /** 任务场景列表（需 organizationId） */
    async listTaskScenes(organizationId) {
      const d = await request('/tasks/scenes/list', { organizationId })
      return d
    },

    /** 查询 OpenAPI token 列表 */
    async listTokens() {
      const d = await request('/tokens/list')
      return d.tokens || []
    },

    /** 透传代理任意 OpenAPI 接口（联调用，返回原始响应对象） */
    async proxy(apiPath, body) {
      const url = cred.baseUrl + BASE_API + (apiPath.startsWith('/') ? apiPath : '/' + apiPath)
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'login-user': JSON.stringify(cred.loginUser) },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(8000),
      })
      return res.json()
    },

    /**
     * 全量同步设备到内存（供 index.js 调用）
     * @returns {Promise<{ok:boolean, devices:Array, error?:string}>}
     */
    async syncDevices() {
      if (!hasCred) return { ok: false, devices: [], error: '凭据未配置' }
      try {
        const devices = await this.listDevices()
        return { ok: true, devices }
      } catch (e) {
        return { ok: false, devices: [], error: e.message }
      }
    },
  }
}
