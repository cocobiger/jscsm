/**
 * 服务器监控模块 - 驾驶舱
 * 定时采集服务器状态，异常时发送邮件告警
 *
 * 功能：
 *  1. 采集系统指标（CPU/内存/磁盘/负载）
 *  2. 检查关键服务与端口
 *  3. 异常时通过 QQ 邮箱 SMTP 发邮件
 *  4. 提供 /api/monitor/status 接口给前端展示
 */
const os = require('os')
const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
// nodemailer 可选加载：未安装时仅监控不发邮件（避免服务因缺依赖起不来）
let nodemailer = null
try { nodemailer = require('nodemailer') } catch { console.warn('[monitor] nodemailer 未安装，邮件告警已禁用') }

// ========== 配置 ==========
const CHECK_INTERVAL_MS = 5 * 60 * 1000   // 每 5 分钟检查一次
const COOLDOWN_MS = 30 * 60 * 1000        // 同一问题 30 分钟内不重复发

const MONITOR_DIR = __dirname
const ALERT_LOG = path.join(MONITOR_DIR, 'monitor_alerts.json')
const MONITOR_STATE = path.join(MONITOR_DIR, 'monitor_state.json')

// SMTP 配置（授权码从环境变量或配置文件读取，不入 git）
function loadMailConfig() {
  // 优先 .env 同级目录
  const envPath = path.join(MONITOR_DIR, 'monitor.env')
  const env = {}
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8')
    for (const line of content.split('\n')) {
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

// ========== 关键监控项配置 ==========
const SERVICES = ['jsc-backend', 'straw-engine', 'nginx', 'docker', 'skymonitor-backend', 'tielu-server']
const PORTS = [80, 81, 7170, 7200, 6080, 8080, 8899, 4000]
const DISK_THRESHOLDS = [{ mount: '/', warn: 85, crit: 95 }, { mount: '/video', warn: 85, crit: 95 }]

// ========== 状态管理 ==========
let lastAlerts = {}  // key -> timestamp

function loadAlerts() {
  try {
    if (fs.existsSync(ALERT_LOG)) {
      return JSON.parse(fs.readFileSync(ALERT_LOG, 'utf8'))
    }
  } catch {}
  return []
}
function saveAlerts(alerts) {
  try { fs.writeFileSync(ALERT_LOG, JSON.stringify(alerts.slice(-200), null, 2)) } catch {}
}

// ========== 采集函数 ==========
function safeExec(cmd) {
  try { return execSync(cmd, { timeout: 8000, encoding: 'utf8' }) } catch (e) { return e.stdout || '' }
}

function collectSystem() {
  const load = os.loadavg()
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const usedMem = totalMem - freeMem
  const memPercent = Math.round((usedMem / totalMem) * 100)
  const uptime = os.uptime()
  // CPU 使用率（两次采样）
  const cpus1 = os.cpus()
  const idle1 = cpus1.reduce((s, c) => s + c.times.idle, 0)
  const total1 = cpus1.reduce((s, c) => s + c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq, 0)
  const sleepMs = 500
  const waited = new Promise(r => setTimeout(r, sleepMs))
  // 同步采集 CPU 用两次快照（简化用 exec top）
  const topOut = safeExec("top -bn1 | grep '%Cpu' | head -1")
  const cpuMatch = topOut.match(/ni\s+([\d.]+)/) || topOut.match(/([\d.]+)\s+us/)
  const cpuPercent = cpuMatch ? Math.round(parseFloat(cpuMatch[1]) * 10) / 10 : null

  // 磁盘
  const disks = []
  for (const d of DISK_THRESHOLDS) {
    const out = safeExec(`df -h ${d.mount} | tail -1`)
    const parts = out.trim().split(/\s+/)
    if (parts.length >= 5) {
      const pct = parseInt(parts[4].replace('%', ''))
      disks.push({ mount: d.mount, size: parts[1], used: parts[2], avail: parts[3], pct: pct || 0 })
    }
  }

  // 服务状态
  const services = []
  for (const s of SERVICES) {
    const st = safeExec(`systemctl is-active ${s}`).trim()
    services.push({ name: s, status: st === 'active' ? 'running' : st })
  }

  // 端口状态
  const ports = []
  for (const p of PORTS) {
    const conn = safeExec(`ss -tlnp 2>/dev/null | grep -q ':${p} ' && echo up || echo down`).trim()
    ports.push({ port: p, status: conn === 'up' ? 'open' : 'closed' })
  }

  return {
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    cpu: { model: os.cpus()[0].model, cores: os.cpus().length, usage: cpuPercent },
    memory: { total: totalMem, used: usedMem, percent: memPercent },
    load: { load1: load[0], load5: load[1], load15: load[2] },
    uptime: uptime,
    disks, services, ports,
    timestamp: new Date().toISOString(),
  }
}

// ========== 异常检测 ==========
function checkAlerts(state) {
  const alerts = []
  // 磁盘
  for (const d of state.disks) {
    if (d.pct >= 95) alerts.push({ level: 'critical', key: `disk-${d.mount}`, msg: `磁盘 ${d.mount} 使用率 ${d.pct}%（严重）: 已用 ${d.used} / 可用 ${d.avail}` })
    else if (d.pct >= 85) alerts.push({ level: 'warning', key: `disk-${d.mount}`, msg: `磁盘 ${d.mount} 使用率 ${d.pct}%（警告）: 可用 ${d.avail}` })
  }
  // 内存
  if (state.memory.percent >= 90) alerts.push({ level: 'critical', key: 'memory', msg: `内存使用率 ${state.memory.percent}%（严重）` })
  else if (state.memory.percent >= 85) alerts.push({ level: 'warning', key: 'memory', msg: `内存使用率 ${state.memory.percent}%（警告）` })
  // CPU
  if (state.cpu.usage && state.cpu.usage >= 90) alerts.push({ level: 'warning', key: 'cpu', msg: `CPU 使用率 ${state.cpu.usage}%（警告）` })
  // 负载
  const cores = state.cpu.cores
  if (state.load.load5 > cores * 1.5) alerts.push({ level: 'warning', key: 'load', msg: `系统负载偏高 load5=${state.load.load5.toFixed(2)}（核数 ${cores}）` })
  // 服务
  for (const s of state.services) {
    if (s.status !== 'running') alerts.push({ level: 'critical', key: `svc-${s.name}`, msg: `服务 ${s.name} 状态异常: ${s.status}` })
  }
  // 端口
  for (const p of state.ports) {
    if (p.status !== 'open') alerts.push({ level: 'critical', key: `port-${p.port}`, msg: `端口 ${p.port} 未监听` })
  }
  return alerts
}

// ========== 邮件发送 ==========
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
    await transporter.sendMail({
      from: `"驾驶舱服务器监控" <${cfg.mailUser}>`,
      to: cfg.mailTo,
      subject, text,
    })
    console.log(`[monitor] 邮件已发送: ${subject}`)
    return true
  } catch (e) {
    console.error('[monitor] 邮件发送失败:', e.message)
    return false
  }
}

