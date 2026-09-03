'use strict'
/**
 * P0 源流定档：直播开启自动锁定 1080P（2026-09-03 实证落地）
 *
 * 背景：司空直播流(ZLM mirror)档位 AUTO 不定（720p↔1080p），straw-engine 检测抽帧源像素量不稳。
 * P0 = 直播会话中固定 HIGH_DEFINITION(1080P)，使检测源稳定 1080p（瓶颈排序：源帧分辨率 > imgsz > 骨干）。
 *
 * 逆向实证（system 服务 kongan-module-system-biz.jar / LiveController）：
 *   GET /admin-api/system/live/setLiveVideoQuality/{dockSn}/{deviceSn}/{quality}   ← 直播中即时调档
 *   GET /admin-api/system/live/getLiveStatus/{dockSn}/{deviceSn}                    ← 读会话状态/当前档位
 *   system 服务内网 172.28.0.103:48081（宿主机 bridge 可达）
 *   鉴权：login-user 头（JSON 序列化 LoginUser，租户超管，与 Feign 内部传递一致）
 *   quality Integer：0=AUTO 1=SMOOTH 2=STANDARD_DEFINITION 3=HIGH_DEFINITION(1080P) 4=ULTRA_HD
 *   写语义 = WebSocket LIVE_SET_QUALITY 实时下发机场固件，非落库持久配置：
 *     - 机场在线即生效（无人机在仓不影响下发）
 *     - 直播未开启时返回 code 1002031012「直播未开启」→ 需等会话就绪后重试
 *   webhook 触发：司空 LIVE_STATUS_CHANGE 事件（data.status=LIVE_ON/LIVE_OFF，顶层含 dockSn/deviceSn）
 *
 * 幂等闭环：LIVE_ON → 轮询 getLiveStatus 至会话就绪 → 读回 videoQuality 已为 HIGH_DEFINITION 则跳过
 *           → 否则下发 setLiveVideoQuality/{dockSn}/{deviceSn}/3，直播未开启 1002031012 则退避重试。
 */
const QUALITY = {
  AUTO: 0,
  SMOOTH: 1,
  STANDARD_DEFINITION: 2,
  HIGH_DEFINITION: 3,
  ULTRA_HD: 4,
}

module.exports = (config) => {
  const cred = config.openapi || {}
  const sysBase = 'http://172.28.0.103:48081' // 司空 system 服务（kongan-module-system-biz），勿改
  // 默认锁 1080P；可通过 config.liveQualityLock 覆盖（{enabled, quality, retries, retryDelayMs}）
  const opt = Object.assign(
    { enabled: true, quality: QUALITY.HIGH_DEFINITION, retries: 10, retryDelayMs: 3000 },
    config.liveQualityLock || {}
  )

  const history = [] // 最近定档尝试（ring 20 条）
  function log(level, msg) {
    const line = `[qualityLock] ${msg}`
    if (level === 'warn') console.warn(line)
    else if (level === 'error') console.error(line)
    else console.log(line)
    history.push({ ts: new Date().toISOString(), level, msg })
    if (history.length > 20) history.shift()
  }

  function headers() {
    const lu = cred.loginUser || {}
    return { 'Content-Type': 'application/json', 'login-user': JSON.stringify(lu) }
  }

  async function getLiveStatus(dockSn, deviceSn) {
    const url = `${sysBase}/admin-api/system/live/getLiveStatus/${dockSn}/${deviceSn}`
    const r = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(8000) })
    const j = await r.json()
    if (j && j.code === 0 && j.data) return { ok: true, data: j.data }
    return { ok: false, code: j && j.code, msg: j && j.msg }
  }

  async function setQuality(dockSn, deviceSn, q) {
    const url = `${sysBase}/admin-api/system/live/setLiveVideoQuality/${dockSn}/${deviceSn}/${q}`
    const r = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(30000) })
    const j = await r.json()
    return { ok: !!(j && j.code === 0), code: j && j.code, msg: j && j.msg }
  }

  /** 读回档位是否为目标档（getLiveStatus.data.videoQuality 序列化为枚举名或 code） */
  function alreadyLocked(data) {
    const vq = data && data.videoQuality
    if (vq === null || vq === undefined) return false
    if (typeof vq === 'number') return vq === opt.quality
    return String(vq).toUpperCase() === 'HIGH_DEFINITION'
  }

  /**
   * 直播开启后尝试锁定档位（幂等 + 退避）。
   * @returns {Promise<'ok'|'skip'|'timeout'|'disabled'|'param'>}
   */
  async function tryLock(dockSn, deviceSn) {
    if (!opt.enabled) { log('warn', `定档已禁用(disabled) ${dockSn}/${deviceSn}`); return 'disabled' }
    if (!dockSn || !deviceSn) { log('warn', `缺 dockSn/deviceSn 不执行`); return 'param' }
    log('info', `LIVE_ON ${dockSn}/${deviceSn} 尝试锁定档位 ${opt.quality}(目标HD=3 1080P)`)
    const seen = {}
    for (let i = 1; i <= opt.retries; i++) {
      // 1) 会话就绪探测 + 档位幂等读回
      const st = await getLiveStatus(dockSn, deviceSn)
      if (st.ok && alreadyLocked(st.data)) {
        log('info', `${dockSn}/${deviceSn} 当前已是 HIGH_DEFINITION，跳过（幂等）`)
        return 'skip'
      }
      // 2) 下发定档（直播未就绪时 system 会返回 1002031012 → 退避重试）
      const r = await setQuality(dockSn, deviceSn, opt.quality)
      if (r.ok) {
        log('info', `${dockSn}/${deviceSn} 定档成功 → quality=${opt.quality} (第${i}次尝试)`)
        return 'ok'
      }
      if (r.code === 1002031012) {
        log('info', `${dockSn}/${deviceSn} 直播未开启(1002031012)，第${i}次退避 ${opt.retryDelayMs}ms`)
      } else {
        log('warn', `${dockSn}/${deviceSn} 定档失败 code=${r.code} msg=${r.msg} (第${i}次)`)
        // 非「直播未开启」类错误无重试意义，直接放弃
        return 'fail'
      }
      await new Promise((res) => setTimeout(res, opt.retryDelayMs))
    }
    log('warn', `${dockSn}/${deviceSn} ${opt.retries} 次尝试后仍未定档（直播可能已结束），seen=${JSON.stringify(seen)}`)
    return 'timeout'
  }

  return { tryLock, QUALITY, history: () => history.slice(), status: () => ({ enabled: opt.enabled, quality: opt.quality, retries: opt.retries, history: history.slice() }) }
}
