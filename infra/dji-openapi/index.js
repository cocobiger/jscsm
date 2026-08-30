'use strict'
/**
 * dji-openapi 接入服务（2026-08-27 数据贯通版）
 * 四通道：
 *  ① 主动 REST（司空 OpenAPI /v1/*，login-user 内部头）—— 设备/组织/任务/直播
 *  ② 实时 OSD WebSocket（/apisocket/osd?token=）—— 机场/无人机实时遥测 → target-locator 定位
 *  ③ 被动 Webhook（POST /webhook/sync，X-Event-Type + X-Signature）—— 直播/任务/文件事件
 *  ④ RTMP 直推（无人机/机场直推我方 ZLM 1936，不经司空转发）
 * 与司空2 本地化部署零冲突（隔离红线见 config.json.isolation）
 */
const http = require('http')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

const config = require(path.join(__dirname, 'config.json'))
const openapi = require(path.join(__dirname, 'lib', 'openapi-client.js'))(config)
const live = require(path.join(__dirname, 'lib', 'live-manager.js'))(config)
const telemetry = require(path.join(__dirname, 'lib', 'telemetry.js'))()
const strawSync = require(path.join(__dirname, 'lib', 'straw-sync.js'))(config)
const webhook = require(path.join(__dirname, 'lib', 'webhook-handler.js'))(config)
const wsOsd = require(path.join(__dirname, 'lib', 'ws-osd-client.js'))(config, telemetry)
const zlmWatch = require(path.join(__dirname, 'lib', 'zlm-watcher.js'))(config, {
  intervalMs: 15000,
  strawSync,
  onEvent: (ev) => pushEvent(ev),
})
const mediaWatch = require(path.join(__dirname, 'lib', 'media-watcher.js'))(config, {
  onEvent: (ev) => pushEvent(ev),
  archivePhotos: true,
})

const state = {
  startedAt: new Date().toISOString(),
  openapi: openapi.status(),
  devices: [],
  devicesSyncedAt: null,
  isolation: config.isolation,
  webhook: webhook.status(),
  wsOsd: wsOsd.status(),
  events: [],
}

const PORT = config.port || 17810

/** 事件 ring（最近 200 条，供 /api/events） */
function pushEvent(ev) {
  state.events.push(ev)
  if (state.events.length > 200) state.events.shift()
}

function send(res, code, data) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(data, null, 2))
}

async function readBody(req) {
  let body = ''
  for await (const c of req) body += c
  return body
}

/** 媒体对象相对路径白名单：仅允许文件名/目录字符，禁止 .. 与协议注入 */
function validMediaPath(p) {
  if (!p || typeof p !== 'string') return false
  if (p.length > 500) return false
  if (p.includes('..') || p.includes('\\') || p.includes('://') || p.startsWith('/')) return false
  return /^[a-zA-Z0-9_\-./ ]+$/.test(p)
}

/** HMAC-SHA256 签名（path|exp），hex 输出 */
function mediaSig(p, exp) {
  const mp = config.minioPlay || {}
  return crypto.createHmac('sha256', String(mp.secret || '')).update(`${p}|${exp}`).digest('hex')
}

