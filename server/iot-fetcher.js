/**
 * IoTCloud AI 视频分析记录拉取模块
 *
 * 定时从 IoTCloud 物联平台拉取通道分析记录，
 * 转换为标准 warning 格式写入 JSC 驾驶舱告警管道。
 *
 * 集成方式（在 index.js 启动回调中）:
 *   const iotFetcher = require('./iot-fetcher')
 *   iotFetcher.start({ store, log, intervalMs: 30000 })
 */

const http = require('http')

// ── 配置 ──────────────────────────────────────────────
// IoTCloud 凭据外置到环境变量（见 systemd 服务文件 Environment= 或部署脚本），
// 不再硬编码在源码中。缺失时给出安全降级：baseUrl/username 退回非敏感默认值，
// password 必须来自环境变量（空串会触发登录失败并被轮询重试捕获，不会崩溃）。
const IOT = {
  baseUrl: process.env.IOT_CLOUD_BASE_URL || 'http://172.16.8.11:6881/prod-api',
  username: process.env.IOT_CLOUD_USERNAME || 'iot-video',
  password: process.env.IOT_CLOUD_PASSWORD || '',
  // 可扩展多通道
  // streamId 关联驾驶舱视频流（coll_streams.id），用于「地理坐标触发对应」：
  // 通道产生 AI 分析推送时，对应摄像头图标在地图上告警。
  channels: [
    { spid: '56331706881318000004', name: '九龙沙场', deviceId: '50010100001310000001', streamId: '43acf69b-cc6a-4cfc-a140-c6fc21b1fcdb' },
  ],
  // 通道触发后摄像头图标保持告警状态的时长（毫秒），超时后自动熄灭
  alertTtlMs: 30 * 60 * 1000,
}

if (!process.env.IOT_CLOUD_PASSWORD) {
  // 仅打印一次提示，不在日志中泄露凭据；实际登录会在轮询中失败并被捕获
  console.warn('[IoT] 警告: 未设置环境变量 IOT_CLOUD_PASSWORD，IoTCloud 登录将失败。请在 systemd 服务或部署环境中配置。')
}

// AI 类型映射（analyseInfo JSON key → 中文）
const AI_TYPE_MAP = {
  unsoilcover: '堆头未覆盖',
  uncovered: '裸土未覆盖',
  person: '人员入侵',
  vehicle: '车辆违停',
  fire: '烟火检测',
  water: '水位异常',
  garbage: '垃圾堆积',
}

// ── 状态 ──────────────────────────────────────────────
let _token = ''
let _tokenExpire = 0       // token 过期时间戳(ms)
let _store = null
let _log = null
let _timer = null
let _lastRecordIds = new Set()  // 去重：已推送的 recordId
// 通道 → 地理坐标 / 视频流 映射（启动时从 coll_streams 解析）
let _channelGeo = {}      // spid -> { lat, lon }
let _channelStream = {}   // spid -> streamId

// ── HTTP 辅助（不走代理，直连局域网） ─────────────────
function iotRequest(method, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    // 注意：baseUrl 含 /prod-api，而 path 是绝对路径（以 / 开头）。
    // 不能直接 new URL('/login', base)，URL 构造器会用 /login 覆盖掉 base 的 /prod-api 路径！
    // 必须手动拼接，保留 /prod-api 前缀。
    const base = IOT.baseUrl.replace(/\/$/, '')
    const rel = path.startsWith('/') ? path : `/${path}`
    const url = new URL(base + rel)
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        ...( _token ? { Authorization: `Bearer ${_token}` } : {}),
        ...extraHeaders,
      },
      timeout: 10000,
    }

    const req = http.request(opts, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }) }
        catch { resolve({ status: res.statusCode, body: data }) }
      })
    })

    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('IoT request timeout')) })

    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

