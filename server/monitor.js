/**
 * 服务器监控模块 - 驾驶舱（多主机版 v2，2026-10-05）
 *
 * 相对 v1 的变更
 *  - 从「只监控本机」升级为「多主机」：本机(12) + 算法主节点(11)
 *  - 11 机数据经 HTTP 从其只读 agent 拉取（http://172.16.8.11:7101/metrics）
 *    —— 12→11 的 22 端口不通、jsc 用户无 SSH 权限，故只能走 HTTP
 *  - 磁盘细化：全部真实挂载点 + 设备名 + fsType + inode + 读写速率 + TOP 目录占用
 *  - 新增 GPU：利用率/显存/温度/功耗/时钟/风扇/pstate + 进程明细
 *  - 采集周期 30s（供前端轮询），告警检查仍 5min
 *  - getState() 保持向后兼容（顶层字段仍指向本机），另加 hosts[]
 *
 * 时间：一律上海时（铁律 4）；对外时间戳用 UTC epoch，前端 +8h 渲染。
 */
const os = require('os')
const fs = require('fs')
const http = require('http')
const path = require('path')
const { exec, execSync } = require('child_process')

let nodemailer = null
try { nodemailer = require('nodemailer') } catch { console.warn('[monitor] nodemailer 未安装，邮件告警已禁用') }

// ========== 配置 ==========
const COLLECT_INTERVAL_MS = 30 * 1000        // 指标采集：30s（前端轮询用）
const CHECK_INTERVAL_MS = 5 * 60 * 1000      // 告警检查：5min
const COOLDOWN_MS = 30 * 60 * 1000           // 同一问题 30min 内不重复发
const REMOTE_TIMEOUT_MS = 8000               // 远端 agent 拉取超时

const MONITOR_DIR = __dirname
const ALERT_LOG = path.join(MONITOR_DIR, 'monitor_alerts.json')
const MONITOR_STATE = path.join(MONITOR_DIR, 'monitor_state.json')

/** 被监控主机。local:true 表示本机（12 机），其余走 HTTP agent。 */
const HOSTS = [
  { id: 'h12', name: '驾驶舱主机', role: 'Web / 后端 / 数据库', local: true },
  { id: 'h11', name: '11 机 · 算法主节点', role: '算法 / TASK / GPU', url: 'http://172.16.8.11:7101/metrics' },
]

/** 本机要盯的服务与端口（12 机） */
const SERVICES = ['jsc-backend', 'straw-engine', 'nginx', 'docker', 'skymonitor-backend', 'tielu-server']
const PORTS = [80, 81, 7170, 7200, 6080, 8080, 8899, 4000]

/** 本机 du 白名单：[路径, max-depth]。绝不遍历 /。 */
const DU_TARGETS = [
  ['/data', 1],
  ['/var/log', 0],
]
const DU_INTERVAL_MS = 10 * 60 * 1000
const DU_TIMEOUT_MS = 240 * 1000

const DISK_WARN = 85
const DISK_CRIT = 95
const DISK_SKIP_FS = new Set(['tmpfs', 'devtmpfs', 'overlay', 'squashfs', 'proc', 'sysfs',
  'cgroup', 'cgroup2', 'autofs', 'ramfs', 'debugfs', 'tracefs', 'mqueue', 'bpf',
  'pstore', 'securityfs', 'fusectl', 'configfs', 'hugetlbfs', 'nsfs'])