/** 常量时间比较，防时序侧信道 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''))
  const bb = Buffer.from(String(b || ''))
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

// ── 缩略图：懒生成 + 永久缓存 + 并发限流 ──────────────────────────────
const { execFile } = require('child_process')
const THUMBS_DIR = path.join(config.dataDir || '/opt/jsc/dji-openapi/data', 'thumbs')
const THUMB_MAX_CONCURRENT = 4
let thumbRunning = 0
const thumbWaiters = []

function thumbKey(p) {
  return crypto.createHash('sha1').update(p).digest('hex') + '.jpg'
}
function thumbFile(p) {
  return path.join(THUMBS_DIR, thumbKey(p))
}
/** 等待并发槽位 */
function acquireThumb() {
  if (thumbRunning < THUMB_MAX_CONCURRENT) { thumbRunning++; return Promise.resolve() }
  return new Promise(res => thumbWaiters.push(res))
}
function releaseThumb() {
  thumbRunning--
  const next = thumbWaiters.shift()
  if (next) { thumbRunning++; next() }
}
function run(cmd, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || '').slice(0, 500); reject(err) } else resolve(stdout)
    })
  })
}
/** 从 MinIO http 抽一帧缩略图（视频取 duration×40% 位置；图片静态缩放） */
async function genThumb(p, dst) {
  const mp = config.minioPlay || {}
  const src = `http://127.0.0.1:${mp.port || 9000}/${mp.bucket || 'test'}/${p.split('/').map(encodeURIComponent).join('/')}`
  const isImage = /\.(jpe?g|png|bmp|webp)$/i.test(p)
  if (isImage) {
    // 静态图片：无需 seek，直接缩放（-ss 对单帧图片会产生空输出）
    await run('ffmpeg', ['-v', 'error', '-i', src, '-frames:v', '1', '-vf', 'scale=480:-1', '-q:v', '5', '-f', 'mjpeg', '-y', dst], 90000)
    return
  }
  // 1) probe duration（MinIO Range 支持，~0.1s）
  const durOut = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src], 20000)
  const dur = parseFloat(String(durOut || '').trim())
  // ss clamp：40% 位置且 ≤dur-1；≤1.5s 的残片不 seek（ss=0 从头读）
  const ss = Number.isFinite(dur) && dur > 1.5
    ? Math.max(1, Math.min(Math.floor(dur * 0.4), Math.max(1, Math.floor(dur) - 1)))
    : 0
  // 2) 抽帧：480 宽 q5 ≈ 8-12KB（-f mjpeg 显式指定，避免 .tmp-<pid> 后缀无法推断格式）
  await run('ffmpeg', ['-v', 'error', '-ss', String(ss), '-i', src, '-frames:v', '1', '-vf', 'scale=480:-1', '-q:v', '5', '-f', 'mjpeg', '-y', dst], 90000)
}

/** 设备同步（启动 + 每 60s 刷新） */
async function syncDevices() {
  const r = await openapi.syncDevices()
  if (r.ok) {
    state.devices = r.devices
    state.devicesSyncedAt = new Date().toISOString()
  } else {
    console.warn('[dji-openapi] 设备同步失败:', r.error)
  }
}

