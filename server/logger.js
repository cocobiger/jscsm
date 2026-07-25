'use strict'
/**
 * 轻量结构化日志（零依赖）
 * - 分级：debug / info / warn / error
 * - 每条日志带 ISO 时间戳、级别、模块名
 * - 控制台彩色输出；可选同时写 data/logs/app-YYYY-MM-DD.log（JSON 行）
 * - 通过环境变量 LOG_LEVEL 控制最低输出级别（默认 info），LOG_FILE=1 开启写文件
 */
const fs = require('fs')
const path = require('path')

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m', reset: '\x1b[0m' }

let minLevel = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info
let logDir = null
let fileEnabled = false

function init(dataDir, opts = {}) {
  if (opts.level && LEVELS[opts.level]) minLevel = LEVELS[opts.level]
  fileEnabled = opts.toFile ?? (process.env.LOG_FILE === '1')
  if (fileEnabled) {
    logDir = path.join(dataDir, 'logs')
    try { if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true }) }
    catch (e) { fileEnabled = false; console.error('[logger] 创建日志目录失败:', e.message) }
  }
}

function writeFile(entry) {
  if (!fileEnabled || !logDir) return
  try {
    const day = entry.time.slice(0, 10)
    fs.appendFileSync(path.join(logDir, `app-${day}.log`), JSON.stringify(entry) + '\n')
  } catch { /* 写文件失败不影响主流程 */ }
}

function log(level, module, msg, meta) {
  if (LEVELS[level] < minLevel) return
  const time = new Date().toISOString()
  const entry = { time, level, module, msg, ...(meta ? { meta } : {}) }
  const c = COLORS[level] || ''
  const metaStr = meta ? ' ' + JSON.stringify(meta) : ''
  console.log(`${c}[${time}] ${level.toUpperCase().padEnd(5)} [${module}]${COLORS.reset} ${msg}${metaStr}`)
  writeFile(entry)
}

// 返回一个绑定了模块名的 logger
function child(module) {
  return {
    debug: (msg, meta) => log('debug', module, msg, meta),
    info: (msg, meta) => log('info', module, msg, meta),
    warn: (msg, meta) => log('warn', module, msg, meta),
    error: (msg, meta) => log('error', module, msg, meta),
  }
}

module.exports = { init, child, LEVELS }