// ========== 工具 ==========
function sh(cmd, timeout = 8000) {
  return new Promise(resolve => {
    exec(cmd, { timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      resolve(stdout || '')
    })
  })
}
function safeExec(cmd, timeout = 8000) {
  try { return execSync(cmd, { timeout, encoding: 'utf8' }) } catch (e) { return e.stdout || '' }
}
function human(b) {
  if (b == null || isNaN(b)) return '-'
  const g = b / 1024 ** 3
  if (g >= 1024) return (g / 1024).toFixed(2) + ' T'
  if (g >= 1) return g.toFixed(1) + ' G'
  return (b / 1024 ** 2).toFixed(0) + ' M'
}
function fetchJson(url, timeout = REMOTE_TIMEOUT_MS) {
  return new Promise(resolve => {
    const t0 = Date.now()
    let done = false
    const fin = (o) => { if (!done) { done = true; resolve(Object.assign({ latencyMs: Date.now() - t0 }, o)) } }
    let req
    try {
      req = http.get(url, { timeout }, res => {
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', d => { buf += d; if (buf.length > 4 * 1024 * 1024) { req.destroy(); fin({ ok: false, error: 'response too large' }) } })
        res.on('end', () => {
          if (res.statusCode !== 200) return fin({ ok: false, error: 'HTTP ' + res.statusCode })
          try { fin(Object.assign(JSON.parse(buf), { ok: true })) }
          catch (e) { fin({ ok: false, error: 'JSON 解析失败: ' + e.message }) }
        })
      })
    } catch (e) { return fin({ ok: false, error: e.message }) }
    req.on('timeout', () => { req.destroy(); fin({ ok: false, error: `超时(${timeout}ms)` }) })
    req.on('error', e => fin({ ok: false, error: e.message }))
  })
}

