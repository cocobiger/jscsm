'use strict'
/**
 * H.265 → H.264 转码 Worker v2（零硬编码，自动探测，持久化恢复）
 *
 * v2 核心改进：
 *   1. 移除硬编码 H265_SOURCE_MAP → 运行时动态注册 + JSON 文件持久化
 *   2. 新增 probeCodec(rtspUrl) → ffprobe 自动探测编码格式
 *   3. 新增 registerStream(streamId, rtspUrl) → 前端加摄像头后无需 SSH 改文件
 *   4. startAll() 从磁盘自动恢复所有已注册的转码流（服务器重启后 self-heal）
 *   5. 探码结果缓存（内存 Map），避免重复 ffprobe
 *
 * 隔离性保证：
 *   - 不改 zlm.js 任何代码
 *   - 不改 coll_streams 原始 url（不改用户配置）
 *   - ffmpeg 进程独立跟踪，停止时只杀自己的 worker
 *   - 通过别名映射，对原 addStreamProxy 调用透明
 */

const { spawn, exec } = require('child_process')
const fs = require('fs')
const path = require('path')

let log = { info() {}, warn() {}, error() {}, debug() {} }
let zlmRef = null
// RTMP 推送目标：ZLM 容器 IP:1935（docker bridge 网络）
let rtmpTarget = 'rtmp://172.17.0.2:1935/jsc_h264'
let zlmApiTarget = 'http://172.17.0.2:8080'
let dataDir = null
let configFile = null

// ===== 运行时状态 =====
const _streamMap = {}              // { streamId: { transcodeId, rtspUrl, createdAt } }
const _probeCache = new Map()      // { rtspUrl -> { codec, probedAt } } 内存探码缓存
const _probeCacheTtlMs = 300_000   // 探码缓存 5 分钟（同一 URL 短时间内不会换编码）
const workers = new Map()          // streamId -> { proc, transcodeId, rtspUrl, lastError, startedAt, status }

// ===== 工具函数 =====

function init(deps) {
  if (deps.log) log = deps.log
  if (deps.zlm) zlmRef = deps.zlm
  if (deps.dataDir) {
    dataDir = deps.dataDir
    configFile = path.join(dataDir, 'transcoder.json')
    loadFromDisk() // 启动时从磁盘恢复注册表
  }
  log.info('[transcoder-v2] 模块已加载 (动态注册模式)')
}

/**
 * 从磁盘加载已注册的 H.265 流映射
 */
function loadFromDisk() {
  if (!configFile || !fs.existsSync(configFile)) {
    log.info('[transcoder-v2] transcoder.json 不存在，从空白开始')
    return
  }
  try {
    const raw = fs.readFileSync(configFile, 'utf-8')
    const data = JSON.parse(raw)
    for (const [streamId, entry] of Object.entries(data)) {
      if (entry.transcodeId && entry.rtspUrl) {
        _streamMap[streamId] = {
          transcodeId: entry.transcodeId,
          rtspUrl: entry.rtspUrl,
          createdAt: entry.createdAt || new Date().toISOString(),
        }
      }
    }
    log.info(`[transcoder-v2] 从磁盘恢复 ${Object.keys(_streamMap).length} 个转码映射`)
  } catch (e) {
    log.warn('[transcoder-v2] transcoder.json 解析失败: ' + e.message)
  }
}

/**
 * 将当前 _streamMap 持久化到磁盘
 */
function saveToDisk() {
  if (!configFile || !dataDir) return
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(configFile, JSON.stringify(_streamMap, null, 2), 'utf-8')
    log.info(`[transcoder-v2] 已保存 ${Object.keys(_streamMap).length} 个映射到磁盘`)
  } catch (e) {
    log.error('[transcoder-v2] 保存 transcoder.json 失败: ' + e.message)
  }
}

// ===== 公共 API =====

/**
 * ffprobe 探码：检测 RTSP 流的视频编码格式
 * @param {string} rtspUrl - RTSP 流地址
 * @returns {Promise<'h264'|'h265'|'unknown'>}
 */
