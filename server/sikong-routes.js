'use strict'
/**
 * 司空2 预设航线读取模块（不装第三方包，spawn docker exec mysql + spawn unzip）
 * 数据链：
 *   司空2 MySQL system_route（航线清单）
 *     → 下载每条航线 KMZ（https 5443，自签名忽略）
 *     → spawn unzip 解压 → 解析 template.kml 的 <coordinates> 得航点经纬度
 *     → 内存缓存（航线不常变，启动加载一次 + 定时刷新）
 * 隔离红线：只读司空2 MySQL（docker exec mysql，不写入/不改表/不锁表），不装第三方包。
 */
const { spawn } = require('child_process')
const https = require('https')
const fs = require('fs')
const path = require('path')
const os = require('os')

const log = {
  info: (...a) => console.log('[sikong-routes]', ...a),
  warn: (...a) => console.warn('[sikong-routes]', ...a),
  error: (...a) => console.error('[sikong-routes]', ...a),
}

// 4 个白名单机场 dockSn
const DOCKS = ['8UUXN7G00A0FDP', '8UUXN8N00A0LS7', '8UUXN8P00A0LZ4', '8UUXN5500A07D1']
const MYSQL_PWD = 'Mysql@xka666.'
const MYSQL_DB = 'v3_private_test'
const KMZ_CACHE_DIR = path.join(os.tmpdir(), 'jsc_routes_kmz')

// 内存缓存
let _cache = { ts: 0, routes: [] }
const REFRESH_MS = Number(process.env.ROUTES_REFRESH_MS) || 30 * 60 * 1000  // 30 分钟刷新

/** spawn 执行命令，收集 stdout */
function sh(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => { try { p.kill() } catch { } ; reject(new Error('超时')) }, timeoutMs)
    p.stdout.on('data', d => { out += d.toString() })
    p.stderr.on('data', d => { err += d.toString() })
    p.on('error', e => { clearTimeout(timer); reject(e) })
    p.on('close', code => { clearTimeout(timer); resolve({ code, out, err }) })
  })
}

/** 从司空2 MySQL 读航线清单（sudo wrapper 查询，jsc 用户最小权限，不装包不依赖 docker 组） */
async function readRoutesFromMysql() {
  const dockList = DOCKS.map(d => `'${d}'`).join(',')
  const sql = `SELECT id, route_name, dock_sn, way_point_count, distance, route_url FROM ${MYSQL_DB}.system_route WHERE deleted=0 AND dock_sn IN (${dockList}) ORDER BY dock_sn, id;`
  // jsc 用户无 docker 权限，用 sudo wrapper（/usr/local/bin/jsc-routes-query.sh，sudoers 授权只读查询）
  const r = await sh('sudo', ['-n', '/usr/local/bin/jsc-routes-query.sh', sql])
  if (r.code !== 0) throw new Error('mysql 查询失败: ' + (r.err || r.out).slice(0, 200))
  const lines = r.out.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length < 2) return []
  // 首行表头：id route_name dock_sn way_point_count distance route_url
  const routes = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t')
    if (cols.length < 6) continue
    routes.push({
      id: cols[0],
      routeName: cols[1],
      dockSn: cols[2],
      wayPointCount: Number(cols[3]) || 0,
      distance: Number(cols[4]) || 0,
      routeUrl: cols[5],
    })
  }
  return routes
}

/** 下载 KMZ 文件（https，自签名忽略）到本地缓存 */
function downloadKmz(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath)
    const req = https.get(url, { rejectUnauthorized: false, timeout: 20000 }, (res) => {
      if (res.statusCode !== 200) { file.close(); try { fs.unlinkSync(destPath) } catch { } ; return reject(new Error('HTTP ' + res.statusCode)) }
      res.pipe(file)
      file.on('finish', () => { file.close(); resolve(destPath) })
    })
    req.on('error', (e) => { file.close(); try { fs.unlinkSync(destPath) } catch { } ; reject(e) })
    req.on('timeout', () => { req.destroy(); file.close(); try { fs.unlinkSync(destPath) } catch { } ; reject(new Error('下载超时')) })
  })
}

