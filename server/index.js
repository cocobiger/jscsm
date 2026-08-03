const express = require('express')
const cors = require('cors')
const { spawn } = require('child_process')
const { v4: uuidv4 } = require('uuid')
const fs = require('fs')
const path = require('path')
const crawler = require('./crawler')
const warningEngine = require('./warning-engine')
const auth = require('./auth')
const logger = require('./logger')
const log = logger.child('server')
const streamMonitor = require('./stream-monitor')
const iotFetcher = require('./iot-fetcher')
const zlm = require('./zlm')
const djiBridge = require('./dji-bridge')
const sms = require('./sms-mas')
const store = require('./store-db')  // 采集数据 SQLite 存储层（长期入库，替代 collected.json 的 5000 条上限）
const reportRenderer = require('./report-renderer')  // 第③环 PDF 结案报告编排器

const app = express()
const PORT = 7170
app.use(cors())
app.use(express.json())
// 短信平台回调可能以 Base64 文本或表单提交，额外挂载 text/urlencoded 解析（仅影响这些 content-type）
app.use(express.text({ type: ['text/*', 'application/octet-stream'], limit: '256kb' }))
app.use(express.urlencoded({ extended: false, limit: '256kb' }))

// ── JSON file store (pure JS, no native deps) ────────────────
// 数据文件存放在独立的 data/ 子目录，与源码隔离
// 关键：避免 node --watch 监视到数据写入而重启进程，从而截断文件
const DATA_DIR = path.join(__dirname, 'data')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

// 初始化日志（LOG_FILE=1 时写 data/logs/）
logger.init(DATA_DIR)
zlm.init(DATA_DIR, log)
djiBridge.init(log)
sms.init(DATA_DIR, log)
store.init(DATA_DIR, log)  // 初始化采集数据 SQLite 库（server/data/jsc.db）

// 初始化登录鉴权（用户/会话存 jsc.db，首次种默认管理员 admin/admin123）
auth.init(log)

// 与前端一致的 streamId 派生算法（DJI WebRTC 用 shareUrl + parentName + airportName 生成稳定 ID）
function deriveStreamId(url) {
  let h = 0
  for (let i = 0; i < (url || '').length; i++) { h = ((h << 5) - h + url.charCodeAt(i)) | 0 }
  return 's' + Math.abs(h).toString(36)
}
function djiStreamId(cfg) {
  if (!cfg) return null
  // 2026-07-09: 嵌套子相机接入时，同一分享页下同名子相机会冲突，把 parentName 纳入哈希。
  // 顶层设备（无 parentName）保持旧算法兼容，避免已有流失效。
  const key = cfg.parentName
    ? `${cfg.shareUrl}#${cfg.parentName}|${cfg.airportName}`
    : `${cfg.shareUrl}#${cfg.airportName}`
  return deriveStreamId(key)
}

// ── 角色权限矩阵 ──────────────────────────────────────────────
// 公开（无需登录）：登录接口 + 短信平台机器回调（靠 IP 白名单保障）
const PUBLIC_PATHS = new Set(['/api/auth/login', '/api/sms/report', '/api/sms/upstream', '/api/device-status', '/api/map-points', '/api/events', '/api/weather', '/api/display-config', '/api/iot-image', '/api/iot-analysis/archive', '/api/iot-analysis/status', '/api/smart-push/callback'])
// 任意登录用户（含访客）可用的写操作：视频播放、登出、改自己密码
const ANY_USER_WRITES = new Set([
  '/api/auth/logout', '/api/auth/me', '/api/auth/change-password',
  '/api/stream/start',
  '/api/smart-push/events',  // 智治推送：告警事件入库（MQTT 告警同步）
])
// 值守员及以上可用的写操作（前缀匹配）
const OPERATOR_WRITE_PREFIXES = [
  '/api/warnings',        // 处理预警 / handle-all
  '/api/sms/send',        // 手动发短信 / send-template
  '/api/collect/run',     // 手动触发采集
  '/api/smart-push/history', // 智治推送人工一键结案
]
// 判断一个写请求所需的最低角色
function requiredRoleForWrite(path) {
  if (ANY_USER_WRITES.has(path)) return 'viewer'
  if (path.startsWith('/api/stream/stop')) return 'viewer'  // 停播放也任意登录可用
  for (const p of OPERATOR_WRITE_PREFIXES) if (path.startsWith(p)) return 'operator'
  return 'admin'  // 其余写操作（各类配置、用户管理）默认仅管理员
}

// 会话鉴权 + 角色判定中间件
app.use('/api', (req, res, next) => {
  // 注意：app.use('/api',...) 内 req.path 已被剥掉 /api 前缀，
  // 故用 baseUrl+path 还原完整路径再做白名单/角色匹配。
  const fullPath = req.baseUrl + req.path
  if (PUBLIC_PATHS.has(fullPath)) return next()
  const token = auth.extractToken(req)
  const session = auth.verify(token)
  if (!session) return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', error: '未登录或会话已过期，请重新登录' })
  req.user = { id: session.user_id, username: session.username, role: session.role }
  // 读操作（GET/HEAD/OPTIONS）：任意登录用户放行
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next()
  // 写操作：按矩阵判定最低角色
  const need = requiredRoleForWrite(fullPath)
  if (!auth.roleAtLeast(session.role, need)) {
    return res.status(403).json({ ok: false, code: 'FORBIDDEN', error: '权限不足，需要更高角色' })
  }
  next()
})

// ── 登录 / 会话接口 ──
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {}
  const r = auth.login(username, password)
  if (!r.ok) return res.status(401).json(r)
  res.json(r)
})
app.post('/api/auth/logout', (req, res) => {
  auth.logout(auth.extractToken(req))
  res.json({ ok: true })
})
// 当前登录用户信息（前端启动时校验会话）
app.get('/api/auth/me', (req, res) => {
  res.json({ ok: true, user: req.user })
})
// 改自己密码
app.post('/api/auth/change-password', (req, res) => {
  const { oldPassword, newPassword } = req.body || {}
  const r = auth.changePassword(req.user.id, oldPassword, newPassword)
  if (!r.ok) return res.status(400).json(r)
  res.json(r)
})

// ── 用户管理（仅管理员，中间件已按 /api/users 默认 admin 拦截）──
app.get('/api/users', (req, res) => res.json(store.listUsers()))
app.post('/api/users', (req, res) => {
  const r = auth.createUser(req.body || {})
  if (!r.ok) return res.status(400).json(r)
  res.status(201).json(r.user)
})
app.patch('/api/users/:id', (req, res) => {
  const { role, enabled } = req.body || {}
  const patch = {}
  if (role !== undefined) { if (!auth.ROLES.includes(role)) return res.status(400).json({ error: '角色非法' }); patch.role = role }
  if (enabled !== undefined) patch.enabled = !!enabled
  const u = store.updateUser(req.params.id, patch)
  if (!u) return res.status(404).json({ error: '用户不存在' })
  res.json({ id: u.id, username: u.username, role: u.role, enabled: u.enabled === 1 })
})
// 管理员重置某用户密码
app.post('/api/users/:id/reset-password', (req, res) => {
  const { newPassword } = req.body || {}
  const r = auth.adminSetPassword(req.params.id, newPassword, true)
  if (!r.ok) return res.status(400).json(r)
  res.json(r)
})
app.delete('/api/users/:id', (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: '不能删除当前登录的自己' })
  const ok = store.deleteUser(req.params.id)
  if (!ok) return res.status(404).json({ error: '用户不存在' })
  res.json({ ok: true })
})
const STREAMS_FILE = path.join(DATA_DIR, 'streams.json')
const POINTS_FILE = path.join(DATA_DIR, 'map_points.json')

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJson(file, data) {
  // 写入前自动备份上一版（滚动保留最近 3 份：.bak1 最新, .bak3 最旧）
  try {
    if (fs.existsSync(file)) {
      const cur = fs.readFileSync(file, 'utf8')
      // 仅在当前文件可解析为非空数组时才备份，避免把损坏文件存进备份
      let valid = false
      try { const p = JSON.parse(cur); valid = Array.isArray(p) && p.length > 0 } catch {}
      if (valid) {
        const b3 = file + '.bak3', b2 = file + '.bak2', b1 = file + '.bak1'
        if (fs.existsSync(b2)) fs.renameSync(b2, b3)
        if (fs.existsSync(b1)) fs.renameSync(b1, b2)
        fs.writeFileSync(b1, cur)
      }
    }
  } catch (e) { log.error('备份失败: ' + e.message) }
  // 序列化 + 自校验：先确保 JSON 字符串本身合法，再写
  let json
  try {
    json = JSON.stringify(data, null, 2)
    JSON.parse(json)  // 序列化结果必须能被解析，否则拒绝写入
  } catch (e) {
    log.error('拒绝写入非法 JSON: ' + file + ' ' + e.message)
    throw new Error('数据序列化失败，已阻止写入以保护文件: ' + e.message)
  }
  // 原子写：唯一临时文件名（防并发） + 写入 + 回读校验 + rename
  const tmp = file + '.tmp.' + process.pid + '.' + Date.now()
  fs.writeFileSync(tmp, json)
  // 回读校验：确认临时文件落盘内容完整且可解析
  const back = fs.readFileSync(tmp, 'utf8')
  JSON.parse(back)  // 抛错则不会执行 rename，主文件保持原样
  fs.renameSync(tmp, file)
}

// 数据文件健康状态：条数 + 是否可解析 + 备份情况
function fileHealth(file) {
  const info = { exists: fs.existsSync(file), parseable: false, count: 0, bytes: 0, backups: 0 }
  if (info.exists) {
    try {
      const raw = fs.readFileSync(file, 'utf8')
      info.bytes = Buffer.byteLength(raw)
      const parsed = JSON.parse(raw)
      info.parseable = true
      info.count = Array.isArray(parsed) ? parsed.length : 1
    } catch { info.parseable = false }
  }
  for (const ext of ['.bak1', '.bak2', '.bak3']) if (fs.existsSync(file + ext)) info.backups++
  return info
}

// ── Seed streams ─────────────────────────────────────────────
const DEFAULT_STREAMS = [
  { id: 'drone-1', name: '龙宝区侦查',  location: '龙宝区', lat: 30.8572, lon: 108.3801, url: 'rtsp://192.168.1.100:554/stream/drone1',  group: '无人机视频', offline: false, protocol: 'rtsp' },
  { id: 'drone-2', name: '万州港上空',  location: '万州港', lat: 30.8569, lon: 108.3756, url: 'rtsp://192.168.1.100:554/stream/drone2',  group: '无人机视频', offline: false, protocol: 'rtsp' },
  { id: 'drone-3', name: '周家坝快检',  location: '周家坝', lat: 30.8610, lon: 108.3920, url: 'rtsp://192.168.1.100:554/stream/drone3',  group: '无人机视频', offline: false, protocol: 'rtsp' },
  { id: 'drone-4', name: '新田镇巡查',  location: '新田镇', lat: 30.7380, lon: 108.4750, url: 'rtsp://192.168.1.100:554/stream/drone4',  group: '无人机视频', offline: false, protocol: 'rtsp' },
  { id: 'port-wz1', name: '万州1#号堆', location: '万州港北堆场', lat: 30.8569, lon: 108.3756, url: 'http://111.10.220.226:18082/rtp/gb_play.live.flv', group: '港口堆场', offline: false, protocol: 'hls' },
  { id: 'port-1',  name: '万州港1#堆', location: '北区', lat: 30.8595, lon: 108.3712, url: 'rtsp://192.168.1.101:554/stream/port1',  group: '港口堆场', offline: false, protocol: 'rtsp' },
  { id: 'port-2',  name: '万州港2#堆', location: '北区', lat: 30.8588, lon: 108.3724, url: 'rtsp://192.168.1.101:554/stream/port2',  group: '港口堆场', offline: false, protocol: 'rtsp' },
  { id: 'port-3',  name: '万州港3#堆', location: '南区', lat: 30.8541, lon: 108.3698, url: 'rtsp://192.168.1.101:554/stream/port3',  group: '港口堆场', offline: false, protocol: 'rtsp' },
  { id: 'port-4',  name: '万州港4#堆', location: '南区', lat: 30.8532, lon: 108.3710, url: 'rtsp://192.168.1.101:554/stream/port4',  group: '港口堆场', offline: false, protocol: 'rtsp' },
  { id: 'road-1',  name: '沿江大道东',  location: '沿江',   lat: 30.7700, lon: 108.3900, url: 'rtsp://192.168.1.102:554/stream/road1',  group: '道路监控', offline: false, protocol: 'rtsp' },
  { id: 'road-2',  name: '高笋塘路口',  location: '高笋塘', lat: 30.7550, lon: 108.4150, url: 'rtsp://192.168.1.102:554/stream/road2',  group: '道路监控', offline: false, protocol: 'rtsp' },
  { id: 'road-3',  name: '百安大道',    location: '百安坝', lat: 30.7615, lon: 108.4461, url: 'rtsp://192.168.1.102:554/stream/road3',  group: '道路监控', offline: false, protocol: 'rtsp' },
  { id: 'water-1', name: '长江上游段',  location: '上游断面', lat: 30.8750, lon: 108.3400, url: 'rtsp://192.168.1.103:554/stream/water1', group: '水体监控', offline: false, protocol: 'rtsp' },
  { id: 'water-2', name: '长江下游段',  location: '下游断面', lat: 30.8320, lon: 108.3550, url: 'rtsp://192.168.1.103:554/stream/water2', group: '水体监控', offline: false, protocol: 'rtsp' },
  { id: 'ent-1',   name: '龙头化工',    location: '1号门', lat: 30.7380, lon: 108.4100, url: 'rtsp://192.168.1.104:554/stream/ent1',   group: '重点企业', offline: false, protocol: 'rtsp' },
  { id: 'ent-2',   name: '万达实业',    location: '2号门', lat: 30.7420, lon: 108.4230, url: 'rtsp://192.168.1.104:554/stream/ent2',   group: '重点企业', offline: false, protocol: 'rtsp' },
  { id: 'ent-3',   name: '三峡工厂',    location: '3号门', lat: 30.7510, lon: 108.4380, url: 'rtsp://192.168.1.104:554/stream/ent3',   group: '重点企业', offline: true,  protocol: 'rtsp' },
]

const DEFAULT_POINTS = [
  { id: 'air1',  type: 'air',   name: '周家坝监测站', lon: 108.372259, lat: 30.840445, aqi: 78, pm25: 18, pm10: 45, so2: 12, no2: 28 },
  { id: 'air2',  type: 'air',   name: '百安坝监测站', lon: 108.446109, lat: 30.7615,   aqi: 55, pm25: 15, pm10: 38, so2: 9,  no2: 22 },
  { id: 'w1',    type: 'water', name: '长江入库断面', lon: 108.428919, lat: 30.752402, ph: 7.2, do_: 8.4, nh3: 0.32, tp: 0.08 },
  // 摄像头点位（type:'camera'）不再硬编码，由视频流同步自动维护
  // 无人机机场点位（type:'uav'）不再硬编码，待用户提供真实坐标后通过管理页录入
  // 告警点位（type:'alert'）不再硬编码，由MQTT/告警系统动态推送
  { id: 'wm1',   type: 'watermon', name: '长江上游断面', lon: 108.35, lat: 30.75 },
  { id: 'wm2',   type: 'watermon', name: '长江下游断面', lon: 108.52, lat: 30.73 },
  { id: 'wm3',   type: 'watermon', name: '苎溪河口',     lon: 108.39, lat: 30.78 },
  { id: 'wm4',   type: 'watermon', name: '五桥河口',     lon: 108.44, lat: 30.72 },
]

// Seed files if absent OR empty/corrupt (防止残留空文件/损坏文件导致数据丢失)
function needsSeed(file) {
  if (!fs.existsSync(file)) return true
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return !Array.isArray(parsed) || parsed.length === 0
  } catch { return true }  // 解析失败 = 损坏文件，需重新种子
}
// 视频流 / 地图点位已迁入 SQLite：集合为空时种子默认值
if (store.collCount('streams') === 0) { store.collReplaceAll('streams', DEFAULT_STREAMS); log.info(`已种子 ${DEFAULT_STREAMS.length} 条视频流`) }
if (store.collCount('map_points') === 0) { store.collReplaceAll('map_points', DEFAULT_POINTS); log.info(`已种子 ${DEFAULT_POINTS.length} 个地图点位`) }

