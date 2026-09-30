'use strict'
/**
 * H.265 → H.264 转码 Worker（独立模块，不影响 ZLM 主流程）
 *
 * 原理：对 3 个已知 H.265 源用 ffmpeg 拉流 → 推 RTMP 到 ZLMediaKit 的 jsc_h264 app
 * 播放端 addStreamProxy 改用 jsc_h264 即可拿到 H.264 副本。
 *
 * 隔离性保证：
 *  - 不改 zlm.js 任何代码
 *  - 不改 coll_streams 原始 url（不改用户配置）
 *  - ffmpeg 进程独立跟踪，停止时只杀自己的 worker
 *  - 通过别名映射，对原 addStreamProxy 调用透明
 *
 * 配置（h265Sources）：
 *   [{
 *     streamId: 's9gt5zu',   // 与 addStreamProxy(id, url) 的 id 一致
 *     rtspUrl: 'rtsp://...',
 *     transcodeId: 's9gt5zu_h264'  // 推到 jsc_h264 app 的流名
 *   }]
 */

const { spawn, exec } = require('child_process')
const fs = require('fs')
const path = require('path')
const http = require('http')

let log = { info(){}, warn(){}, error(){}, debug(){} }
let zlmRef = null  // 注入的 zlm 模块
// RTMP 推送目标：ZLM 容器 IP:1935（默认 docker bridge 网络）。
// 容器内 RTMP 端口 1935 映射到宿主机 1936，所以宿主机内 ffmpeg 必须用容器 IP 直推。
// 如需改其他目标（如 127.0.0.1:1936 经宿主机端口绕回），调用 setRtmpTarget() 覆盖。
let rtmpTarget = 'rtmp://172.17.0.2:1935/jsc_h264'
let zlmApiTarget = 'http://172.17.0.2:8080'  // ZLM HTTP API（getMediaList 用）
let dataDir = null
let configFile = null

// 运行时状态
const workers = new Map()  // streamId -> { proc, transcodeId, rtspUrl, lastError, startedAt, status }

/**
 * 修改 3 个 H.265 源指向转码（如果 rtspUrl 是 H.265 且在白名单中，addStreamProxy 实际拉的是转码后的 RTMP）
 * 注意：addStreamProxy(id, url) 是 zlm.addStreamProxy 的调用，我们拦截 url 即可
 */
const H265_SOURCE_MAP = {
  // streamId -> { rtspUrl, transcodeId }
  s9gt5zu: { transcodeId: 's9gt5zu_h264' },
  s2xqr8g: { transcodeId: 's2xqr8g_h264' },
  // sqs45b3: 172.16.8.50 ch3 无信号，暂不下发（保留映射便于后续恢复）
  // sqs45b3: { transcodeId: 'sqs45b3_h264' },
  // 172.16.8.50 ch6 彼迪 - 主码流 subtype=0 是 H.265 1280x720
  s2xqr8f: { transcodeId: 's2xqr8f_h264' },
  // 172.16.8.50 ch7 万源玻璃 - 主码流 subtype=0 是 H.265 2560x1440
  sqs45b4: { transcodeId: 'sqs45b4_h264' },
}

function init(deps) {
  if (deps.log) log = deps.log
  if (deps.zlm) zlmRef = deps.zlm
  if (deps.dataDir) {
    dataDir = deps.dataDir
    configFile = path.join(dataDir, 'transcoder.json')
  }
  log.info('[transcoder] 模块已加载')
}

/**
 * 判定一个流ID是否需要走转码
 */
function needTranscode(streamId) {
  return Object.prototype.hasOwnProperty.call(H265_SOURCE_MAP, streamId)
}

/**
 * 给 zlm.addStreamProxy(id, url) 用的 URL 重写：
 *   - 如果 streamId 在 H.265 白名单 → 把 url 替换为转码后推入 jsc_h264 app 的 rtmp URL
 *   - 否则原样返回
 */
function rewriteStreamUrl(streamId, rtspUrl) {
  if (!needTranscode(streamId)) return { url: rtspUrl, transcodeId: null, needTranscode: false, skipProxy: false }
  const m = H265_SOURCE_MAP[streamId]
  // H.265 路径：流已被 transcoder worker 推到 ZLM 的 jsc_h264 app，
  // 推荐直接用 jsc_h264 app 的播放 URL（流已在 ZLM 中，零成本直拿）
  return {
    url: `rtmp://127.0.0.1:1935/jsc_h264/${m.transcodeId}`,
    transcodeId: m.transcodeId,
    needTranscode: true,
    skipProxy: true,  // 跳过 addStreamProxy（流已在 ZLM 中）
  }
}

/**
 * 给上层调用方在 H.265 场景下跳过 ZLM addStreamProxy，直接生成播放 URL（更优解）
 * 但为不影响 addStreamProxy 的调用链，本函数仅作为备选/调试用
 */
function buildDirectPlayUrls(streamId) {
  if (!needTranscode(streamId) || !zlmRef) return null
  const m = H265_SOURCE_MAP[streamId]
  return zlmRef.playUrls('jsc_h264', m.transcodeId)
}

/**
 * 启动某路转码 worker
 */