function probeCodec(rtspUrl) {
  // 1. 查内存缓存
  const cached = _probeCache.get(rtspUrl)
  if (cached && (Date.now() - cached.probedAt) < _probeCacheTtlMs) {
    log.debug(`[transcoder-v2] 探码命中缓存: ${rtspUrl.substring(0, 60)}... → ${cached.codec}`)
    return Promise.resolve(cached.codec)
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      log.warn('[transcoder-v2] ffprobe 超时 (H.264 兜底): ' + rtspUrl.substring(0, 70))
      _probeCache.set(rtspUrl, { codec: 'h264', probedAt: Date.now() })
      proc.kill('SIGKILL')
      resolve('h264') // 超时兜底为 H.264（安全侧：宁可走普通拉流）
    }, 8000) // 8 秒硬超时

    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-select_streams', 'v:0',
      '-rtsp_transport', 'tcp',
      '-timeout', '5000000', // 5 秒 socket 超时 (微秒)
      rtspUrl,
    ]
    log.debug('[transcoder-v2] ffprobe 探码: ' + rtspUrl.substring(0, 60) + '...')
    const proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 7000 })
    let stdout = '', stderr = ''

    proc.stdout.on('data', (d) => stdout += d.toString())
    proc.stderr.on('data', (d) => stderr += d.toString())

    proc.on('error', (e) => {
      clearTimeout(timer)
      log.warn('[transcoder-v2] ffprobe 启动失败: ' + e.message)
      _probeCache.set(rtspUrl, { codec: 'h264', probedAt: Date.now() })
      resolve('h264')
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 || !stdout.trim()) {
        log.warn('[transcoder-v2] ffprobe 异常退出 (code=' + code + '): ' + stderr.substring(0, 100))
        _probeCache.set(rtspUrl, { codec: 'h264', probedAt: Date.now() })
        return resolve('h264')
      }
      try {
        const j = JSON.parse(stdout)
        const streams = j.streams || []
        const videoStream = streams.find(s => s.codec_type === 'video')
        if (!videoStream) {
          log.warn('[transcoder-v2] ffprobe 未找到视频流')
          _probeCache.set(rtspUrl, { codec: 'h264', probedAt: Date.now() })
          return resolve('h264')
        }
        const codecName = (videoStream.codec_name || '').toLowerCase()
        let codec
        if (codecName === 'hevc' || codecName === 'h265') codec = 'h265'
        else if (codecName === 'h264' || codecName === 'avc') codec = 'h264'
        else codec = 'h264' // 未知编码走 H.264 路径

        log.info(`[transcoder-v2] 探码成功: ${rtspUrl.substring(0, 60)}... → ${codec} (${videoStream.width}x${videoStream.height})`)
        _probeCache.set(rtspUrl, { codec, probedAt: Date.now() })
        resolve(codec)
      } catch (e) {
        log.warn('[transcoder-v2] ffprobe JSON 解析失败: ' + e.message)
        _probeCache.set(rtspUrl, { codec: 'h264', probedAt: Date.now() })
        resolve('h264')
      }
    })
  })
}

/**
 * 动态注册一个 H.265 流到转码系统
 * @param {string} streamId - 流的唯一标识（UUID 或短ID均可）
 * @param {string} rtspUrl  - RTSP 拉流地址
 * @returns {{ transcodeId: string }} 生成的转码流 ID
 */
function registerStream(streamId, rtspUrl) {
  // 生成转码 ID：UUID 截前 8 位，短 ID 直接拼接
  let transcodeId
  if (streamId.includes('-')) {
    transcodeId = streamId.substring(0, 8) + '_h264'
  } else {
    transcodeId = streamId + '_h264'
  }

  if (_streamMap[streamId]) {
    log.info(`[transcoder-v2] 流已注册，更新 RTSP URL: ${streamId}`)
    _streamMap[streamId].rtspUrl = rtspUrl
  } else {
    _streamMap[streamId] = { transcodeId, rtspUrl, createdAt: new Date().toISOString() }
    log.info(`[transcoder-v2] 新注册 H.265 流: ${streamId} → ${transcodeId}`)
  }
  saveToDisk()
  return { transcodeId }
}

/**
 * 从注册表中移除一个流
 */
function unregisterStream(streamId) {
  stopWorker(streamId)
  delete _streamMap[streamId]
  saveToDisk()
  log.info(`[transcoder-v2] 已注销流: ${streamId}`)
}

/**
 * 判定一个流 ID 是否需要走转码
 */
function needTranscode(streamId) {
  return Object.prototype.hasOwnProperty.call(_streamMap, streamId)
}

/**
 * 获取流映射信息
 */
function getStreamInfo(streamId) {
  return _streamMap[streamId] || null
}

/**
 * URL 重写：如果 streamId 在注册表中 → 替换为转码后 RTMP 地址
 * 不再依赖硬编码白名单
 */
function rewriteStreamUrl(streamId, rtspUrl) {
  if (!needTranscode(streamId)) {
    return { url: rtspUrl, transcodeId: null, needTranscode: false, skipProxy: false }
  }
  const m = _streamMap[streamId]
  return {
    url: `rtmp://127.0.0.1:1935/jsc_h264/${m.transcodeId}`,
    transcodeId: m.transcodeId,
    needTranscode: true,
    skipProxy: true,
  }
}

/**
 * 生成 H.265 转码流的直接播放 URL（跳过 addStreamProxy）
 */
function buildDirectPlayUrls(streamId) {
  if (!needTranscode(streamId) || !zlmRef) return null
  const m = _streamMap[streamId]
  return zlmRef.playUrls('jsc_h264', m.transcodeId)
}

// ===== Worker 管理 =====

/**
 * 启动某路转码 worker
 */