// ========== 本机采集：CPU / 内存 / 负载 ==========
let _prevCpu = null
function readCpuLocal() {
  const cpus = os.cpus()
  const snap = cpus.reduce((a, c) => {
    const t = c.times
    a.idle += t.idle
    a.total += t.user + t.nice + t.sys + t.idle + t.irq
    return a
  }, { idle: 0, total: 0 })
  let usage = null
  if (_prevCpu) {
    const dt = snap.total - _prevCpu.total
    const di = snap.idle - _prevCpu.idle
    if (dt > 0) usage = Math.round((1 - di / dt) * 1000) / 10
  }
  _prevCpu = snap
  return { model: cpus[0] ? cpus[0].model : '', cores: cpus.length, usage }
}
function readMemLocal() {
  const total = os.totalmem()
  const free = os.freemem()
  const used = total - free
  let swapTotal = 0, swapFree = 0
  try {
    const mi = fs.readFileSync('/proc/meminfo', 'utf8')
    const g = (k) => { const m = mi.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm')); return m ? Number(m[1]) * 1024 : 0 }
    swapTotal = g('SwapTotal'); swapFree = g('SwapFree')
  } catch {}
  return {
    total, used, avail: free,
    percent: Math.round(used / total * 1000) / 10,
    swap_total: swapTotal, swap_used: Math.max(0, swapTotal - swapFree),
    swap_percent: swapTotal ? Math.round((swapTotal - swapFree) / swapTotal * 1000) / 10 : 0,
  }
}

// ========== 本机采集：磁盘（细化） ==========
let _prevIo = null
function parseDiskstats(txt) {
  const out = {}
  for (const line of txt.split('\n')) {
    const p = line.trim().split(/\s+/)
    if (p.length < 14) continue
    const name = p[2]
    if (!/^(sd[a-z]+\d*|nvme\d+n\d+(p\d+)?|vd[a-z]+\d*|hd[a-z]+\d*)$/.test(name)) continue
    out[name] = { rb: +p[5], rs: +p[3], wb: +p[9], ws: +p[7] }
  }
  return out
}
async function readDisksLocal() {
  const [dfT, dfB, dfI, ds] = await Promise.all([
    sh('df -T -P'), sh('df -P -B1'), sh('df -i -P'),
    fs.promises.readFile('/proc/diskstats', 'utf8').catch(() => ''),
  ])
  const fsType = {}
  for (const line of dfT.split('\n').slice(1)) {
    const p = line.split(/\s+/)
    if (p.length >= 7) fsType[p[0]] = p[1]
  }
  const inode = {}
  for (const line of dfI.split('\n').slice(1)) {
    const p = line.split(/\s+/)
    if (p.length >= 6) {
      const ipct = parseInt(String(p[4]).replace('%', ''), 10)
      if (!isNaN(ipct)) inode[p[0]] = { iused: +p[2], ifree: +p[3], ipct }
    }
  }
  const cur = parseDiskstats(ds)
  const now = Date.now()
  const io = {}
  if (_prevIo) {
    const dt = Math.max((now - _prevIo.t) / 1000, 0.001)
    for (const [name, c] of Object.entries(cur)) {
      const p = _prevIo.data[name]
      if (!p) continue
      io[name] = {
        read_mbps: Math.round(Math.max(0, c.rb - p.rb) * 512 / dt / 1048576 * 1000) / 1000,
        write_mbps: Math.round(Math.max(0, c.wb - p.wb) * 512 / dt / 1048576 * 1000) / 1000,
        read_iops: Math.round(Math.max(0, c.rs - p.rs) / dt * 10) / 10,
        write_iops: Math.round(Math.max(0, c.ws - p.ws) / dt * 10) / 10,
      }
    }
  }
  _prevIo = { t: now, data: cur }

  const disks = []
  for (const line of dfB.split('\n').slice(1)) {
    const p = line.split(/\s+/)
    if (p.length < 6) continue
    const [dev, size, used, avail, pct, mount] = p
    const fst = fsType[dev] || ''
    if (DISK_SKIP_FS.has(fst)) continue
    const sizeI = +size, usedI = +used, availI = +avail, pctI = parseInt(String(pct).replace('%', ''), 10)
    if (!sizeI || isNaN(pctI)) continue
    const base = dev.split('/').pop()
    let dio = io[base]
    if (!dio) { const m = base.match(/^(nvme\d+n\d+|sd[a-z]+|vd[a-z]+)/); if (m) dio = io[m[1]] }
    disks.push({
      mount, device: dev, fsType: fst,
      size: sizeI, used: usedI, avail: availI, pct: pctI,
      sizeText: human(sizeI), usedText: human(usedI), availText: human(availI),
      inode: inode[dev] || {}, io: dio || {},
    })
  }
  disks.sort((a, b) => a.mount.localeCompare(b.mount))
  return disks
}

// ========== 本机采集：GPU ==========
async function readGpuLocal() {
  const q = 'index,name,driver_version,utilization.gpu,utilization.memory,memory.total,memory.used,' +
    'memory.free,temperature.gpu,temperature.memory,power.draw,power.limit,power.max_limit,' +
    'clocks.current.sm,clocks.max.sm,clocks.current.memory,fan.speed,pstate'
  const raw = await sh(`nvidia-smi --query-gpu=${q} --format=csv,noheader,nounits`, 12000)
  if (!raw.trim()) return { available: false, gpus: [], processes: [], error: 'nvidia-smi 无输出' }
  const num = (x) => { const v = parseFloat(x); return isNaN(v) ? null : v }
  const gpus = []
  for (const line of raw.trim().split('\n')) {
    const c = line.split(',').map(s => s.trim())
    if (c.length < 18) continue
    const mt = num(c[5]), mu = num(c[6])
    gpus.push({
      index: num(c[0]) || 0, name: c[1], driver: c[2],
      util: num(c[3]), memUtil: num(c[4]),
      memTotalMB: mt, memUsedMB: mu, memFreeMB: num(c[7]),
      memPercent: (mt && mu != null) ? Math.round(mu / mt * 1000) / 10 : null,
      tempC: num(c[8]), tempMemC: num(c[9]),
      powerW: num(c[10]), powerLimitW: num(c[11]), powerMaxW: num(c[12]),
      clockSM: num(c[13]), clockMaxSM: num(c[14]), clockMem: num(c[15]),
      fanPercent: num(c[16]), pstate: c[17], processes: [],
    })
  }
  const pRaw = await sh('nvidia-smi --query-compute-apps=pid,process_name,used_gpu_memory --format=csv,noheader,nounits', 12000)
  const processes = []
  for (const line of pRaw.trim().split('\n')) {
    const c = line.split(',').map(s => s.trim())
    if (c.length < 3) continue
    processes.push({ pid: c[0], name: c[1], memMB: num(c[2]) })
  }
  if (gpus.length) gpus[0].processes = processes
  return { available: true, gpus, processes }
}

// ========== 本机 du（后台、缓存、渐进发布） ==========
let _du = { ts: 0, running: false, data: [] }
let _duRunning = false
async function duOnce() {
  const results = []
  for (const [p, depth] of DU_TARGETS) {
    try { await fs.promises.access(p) } catch { continue }
    const t0 = Date.now()
    const out = await sh(`du -B1 --max-depth=${depth} ${p}`, DU_TIMEOUT_MS)
    const items = []
    for (const line of out.split('\n')) {
      const parts = line.split('\t')
      if (parts.length !== 2) continue
      const sz = parseInt(parts[0], 10)
      if (isNaN(sz)) continue
      items.push({ path: parts[1], bytes: sz })
    }
    items.sort((a, b) => b.bytes - a.bytes)
    results.push({ path: p, depth, elapsed_s: Math.round((Date.now() - t0) / 100) / 10, items: items.slice(0, 12) })
    _du.data = results.slice()
  }
  return results
}

// ========== 本机整体采集 ==========
let _prevUptime = null
async function collectLocal(host) {
  const t0 = Date.now()
  const uptime = os.uptime()
  const [disks, gpu] = await Promise.all([readDisksLocal(), readGpuLocal()])

  const services = []
  for (const s of SERVICES) {
    const st = (await sh(`systemctl is-active ${s}`, 5000)).trim()
    services.push({ name: s, status: st === 'active' ? 'running' : (st || 'unknown'), running: st === 'active' })
  }
  const ssOut = await sh('ss -ltn', 6000)
  const listening = new Set()
  for (const line of ssOut.split('\n').slice(1)) {
    const p = line.trim().split(/\s+/)
    if (p.length >= 4) { const m = p[3].match(/:(\d+)$/); if (m) listening.add(+m[1]) }
  }
  const ports = PORTS.map(p => ({ port: p, status: listening.has(p) ? 'open' : 'closed', listening: listening.has(p) }))

  // CPU 使用率靠两次快照求差：首次调用没有基线，短暂等待后再采一次（否则前端首屏恒为 N/A）
  let cpu = readCpuLocal()
  if (cpu.usage == null) {
    await new Promise(r => setTimeout(r, 700))
    cpu = readCpuLocal()
  }

  const load = os.loadavg()
  let ips = []
  try {
    const ifs = os.networkInterfaces()
    for (const arr of Object.values(ifs)) for (const a of arr || []) if (a.family === 'IPv4' && !a.internal) ips.push(a.address)
  } catch {}

  const state = {
    id: host.id, name: host.name, role: host.role, local: true, ok: true,
    hostname: os.hostname(),
    ips,
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    ts: Date.now() / 1000,
    cpu,
    memory: readMemLocal(),
    load: { load1: +load[0].toFixed(2), load5: +load[1].toFixed(2), load15: +load[2].toFixed(2) },
    uptime,
    disks,
    diskTop: { ts: _du.ts, running: _du.running, data: _du.data },
    gpu,
    services,
    ports,
    latencyMs: Date.now() - t0,
  }
  _prevUptime = uptime
  return state
}

// ========== 远端采集 ==========
async function collectRemote(host) {
  const d = await fetchJson(host.url)
  if (!d.ok) {
    return { id: host.id, name: host.name, role: host.role, local: false, ok: false, error: d.error, latencyMs: d.latencyMs, disks: [], gpu: { available: false, gpus: [] }, services: [], ports: [] }
  }
  d.local = false
  d.role = host.role
  d.name = host.name || d.name || d.hostname    // 展示名以本机 HOSTS 配置为准（agent 只报 hostname）
  if (d.ts && d.ts > 1e12) d.ts = d.ts / 1000        // 兼容毫秒
  // 远端 agent 只给字节，这里补人类可读文本，前端统一渲染
  for (const x of d.disks || []) {
    x.sizeText = human(x.size); x.usedText = human(x.used); x.availText = human(x.avail)
  }
  return d
}

// ========== 采集循环与缓存 ==========
let cache = { ts: 0, hosts: [], errors: [] }
let collecting = false

async function collectCycle() {
  if (collecting) return
  collecting = true
  try {
    const hosts = await Promise.all(HOSTS.map(h => (h.local ? collectLocal(h) : collectRemote(h))))
    cache = { ts: Date.now(), hosts }
  } catch (e) {
    console.error('[monitor] 采集异常:', e.message)
  } finally {
    collecting = false
  }
}

// ========== 异常检测（多机） ==========
function checkHostAlerts(h) {
  const alerts = []
  const tag = `${h.name}(${h.id})`
  if (!h.ok) {
    alerts.push({ level: 'critical', key: `host-${h.id}`, msg: `主机 ${tag} 指标不可达: ${h.error || '未知错误'}` })
    return alerts
  }
  for (const d of h.disks || []) {
    if (d.pct >= DISK_CRIT) alerts.push({ level: 'critical', key: `${h.id}-disk-${d.mount}`, msg: `${tag} 磁盘 ${d.mount} 使用率 ${d.pct}%（严重）: 可用 ${d.availText || human(d.avail)}` })
    else if (d.pct >= DISK_WARN) alerts.push({ level: 'warning', key: `${h.id}-disk-${d.mount}`, msg: `${tag} 磁盘 ${d.mount} 使用率 ${d.pct}%（警告）: 可用 ${d.availText || human(d.avail)}` })
    const ipct = d.inode && d.inode.ipct
    if (ipct >= DISK_CRIT) alerts.push({ level: 'critical', key: `${h.id}-inode-${d.mount}`, msg: `${tag} 磁盘 ${d.mount} inode 使用率 ${ipct}%（严重）` })
    else if (ipct >= DISK_WARN) alerts.push({ level: 'warning', key: `${h.id}-inode-${d.mount}`, msg: `${tag} 磁盘 ${d.mount} inode 使用率 ${ipct}%（警告）` })
  }
  const mem = h.memory || {}
  if (mem.percent >= 90) alerts.push({ level: 'critical', key: `${h.id}-memory`, msg: `${tag} 内存使用率 ${mem.percent}%（严重）` })
  else if (mem.percent >= 85) alerts.push({ level: 'warning', key: `${h.id}-memory`, msg: `${tag} 内存使用率 ${mem.percent}%（警告）` })
  const cpu = h.cpu || {}
  if (cpu.usage != null && cpu.usage >= 90) alerts.push({ level: 'warning', key: `${h.id}-cpu`, msg: `${tag} CPU 使用率 ${cpu.usage}%（警告）` })
  const cores = cpu.cores || 1
  if (h.load && h.load.load5 > cores * 1.5) alerts.push({ level: 'warning', key: `${h.id}-load`, msg: `${tag} 负载偏高 load5=${h.load.load5}（核数 ${cores}）` })
  for (const s of h.services || []) {
    if (s.running === false || s.status !== 'running') alerts.push({ level: 'critical', key: `${h.id}-svc-${s.name}`, msg: `${tag} 服务 ${s.name} 状态异常: ${s.status}` })
  }
  for (const p of h.ports || []) {
    if (p.listening === false || p.status !== 'open') alerts.push({ level: 'critical', key: `${h.id}-port-${p.port}`, msg: `${tag} 端口 ${p.port} 未监听` })
  }
  for (const g of (h.gpu && h.gpu.gpus) || []) {
    if (g.tempC != null && g.tempC >= 90) alerts.push({ level: 'critical', key: `${h.id}-gpu${g.index}-temp`, msg: `${tag} GPU${g.index} 温度 ${g.tempC}°C（严重）` })
    else if (g.tempC != null && g.tempC >= 85) alerts.push({ level: 'warning', key: `${h.id}-gpu${g.index}-temp`, msg: `${tag} GPU${g.index} 温度 ${g.tempC}°C（警告）` })
    if (g.memPercent != null && g.memPercent >= 90) alerts.push({ level: 'warning', key: `${h.id}-gpu${g.index}-mem`, msg: `${tag} GPU${g.index} 显存 ${g.memPercent}%（${g.memUsedMB}/${g.memTotalMB} MB）` })
  }
  return alerts
}

function checkAlerts(hosts) {
  const list = Array.isArray(hosts) ? hosts : (hosts ? [hosts] : [])
  return list.reduce((acc, h) => acc.concat(checkHostAlerts(h)), [])
}

// ========== 邮件 ==========
function loadMailConfig() {
  const envPath = path.join(MONITOR_DIR, 'monitor.env')
  const env = {}
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/)
      if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
    }
  }
  return {
    smtpHost: process.env.MAIL_SMTP_HOST || env.MAIL_SMTP_HOST || 'smtp.qq.com',
    smtpPort: Number(process.env.MAIL_SMTP_PORT || env.MAIL_SMTP_PORT || 465),
    mailUser: process.env.MAIL_USER || env.MAIL_USER || '2511925689@qq.com',
    mailPass: process.env.MAIL_PASS || env.MAIL_PASS || '',
    mailTo: process.env.MAIL_TO || env.MAIL_TO || '2511925689@qq.com',
  }
}
let lastAlerts = {}
function loadAlerts() {
  try { if (fs.existsSync(ALERT_LOG)) return JSON.parse(fs.readFileSync(ALERT_LOG, 'utf8')) } catch {}
  return []
}
function saveAlerts(alerts) {
  try { fs.writeFileSync(ALERT_LOG, JSON.stringify(alerts.slice(-200), null, 2)) } catch {}
}
async function sendMail(subject, text) {
  if (!nodemailer) { console.error('[monitor] nodemailer 未安装，无法发送邮件'); return false }
  const cfg = loadMailConfig()
  if (!cfg.mailPass) { console.error('[monitor] 未配置 SMTP 授权码'); return false }
  try {
    const transporter = nodemailer.createTransport({
      host: cfg.smtpHost, port: cfg.smtpPort, secure: true,
      auth: { user: cfg.mailUser, pass: cfg.mailPass },
      tls: { rejectUnauthorized: false },
    })
    await transporter.sendMail({ from: `"驾驶舱服务器监控" <${cfg.mailUser}>`, to: cfg.mailTo, subject, text })
    console.log(`[monitor] 邮件已发送: ${subject}`)
    return true
  } catch (e) {
    console.error('[monitor] 邮件发送失败:', e.message)
    return false
  }
}