/** 解析 KMZ 得航点经纬度（spawn unzip 解压 template.kml，正则解析 <coordinates>） */
async function parseKmzWaypoints(kmzPath) {
  // KMZ 内可能是 template.kml 或 waylines.wpml
  let kml = ''
  for (const entry of ['wpmz/template.kml', 'template.kml', 'wpmz/waylines.wpml', 'waylines.wpml']) {
    try {
      const r = await sh('unzip', ['-p', kmzPath, entry], 8000)
      if (r.code === 0 && r.out && r.out.includes('<')) { kml = r.out; break }
    } catch (e) { }
  }
  if (!kml) return []
  // 解析 <coordinates>lon,lat,alt ...</coordinates>（可能多个点空格分隔）
  const coords = []
  const re = /<coordinates>\s*([0-9.,\s\-]+)\s*<\/coordinates>/g
  let m
  while ((m = re.exec(kml)) !== null) {
    const body = m[1].trim()
    for (const pt of body.split(/\s+/)) {
      const parts = pt.split(',')
      if (parts.length >= 2) {
        const lon = parseFloat(parts[0])
        const lat = parseFloat(parts[1])
        if (!isNaN(lon) && !isNaN(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
          coords.push([lat, lon])
        }
      }
    }
  }
  return coords
}

/** 加载全部航线（MySQL 清单 + 每条 KMZ 解析航点），更新缓存 */
async function loadRoutes() {
  const list = await readRoutesFromMysql()
  log.info(`MySQL 读到 ${list.length} 条预设航线`)
  if (!fs.existsSync(KMZ_CACHE_DIR)) fs.mkdirSync(KMZ_CACHE_DIR, { recursive: true })
  const routes = []
  for (const r of list) {
    let waypoints = []
    if (r.routeUrl) {
      const kmzPath = path.join(KMZ_CACHE_DIR, `${r.id}.kmz`)
      try {
        // 已缓存的 KMZ 不重复下载（航线文件不可变）
        if (!fs.existsSync(kmzPath)) await downloadKmz(r.routeUrl, kmzPath)
        waypoints = await parseKmzWaypoints(kmzPath)
      } catch (e) {
        log.warn(`航线 ${r.routeName} KMZ 下载/解析失败: ${e.message}`)
      }
    }
    routes.push({
      id: r.id,
      routeName: r.routeName,
      dockSn: r.dockSn,
      wayPointCount: r.wayPointCount,
      distance: r.distance,
      points: waypoints,   // [[lat,lon],...]
      pointCount: waypoints.length,
    })
  }
  _cache = { ts: Date.now(), routes }
  log.info(`航线缓存已更新：${routes.length} 条，含航点 ${routes.reduce((s, r) => s + r.pointCount, 0)} 个`)
  return _cache
}

/** 获取航线（带缓存，过期自动刷新） */
async function getRoutes() {
  if (Date.now() - _cache.ts > REFRESH_MS || _cache.routes.length === 0) {
    try { await loadRoutes() } catch (e) { log.error('航线加载失败: ' + e.message) }
  }
  return _cache
}

/** 注册路由 */
function register(app) {
  // 预设航线列表（大地图叠加数据源，只读缓存）
  app.get('/api/sikong/routes', async (req, res) => {
    try {
      const dockSn = String(req.query.dockSn || '')
      const cache = await getRoutes()
      let routes = cache.routes
      if (dockSn) routes = routes.filter(r => r.dockSn === dockSn)
      res.json({ ok: true, count: routes.length, syncedAt: cache.ts, routes })
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message })
    }
  })

  // 手动刷新航线缓存（adminOnly 可选，航线变更后强制重载）
  app.post('/api/sikong/routes/refresh', async (req, res) => {
    try {
      const cache = await loadRoutes()
      res.json({ ok: true, count: cache.routes.length, syncedAt: cache.ts })
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message })
    }
  })

  // 启动时预加载（异步，不阻塞启动）
  setImmediate(() => { loadRoutes().catch(e => log.error('启动预加载航线失败: ' + e.message)) })
  // 定时刷新
  setInterval(() => { loadRoutes().catch(e => log.error('定时刷新航线失败: ' + e.message)) }, REFRESH_MS)
  log.info('预设航线模块已启动（MySQL spawn + KMZ spawn unzip，30min 刷新）')
}

module.exports = { register, getRoutes, loadRoutes }