// 视频流 / 地图点位读写改走 SQLite 集合层（saveXxx 仍是"整数组替换"语义，CRUD 端点零改动）
const loadStreams = () => store.collList('streams')
const saveStreams = (a) => store.collReplaceAll('streams', a)
const loadPoints = () => store.collList('map_points')
const savePoints = (a) => store.collReplaceAll('map_points', a)

// ── Stream CRUD ──────────────────────────────────────────────
app.get('/api/streams', (req, res) => {
  res.json(loadStreams())
})

// 视频流实时探测状态（须在 /api/streams/:id 之前定义，避免被 :id 捕获）
app.get('/api/streams/health', (req, res) => {
  res.json(streamMonitor.getStatusMap())
})

app.post('/api/streams', (req, res) => {
  const { name, location = '', lat = '', lon = '', url = '', group = '道路监控', offline = false, protocol = 'rtsp', thumbnail = '', category, gb28181Config, djiWebRTCConfig } = req.body
  if (!name) return res.status(400).json({ error: '缺少 name' })
  // category: 视频流分类，用于驾驶舱视图过滤（'气环境' | '水环境'），空值表示未分类（全域态势可见）
  const stream = {
    id: uuidv4(), name, location, lat, lon, url, group, offline: !!offline, protocol,
    ...(category ? { category } : {}),
    ...(thumbnail ? { thumbnail } : {}),
    ...(gb28181Config ? { gb28181Config } : {}),
    ...(djiWebRTCConfig ? { djiWebRTCConfig } : {}),
  }
  const streams = loadStreams()
  streams.push(stream)
  saveStreams(streams)
  res.status(201).json(stream)
})

app.patch('/api/streams/:id', async (req, res) => {
  const streams = loadStreams()
  const idx = streams.findIndex(s => s.id === req.params.id)
  if (idx === -1) return res.status(404).json({ error: '未找到' })
  const old = streams[idx]
  streams[idx] = { ...old, ...req.body, id: old.id }
  saveStreams(streams)

  // dji_webrtc 下线时同步停止推流进程（Playwright + Xvfb + ffmpeg），
  // 防止机场流量卡持续消耗。stopSession 失败不回滚 offline 状态，仅记日志，
  // 由定时清理任务（见 app.listen 回调）兜底。
  if (req.body.offline === true && !old.offline
      && old.protocol === 'dji_webrtc' && old.djiWebRTCConfig) {
    const sid = djiStreamId(old.djiWebRTCConfig)
    if (sid) {
      try {
        await djiBridge.stopSession(sid)
        log.info(`下线停流成功 [${sid}]`)
      } catch (e) {
        log.warn(`下线停流失败 [${sid}]: ${e.message}（offline 状态已保存，定时清理将兜底）`)
      }
    }
  }

  res.json(streams[idx])
})

app.delete('/api/streams/:id', (req, res) => {
  const streams = loadStreams()
  const idx = streams.findIndex(s => s.id === req.params.id)
  if (idx === -1) return res.status(404).json({ error: '未找到' })
  const deleted = streams[idx]
  const next = streams.filter(s => s.id !== req.params.id)
  saveStreams(next)
  if (activeForwards.has(req.params.id)) { activeForwards.get(req.params.id).proc.kill(); activeForwards.delete(req.params.id) }
  // 删除大疆司空流时同步停止对应浏览器转码进程
  if (deleted.protocol === 'dji_webrtc' && deleted.djiWebRTCConfig) {
    const sid = djiStreamId(deleted.djiWebRTCConfig)
    if (sid) djiBridge.stopSession(sid).catch(e => log.warn(`停止 dji-bridge 失败 [${sid}]: ${e.message}`))
  }
  res.json({ ok: true })
})

// ── Map point CRUD ───────────────────────────────────────────
app.get('/api/map-points', (req, res) => {
  const { type } = req.query
  const points = loadPoints()
  res.json(type ? points.filter(p => p.type === type) : points)
})

app.post('/api/map-points', (req, res) => {
  const { type, name, lon, lat, ...extra } = req.body
  if (!type || !name || lon === undefined || lat === undefined) return res.status(400).json({ error: '缺少 type/name/lon/lat' })
  const point = { id: uuidv4(), type, name, lon: Number(lon), lat: Number(lat), ...extra }
  const points = loadPoints()
  points.push(point)
  savePoints(points)
  res.status(201).json(point)
})

app.patch('/api/map-points/:id', (req, res) => {
  const points = loadPoints()
  const idx = points.findIndex(p => p.id === req.params.id)
  if (idx === -1) return res.status(404).json({ error: '未找到' })
  points[idx] = { ...points[idx], ...req.body, id: points[idx].id }
  savePoints(points)
  res.json(points[idx])
})

app.delete('/api/map-points/:id', (req, res) => {
  const points = loadPoints()
  const next = points.filter(p => p.id !== req.params.id)
  if (next.length === points.length) return res.status(404).json({ error: '未找到' })
  savePoints(next)
  res.json({ ok: true })
})

// ── RTSP forwarding ──────────────────────────────────────────
const activeForwards = new Map()
let nextPort = 7080

app.post('/api/stream/start', async (req, res) => {
  const { id, url, protocol, djiConfig } = req.body
  if (!id) return res.status(400).json({ error: '缺少 id' })

  // 离线流拒绝启动：防止绕过前端直接调用 API 启动已下线的 dji_webrtc 流，
  // 避免机场流量卡被意外消耗。
  // dji_webrtc 的 id 是由 shareUrl + airportName 派生的 streamId，
  // 需同时匹配 stream.id（其他协议）和 djiStreamId（dji_webrtc）。
  const stream = loadStreams().find(s => s.id === id
    || (s.protocol === 'dji_webrtc' && s.djiWebRTCConfig
        && djiStreamId(s.djiWebRTCConfig) === id))
  if (stream?.offline) {
    return res.status(403).json({ error: '该视频流已标记为离线，无法启动推流' })
  }

  // DJI 司空 WebRTC 适配
  if (protocol === 'dji_webrtc') {
    if (!djiConfig?.shareUrl || (!djiConfig?.airportName && djiConfig?.airportIndex == null)) {
      return res.status(400).json({ error: '缺少 shareUrl 或 airportName/airportIndex' })
    }
    try {
      const urls = await djiBridge.startSession(id, djiConfig)
      log.info(`dji-bridge 已启动 [${id}]`)
      return res.json({ ok: true, engine: 'dji-bridge', ...urls })
    } catch (e) {
      log.error(`dji-bridge 启动失败 [${id}]: ${e.message}`)
      return res.status(500).json({ error: e.message || 'DJI WebRTC 适配器启动失败' })
    }
  }

  if (!url) return res.status(400).json({ error: '缺少 url' })

  // 优先用 ZLMediaKit 拉流代理（已配置 secret 时）
  if (zlm.getConfig().configured) {
    try {
      const urls = await zlm.addStreamProxy(id, url)
      log.info(`ZLM 拉流代理已建立 [${id}]`)
      return res.json({ ok: true, engine: 'zlm', flvUrl: urls.flv, ...urls })
    } catch (e) {
      log.warn(`ZLM 拉流失败 [${id}]: ${e.message}，降级 ffmpeg`)
      // 落到下面 ffmpeg 降级
    }
  }
  // 降级：ffmpeg 推到本地 rtmp（需自备 rtmp 服务，仅兜底）
  if (activeForwards.has(id)) return res.json({ ok: true, engine: 'ffmpeg', flvUrl: `http://localhost:${activeForwards.get(id).httpPort}/live/${id}.flv` })
  const httpPort = nextPort++
  const proc = spawn('ffmpeg', ['-rtsp_transport', 'tcp', '-i', url, '-c', 'copy', '-f', 'flv', `rtmp://localhost:1935/live/${id}`], { stdio: 'ignore' })
  proc.on('error', e => log.error(`ffmpeg 转发失败 [${id}]: ${e.message}`))
  proc.on('close', () => activeForwards.delete(id))
  activeForwards.set(id, { proc, httpPort })
  res.json({ ok: true, engine: 'ffmpeg', flvUrl: `http://localhost:${httpPort}/live/${id}.flv`, note: '未配置 ZLMediaKit，使用 ffmpeg 降级（需自备 RTMP 服务）' })
})

app.delete('/api/stream/stop/:id', async (req, res) => {
  const id = req.params.id
  let stopped = false
  if (zlm.getConfig().configured) {
    try { await zlm.delStreamProxy(id); stopped = true } catch (e) { log.warn(`ZLM 停止代理失败 [${id}]: ${e.message}`) }
  }
  if (activeForwards.has(id)) { activeForwards.get(id).proc.kill(); activeForwards.delete(id); stopped = true }
  try { await djiBridge.stopSession(id); stopped = true } catch (e) { log.warn(`dji-bridge 停止失败 [${id}]: ${e.message}`) }
  if (!stopped) return res.status(404).json({ error: '未找到活跃转发' })
  res.json({ ok: true })
})

// ── DJI 司空 WebRTC 适配器管理 ───────────────────────────────
app.post('/api/dji-bridge/start', async (req, res) => {
  const { id, shareUrl, airportName, airportIndex, parentName, width, height, bitrate } = req.body || {}
  if (!id) return res.status(400).json({ error: '缺少 id' })
  if (!shareUrl) return res.status(400).json({ error: '缺少 shareUrl' })
  if (!airportName && airportIndex == null) return res.status(400).json({ error: '缺少 airportName 或 airportIndex' })
  try {
    const urls = await djiBridge.startSession(id, { shareUrl, airportName, airportIndex, parentName, width, height, bitrate })
    res.json(urls)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/dji-bridge/stop/:id', async (req, res) => {
  try {
    await djiBridge.stopSession(req.params.id)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/dji-bridge/status', (req, res) => {
  res.json(djiBridge.getStatus())
})

// ── ZLMediaKit 配置 ──
app.get('/api/zlm/config', (req, res) => res.json(zlm.getConfig()))

app.post('/api/zlm/config', (req, res) => {
  // setConfig 内部按 CFG_KEYS 白名单取字段，直接透传整个 body 即可
  const r = zlm.setConfig(req.body || {})
  log.info('ZLMediaKit 配置已更新')
  res.json({ ok: true, ...r })
})

// 返回各协议播放地址样例（供配置页预览，stream 名可选）
app.get('/api/zlm/play-urls', (req, res) => {
  const app = req.query.app || 'jsc'
  const stream = req.query.stream || 'test'
  res.json(zlm.playUrls(String(app), String(stream)))
})

// 测试 ZLM 连通性
app.post('/api/zlm/test', async (req, res) => {
  try {
    const list = await zlm.getMediaList()
    res.json({ ok: true, activeStreams: list.length })
  } catch (e) {
    res.json({ ok: false, error: e.message })
  }
})

// ── ONVIF ────────────────────────────────────────────────────
let discoveredDevices = []

app.post('/api/onvif/scan', (req, res) => {
  try {
    const onvif = require('node-onvif')
    discoveredDevices = []
    const task = new onvif.OnvifDeviceManager()
    task.startProbe()
    setTimeout(() => {
      task.stopProbe()
      discoveredDevices = (task.getDeviceList() || []).map(d => ({ id: d.urn || uuidv4(), hostname: d.hostname || '', xaddrs: d.xaddrs || [], name: d.name || '未知设备' }))
      res.json({ discovered: discoveredDevices.length, devices: discoveredDevices })
    }, 5000)
  } catch {
    res.json({ warning: 'node-onvif 未安装，请执行: npm install node-onvif', devices: [] })
  }
})

app.get('/api/onvif/devices', (req, res) => res.json(discoveredDevices))

// ── GB28181 ──────────────────────────────────────────────────
app.post('/api/gb28181/invite', (req, res) => {
  const { sipServer, channelId } = req.body
  if (!channelId) return res.status(400).json({ error: '缺少 channelId' })
  // 若配置了 ZLMediaKit，国标流通常以 channelId 作为 stream 名推入 rtp app
  if (zlm.getConfig().configured) {
    const urls = zlm.playUrls('rtp', channelId)
    return res.json({ ok: true, engine: 'zlm', note: 'GB28181 设备需先通过 WVP-PRO/ZLM 国标信令注册并推流', ...urls, playUrl: urls.flv })
  }
  if (!sipServer) return res.status(400).json({ error: '缺少 sipServer（未配置 ZLMediaKit 时必填）' })
  res.json({ note: '需配合 ZLMediaKit / WVP-PRO', playUrl: `http://${sipServer}:5080/rtp/${channelId}.live.flv` })
})

// ── 气体采集预警模块 ─────────────────────────────────────────
const DATASOURCES_FILE = path.join(DATA_DIR, 'datasources.json')
const COLLECTED_FILE = path.join(DATA_DIR, 'collected.json')
const WARNINGS_FILE = path.join(DATA_DIR, 'warnings.json')
const COLLECT_LOGS_FILE = path.join(DATA_DIR, 'collect_logs.json')

const DEFAULT_DATASOURCES = [
  {
    id: 'ds-cq-zjb', source_name: '重庆市空气质量-周家坝',
    source_type: 'cq_api',
    source_url: 'https://hbyw.sthjj.cq.gov.cn/shouye/BatchDataController/getThirtySixHourAQI',
    request_body: 'stationname=周家坝',
    request_method: 'POST',
    auth_info: '', collect_cycle: 300, timeout: 10000, enabled: 0,
    point_code: 'wanzhou', point_filter: [],
    breaker_open: false,
    lon: 108.372488, lat: 30.840472,
  },
  {
    id: 'ds-cq-bab', source_name: '重庆市空气质量-百安坝',
    source_type: 'cq_api',
    source_url: 'https://hbyw.sthjj.cq.gov.cn/shouye/BatchDataController/getThirtySixHourAQI',
    request_body: 'stationname=百安坝',
    request_method: 'POST',
    auth_info: '', collect_cycle: 300, timeout: 10000, enabled: 0,
    point_code: 'wanzhou', point_filter: [],
    breaker_open: false,
    lon: 108.447045, lat: 30.762872,
  },
]

if (store.collCount('datasources') === 0) store.collReplaceAll('datasources', DEFAULT_DATASOURCES)

const loadDS = () => store.collList('datasources')
const saveDS = (a) => store.collReplaceAll('datasources', a)
const loadCollected = () => readJson(COLLECTED_FILE, [])
const loadWarnings = () => readJson(WARNINGS_FILE, [])
const loadCollectLogs = () => readJson(COLLECT_LOGS_FILE, [])

// ── 短信预警数据存储 ──────────────────────────────────────────
const SMS_CONTACTS_FILE = path.join(DATA_DIR, 'sms_contacts.json')
const SMS_TEMPLATES_FILE = path.join(DATA_DIR, 'sms_templates.json')
const SMS_HISTORY_FILE = path.join(DATA_DIR, 'sms_history.json')
const SMS_REPORTS_FILE = path.join(DATA_DIR, 'sms_reports.json')
const SMS_BLACKLIST_FILE = path.join(DATA_DIR, 'sms_blacklist.json')

// 默认模板：覆盖空气质量超标预警，变量 {point}{pollutant}{value}{unit}{label}{time}
const DEFAULT_SMS_TEMPLATES = [
  {
    id: 'tpl-air-default',
    name: '空气质量超标默认模板',
    triggerType: 'air',          // air=空气质量超标
    content: '【生态环境预警】{point} {time} 监测到 {pollutant}={value}{unit}，触发{label}，请处置。',
    enabled: true,
    createdAt: new Date().toISOString(),
  },
]

if (store.collCount('sms_contacts') === 0) { /* 联系人无默认种子，空集合即可 */ }
if (store.collCount('sms_templates') === 0) store.collReplaceAll('sms_templates', DEFAULT_SMS_TEMPLATES)
if (!fs.existsSync(SMS_HISTORY_FILE)) writeJson(SMS_HISTORY_FILE, [])
if (!fs.existsSync(SMS_REPORTS_FILE)) writeJson(SMS_REPORTS_FILE, [])
if (store.collCount('sms_blacklist') === 0) { /* 黑名单无默认种子 */ }

// ── 地图图标配置存储 ──────────────────────────────────────────
const ICON_CONFIG_FILE = path.join(DATA_DIR, 'icon_config.json')
// 默认图标配置：点位类型 + 视频流分组 → { icon, color }
const DEFAULT_ICON_CONFIG = {
  // 点位类型
  air:      { icon: 'gauge',  color: '#1a7fff' },
  water:    { icon: 'water',  color: '#00e5ff' },
  watermon: { icon: 'wave',   color: '#00e5ff' },
  alert:    { icon: 'alert',  color: '#ff4444' },
  uav:      { icon: 'plane',  color: '#ab47bc' },
  station:  { icon: 'home',   color: '#ffb300' },
  camera:   { icon: 'camera', color: '#00b84a' },  // 摄像头默认（无分组配置时）
  // 视频流分组
  '无人机视频': { icon: 'drone',   color: '#ab47bc' },
  '港口堆场':   { icon: 'crane',   color: '#ffb300' },
  '道路监控':   { icon: 'camera',  color: '#00b84a' },
  '水体监控':   { icon: 'water',   color: '#00e5ff' },
  '重点企业':   { icon: 'factory', color: '#ff7043' },
}
if (store.kvGet('icon_config') == null) store.kvSet('icon_config', DEFAULT_ICON_CONFIG)
const loadIconConfig = () => store.kvGet('icon_config', DEFAULT_ICON_CONFIG)

const loadContacts = () => store.collList('sms_contacts')
const saveContacts = (a) => store.collReplaceAll('sms_contacts', a)
const loadTemplates = () => store.collList('sms_templates')
const saveTemplates = (a) => store.collReplaceAll('sms_templates', a)
const loadSmsHistory = () => readJson(SMS_HISTORY_FILE, [])
const loadSmsReports = () => readJson(SMS_REPORTS_FILE, [])
const loadBlacklist = () => store.collList('sms_blacklist')
const saveBlacklist = (a) => store.collReplaceAll('sms_blacklist', a)

// 过滤黑名单号码：返回 { allowed:[], blocked:[] }
function filterBlacklist(mobiles) {
  const bl = new Set(loadBlacklist().map(b => b.mobile))
  const allowed = [], blocked = []
  for (const m of mobiles) (bl.has(m) ? blocked : allowed).push(m)
  return { allowed, blocked }
}

function addSmsHistory(entry) {
  // 写入 SQLite（长期留存，无 2000 条上限）
  store.insertSmsHistory({ id: uuidv4(), time: new Date().toISOString(), ...entry })
}

function addSmsReport(entry) {
  store.insertSmsReport({ id: uuidv4(), receivedAt: new Date().toISOString(), ...entry })
}

function addCollectLog(entry) {
  store.insertCollectLog({ id: uuidv4(), time: new Date().toISOString(), ...entry })
}

// 数据校验（文档 1.5）
function validateRecord(rec) {
  const errors = []
  if (!rec.monitorTime) errors.push('监测时间为空')
  if (!rec.pointName) errors.push('点位为空')
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rec.monitorTime || '')) errors.push('时间格式非法')
  // 时间合理性：不允许未来时间 / 超过24h历史
  const t = new Date((rec.monitorTime || '').replace(' ', 'T'))
  if (!isNaN(t)) {
    const diff = Date.now() - t.getTime()
    if (diff < -60000) errors.push('未来时间')
    if (diff > 24 * 3600 * 1000) errors.push('超过24小时历史数据')
  }
  for (const p of rec.pollutants || []) {
    if (p.code === 'AQI' || p.value == null) continue
    // AQI范围0-500（针对以AQI近似的值）
    if (typeof rec.aqi === 'number' && (rec.aqi < 0 || rec.aqi > 500)) errors.push('AQI超出0-500')
  }
  return errors
}