/** streamId → 机场 SN 关联（alias 映射 → 精确匹配 → 包含匹配） */
function resolveDockSn(streamId) {
  const aliases = config.streamAliases || {}
  if (aliases[streamId]) return aliases[streamId]
  const s = String(streamId || '')
  if (!s) return null
  for (const d of state.devices) {
    if (d.deviceSn === s || (d.drone && d.drone.droneSn === s)) return d.deviceSn
  }
  for (const d of state.devices) {
    const sns = [d.deviceSn, d.drone && d.drone.droneSn].filter(Boolean)
    if (sns.some((sn) => s.includes(sn) || sn.includes(s))) return d.deviceSn
  }
  return null
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  try {
    // ③ 司空 webhook 推送接收（真实事件：POST + X-Event-Type/X-Signature）
    if ((req.method === 'POST' || req.method === 'GET') && url.pathname === '/webhook/sync') {
      const raw = req.method === 'GET' ? url.searchParams.toString() : await readBody(req)
      const result = webhook.handle(req.headers, raw)
      // 事件联动：LIVE_STATUS_CHANGE → 记录并尝试提取设备/状态（自动建流骨架，真实事件体到校准字段）
      try {
        const cls = result.classified || {}
        let body = null
        try { body = JSON.parse(String(raw)) } catch (e) {}
        const d = body && (body.data || body)
        const sn = d?.droneSn || d?.deviceSn || d?.dockSn || d?.sn || ''
        pushEvent({
          ts: new Date().toISOString(),
          type: cls.eventType || null,
          classified: cls.type || 'unknown',
          deviceSn: sn,
          detail: cls.detail || '',
          signatureOk: !!(result.signature && result.signature.ok),
        })
        if (cls.type === 'live') {
          console.log(`[webhook] 直播状态变更 sn=${sn} detail=${cls.detail}`)
        } else if (cls.type === 'task' || cls.type === 'media') {
          console.log(`[webhook] ${cls.eventType} sn=${sn} detail=${cls.detail}`)
        }
      } catch (e) { console.warn('[webhook] 事件联动处理失败:', e.message) }
      // 始终返回 200 确认，避免司空重试风暴；处理结果记录在日志/存储
      return send(res, 200, { code: 0, message: 'ok', detail: result.classified })
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      state.openapi = openapi.status()
      state.wsOsd = wsOsd.status()
      state.webhook = webhook.status()
      return send(res, 200, { ok: true, service: 'dji-openapi', ...state })
    }

    // ① 司空设备（机场+无人机，含经纬度）
    if (req.method === 'GET' && url.pathname === '/api/devices') {
      return send(res, 200, { ok: true, syncedAt: state.devicesSyncedAt, count: state.devices.length, devices: state.devices })
    }

    // ② 实时遥测（OSD）与目标定位
    if (req.method === 'GET' && url.pathname === '/api/telemetry') {
      return send(res, 200, { ok: true, telemetry: telemetry.recent() })
    }
    if (req.method === 'GET' && url.pathname === '/api/telemetry/latest') {
      return send(res, 200, { ok: true, devices: telemetry.allLatest() })
    }

    if (req.method === 'GET' && url.pathname === '/api/streams') {
      return send(res, 200, { ok: true, streams: live.list() })
    }

    // 司空事件记录（webhook 收到的事件，最近 200 条）
    if (req.method === 'GET' && url.pathname === '/api/events') {
      return send(res, 200, { ok: true, count: state.events.length, events: state.events.slice(-100).reverse() })
    }

    // 司空 ZLM 直播流监视状态
    if (req.method === 'GET' && url.pathname === '/api/zlm-watch') {
      return send(res, 200, { ok: true, ...zlmWatch.status() })
    }

    // 司空媒体归档（MinIO 挂载目录扫描：任务照片/视频/录制/OSD 记录；按时间倒序分页）
    // 参数：kind / limit / offset / date=YYYYMMDD（按 path 日期段过滤）/ q（name+path 模糊）/ dates=1（仅返回日期分布）
    if (req.method === 'GET' && url.pathname === '/api/media') {
      const kind = url.searchParams.get('kind') || null
      const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500)
      const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0)
      const date = url.searchParams.get('date') || ''
      const q = url.searchParams.get('q') || ''
      const datesOnly = url.searchParams.get('dates') === '1'
      const r = mediaWatch.list(limit, kind, offset, { date, q })
      const body = { ok: true, ...mediaWatch.status(), items: r.items, total: r.total, offset, limit, dates: r.dates }
      if (datesOnly) delete body.items
      return send(res, 200, body)
    }

    /**
     * 媒体缩略图（懒生成 + 永久缓存；签名机制同 /api/media/play）
     * 链路：前端(已登录) → /api/sikong/media-sign → /dji-video/api/media/thumb?... → 本端点
     * 生成：ffmpeg 从 MinIO http 抽 duration×40% 位置一帧（~0.2s），sha1(path) 缓存永久复用；
     *      4 并发限流 + 低优先级，不挤占 straw-engine 推理。
     */
    if (req.method === 'GET' && url.pathname === '/api/media/thumb') {
      const p = url.searchParams.get('path') || ''
      const exp = Number(url.searchParams.get('exp')) || 0
      const sig = url.searchParams.get('sig') || ''
      if (!validMediaPath(p)) return send(res, 400, { ok: false, error: 'invalid path' })
      if (!exp || exp < Math.floor(Date.now() / 1000)) return send(res, 401, { ok: false, error: 'expired' })
      if (!safeEqual(sig, mediaSig(p, exp))) return send(res, 401, { ok: false, error: 'bad signature' })

      try {
        fs.mkdirSync(THUMBS_DIR, { recursive: true })
        const dst = thumbFile(p)
        if (!fs.existsSync(dst)) {
          await acquireThumb()
          try {
            // 双重检查（并发下避免重复生成）
            if (!fs.existsSync(dst)) {
              const tmp = dst + '.tmp-' + process.pid
              await genThumb(p, tmp)
              fs.renameSync(tmp, dst)
            }
          } finally {
            releaseThumb()
          }
        }
        res.statusCode = 200
        res.setHeader('Content-Type', 'image/jpeg')
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        res.setHeader('Access-Control-Allow-Origin', '*')
        fs.createReadStream(dst).pipe(res)
      } catch (e) {
        return send(res, 502, { ok: false, error: 'thumb gen: ' + (e.message || e.stderr || e) })
      }
      return
    }

    /**
     * 媒体在线播放（训练可用性预审）
     * 数据源 = 司空 MinIO S3（127.0.0.1:9000，匿名读），对象 key = minioDataRoot 下相对路径。
     * 链路：前端(已登录) → jsc-backend /api/sikong/media-sign → 本端点签发短期签名 URL
     *       → 浏览器 <video src="/dji-video/api/media/play?..."> → nginx 反代 → 本端点 → MinIO GET(带 Range) 透传。
     * 安全：/api/media/sign 走登录鉴权；/api/media/play 校验 HMAC 签名 + 过期时间 + path 白名单，
     *      避免公网 :80/:81 直接拖取任意对象。
     */
    if (req.method === 'GET' && url.pathname === '/api/media/sign') {
      const p = url.searchParams.get('path') || ''
      if (!validMediaPath(p)) return send(res, 400, { ok: false, error: 'invalid path' })
      const exp = Math.floor(Date.now() / 1000) + (Number(url.searchParams.get('exp')) || 3600)
      const sig = mediaSig(p, exp)
      return send(res, 200, {
        ok: true,
        url: `/api/media/play?path=${encodeURIComponent(p)}&exp=${exp}&sig=${sig}`,
      })
    }

    if (req.method === 'GET' && url.pathname === '/api/media/play') {
      const p = url.searchParams.get('path') || ''
      const exp = Number(url.searchParams.get('exp')) || 0
      const sig = url.searchParams.get('sig') || ''
      if (!validMediaPath(p)) return send(res, 400, { ok: false, error: 'invalid path' })
      if (!exp || exp < Math.floor(Date.now() / 1000)) return send(res, 401, { ok: false, error: 'expired' })
      if (!safeEqual(sig, mediaSig(p, exp))) return send(res, 401, { ok: false, error: 'bad signature' })

      const mp = config.minioPlay || {}
      const key = p.split('/').map(encodeURIComponent).join('/')
      const upstream = `http://127.0.0.1:${mp.port || 9000}/${mp.bucket || 'test'}/${key}`
      try {
        const headers = {}
        if (req.headers.range) headers['Range'] = req.headers.range
        const r = await fetch(upstream, { headers, redirect: 'follow' })
        res.statusCode = r.status
        for (const h of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'Last-Modified', 'ETag']) {
          const v = r.headers.get(h)
          if (v) res.setHeader(h, v)
        }
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Access-Control-Allow-Origin', '*')
        const reader = r.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(Buffer.from(value))
        }
        res.end()
      } catch (e) {
        return send(res, 502, { ok: false, error: 'minio upstream: ' + e.message })
      }
      return
    }

    /**
     * 告警定位解析（jsc-backend /api/straw-alert 调用）
     * streamId → 关联司空机场（alias/精确/包含匹配）→ OSD 精确定位(target-locator) → 机场坐标 fallback
     * 返回 source: osd(精确) | dock(机场坐标) | 未关联
     */
    if (req.method === 'GET' && url.pathname === '/api/target') {
      const streamId = url.searchParams.get('streamId') || ''
      const sn = resolveDockSn(streamId)
      if (!sn) return send(res, 200, { ok: false, error: 'streamId 未关联到司空机场', streamId, aliases: Object.keys(config.streamAliases || {}) })
      const dock = state.devices.find((d) => d.deviceSn === sn)
      const droneSn = dock && dock.drone ? dock.drone.droneSn : null
      const t = telemetry.latestTarget(sn) || (droneSn ? telemetry.latestTarget(droneSn) : null)
      if (t && t.target) {
        return send(res, 200, { ok: true, source: 'osd', streamId, deviceSn: sn, droneSn, target: t.target, ts: t.ts })
      }
      if (dock && typeof Number(dock.latitude) === 'number' && typeof Number(dock.longitude) === 'number') {
        return send(res, 200, { ok: true, source: 'dock', streamId, deviceSn: sn, droneSn, target: { lat: Number(dock.latitude), lon: Number(dock.longitude) }, ts: state.devicesSyncedAt })
      }
      return send(res, 200, { ok: false, error: '无定位数据', streamId, deviceSn: sn })
    }
    if (req.method === 'POST' && url.pathname === '/api/streams') {
      const { streamId, pushUrl } = JSON.parse(await readBody(req) || '{}')
      if (!streamId || !pushUrl) return send(res, 400, { ok: false, error: '需 streamId + pushUrl' })
      return send(res, 200, { ok: true, ...live.addStream(streamId, pushUrl) })
    }
    if (req.method === 'POST' && url.pathname === '/api/sync-engine') {
      const { streamId } = JSON.parse(await readBody(req) || '{}')
      const s = streamId ? live.list().find((x) => x.streamId === streamId) : live.list()[0]
      if (!s) return send(res, 400, { ok: false, error: '无直播流可同步' })
      const flvUrl = `${config.zlm.http}/${s.streamId}.live.flv`
      const add = strawSync.addStreamToEngine(s.streamId, flvUrl)
      const restart = await strawSync.restartEngine()
      return send(res, 200, { ok: true, add, restart, flvUrl })
    }

    // ① 直接代理司空 OpenAPI（透传 login-user，方便联调）
    if (req.method === 'POST' && url.pathname.startsWith('/proxy/')) {
      const apiPath = url.pathname.slice('/proxy/'.length)
      const rawBody = await readBody(req)
      const j = await openapi.proxy(apiPath, rawBody ? JSON.parse(rawBody) : {})
      return send(res, 200, j)
    }

    send(res, 404, { ok: false, error: 'not found' })
  } catch (e) {
    send(res, 500, { ok: false, error: e.message })
  }
})

// 启动：设备同步 + OSD 实时遥测 + 司空 ZLM 流监视 + 媒体归档
syncDevices()
setInterval(syncDevices, 60000)
wsOsd.start()
zlmWatch.start()
mediaWatch.start()

server.listen(PORT, () => {
  console.log(`[dji-openapi] 接入服务已启动 :${PORT}`)
  console.log(`[dji-openapi] ① REST: ${config.openapi.baseUrl}/v1/*（login-user 内部头）`)
  console.log(`[dji-openapi] ② OSD WebSocket: ${config.openapi.wsUrl}`)
  console.log(`[dji-openapi] ③ webhook 接收: POST /webhook/sync（X-Event-Type + X-Signature）`)
  console.log(`[dji-openapi] ④ RTMP 直推: ${config.zlm.rtmp}（我方 ZLM）`)
  console.log(`[dji-openapi] 隔离红线: 端口 ${config.isolation.forbiddenPorts.join('/')} 不占用 · systemd 非 docker`)
})