// ── 登录 + Token 管理 ────────────────────────────────
async function login() {
  try {
    const res = await iotRequest('POST', '/login', {
      username: IOT.username,
      password: IOT.password,
    }, { 'isToken': 'false' })
    if (res.status === 200 && res.body?.token) {
      _token = res.body.token
      // JWT 默认有效期较长，设为 2 小时后刷新
      _tokenExpire = Date.now() + 2 * 3600 * 1000
      if (_log) _log.info('[IoT] 登录成功')
      return true
    }
    if (_log) _log.error(`[IoT] 登录失败: ${JSON.stringify(res.body)}`)
    return false
  } catch (e) {
    if (_log) _log.error(`[IoT] 登录异常: ${e.message}`)
    return false
  }
}

async function ensureToken() {
  if (_token && Date.now() < _tokenExpire) return true
  return login()
}

// ── analyseInfo 解析 ─────────────────────────────────
function parseAnalyseInfo(infoStr) {
  try {
    const arr = JSON.parse(infoStr)
    if (!Array.isArray(arr) || arr.length === 0) return { type: 'AI分析', confidence: 0, raw: infoStr }
    const first = arr[0]
    const key = Object.keys(first)[0]
    const value = first[key]
    return {
      type: AI_TYPE_MAP[key] || key || 'AI分析',
      confidence: typeof value === 'number' ? value : 0,
      raw: infoStr,
    }
  } catch {
    return { type: 'AI分析', confidence: 0, raw: infoStr }
  }
}

// ── 单条记录 → Warning 对象 ─────────────────────────
function transformToWarning(rec) {
  const ai = parseAnalyseInfo(rec.analyseInfo)
  const level = ai.confidence >= 0.7 ? 3 : ai.confidence >= 0.5 ? 2 : 1  // 3=中度 2=轻度 1=注意
  // 地理坐标来自关联的视频流（coll_streams），实现与驾驶舱摄像头的「坐标触发对应」
  const spid = rec.channelSpid || rec.channelSipId || ''
  const geo = _channelGeo[spid] || {}
  const streamId = _channelStream[spid] || ''

  return {
    id: `iot-${rec.recordId}`,
    createdAt: rec.createTime,
    status: 'pending',
    warning_type: 'iot-video-analysis',   // 供前端 toAlert 识别（data_json 内）
    warningType: 'iot-video-analysis',    // 供 insertWarning 写入 warning_type 列（camelCase）
    // data_json 字段（前端 AlertItem 所需）
    source: 'iotcloud',
    recordId: rec.recordId,
    deviceSipId: rec.deviceSipId,
    channelSipId: rec.channelSipId,
    channelSpid: rec.channelSpid,
    channelName: rec.channelName || '',
    deviceName: rec.deviceName || '',
    picUrl: rec.picUrl || '',
    aiType: ai.type,
    aiConfidence: ai.confidence,
    ruleId: rec.ruleId,
    streamId,   // 关联视频流 id，供前端地图摄像头图标定位告警
    // 兼容现有 AlertItem 字段
    time: rec.createTime ? rec.createTime.slice(11, 19) : '',
    location: `${rec.channelName || ''} ${rec.deviceName || ''}`.trim(),
    type: `AI视频分析 · ${ai.type}`,
    value: `置信度 ${Math.round(ai.confidence * 100)}%`,
    standard: `阈值 ≥50%`,
    level,
    lat: typeof geo.lat === 'number' ? geo.lat : 30.731352,
    lon: typeof geo.lon === 'number' ? geo.lon : 108.416972,
  }
}