// 构建历史窗口：从已入库数据取某点位某污染物的前一小时值 + 前4小时值
function buildHistory(pointCode, pollutants, collected) {
  const history = {}
  for (const p of pollutants) {
    const past = collected
      .filter(c => c.pointCode === pointCode)
      .flatMap(c => (c.pollutants || []).filter(pp => pp.code === p.code).map(pp => ({ t: c.monitorTime, v: pp.value })))
      .sort((a, b) => (a.t < b.t ? 1 : -1)) // 新→旧
    history[p.code] = {
      prevHour: past[0] ? past[0].v : null,
      prev4Hours: past.slice(0, 4).map(x => x.v),
    }
  }
  return history
}

// ── 短信预警发送频率限制 ──────────────────────────────────────
// 同一预警键（点位+污染物+预警类型）在窗口期内只发一次，避免重复轰炸
const SMS_DEDUP_WINDOW_MS = 30 * 60 * 1000 // 默认 30 分钟
const smsLastSent = new Map()  // key -> timestamp(ms)

function smsDedupKey(hit) {
  return `${hit.pointCode || hit.pointName}|${hit.code}|${hit.warningType}`
}

// 检查是否在频率限制窗口内（true=应跳过发送）
function isSmsRateLimited(hit) {
  const key = smsDedupKey(hit)
  const last = smsLastSent.get(key)
  if (last && (Date.now() - last) < SMS_DEDUP_WINDOW_MS) return true
  return false
}

function markSmsSent(hit) {
  smsLastSent.set(smsDedupKey(hit), Date.now())
}

// 构建模板短信变量数组：模板可定义 paramFields（字段名顺序），按序从预警数据取值
// 默认顺序：点位、污染物、数值、预警类型
function buildTemplateParams(tpl, hit) {
  const dict = {
    point: hit.pointName || '',
    pollutant: hit.name || hit.code || '',
    value: String(hit.value ?? ''),
    unit: hit.unit || '',
    label: hit.warningLabel || hit.warningType || '',
    time: hit.monitorTime || '',
  }
  const fields = Array.isArray(tpl.paramFields) && tpl.paramFields.length
    ? tpl.paramFields
    : ['point', 'pollutant', 'value', 'label']
  return fields.map(f => dict[f] != null ? String(dict[f]) : '')
}

/**
 * 针对一条命中的空气质量预警，按模板渲染并发送给启用的联系人。
 * 受频率限制约束；每次发送写入 sms_history。
 * @param {object} hit warningEngine 命中项 { pointName, pointCode, code, name, value, unit, warningType, warningLabel, monitorTime }
 */
async function dispatchWarningSms(hit) {
  // 频率限制
  if (isSmsRateLimited(hit)) {
    log.debug(`短信频控跳过 [${smsDedupKey(hit)}]（${SMS_DEDUP_WINDOW_MS / 60000}分钟内已发）`)
    return { skipped: true, reason: 'rate-limited' }
  }
  // 未配置则静默跳过（不阻塞采集主流程）
  const smsCfg = sms.getConfig()
  if (!smsCfg.configured) {
    log.debug('短信未配置，跳过自动推送')
    return { skipped: true, reason: 'not-configured' }
  }
  // 取启用的联系人
  const contacts = loadContacts().filter(c => c.enabled !== false && c.mobile)
  if (!contacts.length) {
    log.debug('无启用的短信联系人，跳过推送')
    return { skipped: true, reason: 'no-contacts' }
  }
  // 选模板：优先 triggerType='air' 且启用的，否则取第一个启用模板
  const templates = loadTemplates().filter(t => t.enabled !== false)
  const tpl = templates.find(t => t.triggerType === 'air') || templates[0]
  if (!tpl) {
    log.warn('无可用短信模板，跳过推送')
    return { skipped: true, reason: 'no-template' }
  }
  // 短信变量精简处理：
  //  point     去掉"万州区"等前缀，只留站点短名（周家坝/百安坝）
  //  pollutant 用英文代码小写（no2/so2/pm25/pm10/o3/co）
  //  time      只保留时间部分（HH:mm:ss），去掉日期
  const shortPoint = (name) => {
    const s = String(name || '').trim()
    // 取最后一段（按空格分隔，如 "万州区 周家坝" → "周家坝"）
    const parts = s.split(/\s+/)
    return parts[parts.length - 1] || s
  }
  const pollutantCode = (hit) => {
    const raw = String(hit.code || hit.name || '').toUpperCase()
    // 规范化映射（PM25→pm2.5 带点，其余直接小写）
    const MAP = { PM25: 'pm2.5', 'PM2.5': 'pm2.5', PM10: 'pm10', SO2: 'so2', NO2: 'no2', O3: 'o3', CO: 'co' }
    return MAP[raw] || raw.toLowerCase()
  }
  const timeOnly = (mt) => {
    const m = /\d{2}:\d{2}:\d{2}/.exec(String(mt || ''))
    return m ? m[0] : String(mt || '')
  }
  const content = sms.renderTemplate(tpl.content, {
    point: shortPoint(hit.pointName),
    pollutant: pollutantCode(hit),
    value: hit.value,
    unit: hit.unit || '',
    label: hit.warningLabel || hit.warningType,
    time: timeOnly(hit.monitorTime),
  })
  // 黑名单过滤
  const { allowed: mobiles, blocked } = filterBlacklist(contacts.map(c => c.mobile))
  if (blocked.length) log.info(`短信黑名单过滤 ${blocked.length} 个号码`)
  if (!mobiles.length) {
    log.debug('全部收信人在黑名单中，跳过推送')
    return { skipped: true, reason: 'all-blacklisted' }
  }
  let result
  try {
    // 模板短信模式：模板配置了 templateId 则走 tmpsubmit
    if (tpl.smsType === 'template' && tpl.templateId) {
      const params = buildTemplateParams(tpl, hit)
      result = await sms.sendTemplateSms(mobiles, tpl.templateId, params)
    } else {
      result = await sms.sendSms(mobiles, content)
    }
  } catch (e) {
    result = { ok: false, error: e.message }
  }
  addSmsHistory({
    trigger: 'auto-warning',
    warningKey: smsDedupKey(hit),
    pointName: hit.pointName,
    pollutant: hit.code,
    content,
    recipients: mobiles,
    recipientCount: mobiles.length,
    blocked: blocked.length ? blocked : undefined,
    smsType: tpl.smsType === 'template' ? 'template' : 'normal',
    attempts: result.attempts,
    status: result.ok ? 'success' : 'failed',
    error: result.error || null,
    raw: result.raw || null,
  })
  if (result.ok) {
    markSmsSent(hit)
    log.info(`预警短信已发送 [${hit.pointName}/${hit.code}] → ${mobiles.length} 人`)
  } else {
    log.error(`预警短信发送失败 [${hit.pointName}/${hit.code}]: ${result.error}`)
  }
  return result
}

// 采集编排：对一条标准化数据执行 校验→入库→预警判断
function ingestRecord(rec) {
  const errors = validateRecord(rec)
  if (errors.length) {
    addCollectLog({ source: rec.sourceType, point: rec.pointName, status: 'error', detail: '校验失败: ' + errors.join(', ') })
    return { ok: false, errors }
  }
  // 去重：点位名+采集时间（查 SQLite）
  if (store.existsByPointTime(rec.pointName, rec.monitorTime)) {
    addCollectLog({ source: rec.sourceType, point: rec.pointName, status: 'skip', detail: '重复数据(点位+时间)，跳过' })
    return { ok: false, duplicate: true }
  }
  // 数据质量检查：AQI<=0 或全部污染物缺失/为0 视为无效
  const validPollutants = (rec.pollutants || []).filter(p => typeof p.value === 'number' && p.value > 0)
  const invalid = (!rec.aqi || rec.aqi <= 0) && validPollutants.length === 0
  if (invalid) {
    // 无效数据仍入库留痕，但打 invalid 标记，不参与预警，不进历史窗口
    store.insert({ id: uuidv4(), ...rec, valid: false, collectedAt: new Date().toISOString() })
    addCollectLog({ source: rec.sourceType, point: rec.pointName, status: 'invalid', detail: '无效数据(AQI<=0且无有效污染物)，已留痕但不预警' })
    log.warn(`采集到无效数据 [${rec.pointName}] @ ${rec.monitorTime}`)
    return { ok: false, invalid: true }
  }

  // 历史窗口仅取有效数据（SQLite 按点位查最近记录）
  const history = store.buildHistory(rec.pointCode, rec.pollutants || [])
  // 入库（有效数据标记 valid:true；无 5000 条上限，长期留存）
  store.insert({ id: uuidv4(), ...rec, valid: true, collectedAt: new Date().toISOString() })
  // 预警判断
  const hits = warningEngine.evaluateRecord(rec, history)
  if (hits.length) {
    for (const h of hits) store.insertWarning({ id: uuidv4(), createdAt: new Date().toISOString(), status: 'pending', ...h })
    // 空气质量超标 → 自动短信推送（异步，不阻塞采集主流程；内部受频率限制约束）
    for (const h of hits) {
      dispatchWarningSms(h).catch(e => log.error('短信推送异常: ' + (e.message || e)))
    }
  }
  addCollectLog({ source: rec.sourceType, point: rec.pointName, status: 'ok', detail: `入库成功，命中预警 ${hits.length} 条` })
  return { ok: true, warnings: hits }
}

// ── 数据源 CRUD ──
app.get('/api/datasources', (req, res) => res.json(loadDS()))

app.post('/api/datasources', (req, res) => {
  const b = req.body
  if (!b.source_name || !b.source_type) return res.status(400).json({ error: '缺少 source_name/source_type' })
  const ds = {
    id: uuidv4(),
    source_name: b.source_name, source_type: b.source_type,
    source_url: b.source_url || '', auth_info: b.auth_info || '',
    collect_cycle: b.collect_cycle || 300, timeout: b.timeout || 10000,
    enabled: b.enabled ? 1 : 0, point_code: b.point_code || '',
    point_filter: b.point_filter || [], breaker_open: false,
    ...(b.lon !== undefined && b.lon !== '' ? { lon: Number(b.lon) } : {}),
    ...(b.lat !== undefined && b.lat !== '' ? { lat: Number(b.lat) } : {}),
  }
  const list = loadDS(); list.push(ds); saveDS(list)
  res.status(201).json(ds)
})

app.patch('/api/datasources/:id', (req, res) => {
  const list = loadDS()
  const idx = list.findIndex(d => d.id === req.params.id)
  if (idx === -1) return res.status(404).json({ error: '未找到' })
  const patch = { ...req.body }
  // 经纬度统一转数字（表单传过来可能是字符串）
  if (patch.lon !== undefined) patch.lon = patch.lon === '' ? undefined : Number(patch.lon)
  if (patch.lat !== undefined) patch.lat = patch.lat === '' ? undefined : Number(patch.lat)
  list[idx] = { ...list[idx], ...patch, id: list[idx].id }
  saveDS(list)
  res.json(list[idx])
})

// ── 监测站点位（供地图标注）──────────────────────────────────
// 返回配置了经纬度的数据源，前端地图用🏠标注，点击拉取最新采集数据
app.get('/api/stations', (req, res) => {
  const stations = loadDS()
    .filter(d => typeof d.lon === 'number' && typeof d.lat === 'number')
    .map(d => {
      // 从 request_body 的 stationname 提取站点短名（如 周家坝）
      const m = /stationname=([^&]+)/.exec(d.request_body || '')
      const stationName = m ? decodeURIComponent(m[1]) : d.source_name
      return { id: d.id, name: d.source_name, stationName, lon: d.lon, lat: d.lat, enabled: d.enabled }
    })
  res.json(stations)
})

app.delete('/api/datasources/:id', (req, res) => {
  const list = loadDS()
  const next = list.filter(d => d.id !== req.params.id)
  if (next.length === list.length) return res.status(404).json({ error: '未找到' })
  saveDS(next)
  res.json({ ok: true })
})

// 测试数据源连通性（html_crawl 走爬虫）
app.post('/api/datasources/:id/test', async (req, res) => {
  const ds = loadDS().find(d => d.id === req.params.id)
  if (!ds) return res.status(404).json({ error: '未找到' })
  if (ds.source_type === 'html_crawl' || ds.source_type === 'cq_api') {
    const mode = ds.source_type === 'cq_api' ? 'api' : undefined
    const result = await crawler.crawl({ url: ds.source_url, timeout: ds.timeout, pointFilter: ds.point_filter, mode, method: ds.request_method || 'POST', body: ds.request_body || null })
    return res.json({ ok: result.ok, sample: result.data.slice(0, 2), error: result.error || null, count: result.data.length })
  }
  res.json({ ok: false, error: `类型 ${ds.source_type} 的连通性测试需配置真实接入参数（当前为配置驱动占位）` })
})

