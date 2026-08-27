'use strict'
/**
 * 直播接入骨架（阶段 1.1 占位，1.2 完善）
 * 设计：无人机/机场 RTMP 直推我方 ZLM(1936)（不经司空转发，避开直播分钟数限制）
 * 隔离：用我方 ZLM 端口 1936/6080，不碰司空 ZLM(1935/9080/10443)
 */
const http = require('http')

module.exports = (config) => {
  const zlm = config.zlm || {}
  const streams = new Map() // streamId -> { url, createdAt, status }

  return {
    /** 直播流列表 */
    list() {
      return Array.from(streams.entries()).map(([id, s]) => ({ streamId: id, ...s }))
    },

    /**
     * 添加一路直播流（1.2 时由 openapi-client.getLiveUrl 驱动自动建流）
     * @param {string} streamId
     * @param {string} pushUrl 无人机 RTMP 直推地址（指向我方 ZLM 1936）
     */
    addStream(streamId, pushUrl) {
      streams.set(streamId, {
        pushUrl,
        createdAt: new Date().toISOString(),
        status: 'pending',
      })
      return { ok: true, streamId, pushUrl }
    },

    /**
     * 校验推流已到达我方 ZLM（通过 ZLM HTTP API 查询流）
     * @param {string} streamId
     */
    async checkPublish(streamId) {
      try {
        const url = `${zlm.http}/api/v1/getMediaList?app=jsc&stream=${streamId}&secret=${zlm.secret}`
        const body = await new Promise((resolve, reject) => {
          http.get(url, (r) => {
            let d = ''
            r.on('data', (c) => (d += c))
            r.on('end', () => resolve(d))
          }).on('error', reject)
        })
        const j = JSON.parse(body)
        const ok = j.code === 0 && (j.data || []).some((m) => m.stream === streamId)
        if (streams.has(streamId)) streams.get(streamId).status = ok ? 'live' : 'no_publish'
        return { ok, streamId }
      } catch (e) {
        return { ok: false, error: e.message }
      }
    },

    /** 移除流 */
    removeStream(streamId) {
      streams.delete(streamId)
      return { ok: true }
    },
  }
}
