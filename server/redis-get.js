'use strict'
/**
 * 司空 Redis 轻量 GET 客户端（node 内置 net 手写 RESP 协议，不依赖第三方包）
 * 用途：读司空 Redis（docker 172.28.0.81:6379）的无人机遥测（system:osd_dock_drone:<deviceSn>）。
 * 设计：不装 ioredis/redis 第三方包（生产环境隔离红线），AUTH + GET 即可满足只读需求。
 *
 * 🔐 凭据不硬编码：连接参数一律从环境变量读取。请在 systemd 单元的 EnvironmentFile
 *    （生产 = /data/HBJSC/backend/iotcloud.env）中配置：
 *      SIKONG_REDIS_HOST      默认 172.28.0.81
 *      SIKONG_REDIS_PORT      默认 6379
 *      SIKONG_REDIS_PASSWORD  默认空；为空则【不发 AUTH】（适用于免密实例）
 *    ⚠️ 若实例要求 AUTH 但未配置密码，本函数返回 null（只读用途，静默降级，不影响主流程）。
 */

/**
 * 从司空 Redis 读一个 key 的值（JSON 字符串）。
 * @param {string} key Redis 键名
 * @param {{host?:string,port?:number,password?:string,timeoutMs?:number}} opts 连接选项（默认取环境变量）
 * @returns {Promise<string|null>} 值（不存在/失败返回 null）
 */
function redisGet(key, {
  host = process.env.SIKONG_REDIS_HOST || '172.28.0.81',
  port = Number(process.env.SIKONG_REDIS_PORT || 6379),
  password = process.env.SIKONG_REDIS_PASSWORD || '',
  timeoutMs = 4000,
} = {}) {
  return new Promise((resolve) => {
    const net = require('net')
    const sock = net.connect(port, host)
    let buf = Buffer.alloc(0)
    let stage = 0  // 0=等AUTH响应 1=等GET响应
    let done = false
    const finish = (val) => { if (!done) { done = true; try { sock.destroy() } catch { } resolve(val) } }
    const timer = setTimeout(() => finish(null), timeoutMs)
    const sendGet = () => sock.write(`*2\r\n$3\r\nGET\r\n$${Buffer.byteLength(key)}\r\n${key}\r\n`)
    sock.on('connect', () => {
      if (password) {
        sock.write(`*2\r\n$4\r\nAUTH\r\n$${password.length}\r\n${password}\r\n`)
      } else {
        // 未配置密码 → 直接 GET（免密实例）
        stage = 1
        sendGet()
      }
    })
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (stage === 0) {
        const idx = buf.indexOf('\r\n')
        if (idx === -1) return
        const line = buf.slice(0, idx).toString()
        if (line.startsWith('+')) {
          stage = 1
          buf = buf.slice(idx + 2)
          sendGet()
        } else { clearTimeout(timer); finish(null) }
      } else {
        const idx = buf.indexOf('\r\n')
        if (idx === -1) return
        const head = buf.slice(0, idx).toString()
        if (head === '$-1' || !head.startsWith('$')) { clearTimeout(timer); finish(null); return }
        const len = parseInt(head.slice(1), 10)
        if (isNaN(len) || buf.length < idx + 2 + len + 2) return
        const data = buf.slice(idx + 2, idx + 2 + len).toString()
        clearTimeout(timer); finish(data)
      }
    })
    sock.on('error', () => { clearTimeout(timer); finish(null) })
  })
}

module.exports = { redisGet }