// 诊断数据源页面结构（用于定位表格选择器）
app.post('/api/datasources/:id/clear-breaker', (req, res) => {
  const ds = loadDS().find(d => d.id === req.params.id)
  if (!ds) return res.status(404).json({ error: '未找到' })
  crawler.breaker[ds.source_url] = { failCount: 0, openUntil: 0 }
  res.json({ ok: true, message: '熔断已清除' })
})

app.post('/api/datasources/:id/diagnose', async (req, res) => {
  const ds = loadDS().find(d => d.id === req.params.id)
  if (!ds) return res.status(404).json({ error: '未找到' })
  if (ds.source_type !== 'html_crawl') return res.json({ ok: false, error: '仅 html_crawl 类型支持诊断' })
  const info = await crawler.diagnose({ url: ds.source_url, timeout: ds.timeout })
  res.json(info)
})

// 手动触发采集（html_crawl 网页解析 / cq_api JSON接口）
// 执行一次采集（手动 / 定时复用）
async function executeCollect(ds) {
  if (ds.source_type !== 'html_crawl' && ds.source_type !== 'cq_api') {
    return { ok: false, error: `类型 ${ds.source_type} 的实时采集需真实接入参数（配置驱动占位，暂不执行）` }
  }
  const mode = ds.source_type === 'cq_api' ? 'api' : undefined
  const result = await crawler.crawl({
    url: ds.source_url,
    timeout: ds.timeout,
    pointFilter: ds.point_filter,
    mode,
    method: ds.request_method || (mode === 'api' ? 'POST' : 'GET'),
    body: ds.request_body || null,
  })
  if (!result.ok) {
    addCollectLog({ source: ds.source_type, point: ds.source_name, status: 'error', detail: result.error })
    return { ok: false, error: result.error }
  }
  // 36小时接口同站点多条数据：按监测时间升序入库，保证历史窗口（前1h/前4h）判断正确
  const sorted = [...result.data].sort((a, b) => String(a.monitorTime).localeCompare(String(b.monitorTime)))
  let ingested = 0, totalWarnings = 0, skipped = 0
  for (const rec of sorted) {
    const r = ingestRecord(rec)
    if (r.ok) { ingested++; totalWarnings += (r.warnings || []).length }
    else if (r.duplicate) skipped++
  }
  const latest = sorted.length ? sorted[sorted.length - 1].monitorTime : null
  return { ok: true, fetched: result.data.length, ingested, skipped, warnings: totalWarnings, monitorTime: latest }
}

app.post('/api/collect/run/:id', async (req, res) => {
  const ds = loadDS().find(d => d.id === req.params.id)
  if (!ds) return res.status(404).json({ error: '未找到数据源' })
  const r = await executeCollect(ds)
  res.json(r)
})

// ── 定时采集调度器 ──
// 每个启用的数据源按各自 collect_cycle（秒）独立调度
const scheduleTimers = new Map()  // id -> { lastRun, cycle }

async function schedulerTick() {
  const now = Date.now()
  const list = loadDS().filter(d => d.enabled && (d.source_type === 'cq_api' || d.source_type === 'html_crawl'))
  for (const ds of list) {
    const cycleMs = Math.max(30, Number(ds.collect_cycle) || 300) * 1000  // 最低30秒，防止过频
    const state = scheduleTimers.get(ds.id)
    if (!state || now - state.lastRun >= cycleMs) {
      scheduleTimers.set(ds.id, { lastRun: now, cycle: cycleMs })
      try {
        const r = await executeCollect(ds)
        if (r.ok) log.info(`定时采集完成 [${ds.source_name}] 入库${r.ingested} 预警${r.warnings}`)
        else log.warn(`定时采集失败 [${ds.source_name}]: ${r.error}`)
      } catch (e) {
        log.error(`定时采集异常 [${ds.source_name}]: ${e.message}`)
      }
    }
  }
  // 清理已删除/禁用数据源的计时状态
  const activeIds = new Set(list.map(d => d.id))
  for (const id of scheduleTimers.keys()) if (!activeIds.has(id)) scheduleTimers.delete(id)
}

// 每 15 秒检查一次，按各数据源周期触发
setInterval(schedulerTick, 15 * 1000)
log.info('定时采集调度器已启动（每15秒检查，按数据源 collect_cycle 触发）')

// 查看采集数据 / 预警记录 / 采集日志
app.get('/api/collected', (req, res) => {
  const { point, limit } = req.query
  // 从 SQLite 查询（新→旧）。默认 200 条，可通过 limit 调大
  const data = store.query({ point: point || undefined, limit: Number(limit) || 200 })
  res.json(data)
})

// 将采集数据转换为 AirQualityRecord 格式供前端同步
app.get('/api/collected/as-aq', (req, res) => {
  const { stations } = req.query  // 可选：'周家坝,百安坝'
  const stationFilter = stations ? String(stations).split(',').map(s => s.trim()) : null
  const STATION_MAP = { '周家坝': '周家坝', '百安坝': '百安坝' }
  const getP = (pollutants, code) => {
    const p = (pollutants || []).find(p => p.code === code)
    return p ? Number(p.value) : 0
  }
  // 前端只展示近24小时，这里仍返回全部由前端按需截断；
  // 为避免一年数据全量序列化，限制返回最近 2000 条（足够覆盖多日，前端 recordsToHourly 仅取24h）
  const data = store.query({ limit: 2000 })
    .map(c => {
      // 从 pointName 提取站点名（如 "万州区 周家坝" → "周家坝"）
      const station = Object.keys(STATION_MAP).find(k => (c.pointName || '').includes(k)) || c.pointName || '未知站点'
      if (stationFilter && !stationFilter.includes(station)) return null
      const [date, timePart] = (c.monitorTime || '').split(' ')
      const hour = timePart ? parseInt(timePart.split(':')[0]) : 0
      return {
        id: c.id,
        station,
        date: date || '',
        hour,
        aqi: Number(c.aqi) || 0,
        pm25: getP(c.pollutants, 'PM25'),
        pm10: getP(c.pollutants, 'PM10'),
        so2: getP(c.pollutants, 'SO2'),
        no2: getP(c.pollutants, 'NO2'),
        o3: getP(c.pollutants, 'O3'),
        co: getP(c.pollutants, 'CO'),
        pushedAt: c.collectedAt || new Date().toISOString(),
      }
    })
    .filter(Boolean)
    .filter(r => r.date)  // 过滤无时间的脏数据
  res.json(data)
})

app.get('/api/warnings', (req, res) => {
  const { type, exclude_type, limit, aggregate, lightweight } = req.query
  if (aggregate === '1' || aggregate === 'true') {
    return res.json(store.queryWarningsAggregated({ type: type || undefined, limit: Number(limit) || 200, lightweight: lightweight === '1' || lightweight === 'true' }))
  }
  res.json(store.queryWarnings({ type: type || undefined, excludeType: exclude_type || undefined, limit: Number(limit) || 200 }))
})