// ========== 告警循环（5min） ==========
function shanghaiNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  return d.toISOString().replace('T', ' ').slice(0, 19)
}
async function runCheck(forceEmail = false) {
  try {
    if (!cache.hosts.length) await collectCycle()
    const hosts = cache.hosts
    const alerts = checkAlerts(hosts)
    const now = Date.now()
    const toSend = alerts.filter(a => {
      const last = lastAlerts[a.key]
      if (forceEmail || !last || now - last > COOLDOWN_MS) { lastAlerts[a.key] = now; return true }
      return false
    })
    if (toSend.length > 0) {
      const title = toSend.some(a => a.level === 'critical') ? '【严重】' : '【警告】'
      const body = hosts.map(h => {
        if (!h.ok) return `${h.name}(${h.id}): 不可达 - ${h.error}`
        const g = (h.gpu && h.gpu.gpus || []).map(x => `GPU${x.index} ${x.name}: ${x.util}% / 显存 ${x.memPercent}% / ${x.tempC}°C`).join('\n')
        return `${h.name}(${h.id}) ${h.hostname}\n` +
          `  CPU ${h.cpu && h.cpu.usage != null ? h.cpu.usage + '%' : 'N/A'} (${(h.cpu || {}).cores || '?'}核)  内存 ${(h.memory || {}).percent}%  load5 ${(h.load || {}).load5}\n` +
          (h.disks || []).map(d => `  磁盘 ${d.mount}: ${d.pct}% (可用 ${d.availText || human(d.avail)})`).join('\n') +
          (g ? '\n  ' + g : '')
      }).join('\n\n')
      const text = `服务器监控告警\n时间: ${shanghaiNow()} (上海时)\n\n` +
        toSend.map(a => `[${a.level.toUpperCase()}] ${a.msg}`).join('\n') +
        `\n\n---- 完整状态 ----\n${body}`
      const sent = await sendMail(title + ' ' + toSend[0].msg.slice(0, 60), text)
      if (sent) {
        const log = loadAlerts()
        log.push({ time: new Date().toISOString(), count: toSend.length, alerts: toSend, sent: true })
        saveAlerts(log)
      }
    }
    try {
      fs.writeFileSync(MONITOR_STATE, JSON.stringify({
        ts: new Date().toISOString(),
        hosts: hosts.map(h => ({
          id: h.id, name: h.name, ok: h.ok, hostname: h.hostname,
          cpu: (h.cpu || {}).usage, mem: (h.memory || {}).percent,
          disks: (h.disks || []).map(d => ({ mount: d.mount, pct: d.pct })),
          gpu: (h.gpu && h.gpu.gpus || []).map(x => ({ i: x.index, util: x.util, mem: x.memPercent, temp: x.tempC })),
        })),
        alertCount: alerts.length,
      }, null, 2))
    } catch {}
  } catch (e) {
    console.error('[monitor] 检查异常:', e.message)
  }
}

