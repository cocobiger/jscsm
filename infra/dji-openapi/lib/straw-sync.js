'use strict'
/**
 * 流联动骨架（阶段 1.1 占位，1.2 完善）
 * 把直播流同步到 straw-engine config.json + 重启检测服务
 * 解决 P0-2：驾驶舱/大疆加流 ≠ 检测引擎加流 的链路断裂
 */
const fs = require('fs')
const { execFile } = require('child_process')

module.exports = (config) => {
  const se = config.strawEngine || {}
  const zlm = config.zlm || {}

  return {
    /**
     * 把一路直播流追加到 straw-engine config.json
     * @param {string} streamId
     * @param {string} url 检测引擎拉流地址（我方 ZLM FLV/HLS）
     */
    addStreamToEngine(streamId, url) {
      const cfg = JSON.parse(fs.readFileSync(se.configPath, 'utf8'))
      const streams = cfg.streams || []
      const exists = streams.some((s) => s.streamId === streamId)
      if (!exists) {
        streams.push({
          streamId,
          url,
          interval: 2.0,
          confSmoke: 0.30,
          confFire: 0.45,
          confHouse: 0.35,
          iou: 0.3,
        })
        cfg.streams = streams
        fs.writeFileSync(se.configPath, JSON.stringify(cfg, null, 2), 'utf8')
        return { ok: true, added: true }
      }
      return { ok: true, added: false }
    },

    /** 重启 straw-engine（使新流生效） */
    restartEngine() {
      return new Promise((resolve) => {
        execFile('systemctl', ['restart', se.service], (err) => {
          resolve({ ok: !err, error: err ? err.message : undefined })
        })
      })
    },
  }
}