// ── 拉取一轮数据 ─────────────────────────────────────
async function fetchOnce() {
  if (!await ensureToken()) return

  // 从 iot_channels 表热加载启用通道（每轮查表，管理员改动 30s 内生效，免重启）
  const channels = (_store && typeof _store.listIotChannels === 'function')
    ? _store.listIotChannels().filter(c => c.enabled)
    : []
  if (channels.length === 0) return 0

  // 每轮刷新坐标映射（按 streamId 从 coll_streams 解析）
  resolveChannelGeo(channels.map(c => ({
    spid: c.channelSipId, name: c.channelName, streamId: c.streamId,
  })))

  let totalNew = 0
  for (const ch of channels) {
    try {
      const res = await iotRequest('GET',
        `/sip/analyse/record/list?pageNum=1&pageSize=20&channelSpid=${ch.channelSipId}&deviceId=${ch.deviceSipId}`)

      if (res.status !== 200 || !res.body?.rows) {
        if (_log) _log.warn(`[IoT] 拉取失败 [${ch.channelName}]: HTTP ${res.status}`)
        continue
      }

      const rows = res.body.rows || []
      for (const rec of rows) {
        // 去重
        if (_lastRecordIds.has(rec.recordId)) continue
        _lastRecordIds.add(rec.recordId)

        const warning = transformToWarning(rec)
        if (_store) {
          _store.insertWarning(warning)
        }
        totalNew++
      }

      if (totalNew > 0 && _log) {
        _log.info(`[IoT] 拉取完成 [${ch.channelName}]: 共${rows.length}条, 新增${totalNew}条`)
      }
    } catch (e) {
      if (_log) _log.error(`[IoT] 拉取异常 [${ch.channelName}]: ${e.message}`)
    }
  }
  return totalNew
}

// ── 通道 → 视频流地理坐标解析 ──────────────────────
// 从驾驶舱视频流（coll_streams）解析每个通道的真实经纬度与 streamId，
// 实现「AI 分析通道 ↔ 地图摄像头」的地理坐标触发对应。
// channels: [{ spid, name, streamId }]（来自 iot_channels 表热加载）
function resolveChannelGeo(channels) {
  _channelGeo = {}
  _channelStream = {}
  if (!_store || typeof _store.collList !== 'function') return
  const streams = _store.collList('streams') || []
  for (const ch of channels) {
    const spid = ch.spid || ch.channelSipId
    if (!spid) continue
    let st = ch.streamId ? streams.find(s => s.id === ch.streamId) : null
    if (!st && ch.name) st = streams.find(s => s.name === ch.name)
    if (st && typeof st.lat === 'number' && typeof st.lon === 'number') {
      _channelGeo[spid] = { lat: st.lat, lon: st.lon }
      _channelStream[spid] = st.id
    } else if (ch.streamId) {
      // 找不到关联视频流时，仍记录 streamId（可能稍后补齐），坐标为空由前端兜底
      _channelStream[spid] = ch.streamId
    }
  }
}

// 启动时为已入库的历史记录补齐正确的经纬度与 streamId（避免旧数据坐标错误）
function fixExistingRows() {
  if (!_store || typeof _store.queryWarnings !== 'function') return
  const rows = _store.queryWarnings({ type: 'iot-video-analysis', limit: 5000 }) || []
  let fixed = 0
  for (const w of rows) {
    const spid = w.channelSpid || w.channelSipId || ''
    const geo = _channelGeo[spid]
    const sid = _channelStream[spid] || ''
    if (!geo && !sid) continue
    if (w.lat === geo?.lat && w.lon === geo?.lon && w.streamId === sid) continue
    if (geo) { w.lat = geo.lat; w.lon = geo.lon }
    if (sid) w.streamId = sid
    _store.insertWarning(w)  // INSERT OR REPLACE（以 id 为主键）
    fixed++
  }
  if (fixed > 0 && _log) _log.info(`[IoT] 已修正 ${fixed} 条历史记录的坐标/streamId`)
}