// 按 id 批量查询 warning 成员详情（供研判依据弹窗按需拉取，需登录）
app.post('/api/warnings/by-ids', (req, res) => {
  const { ids } = req.body || {}
  if (!Array.isArray(ids) || ids.length === 0) return res.json([])
  try { res.json(store.getWarningsByIds(ids)) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

// 近 N 天告警趋势（按上海本地日期聚合，含今天），用于「近7天告警趋势」图表
app.get('/api/alert-trend', (req, res) => {
  try {
    const days = Number(req.query.days) || 7
    res.json({ days, data: store.warningTrend(days) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── 重点点位告警排名（驾驶舱 P1）──────────────────────────────
// 按 IoT 视频分析告警的 channelName 聚合告警量 TOP N，供「重点点位告警排名」榜单
app.get('/api/alert-location-rank', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 5, 50)
  const days = Math.min(Number(req.query.days) || 30, 365)
  try {
    const db = store.getDb()
    // created_at 为 UTC ISO 串（与 warningTrend 的 +8h 处理一致，比较用 UTC 'now'）
    const rows = db.prepare(
      `SELECT json_extract(data_json, '$.channelName') AS location, COUNT(*) AS alert_count
       FROM warnings
       WHERE warning_type = 'iot-video-analysis'
         AND created_at > datetime('now', '-' || ? || ' days')
         AND json_extract(data_json, '$.channelName') IS NOT NULL
       GROUP BY location
       ORDER BY alert_count DESC
       LIMIT ?`
    ).all(days, limit)
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// 更新预警处理状态（标记处理/撤销处理）
app.patch('/api/warnings/:id', (req, res) => {
  const { status, handledBy } = req.body || {}
  if (status !== 'handled' && status !== 'pending') {
    return res.status(400).json({ error: 'status 仅支持 handled / pending' })
  }
  const updated = store.updateWarningStatus(req.params.id, status, handledBy)
  if (!updated) return res.status(404).json({ error: '未找到该预警' })
  res.json(updated)
})

// 批量标记处理（全部标记）
app.post('/api/warnings/handle-all', (req, res) => {
  const { handledBy } = req.body || {}
  const count = store.handleAllWarnings(handledBy)
  res.json({ ok: true, handled: count })
})

app.get('/api/collect-logs', (req, res) => {
  const { status, limit } = req.query
  res.json(store.queryCollectLogs({ status: status || undefined, limit: Number(limit) || 200 }))
})

// 预警规则元数据（供前端展示阈值表）
app.get('/api/warning-rules', (req, res) => {
  res.json({
    safeMax: warningEngine.SAFE_MAX,
    crossThresholds: warningEngine.CROSS_THRESHOLDS,
    growthRange: warningEngine.GROWTH_RANGE,
    labels: warningEngine.LABELS,
  })
})

// ── 地图图标配置 ─────────────────────────────────────────────
app.get('/api/icon-config', (req, res) => res.json(loadIconConfig()))

// 整体替换或合并图标配置（body: { key: {icon,color}, ... }）
app.put('/api/icon-config', (req, res) => {
  const body = req.body || {}
  if (typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: '配置格式应为对象' })
  const cur = loadIconConfig()
  const next = { ...cur }
  for (const [k, v] of Object.entries(body)) {
    if (v && typeof v === 'object') {
      next[k] = { icon: v.icon || (cur[k] && cur[k].icon) || 'pin', color: v.color || (cur[k] && cur[k].color) || '#00b84a' }
    }
  }
  writeJson(ICON_CONFIG_FILE, next)
  store.kvSet('icon_config', next)
  res.json(next)
})

// ── 数据统计报表 ─────────────────────────────────────────────
// 聚合采集数据与预警，供报表页展示趋势/超标/分布。
// query: hours（时间窗，默认48）、point（点位过滤，可选）
app.get('/api/stats', (req, res) => {
  const hours = Math.min(Number(req.query.hours) || 48, 8760)  // 最大放开到 365 天，支持查一年
  const pointFilter = req.query.point || null
  const since = Date.now() - hours * 3600 * 1000
  // 时间窗起点格式化为 'YYYY-MM-DD HH:mm:ss'，下推到 SQL 过滤（monitor_time 已建索引）
  const pad = (n) => String(n).padStart(2, '0')
  const d = new Date(since)
  const sinceMT = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

  // 点位清单取全部有效记录的去重点位（轻量查询）
  const points = store.distinctPoints()
  // 时间窗内的有效记录（已在 SQL 层按 monitor_time 与点位过滤）
  const collected = store.queryRange({ sinceMonitorTime: sinceMT, validOnly: true, point: pointFilter || undefined })

  // 各污染物：平均值、最大值、超标次数（value > standardValue）
  const pollutantStats = {}
  let totalExceed = 0
  for (const rec of collected) {
    for (const p of rec.pollutants || []) {
      if (typeof p.value !== 'number') continue
      const s = pollutantStats[p.code] || (pollutantStats[p.code] = {
        code: p.code, name: p.name || p.code, unit: p.unit || '',
        count: 0, sum: 0, max: 0, exceed: 0, standardValue: p.standardValue,
      })
      s.count++; s.sum += p.value; s.max = Math.max(s.max, p.value)
      if (p.standardValue != null && p.value > p.standardValue) { s.exceed++; totalExceed++ }
    }
  }
  const pollutants = Object.values(pollutantStats).map(s => ({
    code: s.code, name: s.name, unit: s.unit, standardValue: s.standardValue,
    avg: s.count ? +(s.sum / s.count).toFixed(1) : 0, max: s.max, exceed: s.exceed, samples: s.count,
  }))

  // AQI 趋势（按监测时间排序，每点位一条序列）
  const trendByPoint = {}
  for (const rec of collected) {
    const key = rec.pointName || rec.pointCode || '未知'
    ;(trendByPoint[key] || (trendByPoint[key] = [])).push({ time: rec.monitorTime, aqi: rec.aqi })
  }
  for (const k of Object.keys(trendByPoint)) {
    trendByPoint[k].sort((a, b) => (a.time < b.time ? -1 : 1))
  }

  // 点位超标排行
  const pointExceed = {}
  for (const rec of collected) {
    const key = rec.pointName || rec.pointCode || '未知'
    let ex = 0
    for (const p of rec.pollutants || []) {
      if (typeof p.value === 'number' && p.standardValue != null && p.value > p.standardValue) ex++
    }
    pointExceed[key] = (pointExceed[key] || 0) + ex
  }
  const pointRanking = Object.entries(pointExceed)
    .map(([name, exceed]) => ({ name, exceed }))
    .sort((a, b) => b.exceed - a.exceed)

  // 预警类型分布（SQLite 聚合）
  const warningByType = store.warningTypeDistribution()
  const warningTotal = store.warningCount()

  res.json({
    range: { hours, since: new Date(since).toISOString() },
    summary: {
      totalRecords: collected.length,
      points: points.length,
      pollutantKinds: pollutants.length,
      totalExceed,
      warnings: warningTotal,
    },
    points,
    pollutants,
    trendByPoint,
    pointRanking,
    warningByType,
    warningLabels: warningEngine.LABELS,
  })
})

// ── 设备在线状态：从数据库实时统计 ──────────────────────
app.get('/api/device-status', (req, res) => {
  try {
    const db = store.getDb()

    // 1. 大气监测站 — collected 表中最近 N 小时内有数据的点位视为在线
    const AIR_ONLINE_HOURS = 6
    const airRows = db.prepare(
      "SELECT DISTINCT point_name FROM collected WHERE monitor_time > datetime('now', '-' || ? || ' hours')"
    ).all(AIR_ONLINE_HOURS)
    const airOnline = airRows.length
    const airTotalRow = db.prepare("SELECT COUNT(DISTINCT point_name) as c FROM collected").get()
    const airTotal = (airTotalRow && airTotalRow.c) || 0

    // 2. 水质监测站 — coll_map_points 中 type='watermon' 的点位
    const watermonRows = db.prepare(
      "SELECT id, data_json FROM coll_map_points WHERE json_extract(data_json, '$.type')='watermon'"
    ).all()
    const watermonTotal = watermonRows.length
    // 暂无水质采集表，点位存在即视为在线
    const watermonOnline = watermonTotal

    // 3. 污染监控摄像 — 排除无人机视频分组的所有视频流
    const allStreams = loadStreams()
    const cameraStreams = allStreams.filter(s => s.group !== '无人机视频')
    const cameraOnline = cameraStreams.filter(s => !s.offline).length
    const cameraTotal = cameraStreams.length

    // 4. 无人机快检 — 无人机视频分组
    const droneStreams = allStreams.filter(s => s.group === '无人机视频')
    const droneOnline = droneStreams.filter(s => !s.offline).length
    const droneTotal = droneStreams.length

    const categories = [
      { label: '大气监测站',   online: airOnline,   total: Math.max(airTotal, airOnline), key: 'air',      color: '#00aaff' },
      { label: '水质监测站',   online: watermonOnline, total: watermonTotal,               key: 'watermon', color: '#00bcd4' },
      { label: '污染监控摄像', online: cameraOnline,  total: cameraTotal,                 key: 'camera',   color: '#00e676' },
      { label: '无人机快检',   online: droneOnline,  total: droneTotal,                  key: 'drone',    color: '#ab47bc' },
    ]
    const sumOnline = categories.reduce((s, c) => s + c.online, 0)
    const sumTotal = categories.reduce((s, c) => s + c.total, 0)

    res.json({
      total: { online: sumOnline, total: sumTotal, rate: sumTotal > 0 ? +(sumOnline / sumTotal * 100).toFixed(1) : 0 },
      categories,
      updatedAt: new Date().toISOString(),
    })
  } catch (e) {
    console.error('[device-status]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── 短信预警：联系人 CRUD ────────────────────────────────────
app.get('/api/sms/contacts', (req, res) => res.json(loadContacts()))

app.post('/api/sms/contacts', (req, res) => {
  const { name, mobile, group = '默认分组', enabled = true } = req.body || {}
  if (!name || !mobile) return res.status(400).json({ error: '缺少 name 或 mobile' })
  if (!/^1[3-9]\d{9}$/.test(String(mobile))) return res.status(400).json({ error: '手机号格式非法' })
  const contacts = loadContacts()
  if (contacts.some(c => c.mobile === mobile)) return res.status(409).json({ error: '该手机号已存在' })
  const c = { id: uuidv4(), name, mobile: String(mobile), group, enabled: !!enabled, createdAt: new Date().toISOString() }
  contacts.push(c)
  saveContacts(contacts)
  res.status(201).json(c)
})

app.put('/api/sms/contacts/:id', (req, res) => {
  const contacts = loadContacts()
  const idx = contacts.findIndex(c => c.id === req.params.id)
  if (idx < 0) return res.status(404).json({ error: '联系人不存在' })
  const { name, mobile, group, enabled } = req.body || {}
  if (mobile !== undefined && !/^1[3-9]\d{9}$/.test(String(mobile))) return res.status(400).json({ error: '手机号格式非法' })
  if (name !== undefined) contacts[idx].name = name
  if (mobile !== undefined) contacts[idx].mobile = String(mobile)
  if (group !== undefined) contacts[idx].group = group
  if (enabled !== undefined) contacts[idx].enabled = !!enabled
  saveContacts(contacts)
  res.json(contacts[idx])
})

app.delete('/api/sms/contacts/:id', (req, res) => {
  const contacts = loadContacts()
  const next = contacts.filter(c => c.id !== req.params.id)
  if (next.length === contacts.length) return res.status(404).json({ error: '联系人不存在' })
  saveContacts(next)
  res.json({ ok: true })
})

// ── 短信预警：模板 CRUD ──────────────────────────────────────
app.get('/api/sms/templates', (req, res) => res.json(loadTemplates()))

app.post('/api/sms/templates', (req, res) => {
  const { name, content, triggerType = 'air', enabled = true, smsType = 'normal', templateId = '', paramFields } = req.body || {}
  if (!name || !content) return res.status(400).json({ error: '缺少 name 或 content' })
  if (smsType === 'template' && !templateId) return res.status(400).json({ error: '模板短信需填写 templateId' })
  const t = {
    id: uuidv4(), name, content, triggerType, enabled: !!enabled,
    smsType: smsType === 'template' ? 'template' : 'normal',
    templateId: templateId || '',
    paramFields: Array.isArray(paramFields) ? paramFields : undefined,
    createdAt: new Date().toISOString(),
  }
  const templates = loadTemplates()
  templates.push(t)
  saveTemplates(templates)
  res.status(201).json(t)
})

app.put('/api/sms/templates/:id', (req, res) => {
  const templates = loadTemplates()
  const idx = templates.findIndex(t => t.id === req.params.id)
  if (idx < 0) return res.status(404).json({ error: '模板不存在' })
  const { name, content, triggerType, enabled, smsType, templateId, paramFields } = req.body || {}
  if (name !== undefined) templates[idx].name = name
  if (content !== undefined) templates[idx].content = content
  if (triggerType !== undefined) templates[idx].triggerType = triggerType
  if (enabled !== undefined) templates[idx].enabled = !!enabled
  if (smsType !== undefined) templates[idx].smsType = smsType === 'template' ? 'template' : 'normal'
  if (templateId !== undefined) templates[idx].templateId = templateId
  if (paramFields !== undefined) templates[idx].paramFields = Array.isArray(paramFields) ? paramFields : undefined
  saveTemplates(templates)
  res.json(templates[idx])
})

app.delete('/api/sms/templates/:id', (req, res) => {
  const templates = loadTemplates()
  const next = templates.filter(t => t.id !== req.params.id)
  if (next.length === templates.length) return res.status(404).json({ error: '模板不存在' })
  saveTemplates(next)
  res.json({ ok: true })
})

// 模板预览：用示例变量渲染
app.post('/api/sms/templates/preview', (req, res) => {
  const { content } = req.body || {}
  if (!content) return res.status(400).json({ error: '缺少 content' })
  const preview = sms.renderTemplate(content, {
    point: '周家坝', pollutant: 'pm2.5', value: 86, unit: 'μg/m³',
    label: '跨阈值预警', time: '11:00:00',
  })
  res.json({ preview })
})

// ── 短信预警：发送历史 ───────────────────────────────────────
app.get('/api/sms/history', (req, res) => {
  const { status, limit } = req.query
  res.json(store.querySmsHistory({ status: status || undefined, limit: Number(limit) || 200 }))
})

// ── 短信预警：MAS 配置 ───────────────────────────────────────
app.get('/api/sms/config', (req, res) => res.json(sms.getConfig()))

app.post('/api/sms/config', (req, res) => {
  res.json(sms.setConfig(req.body || {}))
})

app.post('/api/sms/test', async (req, res) => {
  const r = await sms.testConnect()
  res.json(r)
})

// 手动发送：指定联系人/分组/手机号 + 内容
app.post('/api/sms/send', async (req, res) => {
  const { mobiles, contactIds, group, content } = req.body || {}
  if (!content) return res.status(400).json({ error: '缺少 content' })
  let targets = []
  if (Array.isArray(mobiles) && mobiles.length) targets = mobiles.map(String)
  else {
    const contacts = loadContacts().filter(c => c.enabled !== false && c.mobile)
    if (Array.isArray(contactIds) && contactIds.length) {
      targets = contacts.filter(c => contactIds.includes(c.id)).map(c => c.mobile)
    } else if (group) {
      targets = contacts.filter(c => c.group === group).map(c => c.mobile)
    } else {
      targets = contacts.map(c => c.mobile)
    }
  }
  if (!targets.length) return res.status(400).json({ error: '无有效收信人' })
  // 黑名单过滤
  const { allowed, blocked } = filterBlacklist(targets)
  if (!allowed.length) return res.status(400).json({ error: '收信人全部在黑名单中', blocked })
  let result
  try { result = await sms.sendSms(allowed, content) }
  catch (e) { result = { ok: false, error: e.message } }
  addSmsHistory({
    trigger: 'manual', content, recipients: allowed, recipientCount: allowed.length,
    blocked: blocked.length ? blocked : undefined, attempts: result.attempts,
    status: result.ok ? 'success' : 'failed', error: result.error || null, raw: result.raw || null,
  })
  // 始终返回 200，成败由 body.ok 表示（避免与网关/代理的真实 502 混淆）
  res.json({ ...result, blocked })
})

// 手动发送模板短信
app.post('/api/sms/send-template', async (req, res) => {
  const { mobiles, contactIds, group, templateId, params = [] } = req.body || {}
  if (!templateId) return res.status(400).json({ error: '缺少 templateId' })
  let targets = []
  if (Array.isArray(mobiles) && mobiles.length) targets = mobiles.map(String)
  else {
    const contacts = loadContacts().filter(c => c.enabled !== false && c.mobile)
    if (Array.isArray(contactIds) && contactIds.length) targets = contacts.filter(c => contactIds.includes(c.id)).map(c => c.mobile)
    else if (group) targets = contacts.filter(c => c.group === group).map(c => c.mobile)
    else targets = contacts.map(c => c.mobile)
  }
  if (!targets.length) return res.status(400).json({ error: '无有效收信人' })
  const { allowed, blocked } = filterBlacklist(targets)
  if (!allowed.length) return res.status(400).json({ error: '收信人全部在黑名单中', blocked })
  let result
  try { result = await sms.sendTemplateSms(allowed, templateId, params) }
  catch (e) { result = { ok: false, error: e.message } }
  addSmsHistory({
    trigger: 'manual', smsType: 'template', content: `模板:${templateId} 变量:${JSON.stringify(params)}`,
    recipients: allowed, recipientCount: allowed.length, blocked: blocked.length ? blocked : undefined,
    attempts: result.attempts, status: result.ok ? 'success' : 'failed', error: result.error || null, raw: result.raw || null,
  })
  res.json({ ...result, blocked })
})

// ── 短信预警：黑名单 CRUD ────────────────────────────────────
app.get('/api/sms/blacklist', (req, res) => res.json(loadBlacklist()))

app.post('/api/sms/blacklist', (req, res) => {
  const { mobile, reason = '' } = req.body || {}
  if (!mobile || !/^1[3-9]\d{9}$/.test(String(mobile))) return res.status(400).json({ error: '手机号格式非法' })
  const bl = loadBlacklist()
  if (bl.some(b => b.mobile === String(mobile))) return res.status(409).json({ error: '该号码已在黑名单' })
  const item = { id: uuidv4(), mobile: String(mobile), reason, createdAt: new Date().toISOString() }
  bl.push(item); saveBlacklist(bl)
  res.status(201).json(item)
})

app.delete('/api/sms/blacklist/:id', (req, res) => {
  const bl = loadBlacklist()
  const next = bl.filter(b => b.id !== req.params.id)
  if (next.length === bl.length) return res.status(404).json({ error: '记录不存在' })
  saveBlacklist(next)
  res.json({ ok: true })
})

// ── 短信平台回调：状态报告（送达回执）──────────────────────────
// 平台出口 IP（112.35.4.196 / 112.35.4.200）会 POST 到此地址上报每条短信送达状态。
// 鉴权已在 auth.js 放行；安全性由来源 IP 白名单（防火墙层）保障。
app.post('/api/sms/report', (req, res) => {
  const { parsed, mode } = sms.decodeCallback(req.body)
  addSmsReport({ type: 'report', mode, srcIp: req.ip, data: parsed })
  log.info(`收到短信状态报告 [${mode}] from ${req.ip}`)
  // 平台通常期望返回简单成功标识
  res.json({ success: true })
})

// ── 短信平台回调：上行短信（用户回复）──────────────────────────
app.post('/api/sms/upstream', (req, res) => {
  const { parsed, mode } = sms.decodeCallback(req.body)
  addSmsReport({ type: 'upstream', mode, srcIp: req.ip, data: parsed })
  log.info(`收到上行短信 [${mode}] from ${req.ip}`)
  res.json({ success: true })
})

// 查看回执/上行记录
app.get('/api/sms/reports', (req, res) => {
  const { type, limit } = req.query
  res.json(store.querySmsReports({ type: type || undefined, limit: Number(limit) || 200 }))
})

// ── Health ───────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', streams: loadStreams().length, mapPoints: loadPoints().length, datasources: loadDS().length, warnings: store.warningCount(), activeForwards: activeForwards.size, uptime: process.uptime() })
})

// ── IoTCloud AI 视频分析接入 ───────────────────────────────
iotFetcher.registerRoutes(app)  // /api/iot-analysis, /api/iot-image, /api/iot-fetch/now

// ── IoT 通道接入管理（iot_channels 表 CRUD，管理员）──
//   通道来源：IoTCloud NVR 设备通道；与驾驶舱视频流 coll_streams 做 1:1 映射
const adminOnly = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ ok: false, error: '仅管理员可操作' })
  next()
}
// 列出已接入通道（未软删）
app.get('/api/iot-channels', adminOnly, (req, res) => {
  res.json(store.listIotChannels())
})
// 远程通道列表（代理 IoTCloud /sip/channel/list，带 alreadyAdded 标记）
app.get('/api/iot-analysis/iot-channels', adminOnly, async (req, res) => {
  const r = await iotFetcher.listRemoteChannels()
  if (!r.ok) return res.status(502).json(r)
  res.json(r)
})

// ── AI 类型主数据（后台可自由增删改，adminOnly）──
app.get('/api/ai-types', adminOnly, (req, res) => {
  try { res.json(store.listAiTypes()) } catch (e) { res.status(500).json({ error: e.message }) }
})
app.post('/api/ai-types', adminOnly, (req, res) => {
  const { name } = req.body || {}
  try { res.json(store.createAiType(name)) } catch (e) { res.status(400).json({ error: e.message }) }
})
app.delete('/api/ai-types/:name', adminOnly, (req, res) => {
  try {
    const r = store.deleteAiType(req.params.name)
    if (!r.ok) {
      const msg = r.reason === 'rule' ? '该 AI 类型被启用的推送规则引用，无法删除' : r.reason === 'warning' ? '该 AI 类型存在未处理告警，无法删除' : '无法删除'
      return res.status(409).json({ ...r, error: msg })
    }
    res.json(r)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── AI 分析推送规则（后台配置，adminOnly）──
app.get('/api/push-rules', adminOnly, (req, res) => {
  try { res.json(store.listPushRules()) } catch (e) { res.status(500).json({ error: e.message }) }
})
app.post('/api/push-rules', adminOnly, (req, res) => {
  const { name, channelSipId, aiTypes, timeWindowHours, threshold, enabled } = req.body || {}
  if (!name || !Array.isArray(aiTypes) || aiTypes.length === 0) return res.status(400).json({ error: 'name 与 aiTypes（非空数组）必填' })
  try {
    res.json(store.createPushRule({ name, channel_sip_id: channelSipId || null, ai_types: aiTypes, time_window_hours: timeWindowHours, threshold, enabled }))
  } catch (e) { res.status(500).json({ error: e.message }) }
})
app.patch('/api/push-rules/:id', adminOnly, (req, res) => {
  const r = store.updatePushRule(req.params.id, req.body || {})
  if (!r) return res.status(404).json({ error: '未找到规则' })
  res.json(r)
})
app.delete('/api/push-rules/:id', adminOnly, (req, res) => {
  const c = store.deletePushRule(req.params.id)
  res.json({ ok: true, deleted: c })
})
// 批量标记聚合组（聚合告警"标记处理"，需登录即可）
app.post('/api/warnings/handle-group', (req, res) => {
  const { memberIds, handledBy } = req.body || {}
  if (!Array.isArray(memberIds) || memberIds.length === 0) return res.status(400).json({ error: 'memberIds 必填且为非空数组' })
  try { const n = store.handleGroupWarnings(memberIds, handledBy); res.json({ ok: true, handled: n }) }
  catch (e) { res.status(500).json({ error: e.message }) }
})
// 接入一条通道（upsert：已软删则复活）
app.post('/api/iot-channels', adminOnly, (req, res) => {
  const { channelSipId, channelName, deviceSipId, deviceName, streamId, enabled, remark } = req.body || {}
  if (!channelSipId || !channelName) return res.status(400).json({ error: '缺少 channelSipId / channelName' })
  try {
    // 1:1 冲突兜底：若指定 streamId，先清空占用它的其它通道
    if (streamId) store.clearStreamMapping(streamId, channelSipId)
    const row = store.upsertIotChannel({ channelSipId, channelName, deviceSipId, deviceName, streamId, enabled: enabled !== false, remark })
    res.status(201).json(row)
  } catch (e) { res.status(500).json({ error: e.message }) }
})
// 更新映射 / 启停 / 备注 / 快照
app.put('/api/iot-channels/:channelSipId', adminOnly, (req, res) => {
  const { channelSipId } = req.params
  const patch = req.body || {}
  try {
    // 1:1 冲突兜底：改 streamId 时，先清空占用它的其它通道
    if (patch.streamId) store.clearStreamMapping(patch.streamId, channelSipId)
    const row = store.updateIotChannel(channelSipId, patch)
    if (!row) return res.status(404).json({ error: '通道不存在或已删除' })
    res.json(row)
  } catch (e) { res.status(500).json({ error: e.message }) }
})
// 更新通道 AI 类型映射（多选，纯元数据）
app.patch('/api/iot-channels/:channelSipId/ai-types', adminOnly, (req, res) => {
  const { aiTypes } = req.body || {}
  try {
    const row = store.updateIotChannelAiTypes(req.params.channelSipId, aiTypes)
    if (!row) return res.status(404).json({ error: '通道不存在或已删除' })
    res.json(row)
  } catch (e) { res.status(500).json({ error: e.message }) }
})
// 软删除
app.delete('/api/iot-channels/:channelSipId', adminOnly, (req, res) => {
  const n = store.softDeleteIotChannel(req.params.channelSipId)
  if (n === 0) return res.status(404).json({ error: '通道不存在或已删除' })
  res.json({ ok: true })
})

// 数据文件健康检查：各文件条数、是否可解析、备份数量
app.get('/api/health/files', (req, res) => {
  res.json({
    // 全部已迁至 SQLite，返回库内条数
    streams: { db: true, count: store.collCount('streams') },
    map_points: { db: true, count: store.collCount('map_points') },
    datasources: { db: true, count: store.collCount('datasources') },
    collected: { db: true, ...store.counts() },
    warnings: { db: true, count: store.warningCount() },
    collect_logs: { db: true, count: store.tableCount('collect_logs') },
    sms_contacts: { db: true, count: store.collCount('sms_contacts') },
    sms_templates: { db: true, count: store.collCount('sms_templates') },
    sms_history: { db: true, count: store.tableCount('sms_history') },
    sms_reports: { db: true, count: store.tableCount('sms_reports') },
    sms_blacklist: { db: true, count: store.collCount('sms_blacklist') },
  })
})

// 从备份恢复指定数据文件（仅剩仍以 JSON 存储的 sms_history/sms_reports 可恢复；其余已在 SQLite）
app.post('/api/health/restore', (req, res) => {
  const FILES = {
    sms_history: SMS_HISTORY_FILE, sms_reports: SMS_REPORTS_FILE,
  }
  const { file, ver = 1 } = req.body || {}
  const target = FILES[file]
  if (!target) return res.status(400).json({ error: '未知文件名，可选: ' + Object.keys(FILES).join(', ') })
  const bak = target + '.bak' + ver
  if (!fs.existsSync(bak)) return res.status(404).json({ error: `备份 ${file}.bak${ver} 不存在` })
  try {
    const content = fs.readFileSync(bak, 'utf8')
    JSON.parse(content)  // 校验备份本身合法
    fs.writeFileSync(target, content)
    res.json({ ok: true, message: `已从 ${file}.bak${ver} 恢复` })
  } catch (e) {
    res.status(500).json({ error: '恢复失败: ' + e.message })
  }
})

// ── 重点企业管理 ─────────────────────────────────────────────
// 查询企业名单
app.get('/api/enterprises', (req, res) => {
  const db = store.getDb()
  const rows = db.prepare('SELECT * FROM enterprises ORDER BY id').all()
  res.json(rows)
})
// 新增企业（管理员）
app.post('/api/enterprises', (req, res) => {
  const { name, industry_type, location, contact } = req.body || {}
  if (!name) return res.status(400).json({ error: '企业名称不能为空' })
  try {
    const db = store.getDb()
    const r = db.prepare('INSERT INTO enterprises (name, industry_type, location, contact) VALUES (?,?,?,?)').run(name, industry_type || null, location || null, contact || null)
    res.status(201).json({ ok: true, id: r.lastInsertRowid })
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: '企业名称已存在' })
    res.status(500).json({ error: e.message })
  }
})
// 编辑企业（管理员）
app.patch('/api/enterprises/:id', (req, res) => {
  const { name, industry_type, location, contact } = req.body || {}
  try {
    const db = store.getDb()
    const fields = []
    const args = []
    if (name !== undefined) { fields.push('name = ?'); args.push(name) }
    if (industry_type !== undefined) { fields.push('industry_type = ?'); args.push(industry_type) }
    if (location !== undefined) { fields.push('location = ?'); args.push(location) }
    if (contact !== undefined) { fields.push('contact = ?'); args.push(contact) }
    if (!fields.length) return res.status(400).json({ error: '无字段可更新' })
    fields.push("updated_at = datetime('now','localtime')")
    args.push(req.params.id)
    db.prepare(`UPDATE enterprises SET ${fields.join(', ')} WHERE id = ?`).run(...args)
    const row = db.prepare('SELECT * FROM enterprises WHERE id = ?').get(req.params.id)
    if (!row) return res.status(404).json({ error: '企业不存在' })
    res.json(row)
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: '企业名称已存在' })
    res.status(500).json({ error: e.message })
  }
})
// 删除企业（管理员）
app.delete('/api/enterprises/:id', (req, res) => {
  try {
    const db = store.getDb()
    // 同时删除该企业的事件记录
    db.prepare('DELETE FROM pollution_events WHERE enterprise_id = ?').run(req.params.id)
    const r = db.prepare('DELETE FROM enterprises WHERE id = ?').run(req.params.id)
    if (r.changes === 0) return res.status(404).json({ error: '企业不存在' })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── 告警类型占比聚合（供驾驶舱饼图）──────────────────────
// 合并污染事件(event_type) + 气体采集预警(warnings)，返回各类数量
app.get('/api/alert-type-stats', (req, res) => {
  const hours = Math.min(Number(req.query.hours) || 48, 8760)
  try {
    const db = store.getDb()
    // 1. 污染事件按 event_type 分组计数
    const eventRows = db.prepare(
      `SELECT event_type, COUNT(*) c FROM pollution_events
       WHERE reported_at > datetime('now', '-' || ? || ' hours')
       GROUP BY event_type`
    ).all(hours)
    // 2. 气体采集预警总数
    const warnTotal = db.prepare(
      `SELECT COUNT(*) c FROM warnings
       WHERE created_at > datetime('now', '-' || ? || ' hours')`
    ).get(hours)
    // 汇总为 6 类：5 种污染类型 + 气体采集预警
    const categories = {
      '气体污染': 0,
      '水体污染': 0,
      '秸秆燃烧': 0,
      '道路扬尘': 0,
      '堆头未覆盖': 0,
      '气体采集预警': warnTotal?.c || 0,
    }
    for (const { event_type, c } of eventRows) {
      // 直接匹配已知分类名，未知类型计入最接近的分类
      if (event_type in categories) {
        categories[event_type] = c
      } else {
        // 未匹配的类型放入"其他"，但不影响标准分类
        categories['气体污染'] = (categories['气体污染'] || 0) + c
      }
    }
    res.json({
      ok: true,
      range: { hours },
      categories,
      total: Object.values(categories).reduce((a, b) => a + b, 0),
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── 污染事件 ────────────────────────────────────────────────
// 接收污染事件（供 MQTT 桥接脚本调用，需要登录）
app.post('/api/events', (req, res) => {
  const { enterprise_id, enterprise_name, event_type, severity, description, timestamp } = req.body || {}
  if (!event_type || !severity) return res.status(400).json({ error: 'event_type 和 severity 必填' })
  try {
    const db = store.getDb()
    // 匹配企业
    let ent = null
    if (enterprise_id) ent = db.prepare('SELECT id FROM enterprises WHERE id = ?').get(enterprise_id)
    if (!ent && enterprise_name) {
      const rows = db.prepare('SELECT id FROM enterprises WHERE name LIKE ?').all('%' + enterprise_name + '%')
      if (rows.length) ent = rows[0]
    }
    if (!ent) return res.status(404).json({ error: '企业未匹配，请检查 enterprise_id 或 enterprise_name' })
    const r = db.prepare(`INSERT INTO pollution_events (enterprise_id, event_type, severity, description, reported_at) VALUES (?,?,?,?,?)`)
      .run(ent.id, event_type, severity, description || null, timestamp || new Date().toISOString())
    log.info(`污染事件入库 [${ent.id}] ${event_type} ${severity}`)
    res.status(201).json({ ok: true, id: r.lastInsertRowid })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})
// 污染事件排行（按企业汇总次数）
app.get('/api/events/rank', (req, res) => {
  const period = req.query.period || '30d'
  const limit = parseInt(req.query.limit) || 5
  let dateFilter = ''
  if (period === '7d') dateFilter = "AND reported_at > datetime('now','-7 days')"
  else if (period === '30d') dateFilter = "AND reported_at > datetime('now','-30 days')"
  else if (period === '90d') dateFilter = "AND reported_at > datetime('now','-90 days')"
  try {
    const db = store.getDb()
    const sql = `
      SELECT e.id as enterprise_id, e.name as enterprise_name,
             COUNT(pe.id) as event_count,
             MAX(pe.event_type) as last_event_type,
             MAX(pe.severity) as last_severity
      FROM enterprises e
      LEFT JOIN pollution_events pe ON e.id = pe.enterprise_id ${dateFilter}
      GROUP BY e.id
      HAVING event_count > 0
      ORDER BY event_count DESC
      LIMIT ?
    `
    const rows = db.prepare(sql).all(limit)
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})
// 查询污染事件记录
app.get('/api/events', (req, res) => {
  const enterprise_id = req.query.enterprise_id
  const limit = parseInt(req.query.limit) || 50
  try {
    const db = store.getDb()
    let sql = `
      SELECT pe.*, e.name as enterprise_name
      FROM pollution_events pe
      JOIN enterprises e ON pe.enterprise_id = e.id
    `
    const args = []
    if (enterprise_id) { sql += ' WHERE pe.enterprise_id = ?'; args.push(enterprise_id) }
    sql += ' ORDER BY pe.reported_at DESC LIMIT ?'
    args.push(limit)
    const rows = db.prepare(sql).all(...args)
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── 智治推送（城运中心对接）────────────────────────────────────
// 处置预案 CRUD
app.get('/api/smart-push/plans', (req, res) => {
  try {
    const rows = store.getDb().prepare('SELECT * FROM smart_push_plans ORDER BY created_at DESC').all()
    res.json(rows.map(r => ({
      ...r, enabled: !!r.enabled,
      api_headers: r.api_headers ? JSON.parse(r.api_headers) : {},
      api_headers_other: r.api_headers_other ? (() => { try { return JSON.parse(r.api_headers_other) } catch { return {} } })() : {},
    })))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/smart-push/plans', (req, res) => {
  const { event_type, name, api_url, api_method, api_headers, body_template, description, enabled, platform_id,
          api_url_other, api_method_other, api_headers_other, body_template_other } = req.body || {}
  if (!event_type || !name) return res.status(400).json({ error: 'event_type 和 name 必填' })
  const id = uuidv4()
  const now = new Date().toLocaleString('sv', { timeZone: 'Asia/Shanghai' })
  try {
    store.getDb().prepare(`INSERT INTO smart_push_plans (id, event_type, name, enabled, api_url, api_method, api_headers, body_template, description, platform_id, created_at, updated_at, api_url_other, api_method_other, api_headers_other, body_template_other) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, event_type, name, enabled === false ? 0 : 1, api_url || '', api_method || 'POST',
           JSON.stringify(api_headers || { 'Content-Type': 'application/json' }),
           body_template || '', description || '', platform_id || null, now, now,
           api_url_other || '', api_method_other || 'POST',
           JSON.stringify(api_headers_other || {}), body_template_other || '')
    res.status(201).json({ ok: true, id })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.patch('/api/smart-push/plans/:id', (req, res) => {
  const { id } = req.params
  const fields = ['event_type', 'name', 'enabled', 'api_url', 'api_method', 'api_headers', 'body_template', 'description', 'platform_id', 'api_url_other', 'api_method_other', 'api_headers_other', 'body_template_other']
  const sets = []
  const vals = []
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      if (f === 'enabled') { sets.push('enabled = ?'); vals.push(req.body[f] ? 1 : 0) }
      else if (f === 'api_headers' || f === 'api_headers_other') { sets.push(f + ' = ?'); vals.push(JSON.stringify(req.body[f])) }
      else { sets.push(f + ' = ?'); vals.push(req.body[f]) }
    }
  }
  if (sets.length === 0) return res.json({ ok: true })
  sets.push("updated_at = ?"); vals.push(new Date().toLocaleString('sv', { timeZone: 'Asia/Shanghai' }))
  vals.push(id)
  try {
    store.getDb().prepare(`UPDATE smart_push_plans SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.delete('/api/smart-push/plans/:id', (req, res) => {
  try {
    store.getDb().prepare('DELETE FROM smart_push_plans WHERE id = ?').run(req.params.id)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── 目标平台 CRUD（P2：可复用的推送连接配置）──
app.get('/api/smart-push/platforms', (req, res) => {
  try {
    res.json(store.listSmartPushPlatforms())
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/smart-push/platforms', (req, res) => {
  const { name, api_url, api_method, api_headers, body_template, auth_mode, auth_key_name, event_types, enabled, description,
          api_url_other, api_method_other, api_headers_other, body_template_other } = req.body || {}
  if (!name) return res.status(400).json({ error: 'name 必填' })
  try {
    const r = store.upsertSmartPushPlatform({ name, api_url, api_method, api_headers, body_template, auth_mode, auth_key_name, event_types, enabled, description,
      api_url_other, api_method_other, api_headers_other, body_template_other })
    res.status(201).json(r)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.patch('/api/smart-push/platforms/:id', (req, res) => {
  const { id } = req.params
  const fields = ['name', 'api_url', 'api_method', 'api_headers', 'body_template', 'auth_mode', 'auth_key_name', 'event_types', 'enabled', 'description',
                  'api_url_other', 'api_method_other', 'api_headers_other', 'body_template_other']
  const sets = []
  const vals = []
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      if (f === 'enabled') { sets.push('enabled = ?'); vals.push(req.body[f] ? 1 : 0) }
      else if (f === 'api_headers' || f === 'api_headers_other') { sets.push(f + ' = ?'); vals.push(JSON.stringify(req.body[f])) }
      else { sets.push(f + ' = ?'); vals.push(req.body[f]) }
    }
  }
  if (sets.length === 0) return res.json({ ok: true })
  sets.push("updated_at = ?"); vals.push(new Date().toLocaleString('sv', { timeZone: 'Asia/Shanghai' }))
  vals.push(id)
  try {
    store.getDb().prepare(`UPDATE smart_push_platforms SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.delete('/api/smart-push/platforms/:id', (req, res) => {
  try {
    const r = store.deleteSmartPushPlatform(req.params.id)
    res.json(r)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// 推送规则 CRUD
app.get('/api/smart-push/rules', (req, res) => {
  try {
    const rows = store.getDb().prepare(`
      SELECT r.*, p.name as plan_name, p.platform_id, pl.name as platform_name
      FROM smart_push_rules r
      LEFT JOIN smart_push_plans p ON r.plan_id = p.id
      LEFT JOIN smart_push_platforms pl ON p.platform_id = pl.id
      ORDER BY r.created_at DESC
    `).all()
    res.json(rows.map(r => ({ ...r, enabled: !!r.enabled })))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/smart-push/rules', (req, res) => {
  const { name, event_type, plan_id, location_match, time_window_hours, trigger_count, enabled } = req.body || {}
  if (!name || !event_type) return res.status(400).json({ error: 'name 和 event_type 必填' })
  const id = uuidv4()
  const now = new Date().toLocaleString('sv', { timeZone: 'Asia/Shanghai' })
  try {
    store.getDb().prepare(`INSERT INTO smart_push_rules (id, name, event_type, plan_id, location_match, time_window_hours, trigger_count, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, name, event_type, plan_id || null, location_match || '', time_window_hours || 48, trigger_count || 5, enabled === false ? 0 : 1, now, now)
    res.status(201).json({ ok: true, id })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.patch('/api/smart-push/rules/:id', (req, res) => {
  const { id } = req.params
  const fields = ['name', 'event_type', 'plan_id', 'location_match', 'time_window_hours', 'trigger_count', 'enabled']
  const sets = []
  const vals = []
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      if (f === 'enabled') { sets.push('enabled = ?'); vals.push(req.body[f] ? 1 : 0) }
      else { sets.push(f + ' = ?'); vals.push(req.body[f]) }
    }
  }
  if (sets.length === 0) return res.json({ ok: true })
  sets.push("updated_at = ?"); vals.push(new Date().toLocaleString('sv', { timeZone: 'Asia/Shanghai' }))
  vals.push(id)
  try {
    store.getDb().prepare(`UPDATE smart_push_rules SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.delete('/api/smart-push/rules/:id', (req, res) => {
  try {
    store.getDb().prepare('DELETE FROM smart_push_rules WHERE id = ?').run(req.params.id)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// 推送历史（支持事件类型/状态筛选 + 超时判定）
app.get('/api/smart-push/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 200
  const eventType = req.query.event_type
  const status = req.query.status
  const location = req.query.location
  const start = req.query.start
  const end = req.query.end
  const platformId = req.query.platform_id
  try {
    res.json(store.getSmartPushHistory({ eventType, status, location, start, end, platformId, limit }))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// 智治推送统计（按预案名称聚合推送次数）
app.get('/api/smart-push/stats', (req, res) => {
  const limit = parseInt(req.query.limit) || 10
  try {
    const rows = store.getDb().prepare(`
      SELECT p.name AS plan_name, p.event_type, COUNT(*) AS push_count,
             SUM(CASE WHEN h.success = 1 THEN 1 ELSE 0 END) AS success_count,
             SUM(CASE WHEN h.success = 0 THEN 1 ELSE 0 END) AS fail_count
      FROM smart_push_history h
      LEFT JOIN smart_push_plans p ON h.plan_id = p.id
      GROUP BY p.name
      ORDER BY push_count DESC
      LIMIT ?
    `).all(limit)
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── 推送引擎核心 ──────────────────────────────────────────
// 变量替换：将 body_template 中的 {xxx} 替换为实际值
function fillTemplate(template, vars) {
  if (!template) return JSON.stringify(vars)
  let result = template
  for (const [k, v] of Object.entries(vars)) {
    result = result.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v ?? ''))
  }
  return result
}

// 把报文中所有「相对路径形式」的 /api/iot-image 补全为公网绝对 URL，
// 以便城运中心等外网平台能直接拉取图片。已是 http(s):// 绝对地址的不重复处理。
// base 为空则不改写（兼容旧行为）。
function absolutizeImageUrls(text, base) {
  if (!text || !base) return text
  const b = base.replace(/\/+$/, '')
  return text.replace(/(?<!\:\/\/[^\s"']*)\/api\/iot-image/g, b + '/api/iot-image')
}

// 执行 HTTP 推送
async function executePush(plan, events, rule, platformId) {
  const histId = uuidv4()
  const vars = {
    event_type: events[0].event_type,
    location: events[0].location || '',
    lat: events[0].lat || '',
    lon: events[0].lon || '',
    level: events[0].level || '',
    value: events[0].value || '',
    standard: events[0].standard || '',
    description: events[0].description || '',
    time: events[0].created_at || '',
    trigger_count: events.length,
    event_ids: events.map(e => e.id).join(','),
    image_url: events[0].image_url || '',
    // 回执关联：城运中心回调时用 push_id 关联本次推送（见 /api/smart-push/callback）
    push_id: histId,
    callback_url: process.env.SMART_PUSH_CALLBACK_URL || '',
  }
  // 从原始告警 JSON 提取通道ID/设备名/AI置信度（与 AI分析存档同源字段），
  // 供向导「通道ID(spid) / 设备名称(deviceName) / AI置信度(aiConfidence)」系统字段使用。
  // 极少数来源（如手动测试）raw_json 可能不含这些字段，用 '' 兜底，不产生坏数据。
  try {
    const raw = events[0]?.raw_json ? JSON.parse(events[0].raw_json) : null
    if (raw) {
      vars.spid = raw.channelSipId || raw.channelSpid || raw.spid || ''
      vars.deviceName = raw.deviceName || ''
      if (raw.aiConfidence !== undefined && raw.aiConfidence !== null && raw.aiConfidence !== '') vars.aiConfidence = raw.aiConfidence
    }
  } catch (_) {}
  // AI 置信度统计（范围/均值/样本数）：聚合告警按 memberIds 反查多图置信度，单条取自身置信度。
  // 与结案报告 getClosureReportData 共用 store.computeAiConfidenceStats，口径一致。
  const _conf = store.computeAiConfidenceStats(events)
  vars.aiConfidenceMin = _conf.min
  vars.aiConfidenceMax = _conf.max
  vars.aiConfidenceAvg = _conf.avg
  vars.aiConfidenceCount = _conf.count
  const publicBase = (process.env.SMART_PUSH_PUBLIC_BASE || 'http://111.10.220.226:81').replace(/\/+$/, '')
  const body = absolutizeImageUrls(fillTemplate(plan.body_template, vars), publicBase)
  const headers = Object.assign({}, plan.api_headers || { 'Content-Type': 'application/json' })
  // 回执关联头：即使报文模板未写 push_id，城运中心也可从响应头取 X-Push-Id 回传
  headers['X-Push-Id'] = histId
  if (vars.callback_url) headers['X-Callback-Url'] = vars.callback_url
  const fetchOpts = {
    method: plan.api_method || 'POST',
    headers: headers,
  }
  if (fetchOpts.method !== 'GET') fetchOpts.body = body

  const now = new Date().toLocaleString('sv', { timeZone: 'Asia/Shanghai' })
  // platformId 有值 → 本次推送由"目标平台"自动订阅触发，history 记 platform_id、plan_id 置空
  const histPlanId = platformId ? null : (plan?.id || null)
  const histPlatformId = platformId || (plan?.platform_id || null)
  const insertHistory = (success, status, respText, errMsg) => {
    store.getDb().prepare(`INSERT INTO smart_push_history (id, rule_id, plan_id, event_type, event_ids, location, trigger_count, api_url, api_method, request_body, response_status, response_body, success, error_message, created_at, status, platform_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(histId, rule?.id || null, histPlanId, events[0].event_type,
           JSON.stringify(events.map(e => e.id)), events[0].location || '', events.length,
           plan.api_url, plan.api_method, body, status, (respText || '').slice(0, 2000),
           success, errMsg || null, now, 'pushed', histPlatformId)
  }
  try {
    const resp = await fetch(plan.api_url, fetchOpts)
    const respText = await resp.text()
    const success = resp.ok ? 1 : 0
    insertHistory(success, resp.status, respText, resp.ok ? null : `HTTP ${resp.status}`)
    if (success) store.markEventsPushed(events.map(e => e.id))
    log.info(`[智治推送] ${success ? '成功' : '失败'}: ${events[0].event_type} @ ${events[0].location} (${events.length}次 → ${plan.api_url}) pushId=${histId}`)
    // ── 副接口（附件/补充信息接口，如城运中心 /client/handle_event_other）：主接口成功后才调用 ──
    let otherResult = null
    if (success && plan.api_url_other && plan.body_template_other) {
      try {
        const otherVars = { ...vars, push_id: histId, callback_url: vars.callback_url }
        const otherBody = absolutizeImageUrls(fillTemplate(plan.body_template_other, otherVars), publicBase)
        let otherHeadersObj = plan.api_headers_other
        if (typeof otherHeadersObj === 'string') { try { otherHeadersObj = JSON.parse(otherHeadersObj) } catch { otherHeadersObj = {} } }
        const otherHeaders = Object.assign({}, (otherHeadersObj && typeof otherHeadersObj === 'object') ? otherHeadersObj : { 'Content-Type': 'application/json' })
        otherHeaders['X-Push-Id'] = histId
        const otherOpts = { method: plan.api_method_other || 'POST', headers: otherHeaders }
        if (otherOpts.method !== 'GET') otherOpts.body = otherBody
        const oResp = await fetch(plan.api_url_other, otherOpts)
        const oText = await oResp.text()
        otherResult = { success: oResp.ok ? 1 : 0, status: oResp.status, body: oText.slice(0, 2000) }
        log.info(`[智治推送] 副接口 ${oResp.ok ? '成功' : '失败'}: ${plan.api_url_other} pushId=${histId}`)
      } catch (oe) {
        otherResult = { success: 0, error: oe.message }
        log.error(`[智治推送] 副接口异常: ${oe.message}`)
      }
    }
    return { success: !!success, status: resp.status, body: respText, push_id: histId, other: otherResult }
  } catch (e) {
    insertHistory(0, 0, '', e.message)
    log.error(`[智治推送] 异常: ${e.message}`)
    return { success: false, error: e.message, push_id: histId }
  }
}

// 检查规则并触发推送
async function checkRulesAndPush(event) {
  const db = store.getDb()
  // 查找匹配的启用规则
  const rules = db.prepare('SELECT * FROM smart_push_rules WHERE event_type = ? AND enabled = 1').all(event.event_type)
  for (const rule of rules) {
    // 点位匹配：空=所有点位，否则模糊匹配
    if (rule.location_match && rule.location_match.trim()) {
      const pattern = rule.location_match.trim()
      if (!event.location || !event.location.includes(pattern)) continue
    }
    // 统计时间窗口内同类型、同点位的事件数
    let countSql = 'SELECT * FROM smart_push_events WHERE event_type = ? AND created_at > ?'
    const countArgs = [event.event_type, new Date(Date.now() - rule.time_window_hours * 3600000).toLocaleString('sv', { timeZone: 'Asia/Shanghai' })]
    if (rule.location_match && rule.location_match.trim()) {
      countSql += ' AND location LIKE ?'
      countArgs.push('%' + rule.location_match.trim() + '%')
    }
    countSql += ' ORDER BY created_at DESC'
    const events = db.prepare(countSql).all(...countArgs)
    if (events.length >= rule.trigger_count) {
      const deliveredPlatformIds = []  // 记录本次已送达的平台，避免与"平台自动订阅"重复推送
      // (A) 预案关联推送（预案可引用平台，继承平台配置）
      const plan = db.prepare('SELECT * FROM smart_push_plans WHERE id = ?').get(rule.plan_id)
      if (plan && plan.enabled !== 0) {
        let effectivePlan = plan
        let platformId = null
        if (plan.platform_id) {
          const plat = db.prepare('SELECT * FROM smart_push_platforms WHERE id = ? AND enabled = 1').get(plan.platform_id)
          if (plat) {
            platformId = plat.id
            effectivePlan = {
              id: plat.id, name: plat.name, api_url: plat.api_url,
              api_method: plat.api_method || 'POST',
              api_headers: plat.api_headers ? JSON.parse(plat.api_headers) : { 'Content-Type': 'application/json' },
              body_template: plat.body_template || '', event_type: event.event_type,
              api_url_other: plat.api_url_other || '',
              api_method_other: plat.api_method_other || 'POST',
              api_headers_other: plat.api_headers_other ? JSON.parse(plat.api_headers_other) : {},
              body_template_other: plat.body_template_other || '',
            }
            deliveredPlatformIds.push(plat.id)
          }
        }
        if (platformId || effectivePlan.api_url) {
          if (!platformId) effectivePlan.api_headers = effectivePlan.api_headers ? JSON.parse(effectivePlan.api_headers) : { 'Content-Type': 'application/json' }
          await executePush(effectivePlan, events, rule, platformId)
        } else {
          log.warn(`[智治推送] 规则 ${rule.name} 匹配但预案不可用`)
        }
      }
      // (B) 目标平台自动订阅（event_types 含本事件类型或 'ALL'）→ 零预案即可送达
      const platforms = db.prepare('SELECT * FROM smart_push_platforms WHERE enabled = 1').all()
      for (const plat of platforms) {
        if (deliveredPlatformIds.includes(plat.id)) continue
        if (!store.platformSubscribes(plat, event.event_type)) continue
        if (!plat.api_url) { log.warn(`[智治推送] 平台 ${plat.name} 订阅了 ${event.event_type} 但未配置接口地址`); continue }
        const platPlan = {
          id: plat.id, name: plat.name, api_url: plat.api_url,
          api_method: plat.api_method || 'POST',
          api_headers: plat.api_headers ? JSON.parse(plat.api_headers) : { 'Content-Type': 'application/json' },
          body_template: plat.body_template || '', event_type: event.event_type,
          api_url_other: plat.api_url_other || '',
          api_method_other: plat.api_method_other || 'POST',
          api_headers_other: plat.api_headers_other ? JSON.parse(plat.api_headers_other) : {},
          body_template_other: plat.body_template_other || '',
        }
        await executePush(platPlan, events, rule, plat.id)
      }
    }
  }
}

// 接收告警事件（前端 MQTT 告警同步到后端）
app.post('/api/smart-push/events', async (req, res) => {
  const { event_type, location, lat, lon, level, value, standard, description, image_url, raw_json, source } = req.body || {}
  if (!event_type) return res.status(400).json({ error: 'event_type 必填' })
  const id = uuidv4()
  const now = new Date().toLocaleString('sv', { timeZone: 'Asia/Shanghai' })
  try {
    store.getDb().prepare(`INSERT INTO smart_push_events (id, event_type, location, lat, lon, level, value, standard, description, image_url, raw_json, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, event_type, location || '', lat || null, lon || null, level || null,
           value || '', standard || '', description || '', image_url || '', raw_json ? JSON.stringify(raw_json) : null, source || 'mqtt', now)
    res.status(201).json({ ok: true, id })
    // 异步检查规则并推送（不阻塞响应）
    checkRulesAndPush({ id, event_type, location, lat, lon, level, value, standard, description, image_url, created_at: now }).catch(e => log.error('[智治推送] 规则检查异常:', e.message))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// 查询告警事件记录
app.get('/api/smart-push/events', (req, res) => {
  const limit = parseInt(req.query.limit) || 100
  const eventType = req.query.event_type
  try {
    let sql = 'SELECT * FROM smart_push_events'
    const args = []
    if (eventType) { sql += ' WHERE event_type = ?'; args.push(eventType) }
    sql += ' ORDER BY created_at DESC LIMIT ?'
    args.push(limit)
    res.json(store.getDb().prepare(sql).all(...args))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// 手动测试推送（支持 plan_id 或 platform_id 二选一）
app.post('/api/smart-push/test', async (req, res) => {
  const { plan_id, platform_id, event_type, location, lat, lon, level, value, standard, description, image_url } = req.body || {}
  if (!plan_id && !platform_id) return res.status(400).json({ error: 'plan_id 或 platform_id 必填其一' })
  try {
    let target = null
    let pid = null
    if (platform_id) {
      const plat = store.getSmartPushPlatform(platform_id)
      if (!plat) return res.status(404).json({ error: '目标平台不存在' })
      if (!plat.api_url) return res.status(400).json({ error: '目标平台未配置接口地址' })
      target = { id: plat.id, name: plat.name, api_url: plat.api_url, api_method: plat.api_method || 'POST', api_headers: plat.api_headers || {}, body_template: plat.body_template || '', event_type: event_type || '气体污染',
        api_url_other: plat.api_url_other || '', api_method_other: plat.api_method_other || 'POST', api_headers_other: plat.api_headers_other || {}, body_template_other: plat.body_template_other || '' }
      pid = plat.id
    } else {
      const plan = store.getDb().prepare('SELECT * FROM smart_push_plans WHERE id = ?').get(plan_id)
      if (!plan) return res.status(404).json({ error: '预案不存在' })
      if (!plan.api_url && !plan.platform_id) return res.status(400).json({ error: '预案未配置接口地址' })
      if (plan.platform_id) {
        const plat = store.getSmartPushPlatform(plan.platform_id)
        if (plat && plat.api_url) { target = { id: plat.id, name: plat.name, api_url: plat.api_url, api_method: plat.api_method || 'POST', api_headers: plat.api_headers || {}, body_template: plat.body_template || '', event_type: event_type || plan.event_type,
          api_url_other: plat.api_url_other || '', api_method_other: plat.api_method_other || 'POST', api_headers_other: plat.api_headers_other || {}, body_template_other: plat.body_template_other || '' }; pid = plat.id }
      }
      if (!target) { target = plan; target.api_headers = target.api_headers ? JSON.parse(target.api_headers) : { 'Content-Type': 'application/json' } }
    }
    const fakeEvent = {
      id: 'test-' + Date.now(), event_type: event_type || target.event_type, location: location || '测试点位',
      lat: lat || 30.8, lon: lon || 108.4, level: level || 2, value: value || '测试值',
      standard: standard || '', description: description || '手动测试推送', image_url: image_url || '', created_at: new Date().toLocaleString('sv', { timeZone: 'Asia/Shanghai' })
    }
    const result = await executePush(target, [fakeEvent], null, pid)
    res.json(result)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── 城运中心处置回执（回调闭环）──
// 由城运中心在处置完成后调用；复用城运入站 Guard（IP 白名单 CHENGYUN_ALLOW_IPS + 令牌 X-Callback-Token）
// 关联方式：优先取响应头 X-Push-Id，其次报文体 push_id / event_id；状态 processing(受理中) / closed(已结案)
app.post('/api/smart-push/callback', chengyunGuard, (req, res) => {
  const b = parseChengyunBody(req)
  const pushId = (req.get && req.get('X-Push-Id')) || b.push_id || b.pushId || b.event_id
  if (!pushId) return res.status(400).json({ code: 400, message: '缺少 push_id（请携带 X-Push-Id 头或报文体 push_id）', data: {} })
  const statusRaw = (b.disposal_status || b.status || '').toString().toLowerCase()
  const finalStatus = statusRaw === 'closed' || statusRaw === 'processing' ? statusRaw : 'processing'
  try {
    const r = store.recordSmartPushCallback({
      pushId,
      status: finalStatus,
      disposalResult: b.disposal_result || b.disposalResult || b.result || b.remark || '',
      disposalOperator: b.disposal_operator || b.disposalOperator || b.operator || '',
      disposalTime: b.disposal_time || b.disposalTime || '',
      body: b,
    })
    if (!r.ok) return res.status(r.code || 404).json({ code: r.code || 404, message: r.error, data: {} })
    log.info(`[智治推送回调] pushId=${pushId} → ${finalStatus} from ${clientIp(req)}`)
    res.json({ code: 200, message: '请求已成功', data: { status: finalStatus } })
  } catch (e) {
    log.error('智治推送回调处理失败: ' + (e && e.stack))
    res.status(500).json({ code: 500, message: '处理失败', data: {} })
  }
})

// 人工一键结案（值守员在驾驶舱对 pushed/processing 的推送记录手动结案）
app.post('/api/smart-push/history/:id/close', (req, res) => {
  const operator = (req.user && req.user.username) || (req.body && req.body.operator) || ''
  try {
    const r = store.closeSmartPushHistory(req.params.id, operator)
    if (!r.ok) return res.status(r.code || 404).json({ ok: false, error: r.error })
    res.json({ ok: true, status: r.status })
  } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
})

// ── 第③环 PDF 结案报告：模板 CRUD（admin）+ 预览 + 生成/下载（operator+）──
// 版式存库可编辑；代码只取模板+填数据+渲染，不固化版式。
app.get('/api/smart-push/report-templates', (req, res) => {
  try { res.json(store.listReportTemplates(req.query.kind)) } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/smart-push/report-templates', (req, res) => {
  const { name, content, description, kind, blocks_json } = req.body || {}
  if (!name || !content) return res.status(400).json({ error: 'name 和 content 必填' })
  try { res.status(201).json(store.upsertReportTemplate({ name, content, description, kind, blocks_json })) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

// 预览：用样例数据渲染模板（content 或 templateId），返回 PDF
app.post('/api/smart-push/report-templates/preview', async (req, res) => {
  const { content, templateId } = req.body || {}
  let html = content
  if (!html && templateId) {
    const t = store.getReportTemplate(templateId)
    if (!t) return res.status(404).json({ error: '模板不存在' })
    html = t.content
  }
  if (!html) return res.status(400).json({ error: 'content 或 templateId 必填' })
  try {
    const pdfPath = await reportRenderer.previewReport(html)
    const buf = require('fs').readFileSync(pdfPath)
    try { require('fs').unlinkSync(pdfPath) } catch {}
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'inline; filename="preview.pdf"')
    res.send(buf)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/smart-push/report-templates/:id', (req, res) => {
  const tpl = store.getReportTemplate(req.params.id)
  if (!tpl) return res.status(404).json({ ok: false, error: '模板不存在' })
  res.json({ ok: true, template: tpl })
})

app.patch('/api/smart-push/report-templates/:id', (req, res) => {
  const { name, content, description, kind, blocks_json } = req.body || {}
  const sets = [], vals = []
  if (name !== undefined) { sets.push('name = ?'); vals.push(name) }
  if (content !== undefined) { sets.push('content = ?'); vals.push(content) }
  if (description !== undefined) { sets.push('description = ?'); vals.push(description) }
  if (kind !== undefined) { sets.push('kind = ?'); vals.push(kind) }
  if (blocks_json !== undefined) { sets.push('blocks_json = ?'); vals.push(blocks_json) }
  if (!sets.length) return res.json({ ok: true })
  sets.push('updated_at = ?'); vals.push(new Date().toLocaleString('sv', { timeZone: 'Asia/Shanghai' }))
  vals.push(req.params.id)
  try {
    store.getDb().prepare(`UPDATE smart_push_report_templates SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/smart-push/report-templates/:id/default', (req, res) => {
  try { res.json(store.setDefaultReportTemplate(req.params.id)) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

app.delete('/api/smart-push/report-templates/:id', (req, res) => {
  try { res.json(store.deleteReportTemplate(req.params.id)) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

// 为指定推送记录生成/重生成结案报告 PDF
app.post('/api/smart-push/history/:id/report', async (req, res) => {
  const { templateId } = req.body || {}
  try {
    const r = await reportRenderer.generateClosureReport(req.params.id, templateId)
    res.json(r)
  } catch (e) { res.status(e.code || 500).json({ ok: false, error: e.message }) }
})

// 下载结案报告 PDF
app.get('/api/smart-push/history/:id/report', (req, res) => {
  try {
    const h = store.getDb().prepare('SELECT report_path FROM smart_push_history WHERE id = ?').get(req.params.id)
    const fs = require('fs'), path = require('path')
    const candidate = (h && h.report_path) || path.join(reportRenderer.REPORTS_DIR, `${req.params.id}.pdf`)
    if (!fs.existsSync(candidate)) return res.status(404).json({ ok: false, error: '尚未生成结案报告，请先点击"导出结案报告"' })
    res.download(candidate, `closure-report-${req.params.id}.pdf`)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// 推送历史 — 关联证据明细（AI 分析图片 + 置信度），供详情弹窗展示
// 链路：history.event_ids → smart_push_events.raw_json.memberIds → getWarningsByIds → warnings 表
app.get('/api/smart-push/history/:id/evidence', (req, res) => {
  try {
    const history = store.getDb().prepare(`
      SELECT id, event_type, event_ids, status, trigger_count,
             location, created_at, disposal_result
      FROM smart_push_history WHERE id = ?
    `).get(req.params.id)
    if (!history) return res.status(404).json({ ok: false, error: '推送记录不存在' })

    // 解析 event_ids
    let eids = []
    try { eids = JSON.parse(history.event_ids || '[]') } catch {}
    if (!eids.length) {
      return res.json({ ok: true, evidenceType: 'no_events', message: '暂无事件数据', evidences: [] })
    }

    // 取第一条聚合事件（典型为 1 条 event 聚合多条 warning）
    const event = store.getDb().prepare(
      'SELECT id, event_type, raw_json, status FROM smart_push_events WHERE id = ?'
    ).get(eids[0])
    if (!event) {
      return res.json({ ok: true, evidenceType: 'no_events', message: '关联事件不存在（可能已清理）', evidences: [] })
    }

    let raw = {}
    try { raw = JSON.parse(event.raw_json || '{}') } catch {}
    const memberIds = Array.isArray(raw.memberIds) ? raw.memberIds : []

    if (!memberIds.length) {
      // 传感器事件等无 memberIds → 无 AI 分析图片
      return res.json({
        ok: true, evidenceType: 'sensor',
        message: '本次推送为传感器事件，无 AI 分析图片',
        evidences: [], eventType: event.event_type,
      })
    }

    const warnings = store.getWarningsByIds(memberIds)
    const found = warnings.length
    const expired = memberIds.length - found
    // 按时间倒序
    warnings.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))

    return res.json({
      ok: true,
      evidenceType: found > 0 ? 'evidence' : 'expired',
      message: found > 0 ? null : `关联证据已过期（${memberIds.length} 条原始记录未找到）`,
      evidences: warnings.map(w => ({
        id: w.id,
        picUrl: w.picUrl || '',
        time: w.createdAt || '',
        confidence: w.aiConfidence != null ? Number(w.aiConfidence) : null,
        level: w.level || 1,
        channelName: w.channelName || '',
        aiType: w.aiType || '',
      })),
      totalMemberIds: memberIds.length,
      foundCount: found,
      expiredCount: expired,
      eventType: event.event_type,
      historyEventType: history.event_type,
    })
  } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
})

// 工作报表聚合查询（周/月/季报 + 留痕查找）：周期/筛选/区域透传，零新采集
app.get('/api/smart-push/work-report', (req, res) => {
  try {
    const q = req.query
    const data = store.getWorkReportData({
      range: q.range, start: q.start, end: q.end,
      eventType: q.eventType, platformId: q.platformId, status: q.status, region: q.region,
      limit: q.limit,
    })
    res.json(data)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// 工作报表 PDF 预览/导出（前端三格式导出中的 PDF；{templateId, params} → 生成 PDF 字节）
app.post('/api/smart-push/work-report/preview', async (req, res) => {
  const { templateId, content, params } = req.body || {}
  try {
    const r = await reportRenderer.generateWorkReport(params || {}, templateId, content)
    const fsMod = require('fs')
    const buf = fsMod.readFileSync(r.path)
    try { fsMod.unlinkSync(r.path) } catch {}
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="work-report-${Date.now()}.pdf"`)
    res.send(buf)
  } catch (e) { res.status(e.code || 500).json({ ok: false, error: e.message }) }
})

app.get('/api/weather', async (req, res) => {
  // 默认重庆市万州区；可通过 ?lat=xx&lon=xx 覆盖
  const lat = parseFloat(req.query.lat) || 30.8050
  const lon = parseFloat(req.query.lon) || 108.3893
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&timezone=Asia%2FShanghai`
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } })
    if (!r.ok) throw new Error(`Open-Meteo 响应 ${r.status}`)
    const data = await r.json()
    res.json(data)
  } catch (e) {
    log.error(`获取天气失败: ${e.message}`)
    res.status(502).json({ error: '获取天气数据失败', detail: e.message })
  }
})

// 显示分辨率自适应配置
// 前端检测屏幕分辨率/DPR 后，依据此配置把驾驶舱按设计基准分辨率等比缩放到当前窗口。
// 后续如需支持 2K/4K/超宽屏，只需在此扩展 presets 或调整 default，无需改前端代码。
// 每个 preset 可携带：scale(缩放系数) / baseWidth+baseHeight(设计画布尺寸) / layout('wide' 加宽栅格) / mode
const DISPLAY_CONFIG = {
  baseWidth: 1920,
  baseHeight: 1080,
  mode: 'fit', // fit=等比缩放铺满(保持比例, 非匹配比例留黑边); stretch=拉伸铺满(可能变形)
  layout: 'default',
  // 按物理屏幕分辨率(宽×高)匹配预设；命中则采用该预设的画布/布局/缩放基准，否则回退 default
  presets: {
    '1920x1080': { scale: 1, note: '标准全高清' },
    '2560x1440': { scale: 1.33, note: '2K' },
    '3840x2160': { scale: 2, note: '4K 超高清' },
    '1366x768': { scale: 0.71, note: '笔记本常见分辨率' },
    '1280x720': { scale: 0.67, note: 'HD' },
    // 超宽屏（21:9 / 32:9）：采用更宽设计画布 + layout:'wide'，尽量铺满、减少黑边
    '3440x1440': { scale: 1.33, baseWidth: 2560, layout: 'wide', note: '21:9 超宽（加宽画布利用横向空间）' },
    '5120x1440': { scale: 1.33, baseWidth: 3840, layout: 'wide', note: '32:9 超宽（加宽画布利用横向空间）' },
    '3840x1080': { scale: 1.0, baseWidth: 3840, layout: 'wide', note: '超宽 1080p（加宽画布）' },
  },
}
app.get('/api/display-config', (req, res) => {
  res.json(DISPLAY_CONFIG)
})

// ── 城运视频平台事件接入（入站，绕过 /api 会话鉴权，改用 IP 白名单 + 令牌预留）──
// 注意：/client/* 不在 /api 前缀下，不会进入上方会话鉴权中间件，故此处自行做来源校验。
function clientIp(req) {
  const xff = req.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  return (req.ip || '').replace(/^::ffff:/, '')
}
function chengyunGuard(req, res, next) {
  const whitelist = (process.env.CHENGYUN_ALLOW_IPS || '127.0.0.1').split(',').map(s => s.trim()).filter(Boolean)
  const ip = clientIp(req)
  if (whitelist.length && !whitelist.includes(ip)) {
    log.warn(`城运入站拒绝(非白名单IP): ${ip}`)
    return res.status(403).json({ code: 403, message: '来源 IP 不在白名单', data: {} })
  }
  const token = process.env.CHENGYUN_CALLBACK_TOKEN
  if (token) {
    const incoming = req.get('X-Callback-Token') || (req.query && req.query.token)
    if (incoming !== token) return res.status(401).json({ code: 401, message: '令牌无效', data: {} })
  }
  next()
}
function parseChengyunBody(req) {
  let b = req.body
  if (typeof b === 'string') { try { b = JSON.parse(b) } catch { b = {} } }
  return b && typeof b === 'object' ? b : {}
}
// 平台调用我方订阅接口推送摄像头识别事件；响应固定 {code:200,message:"请求已成功",data:{}}
app.post('/client/handle_event', chengyunGuard, (req, res) => {
  const ev = parseChengyunBody(req)
  if (!ev.eventId) return res.status(400).json({ code: 400, message: '缺少 eventId', data: {} })
  try {
    const w = store.upsertWarningFromChengyun(ev)
    log.info(`城运入站事件已落库: ${ev.eventId} (aiType=${w && w.aiType}) from ${clientIp(req)}`)
    res.json({ code: 200, message: '请求已成功', data: {} })
  } catch (e) {
    log.error('城运入站事件处理失败: ' + (e && e.stack))
    res.status(500).json({ code: 500, message: '处理失败', data: {} })
  }
})
// 短视频接入：eventIds(可逗号分隔) + fileUrl，把视频关联到对应事件
app.post('/client/handle_event_other', chengyunGuard, (req, res) => {
  const ev = parseChengyunBody(req)
  const ids = Array.isArray(ev.eventIds) ? ev.eventIds : String(ev.eventIds || '').split(',').map(s => s.trim()).filter(Boolean)
  const url = ev.fileUrl
  let updated = 0
  if (url && ids.length) {
    for (const id of ids) { if (store.setWarningVideoUrl(id, url)) updated++ }
  }
  log.info(`城运短视频接入: ${ids.length} 个事件 fileUrl=${url} 更新 ${updated} from ${clientIp(req)}`)
  res.json({ code: 200, message: '请求已成功', data: { updated } })
})

app.listen(PORT, () => {
  log.info(`JSC Media Server 已启动 http://localhost:${PORT}`)
  log.info(`数据库: ${path.join(DATA_DIR, 'jsc.db')}（视频流/点位/数据源/采集/预警等已全部入库）`)
  // 启动视频流在线状态探测（每 60 秒）
  // 关键：传入 updateStreamStatus（按 id 精准更新），探测器不再整表覆盖，根治并发竞态
  streamMonitor.start({
    loadStreams,
    updateStreamStatus: (id, patch) => store.collPatchById('streams', id, patch),
    logger: log, intervalMs: 60000, timeoutMs: 8000,
  })
  // 启动 IoTCloud AI 视频分析拉取（每 30s 轮询，自动写入 warnings 表）
  iotFetcher.start({ store, log, intervalMs: 30000 })

  // 自动启动所有大疆司空 WebRTC 流（持久化：后端重启后自动恢复推流）
  setTimeout(() => {
    const djiStreams = loadStreams().filter(s => s.protocol === 'dji_webrtc' && s.djiWebRTCConfig && !s.offline)
    if (djiStreams.length) {
      log.info(`自动启动 ${djiStreams.length} 路大疆司空 WebRTC 转码...`)
      for (const s of djiStreams) {
        const sid = djiStreamId(s.djiWebRTCConfig)
        if (!sid) continue
        djiBridge.startSession(sid, s.djiWebRTCConfig).catch(e => log.error(`自动启动 dji-bridge 失败 [${sid}]: ${e.message}`))
      }
    }
  }, 5000)

  // 定时清理兜底：每 60 秒扫描所有 offline=true 的 dji_webrtc 流，
  // 若 djiBridge 内存中仍有对应 session（进程仍在跑），则强制停止。
  // 覆盖场景：后端重启后内存丢失但 Python 进程残留、PATCH 事件因异常被跳过等。
  setInterval(() => {
    const activeSessions = djiBridge.getStatus().sessions
    if (!activeSessions.length) return
    const offlineDjiStreams = loadStreams().filter(s =>
      s.protocol === 'dji_webrtc' && s.djiWebRTCConfig && s.offline)
    for (const s of offlineDjiStreams) {
      const sid = djiStreamId(s.djiWebRTCConfig)
      if (!sid) continue
      if (activeSessions.some(sess => sess.streamId === sid)) {
        log.info(`定时清理：停止离线流残留推流进程 [${sid}]`)
        djiBridge.stopSession(sid).catch(e =>
          log.warn(`定时清理停流失败 [${sid}]: ${e.message}`))
      }
    }
  }, 60000)
})
