'use strict'
/**
 * 司空 OpenAPI 实时 OSD WebSocket 客户端（2026-08-27 实装）
 * 端点：ws://172.28.0.108:48089/apisocket/osd?token=<openapi_user_token>
 * 鉴权：query token 或 X-Token header（拦截器 getByToken 查 openapi_user_token 表）
 * 数据：机场 OSD（deviceType=0）/ 无人机 OSD（deviceType=1）实时遥测
 *       → 解析后交 telemetry.record()（自动触发 target-locator 目标定位）
 * 可靠性：断线自动重连（指数退避 3s→30s）+ 心跳保活（30s ping）
 */
const MAX_RETRY = 3

module.exports = (config, telemetry) => {
  const cred = config.openapi || {}
  let ws = null
  let closed = false
  let retryCount = 0
  let lastMessageAt = 0
  let framesReceived = 0
  let lastError = ''

  function buildUrl() {
    const base = cred.wsUrl || 'ws://172.28.0.108:48089/apisocket/osd'
    const sep = base.includes('?') ? '&' : '?'
    return `${base}${sep}token=${encodeURIComponent(cred.token || '')}`
  }

  function connect() {
    if (closed) return
    const url = buildUrl()
    try {
      ws = new WebSocket(url)
    } catch (e) {
      lastError = `创建 WebSocket 失败: ${e.message}`
      scheduleReconnect()
      return
    }

    ws.onopen = () => {
      retryCount = 0
      lastError = ''
      console.log(`[ws-osd] 已连接 ${url}`)
    }

    ws.onmessage = (ev) => {
      framesReceived++
      lastMessageAt = Date.now()
      try {
        const msg = JSON.parse(String(ev.data))
        // 握手确认帧：{message:"Connected...", deviceTypes:[...]}
        if (msg.message && msg.deviceTypes) {
          console.log(`[ws-osd] 握手成功: ${msg.message}`)
          return
        }
        // 遥测帧：{data:{...OSD字段}, deviceType:0|1}
        const data = msg.data || msg
        const deviceType = msg.deviceType != null ? msg.deviceType : null
        const deviceSn = data.dockSn || data.sn || data.deviceSn || (deviceType === 1 ? data.childSn : '')
        if (deviceSn) {
          telemetry.record(deviceSn, { ...data, _deviceType: deviceType })
        }
      } catch (e) {
        lastError = `解析 OSD 消息失败: ${e.message}`
      }
    }

    ws.onclose = (ev) => {
      if (closed) return
      lastError = `连接关闭 code=${ev.code} reason=${ev.reason || ''}`
      console.warn(`[ws-osd] 断开(${ev.code})，重连中...`)
      scheduleReconnect()
    }

    ws.onerror = (ev) => {
      lastError = 'WebSocket 错误'
    }
  }

  function scheduleReconnect() {
    if (closed) return
    const delay = Math.min(3000 * Math.pow(2, retryCount), 30000)
    retryCount++
    setTimeout(connect, delay)
  }

  // 心跳保活（30s ping）
  const heartbeat = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send('ping')
      if (Date.now() - lastMessageAt > 60000 && lastMessageAt > 0) {
        // 超过 60s 无数据，主动重连
        try { ws.close() } catch (e) {}
      }
    }
  }, 30000)

  return {
    start() {
      closed = false
      connect()
    },
    stop() {
      closed = true
      clearInterval(heartbeat)
      if (ws) { try { ws.close() } catch (e) {} }
    },
    status() {
      return {
        connected: !!(ws && ws.readyState === WebSocket.OPEN),
        state: ws ? ws.readyState : -1,
        framesReceived,
        lastMessageAt: lastMessageAt ? new Date(lastMessageAt).toISOString() : null,
        retryCount,
        lastError,
      }
    },
  }
}