// ── 按通道分类的 AI 历史分析存档 ────────────────────
function getArchive() {
  if (!_store) return { channels: [], total: 0 }
  const rows = _store.queryWarnings({ type: 'iot-video-analysis', limit: 5000 }) || []
  const byChannel = new Map()
  for (const w of rows) {
    const key = w.channelName || w.channelSipId || '未命名通道'
    const spid = w.channelSpid || w.channelSipId || ''
    if (!byChannel.has(key)) {
      byChannel.set(key, {
        channelName: key,
        spid,
        deviceId: w.deviceSipId || '',
        streamId: w.streamId || _channelStream[spid] || '',
        lat: typeof w.lat === 'number' ? w.lat : (_channelGeo[spid]?.lat ?? null),
        lon: typeof w.lon === 'number' ? w.lon : (_channelGeo[spid]?.lon ?? null),
        records: [],
        latestAt: '',
      })
    }
    const ch = byChannel.get(key)
    const createdAt = w.createdAt || ''
    if (createdAt > ch.latestAt) ch.latestAt = createdAt
    ch.records.push({
      id: w.id,
      createdAt,
      time: w.time || (createdAt ? createdAt.slice(11) : ''),
      fullTime: createdAt,
      aiType: w.aiType || '',
      aiConfidence: w.aiConfidence || 0,
      level: w.level || 1,
      imageUrl: w.picUrl ? `/api/iot-image?url=${encodeURIComponent(w.picUrl)}` : null,
      channelName: w.channelName || '',
      deviceName: w.deviceName || '',
      warningType: w.warning_type || 'iot-video-analysis',
    })
  }
  const channels = [...byChannel.values()].map(ch => ({
    ...ch,
    total: ch.records.length,
    records: ch.records.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')),
  })).sort((a, b) => (b.latestAt || '').localeCompare(a.latestAt || ''))
  return { channels, total: rows.length }
}

// ── 通道实时触发状态（驱动地图摄像头图标告警）────────
function getStatus() {
  const archive = getArchive()
  const now = Date.now()
  const channels = archive.channels.map(ch => {
    let alerting = false
    let lastEventAt = ch.latestAt || ''
    let lastEventType = ''
    if (ch.records.length) {
      const latest = ch.records[0] // records 已按时间倒序
      lastEventAt = latest.createdAt
      lastEventType = latest.aiType || ''
      const t = new Date(String(latest.createdAt).replace(' ', 'T')).getTime()
      alerting = !isNaN(t) && (now - t) < IOT.alertTtlMs
    }
    return {
      spid: ch.spid,
      name: ch.channelName,
      streamId: ch.streamId,
      lat: ch.lat,
      lon: ch.lon,
      alerting,
      lastEventAt,
      lastEventType,
    }
  })
  return { channels, ttlMinutes: IOT.alertTtlMs / 60000, serverTime: new Date().toISOString() }
}

