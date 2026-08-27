'use strict'
/**
 * 司空 ZLM 直播流监视器（2026-08-27 第 2 批）
 * 替代 webhook LIVE_STATUS_CHANGE 的可靠路径（司空 webhook test 为假推送，真实事件低频）：
 *   轮询司空 ZLM getMediaList → 发现 app=live 新流（司空原生直播，stream=机场/无人机 SN）
 *   → ① mirror：我方 ZLM addStreamProxy 拉流（不经司空转发链路检测兜底）
 *   → ② straw-engine 加流检测（写 config + 重启）
 *   → ③ 事件记录（/api/events 可见）
 * 隔离红线：只读司空 ZLM REST API（getMediaList/addStreamProxy 不在司空写），不改司空任何配置。
 */
const http = require('http')
const crypto = require('crypto')

function jget(url, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    http.get(url, (r) => {
      let d = ''
      r.on('data', (c) => (d += c))
      r.on('end', () => {
        try { resolve(JSON.parse(d)) } catch (e) { reject(new Error('JSON 解析失败: ' + e.message)) }
      })
    }).on('error', reject).setTimeout(timeoutMs, function () { this.destroy(new Error('timeout')) })
  })
}

module.exports = (config, opts) => {
  const sk = config.sikongZlm || {}
  const zlm = config.zlm || {}
  const intervalMs = opts.intervalMs || 15000
  const known = new Map() // stream -> { firstSeen, mirrored, engineAdded }
  let timer = null
  let lastError = ''

  /** 司空 ZLM 播放鉴权 token（ZLM 官方: md5(secret + req_path + expire_ts)） */
  function playToken(app, stream) {
    if (!sk.tokenSecret) return ''
    const expire = Math.floor(Date.now() / 1000) + (sk.tokenExpire || 3600)
    const sign = crypto.createHash('md5').update(`${sk.tokenSecret}/${app}/${stream}${expire}`).digest('hex')
    return `&token=${expire}_${sign}`
  }

  /** 把司空流 mirror 到我方 ZLM（addStreamProxy 拉流） */
  async function mirrorToOurZlm(stream) {
    const app = sk.liveApp || 'live'
    const srcUrl = `${sk.rtmp}/${app}/${stream}?secret=${sk.secret}${playToken(app, stream)}`
    const targetStream = `sikong_${stream}`
    const api = `${zlm.http}/index/api/addStreamProxy?secret=${zlm.secret}` +
      `&vhost=__defaultVhost__&app=${encodeURIComponent(zlm.app || 'jsc')}&stream=${encodeURIComponent(targetStream)}` +
      `&url=${encodeURIComponent(srcUrl)}&retry_count=0&enable_hls=0&enable_mp4=0`
    const j = await jget(api)
    return { ok: j.code === 0, targetStream, srcUrl: srcUrl.replace(sk.secret, '***'), result: j }
  }

  /** 轮询司空 ZLM 流列表，发现新流联动 */
  async function tick() {
    const url = `${sk.http}/index/api/getMediaList?secret=${sk.secret}`
    let list
    try {
      const j = await jget(url)
      list = Array.isArray(j.data) ? j.data : []
      lastError = ''
    } catch (e) {
      lastError = e.message
      return
    }

    const liveStreams = list.filter((m) => m.app === (sk.liveApp || 'live'))
    const current = new Set(liveStreams.map((m) => m.stream))

    // 新流出现
    for (const m of liveStreams) {
      if (known.has(m.stream)) continue
      const info = { firstSeen: new Date().toISOString(), mirrored: null, engineAdded: null, schema: m.schema }
      known.set(m.stream, info)
      const ev = { ts: info.firstSeen, type: 'LIVE_STATUS_CHANGE', classified: 'live', deviceSn: m.stream, detail: `司空流出现 ${m.app}/${m.stream}(${m.schema})`, source: 'zlm-watcher' }
      opts.onEvent && opts.onEvent(ev)
      console.log(`[zlm-watcher] 司空直播流出现: ${m.app}/${m.stream} → mirror+检测`)

      // ① mirror 到我方 ZLM
      try {
        const mr = await mirrorToOurZlm(m.stream)
        info.mirrored = mr
        if (mr.ok) {
          opts.onEvent && opts.onEvent({ ts: new Date().toISOString(), type: 'LIVE_MIRROR', classified: 'live', deviceSn: m.stream, detail: `已 mirror 到我方 ZLM jsc/sikong_${m.stream}`, source: 'zlm-watcher' })
          // ② straw-engine 加流检测
          try {
            const flvUrl = `${zlm.http}/${zlm.app || 'jsc'}/sikong_${m.stream}.live.flv`
            const add = opts.strawSync.addStreamToEngine(`sikong_${m.stream}`, flvUrl)
            const restart = await opts.strawSync.restartEngine()
            info.engineAdded = { add, restart }
            opts.onEvent && opts.onEvent({ ts: new Date().toISOString(), type: 'LIVE_ENGINE', classified: 'live', deviceSn: m.stream, detail: `straw-engine 已加流 sikong_${m.stream}（restart=${restart.ok}）`, source: 'zlm-watcher' })
          } catch (e) {
            console.warn('[zlm-watcher] 引擎加流失败:', e.message)
          }
        } else {
          console.warn('[zlm-watcher] mirror 失败:', JSON.stringify(mr.result).slice(0, 200))
        }
      } catch (e) {
        console.warn('[zlm-watcher] mirror 异常:', e.message)
      }
    }

    // 流消失
    for (const [stream, info] of known) {
      if (!current.has(stream)) {
        opts.onEvent && opts.onEvent({ ts: new Date().toISOString(), type: 'LIVE_STATUS_CHANGE', classified: 'live', deviceSn: stream, detail: `司空流消失 ${stream}（存活 ${Math.round((Date.now() - new Date(info.firstSeen).getTime()) / 1000)}s）`, source: 'zlm-watcher' })
        known.delete(stream)
      }
    }
  }

  return {
    start() { timer = setInterval(tick, intervalMs); tick() },
    stop() { if (timer) clearInterval(timer) },
    status() {
      return {
        running: !!timer,
        watching: Array.from(known.entries()).map(([s, i]) => ({ stream: s, ...i })),
        lastError,
        intervalMs,
      }
    },
    playToken, // 导出供联调测试
  }
}