// ========== 主检查循环 ==========
let monitorState = null
async function runCheck(forceEmail = false) {
  try {
    const state = collectSystem()
    monitorState = state
    const alerts = checkAlerts(state)
    // 去重：cooldown 内不重复发
    const now = Date.now()
    const toSend = alerts.filter(a => {
      const last = lastAlerts[a.key]
      if (forceEmail || !last || now - last > COOLDOWN_MS) { lastAlerts[a.key] = now; return true }
      return false
    })
    if (toSend.length > 0) {
      const title = toSend.some(a => a.level === 'critical') ? '【严重】' : '【警告】'
      const text = `服务器监控告警\n时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n主机: ${state.hostname}\n\n` +
        toSend.map(a => `[${a.level.toUpperCase()}] ${a.msg}`).join('\n') +
        `\n\n---- 完整状态 ----\nCPU: ${state.cpu.usage ?? 'N/A'}% (${state.cpu.cores}核)\n内存: ${state.memory.percent}%\n` +
        state.disks.map(d => `磁盘 ${d.mount}: ${d.pct}%`).join('\n') +
        `\n服务: ${state.services.map(s => `${s.name}=${s.status}`).join(', ')}\n` +
        `端口: ${state.ports.filter(p => p.status === 'closed').map(p => p.port).join(', ') || '全部正常'}`
      const sent = await sendMail(title + ' ' + toSend[0].msg.slice(0, 60), text)
      if (sent) {
        const alertsLog = loadAlerts()
        alertsLog.push({ time: new Date().toISOString(), count: toSend.length, alerts: toSend, sent: true })
        saveAlerts(alertsLog)
      }
    } else {
      // 恢复：清空 key 的 cooldown（可选）
    }
    // 持久化 state 供 API 查询
    try { fs.writeFileSync(MONITOR_STATE, JSON.stringify({ ...state, alerts: alerts.length })) } catch {}
  } catch (e) {
    console.error('[monitor] 检查异常:', e.message)
  }
}

// ========== 启动 ==========
function startMonitor() {
  console.log('[monitor] 服务器监控已启动，每 5 分钟检查一次')
  runCheck()
  setInterval(runCheck, CHECK_INTERVAL_MS)
}

module.exports = { startMonitor, runCheck, getState: () => monitorState, loadAlerts, sendMail, collectSystem, checkAlerts }