function startWorker(streamId, rtspUrl) {
  if (!needTranscode(streamId)) {
    // 动态注册模式：allow auto-register
    registerStream(streamId, rtspUrl)
  }

  // 已在跑
  if (workers.has(streamId)) {
    const w = workers.get(streamId)
    if (w.proc && !w.proc.killed) {
      log.info(`[transcoder-v2] worker 已在运行: ${streamId}`)
      return w
    }
  }
  const m = _streamMap[streamId]
  if (!m) {
    log.error(`[transcoder-v2] 无法启动 worker: ${streamId} 未注册`)
    return null
  }
  const transcodeId = m.transcodeId

  // 视频码率自适应：2K=2500k, 720p=1500k, 其他=1500k
  // 如果需要精确码率控制，调用方可以先 probeCodec 拿到分辨率后传参
  const args = [
    '-rtsp_transport', 'tcp',
    '-i', rtspUrl,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-g', '30',
    '-sc_threshold', '0',
    '-b:v', '1500k',
    '-maxrate', '2000k',
    '-bufsize', '3000k',
    '-c:a', 'aac',
    '-b:a', '64k',
    '-f', 'flv',
    `${rtmpTarget}/${transcodeId}`,
  ]
  log.info(`[transcoder-v2] 启动 worker: ${streamId} → ${rtmpTarget}/${transcodeId}`)
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
    log.error(`[transcoder-v2] worker ${streamId} 启动失败: ${e.message}`)
    w.status = 'error'
    w.lastError = e.message
  })
  proc.on('close', (code, sig) => {
    log.warn(`[transcoder-v2] worker ${streamId} 退出 (code=${code}, sig=${sig})`)
    w.status = 'stopped'
    workers.delete(streamId)
    // 30 秒后自动重启（崩溃恢复）
    setTimeout(() => {
      if (!workers.has(streamId) && _streamMap[streamId]) {
        log.info(`[transcoder-v2] 自动重启 worker: ${streamId}`)
        startWorker(streamId, _streamMap[streamId].rtspUrl)
      }
    }, 30000)
  })
  return w
}

function stopWorker(streamId) {
  const w = workers.get(streamId)
  if (!w) return false
  try { w.proc.kill('SIGTERM') } catch {}
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
 * 启动所有已注册的转码 worker（从 _streamMap 读取，无需参数）
 * 用于服务器重启后自动恢复所有转码流
 */
async function startAll() {
  const entries = Object.entries(_streamMap)
  if (entries.length === 0) {
    log.info('[transcoder-v2] 无已注册的转码流，跳过启动')
    return []
  }
  log.info(`[transcoder-v2] 即将启动 ${entries.length} 路转码 worker`)
  const started = []
  for (const [streamId, m] of entries) {
    const w = startWorker(streamId, m.rtspUrl)
    if (w) started.push(streamId)
  }
  // 等待 5 秒让 ffmpeg 启动
  await new Promise(r => setTimeout(r, 5000))
  // 验证 ZLM 推流状态
  const checks = []
  for (const streamId of started) {
    const m = _streamMap[streamId]
    if (!m) continue
    const online = await checkTranscodeOnline(m.transcodeId)
    checks.push({ streamId, transcodeId: m.transcodeId, online })
  }
  log.info(`[transcoder-v2] 启动结果: ${JSON.stringify(checks)}`)
  return checks
}

function stopAll() {
  for (const id of Array.from(workers.keys())) stopWorker(id)
}

// ===== ZLM 推流状态检测 =====

/**
 * 检查 ZLM 中 jsc_h264 app 的转码流是否在线
 */
function checkTranscodeOnline(transcodeId, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (!zlmRef) return resolve(false)
    let host = '172.17.0.2', port = 80
    try {
      const u = new URL(zlmApiTarget)
      host = u.hostname; port = Number(u.port) || 80
    } catch {}
    const httpMod = require('http')
    const req = httpMod.request({
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

// ===== 一键智能注册（probe + register + start worker） =====

/**
 * 智能添加流：自动探测编码 → 自动注册 → 自动启动转码
 * 这是"加摄像头即推流"的主入口
 * @returns {{ codec, needTranscode, transcodeId|null, probeTimeMs }}
 */
async function smartAdd(streamId, rtspUrl) {
  const t0 = Date.now()
  const codec = await probeCodec(rtspUrl)
  const probeTimeMs = Date.now() - t0

  if (codec === 'h265') {
    const { transcodeId } = registerStream(streamId, rtspUrl)
    startWorker(streamId, rtspUrl)
    log.info(`[transcoder-v2] 智能注册: ${streamId} → ${transcodeId} (${codec}, ${probeTimeMs}ms)`)
    return { codec, needTranscode: true, transcodeId, probeTimeMs }
  }
  log.info(`[transcoder-v2] 跳过转码: ${streamId} (${codec}, ${probeTimeMs}ms)`)
  return { codec, needTranscode: false, transcodeId: null, probeTimeMs }
}

module.exports = {
  init,
  probeCodec,
  registerStream,
  unregisterStream,
  needTranscode,
  getStreamInfo,
  rewriteStreamUrl,
  buildDirectPlayUrls,
  startWorker,
  stopWorker,
  listWorkers,
  startAll,
  stopAll,
  smartAdd,              // 一键智能注册（probe + register + start）
  _streamMap,            // 暴露给 index.js 做调试/API 查询
  _probeCache,           // 探码缓存
}