function startWorker(streamId, rtspUrl) {
  if (!needTranscode(streamId)) {
    log.warn(`[transcoder] streamId ${streamId} 不在 H.265 白名单，跳过`)
    return null
  }
  // 已在跑
  if (workers.has(streamId)) {
    const w = workers.get(streamId)
    if (w.proc && !w.proc.killed) return w
  }
  const m = H265_SOURCE_MAP[streamId]
  const transcodeId = m.transcodeId

  // ffmpeg 参数：
  //   -rtsp_transport tcp：RTSP over TCP，更稳定
  //   -c:v libx264 -preset ultrafast -tune zerolatency：低延迟 H.264
  //   -g 30 -sc_threshold 0：固定 GOP
  //   -c:a aac -b:a 64k：音频转 AAC
  //   -f flv 推 RTMP
  const args = [
    '-rtsp_transport', 'tcp',
    '-i', rtspUrl,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-g', '30',
    '-sc_threshold', '0',
    '-b:v', '1500k',         // 2Mbps H.265 压到 1.5Mbps H.264
    '-maxrate', '2000k',
    '-bufsize', '3000k',
    '-c:a', 'aac',
    '-b:a', '64k',
    '-f', 'flv',
    `${rtmpTarget}/${transcodeId}`,
  ]
  log.info(`[transcoder] 启动 worker: ${streamId} → ${rtmpTarget}/${transcodeId}`)
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const w = {
    proc,
    streamId,
    transcodeId,
    rtspUrl,
    startedAt: new Date().toISOString(),
    status: 'starting',
    lastError: null,
    stderrBuf: '',
  }
  workers.set(streamId, w)
  proc.stderr.on('data', (d) => {
    const s = d.toString()
    w.stderrBuf = (w.stderrBuf + s).slice(-2000)
    if (s.includes('Stream mapping') || s.includes('frame=')) w.status = 'running'
  })
  proc.on('error', (e) => {
    log.error(`[transcoder] worker ${streamId} 启动失败: ${e.message}`)
    w.status = 'error'
    w.lastError = e.message
  })
  proc.on('close', (code, sig) => {
    log.warn(`[transcoder] worker ${streamId} 退出 (code=${code}, sig=${sig})`)
    w.status = 'stopped'
    workers.delete(streamId)
    // 30 秒后自动重启（崩溃恢复）
    setTimeout(() => {
      if (!workers.has(streamId)) {
        log.info(`[transcoder] 自动重启 worker: ${streamId}`)
        startWorker(streamId, rtspUrl)
      }
    }, 30000)
  })
  return w
}

function stopWorker(streamId) {
  const w = workers.get(streamId)
  if (!w) return false
  try { w.proc.kill('SIGTERM') } catch {}
  // 5 秒后强杀
  setTimeout(() => { try { w.proc.kill('SIGKILL') } catch {} }, 5000)
  workers.delete(streamId)
  return true
}

function listWorkers() {
  const out = []
  for (const [id, w] of workers.entries()) {
    out.push({
      streamId: id,
      transcodeId: w.transcodeId,
      rtspUrl: w.rtspUrl,
      status: w.status,
      startedAt: w.startedAt,
      lastError: w.lastError,
      pid: w.proc?.pid,
    })
  }
  return out
}

/**
 * 检查 ZLM 中 jsc_h264 app 的流是否在线（ffmpeg 推流成功标志）
 */
async function checkTranscodeOnline(transcodeId, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (!zlmRef) return resolve(false)
    // 解析 zlmApiTarget（http://host:port）取 host/port
    let host = '172.17.0.2', port = 8080
    try {
      const u = new URL(zlmApiTarget)
      host = u.hostname; port = Number(u.port) || 80
    } catch {}
    const req = http.request({
      method: 'GET',
      host, port,
      path: `/index/api/getMediaList?secret=${encodeURIComponent(zlmRef.getConfig().zlmSecret || '')}`,
      timeout: timeoutMs,
    }, (res) => {
      let buf = ''
      res.on('data', (c) => buf += c)
      res.on('end', () => {
        try {
          const j = JSON.parse(buf)
          if (j.code !== 0) return resolve(false)
          const list = j.data || []
          resolve(list.some(m => m.app === 'jsc_h264' && m.stream === transcodeId))
        } catch { resolve(false) }
      })
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.end()
  })
}

/**
 * 启动所有 H.265 源的转码 worker
 * 需传入 [{ streamId, rtspUrl }]
 */
async function startAll(sourceList) {
  const started = []
  for (const s of sourceList) {
    if (!needTranscode(s.streamId)) continue
    const w = startWorker(s.streamId, s.rtspUrl)
    if (w) started.push(s.streamId)
  }
  // 等待 5 秒让 ffmpeg 起来
  await new Promise(r => setTimeout(r, 5000))
  // 验证 ZLM 是否收到推流
  const checks = await Promise.all(
    started.map(async (id) => {
      const m = H265_SOURCE_MAP[id]
      const online = await checkTranscodeOnline(m.transcodeId)
      return { streamId: id, transcodeId: m.transcodeId, online }
    })
  )
  log.info(`[transcoder] 启动结果: ${JSON.stringify(checks)}`)
  return checks
}

function stopAll() {
  for (const id of Array.from(workers.keys())) stopWorker(id)
}

module.exports = {
  init,
  needTranscode,
  rewriteStreamUrl,
  buildDirectPlayUrls,
  startWorker,
  stopWorker,
  listWorkers,
  startAll,
  stopAll,
  H265_SOURCE_MAP,
}