// ── 远程通道列表（供后台「通道接入」拉取 IoTCloud NVR 设备通道）──
async function listRemoteChannels() {
  if (!await ensureToken()) return { ok: false, error: 'IoTCloud 登录失败' }
  try {
    const res = await iotRequest('GET', '/sip/channel/list?pageNum=1&pageSize=200')
    if (res.status !== 200 || !Array.isArray(res.body?.rows)) {
      return { ok: false, error: `HTTP ${res.status}` }
    }
    const local = (_store && typeof _store.listIotChannels === 'function') ? _store.listIotChannels() : []
    const localSet = new Set(local.map(c => c.channelSipId))
    const list = res.body.rows.map(r => ({
      channelSipId: r.channelSipId,
      channelName: r.channelName || '',
      deviceSipId: r.deviceSipId || '',
      deviceName: r.deviceName || '',
      snapshotUrl: r.sipChannelPhoto?.picUrl ? `/api/iot-image?url=${encodeURIComponent(r.sipChannelPhoto.picUrl)}` : null,
      alreadyAdded: localSet.has(r.channelSipId),
    }))
    return { ok: true, channels: list, total: res.body.total || list.length }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// ── 图片代理（解决跨域，供前端调用） ────────────────
// 简易内存 LRU 缓存：同一张图（如聚合告警预览、通道快照）在 5 分钟内被多张卡片重复请求时，
// 命中缓存直接返回字节，避免反复回源 IoTCloud，显著降低驾驶舱告警图片加载耗时。
const _imageCache = new Map() // key: picUrl -> { buf, contentType, expire }
const IMAGE_CACHE_TTL = 5 * 60 * 1000
const IMAGE_CACHE_MAX = 300
function _cacheGet(url) {
  const e = _imageCache.get(url)
  if (!e) return null
  if (Date.now() > e.expire) { _imageCache.delete(url); return null }
  // LRU touch：移到队尾
  _imageCache.delete(url); _imageCache.set(url, e)
  return e
}
function _cacheSet(url, buf, contentType) {
  if (_imageCache.size >= IMAGE_CACHE_MAX) {
    const oldest = _imageCache.keys().next().value // Map 保留插入顺序，首条即最旧
    if (oldest !== undefined) _imageCache.delete(oldest)
  }
  _imageCache.set(url, { buf, contentType, expire: Date.now() + IMAGE_CACHE_TTL })
}

async function proxyImage(req, res) {
  const picUrl = req.query.url
  if (!picUrl) return res.status(400).send('Missing url param')

  // 安全检查：允许 IoTCloud 图片域名（限定路径前缀）+ 城运视频平台图片域名（路径放宽）
  // 城运平台图片域名通过 CHENGYUN_IMG_HOSTS 配置（默认含文档示例 10.120.49.14）
  const IOT_CLOUD_HOSTS = ['111.10.220.226', '172.16.8.11']
  const CHENGYUN_IMG_HOSTS = (process.env.CHENGYUN_IMG_HOSTS || '10.120.49.14').split(',').map(s => s.trim()).filter(Boolean)
  const ALLOWED_HOSTS = Array.from(new Set([...IOT_CLOUD_HOSTS, ...CHENGYUN_IMG_HOSTS]))
  try {
    const u = new URL(picUrl)
    if (!ALLOWED_HOSTS.includes(u.hostname)) return res.status(403).send('Forbidden')
    // IoTCloud 域名强制路径前缀；城运域名放宽（平台图片路径格式未定）
    if (IOT_CLOUD_HOSTS.includes(u.hostname)) {
      const pathOk = u.pathname.includes('/images/') || u.pathname.includes('/profile/snap/')
      if (!pathOk) return res.status(403).send('Forbidden')
    }
  } catch {
    return res.status(400).send('Invalid URL')
  }

  // 命中缓存：直接返回字节（带 X-Cache 头便于联调观察）
  const cached = _cacheGet(picUrl)
  if (cached) {
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.setHeader('Content-Type', cached.contentType || 'image/jpeg')
    res.setHeader('X-Cache', 'HIT')
    return res.end(cached.buf)
  }

  try {
    const purl = new URL(picUrl)
    // JSC 服务器内部无法访问公网 IP（111.10.220.226），改写为局域网 IP（172.16.8.11）
    const targetHost = purl.hostname === '111.10.220.226' ? '172.16.8.11' : purl.hostname
    const proxyReq = http.get({
      hostname: targetHost,
      port: purl.port || 80,
      path: purl.pathname + purl.search,
      timeout: 15000,
    }, (proxyRes) => {
      if (proxyRes.statusCode !== 200) {
        proxyRes.resume() // 丢弃错误响应体
        return res.status(proxyRes.statusCode || 502).send('Image source error')
      }
      const contentType = proxyRes.headers['content-type'] || 'image/jpeg'
      res.setHeader('Cache-Control', 'public, max-age=300')
      res.setHeader('Content-Type', contentType)
      res.setHeader('X-Cache', 'MISS')
      // 边转发边收集字节，结束后再写入缓存
      const chunks = []
      proxyRes.on('data', (c) => { chunks.push(c); res.write(c) })
      proxyRes.on('end', () => {
        try { _cacheSet(picUrl, Buffer.concat(chunks), contentType) } catch {}
        res.end()
      })
    })

    proxyReq.on('error', () => res.status(502).send('Image proxy error'))
    proxyReq.on('timeout', () => { proxyRes.destroy(); res.status(504).send('Image timeout') })
  } catch (e) {
    res.status(500).send('Proxy failed')
  }
}

// ── API 路由注册 ─────────────────────────────────────
function registerRoutes(app) {
  // IoT 分析历史查询
  app.get('/api/iot-analysis', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 100)
    if (!_store) return res.json({ rows: [], total: 0 })

    const warnings = _store.queryWarnings({ type: 'iot-video-analysis', limit })
    res.json({
      rows: warnings.map(w => ({
        id: w.id,
        time: w.time,
        fullTime: w.createdAt,
        type: w.type,
        location: w.location,
        value: w.value,
        level: w.level,
        imageUrl: w.picUrl ? `/api/iot-image?url=${encodeURIComponent(w.picUrl)}` : null,
        channelName: w.channelName,
        deviceName: w.deviceName,
        aiType: w.aiType,
        aiConfidence: w.aiConfidence,
        createdAt: w.createdAt,
      })),
      total: warnings.length,
    })
  })

  // 图片代理
  app.get('/api/iot-image', proxyImage)

  // 按通道分类的 AI 历史分析存档
  app.get('/api/iot-analysis/archive', (req, res) => {
    res.json(getArchive())
  })

  // 通道实时触发状态（地理坐标对应摄像头图标告警）
  app.get('/api/iot-analysis/status', (req, res) => {
    res.json(getStatus())
  })

  // 手动触发一次拉取（调试用）
  app.post('/api/iot-fetch/now', async (req, res) => {
    const count = await fetchOnce()
    res.json({ ok: true, newRecords: count })
  })

  // 演示/验证用：为指定通道注入一条「当前时间」的 AI 分析记录，触发摄像头图标告警
  app.post('/api/iot-analysis/simulate', async (req, res) => {
    const spid = String(req.body?.spid || '')
    const channels = (_store && typeof _store.listIotChannels === 'function') ? _store.listIotChannels() : []
    const ch = channels.find(c => c.channelSipId === spid) || channels[0]
    if (!ch) return res.status(400).json({ error: '无已接入通道' })
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const createdAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    // 模拟记录尽量附带一张真实图片，避免前端缩略图裂图
    let fallbackPicUrl = ''
    if (_store && typeof _store.queryWarnings === 'function') {
      const samples = _store.queryWarnings({ type: 'iot-video-analysis', limit: 1 })
      if (samples.length && samples[0].picUrl) fallbackPicUrl = samples[0].picUrl
    }
    const rec = {
      recordId: `sim-${Date.now()}`,
      deviceSipId: ch.deviceSipId,
      channelSipId: ch.channelSipId,
      channelSpid: ch.channelSipId,
      channelName: ch.channelName,
      deviceName: ch.deviceName,
      picUrl: fallbackPicUrl,
      analyseInfo: JSON.stringify([{ unsoilcover: 0.82 }]),
      createTime: createdAt,
    }
    const w = transformToWarning(rec)
    if (_store) _store.insertWarning(w)
    _lastRecordIds.add(rec.recordId)
    if (_log) _log.info(`[IoT] 模拟触发通道 [${ch.channelName}]，摄像头图标进入告警`)
    res.json({ ok: true, warning: w, status: getStatus() })
  })

  // 模拟走完「AI分析存档 → 智治推送结案」全流程（验证 AI 置信度范围/均值变量用）
  // 注入 N 张 AI 分析图（不同置信度）→ 聚合为带 memberIds 的一条事件 → 直插推送历史(pushed)
  // → 模拟城运回执(processing) → 一键结案(closed) → 生成结案 PDF。全程真实落库，跳过真实 HTTP 推送。
  app.post('/api/iot-analysis/simulate-closure', async (req, res) => {
    try {
      if (!_store) return res.status(500).json({ error: '存储未就绪' })
      const channels = (typeof _store.listIotChannels === 'function') ? _store.listIotChannels() : []
      const spid = String(req.body?.spid || channels[0]?.channelSipId || '')
      const ch = channels.find(c => c.channelSipId === spid) || channels[0]
      if (!ch) return res.status(400).json({ error: '无已接入通道' })

      // 事件类型：默认「堆头未覆盖」（AI_TYPE_MAP.key=unsoilcover）
      const aiKey = 'unsoilcover'
      const aiTypeLabel = AI_TYPE_MAP[aiKey] || 'AI分析'
      const imageCount = Math.min(Math.max(parseInt(req.body?.count) || 5, 1), 20)

      const now = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      const createdAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`

      // 取一张真实图片作缩略图，避免前端裂图
      let fallbackPicUrl = ''
      const samples = _store.queryWarnings({ type: 'iot-video-analysis', limit: 1 })
      if (samples.length && samples[0].picUrl) fallbackPicUrl = samples[0].picUrl

      // 1) 注入 N 张 AI 分析存档记录（每张不同置信度，铺开在 [0.76, 0.95]）
      const confs = []
      const memberIds = []
      for (let i = 0; i < imageCount; i++) {
        const conf = Number((0.76 + (0.95 - 0.76) * (i / Math.max(1, imageCount - 1))).toFixed(2))
        confs.push(conf)
        const recordId = `simc-${Date.now()}-${i}-${Math.floor(Math.random() * 1e4)}`
        const rec = {
          recordId,
          deviceSipId: ch.deviceSipId,
          channelSipId: ch.channelSipId,
          channelSpid: ch.channelSipId,
          channelName: ch.channelName,
          deviceName: ch.deviceName,
          picUrl: fallbackPicUrl,
          analyseInfo: JSON.stringify([{ [aiKey]: conf }]),
          createTime: createdAt,
        }
        const w = transformToWarning(rec)
        _store.insertWarning(w)
        _lastRecordIds.add(recordId)
        memberIds.push(w.id)
      }

      // 2) 聚合为一条带 memberIds 的推送事件（与前端 DashboardContext 推送 raw_json 同构）
      const geo = _channelGeo[ch.channelSipId] || {}
      const eventId = `simevt-${Date.now()}`
      const eventRaw = {
        memberIds,
        channelSipId: ch.channelSipId,
        channelSpid: ch.channelSipId,
        channelName: ch.channelName,
        deviceName: ch.deviceName,
        aiType: aiTypeLabel,
        event_type: aiTypeLabel,
      }
      _store.getDb().prepare(`INSERT INTO smart_push_events (id, event_type, location, lat, lon, level, value, standard, description, image_url, raw_json, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(eventId, aiTypeLabel, ch.channelName || '',
          typeof geo.lat === 'number' ? geo.lat : 30.731352,
          typeof geo.lon === 'number' ? geo.lon : 108.416972,
          3, '多张 AI 分析图像', '阈值 ≥50%',
          `模拟聚合：${imageCount} 张「${aiTypeLabel}」AI 分析图，置信度 ${Math.min(...confs)}~${Math.max(...confs)}`,
          '', JSON.stringify(eventRaw), 'iot-simulate', createdAt)

      // 3) 直插推送历史（跳过真实 HTTP 推送），状态 pushed
      const historyId = require('crypto').randomUUID()
      _store.getDb().prepare(`INSERT INTO smart_push_history (id, rule_id, plan_id, event_type, event_ids, location, trigger_count, api_url, api_method, request_body, response_status, response_body, success, error_message, created_at, status, platform_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(historyId, null, null, `（模拟）${aiTypeLabel}`, JSON.stringify([eventId]),
          ch.channelName || '', imageCount, 'SIMULATE-LOCAL', 'POST', JSON.stringify(eventRaw),
          200, '模拟推送成功', 1, null, createdAt, 'pushed', null)

      // 4) 模拟城运中心回执（受理中）
      _store.recordSmartPushCallback({
        pushId: historyId,
        status: 'processing',
        disposalResult: `经 AI 视频分析确认，${ch.channelName || '该通道'} 存在「${aiTypeLabel}」问题，已派单属地网格员现场核查处置。`,
        disposalOperator: '模拟坐席（演示）',
        disposalTime: createdAt,
        body: { simulated: true, source: 'iot-analysis-simulate-closure', event_type: aiTypeLabel, memberCount: imageCount },
      })

      // 5) 一键结案
      _store.closeSmartPushHistory(historyId, '模拟结案（演示）')

      // 6) 生成结案 PDF
      const reportRenderer = require('./report-renderer')
      const report = await reportRenderer.generateClosureReport(historyId)

      // 7) 取回置信度统计，便于前端即时提示
      const evt = _store.getDb().prepare('SELECT * FROM smart_push_events WHERE id = ?').get(eventId)
      const conf = _store.computeAiConfidenceStats([evt])

      if (_log) _log.info(`[IoT] 模拟结案流程完成：historyId=${historyId}, 图片=${imageCount}, conf=${JSON.stringify(conf)}`)
      res.json({
        ok: true,
        historyId,
        reportPath: report.path,
        reportUrl: `/api/smart-push/history/${historyId}/report`,
        eventType: `（模拟）${aiTypeLabel}`,
        imageCount,
        memberIds,
        conf,
      })
    } catch (e) {
      if (_log) _log.error(`[IoT] 模拟结案流程异常: ${e.message}\n${e.stack}`)
      res.status(500).json({ error: e.message })
    }
  })
}

// ── 首次种子迁移：iot_channels 表完全为空（含软删行）时，把硬编码 IOT.channels 写入一次 ──
function seedIfEmpty() {
  if (!_store || typeof _store.countIotChannelsAll !== 'function') return
  if (_store.countIotChannelsAll() > 0) return
  for (const ch of IOT.channels) {
    _store.upsertIotChannel({
      channelSipId: ch.spid, channelName: ch.name, deviceSipId: ch.deviceId,
      deviceName: '', streamId: ch.streamId, enabled: true, remark: '种子迁移',
    })
  }
  if (_log && IOT.channels.length) _log.info(`[IoT] 首次启动：已种子 ${IOT.channels.length} 条通道到 iot_channels 表`)
}

// ── 启动 / 停止 ───────────────────────────────────────
function start(opts = {}) {
  _store = opts.store
  _log = opts.log || console
  const intervalMs = opts.intervalMs || 30000

  // 初始登录
  login().then(ok => {
    if (ok) {
      // 首次种子迁移（表为空时）
      seedIfEmpty()
      // 解析通道→视频流地理坐标，并修正历史记录
      const channels = (_store && typeof _store.listIotChannels === 'function')
        ? _store.listIotChannels().filter(c => c.enabled) : []
      resolveChannelGeo(channels.map(c => ({ spid: c.channelSipId, name: c.channelName, streamId: c.streamId })))
      fixExistingRows()
      // 立即拉取一次
      fetchOnce()
      // 定时轮询（每轮从表热加载通道）
      _timer = setInterval(fetchOnce, intervalMs)
      _log.info(`[IoT] 启动成功，每 ${(intervalMs / 1000)}s 拉取一次（通道来源 iot_channels 表）`)
    } else {
      _log.error('[IoT] 启动失败：无法登录 IoTCloud')
    }
  })
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null }
  _token = ''
  _lastRecordIds.clear()
}

module.exports = { start, stop, registerRoutes, fetchOnce, listRemoteChannels, IOT }
