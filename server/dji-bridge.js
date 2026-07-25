'use strict'
/**
 * 大疆司空 WebRTC 适配器管理模块
 * 通过启动 /opt/jsc/dji-bridge/dji_bridge.py 子进程，
 * 把大疆司空 share/live 页面的机场视频转推为 RTMP 流到 ZLMediaKit。
 */
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const PYTHON = '/opt/jsc/dji-bridge/venv/bin/python3'
const SCRIPT = '/opt/jsc/dji-bridge/dji_bridge.py'
const WORKDIR = '/opt/jsc/dji-bridge'

let log = { info() {}, warn() {}, error() {}, debug() {} }

// streamId -> session
const sessions = new Map()

function init(logger) {
  if (logger) log = logger
  try {
    fs.mkdirSync(WORKDIR, { recursive: true })
    fs.mkdirSync(path.join(WORKDIR, 'sessions'), { recursive: true })
  } catch (e) {
    log.error('创建 dji-bridge 工作目录失败: ' + e.message)
  }
}

function pidfile(streamId) {
  return path.join(WORKDIR, 'sessions', `${streamId}.json`)
}

function readSessionFile(streamId) {
  try {
    const raw = fs.readFileSync(pidfile(streamId), 'utf8').trim()
    // 兼容旧版纯文本 pid（仅一行数字）
    if (/^\d+$/.test(raw)) {
      return { python_pid: parseInt(raw, 10) }
    }
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function writeSessionFile(streamId, data) {
  try {
    fs.writeFileSync(pidfile(streamId), JSON.stringify(data, null, 2))
  } catch (e) {
    log.warn(`写入 dji-bridge 会话文件失败 [${streamId}]: ${e.message}`)
  }
}

function removeSessionFile(streamId) {
  try { fs.unlinkSync(pidfile(streamId)) } catch {}
}

function isProcessAlive(pid) {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killProcess(pid, signal = 'SIGTERM') {
  if (!pid || pid <= 0) return
  try {
    process.kill(pid, signal)
  } catch (e) {
    log.debug(`kill ${pid} ${signal} 失败: ${e.message}`)
  }
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 根据 pidfile 清理某路流可能遗留的 python / Xvfb / ffmpeg 进程
 */
async function cleanupLegacy(streamId) {
  const info = readSessionFile(streamId)
  if (!info) return

  const pids = [
    info.python_pid,
    info.ffmpeg_pid,
    info.xvfb_pid,
  ].filter(Boolean)

  if (pids.length === 0) {
    removeSessionFile(streamId)
    return
  }

  log.info(`清理 dji-bridge 遗留进程 [${streamId}]: ${pids.join(', ')}`)
  for (const pid of pids) killProcess(pid, 'SIGTERM')
  await wait(2500)
  for (const pid of pids) {
    if (isProcessAlive(pid)) killProcess(pid, 'SIGKILL')
  }
  await wait(500)
  removeSessionFile(streamId)
}

function buildUrls(streamId) {
  return {
    ok: true,
    hls: `/jsc/${streamId}/hls.m3u8`,
    flv: `/jsc/${streamId}.live.flv`,
    ws_flv: `/jsc/${streamId}.live.flv`,
    rtmp: `rtmp://127.0.0.1:1935/jsc/${streamId}`,
    rts: `/jsc/${streamId}.live.ts`,
  }
}

/**
 * 启动一路 DJI WebRTC 转码
 * @param {string} streamId
 * @param {object} djiConfig
 * @returns {Promise<{ok:boolean, hls:string, flv:string, ws_flv:string, rtmp:string, rts:string}>}
 */
async function startSession(streamId, djiConfig) {
  if (!streamId) throw new Error('缺少 streamId')
  if (!djiConfig?.shareUrl) throw new Error('缺少 shareUrl')
  if (!djiConfig?.airportName && djiConfig?.airportIndex == null) {
    throw new Error('缺少 airportName 或 airportIndex')
  }

  // 1. 如果该流已经在运行，直接返回播放地址（避免重复推流导致 ZLM Already publishing）
  const existing = readSessionFile(streamId)
  if (existing && (isProcessAlive(existing.python_pid) || isProcessAlive(existing.ffmpeg_pid))) {
    log.info(`dji-bridge 已在运行 [${streamId}]，直接返回播放地址`)
    return buildUrls(streamId)
  }

  // 2. 清理可能遗留的旧进程（兼容后端重启后内存丢失、子进程残留的情况）
  await cleanupLegacy(streamId)

  // 3. 内存中如果还有残留 session，先移除
  if (sessions.has(streamId)) {
    const old = sessions.get(streamId)
    if (old?.proc && !old.proc.killed) {
      killProcess(old.proc.pid, 'SIGTERM')
      await wait(2000)
      if (!old.proc.killed) killProcess(old.proc.pid, 'SIGKILL')
    }
    sessions.delete(streamId)
  }

  const args = [
    SCRIPT,
    '--share-url', String(djiConfig.shareUrl),
    '--stream-id', streamId,
    '--width', String(djiConfig.width || 1280),
    '--height', String(djiConfig.height || 720),
    '--capture-offset-y', String(djiConfig.captureOffsetY || 80),
    '--bitrate', String(djiConfig.bitrate || 2000),
    '--keep-alive', '1',
    '--pidfile', pidfile(streamId),
  ]
  if (djiConfig.airportName) args.push('--airport-name', String(djiConfig.airportName))
  if (djiConfig.airportIndex != null) args.push('--airport-index', String(djiConfig.airportIndex))
  if (djiConfig.parentName) args.push('--parent-name', String(djiConfig.parentName))
  if (djiConfig.autoFullscreen === false) args.push('--no-fullscreen')

  log.info(`启动 dji-bridge [${streamId}]: ${PYTHON} ${args.join(' ')}`)

  const proc = spawn(PYTHON, args, {
    cwd: WORKDIR,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
  })

  const session = {
    streamId,
    proc,
    djiConfig,
    startTime: new Date().toISOString(),
    stdout: '',
    stderr: '',
    started: false,
    error: null,
  }
  sessions.set(streamId, session)

  proc.stdout.on('data', (data) => {
    const s = data.toString()
    session.stdout += s
    if (session.stdout.length > 20000) session.stdout = session.stdout.slice(-10000)
    log.info(`[dji-bridge ${streamId}] ${s.trim()}`)
    if (s.includes('DJI WebRTC 适配器已启动')) session.started = true
  })
  proc.stderr.on('data', (data) => {
    const s = data.toString()
    session.stderr += s
    if (session.stderr.length > 20000) session.stderr = session.stderr.slice(-10000)
    log.warn(`[dji-bridge ${streamId}] ${s.trim()}`)
  })

  proc.on('error', (e) => {
    session.error = e.message
    log.error(`dji-bridge 进程启动失败 [${streamId}]: ${e.message}`)
  })
  proc.on('close', (code) => {
    log.warn(`dji-bridge 进程退出 [${streamId}] code=${code}`)
    sessions.delete(streamId)
  })

  // 等待启动成功或失败
  await new Promise((resolve, reject) => {
    const start = Date.now()
    const timeout = 90000
    const timer = setInterval(() => {
      if (session.started) {
        clearInterval(timer)
        resolve(undefined)
        return
      }
      if (session.error) {
        clearInterval(timer)
        reject(new Error(session.error))
        return
      }
      if (proc.killed || proc.exitCode != null) {
        clearInterval(timer)
        reject(new Error(`dji-bridge 进程过早退出: ${session.stderr.slice(-500)}`))
        return
      }
      if (Date.now() - start > timeout) {
        clearInterval(timer)
        // 超时不代表失败，可能已经推流但日志未输出；继续返回地址
        resolve(undefined)
      }
    }, 1000)
  })

  // 写出 node 端会话文件（会被 python 后续覆盖为含子进程 pid 的 JSON）
  writeSessionFile(streamId, {
    streamId,
    python_pid: proc.pid,
    startTime: session.startTime,
    djiConfig,
  })

  return buildUrls(streamId)
}

/**
 * 停止一路 DJI WebRTC 转码
 */
async function stopSession(streamId) {
  // 优先杀掉内存中的 session
  const session = sessions.get(streamId)
  if (session?.proc && !session.proc.killed) {
    session.proc.kill('SIGTERM')
    await wait(3000)
    if (!session.proc.killed) {
      session.proc.kill('SIGKILL')
    }
  }
  sessions.delete(streamId)

  // 再按 pidfile 清理可能遗留的子进程
  await cleanupLegacy(streamId)
  return { ok: true }
}

function getStatus() {
  return {
    sessions: Array.from(sessions.entries()).map(([streamId, s]) => ({
      streamId,
      pid: s.proc?.pid,
      started: s.started,
      startTime: s.startTime,
      error: s.error,
      djiConfig: s.djiConfig,
    })),
  }
}

module.exports = { init, startSession, stopSession, getStatus }