// ========== 对外状态（向后兼容 + 多机） ==========
function getState() {
  const hosts = cache.hosts || []
  const local = hosts.find(h => h.local) || null
  const base = local || {}
  return Object.assign({}, base, {
    multi: true,
    hosts,
    lastCollectTs: cache.ts,
    alertCount: checkAlerts(hosts).length,
  })
}

// ========== 启动 ==========
let _duTimer = null
function startDuLoop() {
  const tick = async () => {
    if (_du.running) return
    _du.running = true
    try {
      const data = await duOnce()
      _du.ts = Date.now()
      _du.data = data
    } catch (e) {
      console.error('[monitor] du 异常:', e.message)
    } finally {
      _du.running = false
    }
  }
  setTimeout(tick, 8000)                       // 服务先起来再跑重的 du
  _duTimer = setInterval(tick, DU_INTERVAL_MS)
}

function startMonitor() {
  console.log('[monitor] 服务器监控(多机)已启动：采集 30s / 告警 5min / 主机=' + HOSTS.map(h => h.id).join(','))
  startDuLoop()
  collectCycle().then(() => runCheck())
  setInterval(collectCycle, COLLECT_INTERVAL_MS)
  setInterval(runCheck, CHECK_INTERVAL_MS)
}

/**
 * 🔒 未登录调用方可见的**最小健康摘要**。
 *
 * 背景：`/api/monitor/status` 在 index.js 的 PREFIX_PATHS 白名单里（历史原因：早期
 * 是一个不含敏感信息的单机健康页）。多机化之后载荷里带上了**内网目录树（diskTop）、
 * GPU 占用进程名/pid、服务与端口清单**——这些属于对内网攻击者很有价值的侦察信息，
 * 而该端点对外网 81 端口开放且**不需要任何凭证**。
 *
 * 因此：已登录（中间件挂了 req.user）⇒ 全量；未登录 ⇒ 只给「主机活着吗 + 资源水位」，
 * 既保住任何既有的免密保活探测，又不再泄露内部结构。
 */
