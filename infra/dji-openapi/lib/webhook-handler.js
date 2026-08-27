'use strict'
/**
 * 司空 Sync webhook 接收处理（2026-08-27 真实格式适配版）
 * 真实推送（逆向自 WebhookServiceImpl，实测确认）：
 *   POST {webhookUrl}  Content-Type: application/json
 *   headers: User-Agent: KongAn-Cloud-Webhook/1.0
 *            X-Event-Type: LIVE_STATUS_CHANGE | FLIGHT_TASK_STATUS_CHANGE | FILE_UPLOAD_COMPLETE
 *            X-Event-ID: <事件ID>
 *            X-Signature: HMAC-SHA256(body, webhookSecret) hex 小写（有 secret 时）
 *   body: WebhookEventDTO JSON（{data:{...}, deviceType, eventType, eventId, timestamp, tenantId...}）
 * 事件类型（/v1/webhook/event-types）：
 *   FILE_UPLOAD_COMPLETE 文件上传完成 / FLIGHT_TASK_STATUS_CHANGE 飞行任务状态变更 / LIVE_STATUS_CHANGE 直播状态变更
 * 记录：原始 headers + body 落盘 data/webhook/，便于联调校准
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

module.exports = (config) => {
  const cred = config.openapi || {}
  const dataDir = config.dataDir
  const logDir = path.join(dataDir, 'webhook')
  let receivedCount = 0
  let lastEvent = null

  function record(rawHeaders, body) {
    try {
      fs.mkdirSync(logDir, { recursive: true })
      fs.writeFileSync(
        path.join(logDir, `push_${Date.now()}.json`),
        JSON.stringify({ ts: new Date().toISOString(), headers: rawHeaders, body: String(body).slice(0, 8000) }, null, 2)
      )
    } catch (e) {
      console.warn('[webhook] 记录失败:', e.message)
    }
  }

  /** 签名验证：HMAC-SHA256(webhook_secret, body) → hex 小写（hutool HMac.digestHex） */
  function verifySignature(rawHeaders, body) {
    const sig = rawHeaders['x-signature'] || rawHeaders['signature'] || ''
    const secret = cred.signatureSecret
    if (!sig || !secret) return { ok: !sig, reason: sig ? '密钥未配置' : '无签名头（未启用签名）' }
    const expected = crypto.createHmac('sha256', String(secret)).update(String(body)).digest('hex')
    const ok = expected.toLowerCase() === String(sig).toLowerCase()
    return { ok, reason: ok ? '签名验证通过 (HMAC-SHA256)' : `签名不匹配 (expected=${expected.slice(0, 16)}...)` }
  }

  /** 内容解密骨架：AES（加密密钥），模式待真实事件校准（当前事件体为明文 JSON） */
  function decryptBody(rawBody) {
    try {
      const j = JSON.parse(String(rawBody))
      return { ok: true, plain: String(rawBody), parsed: j }
    } catch (e) {
      return { ok: false, reason: `非 JSON: ${e.message}`, plain: String(rawBody), parsed: null }
    }
  }

  /**
   * 推送分类处理：真实事件（X-Event-Type 优先）→ live/telemetry/event
   * @returns {{type:string, handled:boolean, detail:string, eventType?:string}}
   */
  function classify(rawHeaders, parsed) {
    const eventType = rawHeaders['x-event-type'] || ''
    const eventId = rawHeaders['x-event-id'] || ''
    if (eventType === 'LIVE_STATUS_CHANGE') {
      return { type: 'live', handled: false, detail: `直播状态变更 event=${eventId}`, eventType }
    }
    if (eventType === 'FLIGHT_TASK_STATUS_CHANGE') {
      return { type: 'task', handled: false, detail: `飞行任务状态变更 event=${eventId}`, eventType }
    }
    if (eventType === 'FILE_UPLOAD_COMPLETE') {
      return { type: 'media', handled: false, detail: `文件上传完成 event=${eventId}`, eventType }
    }
    // 无事件头时按 body 特征兜底
    const body = (parsed && (parsed.data || parsed)) || {}
    const method = parsed?.method || parsed?.type || body.method || body.type || ''
    const m = String(method).toLowerCase()
    const sn = body.sn || body.deviceSn || body.dockSn || (body.device && body.device.sn) || ''
    if (m.includes('live') || m.includes('stream') || body.url || body.live) {
      return { type: 'live', handled: false, detail: `live 推送 sn=${sn}` }
    }
    if (m.includes('telemetry') || m.includes('state') || m.includes('position') || body.longitude || body.gps) {
      return { type: 'telemetry', handled: false, detail: `telemetry 推送 sn=${sn}` }
    }
    if (m.includes('event') || m.includes('task') || m.includes('flight')) {
      return { type: 'event', handled: false, detail: `event 推送 ${method} sn=${sn}` }
    }
    return { type: 'unknown', handled: false, detail: `未知推送 ${method || eventType || '(无)'} sn=${sn}`, eventType }
  }

  return {
    /** 处理一次 webhook 推送 */
    handle(rawHeaders, rawBody) {
      receivedCount++
      record(rawHeaders, rawBody)

      const sigCheck = verifySignature(rawHeaders, rawBody)
      const dec = decryptBody(rawBody)
      const cls = classify(rawHeaders, dec.parsed)
      lastEvent = { ts: new Date().toISOString(), eventType: cls.eventType || null, detail: cls.detail, signature: sigCheck.ok }

      return {
        ok: true,
        signature: sigCheck,
        decrypt: { ok: dec.ok, reason: dec.reason },
        classified: cls,
      }
    },

    status() {
      return { received: receivedCount, lastEvent }
    },
  }
}