function getPublicState() {
  const hosts = (cache.hosts || []).map(h => {
    const g = h.gpu || {}
    return {
      id: h.id, name: h.name, role: h.role, ok: h.ok, error: h.error,
      hostname: h.hostname, ts: h.ts, latencyMs: h.latencyMs,
      cpu: h.cpu ? { model: h.cpu.model, cores: h.cpu.cores, usage: h.cpu.usage } : undefined,
      memory: h.memory, load: h.load, uptime: h.uptime,
      // 只留水位，不留 device / fsType / inode / 实时 IO
      disks: (h.disks || []).map(d => ({
        mount: d.mount, pct: d.pct, sizeText: d.sizeText, usedText: d.usedText, availText: d.availText,
      })),
      // 只留卡的利用率，不留进程列表
      gpu: { available: g.available, error: g.error,
        gpus: (g.gpus || []).map(x => ({ index: x.index, name: x.name, util: x.util, memPercent: x.memPercent, tempC: x.tempC })) },
      // 明确不给：diskTop / gpu.processes / services / ports / ips
    }
  })
  return { multi: true, hosts, lastCollectTs: cache.ts, limited: true }
}

module.exports = {
  startMonitor, runCheck, getState, getPublicState, loadAlerts, sendMail,
  collectSystem: () => getState(),
  collectCycle, checkAlerts, HOSTS,
}
