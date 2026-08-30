/**
 * 算法调参模块 - 驾驶舱
 * 自研推理引擎参数优化：注册表读取 / 后台调参 / 进度查询 / 应用回滚 / 历史
 *
 * 架构：
 *  - 引擎：straw-engine/tune_engine.py（注册表驱动，网格/Optuna/单点 + 误报率约束）
 *  - 运行：spawn tune_run.sh（含 GPU 环境 + 无缓冲输出）
 *  - 结果：--out 输出 JSON 到 evidence/tune/，供前端展示
 */
const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ENGINE_DIR = '/opt/jsc/straw-engine'
const RUNNER = path.join(ENGINE_DIR, 'tune_run.sh')
const ALGO_FILE = path.join(ENGINE_DIR, 'config/algorithms.json')
const TUNE_DIR = path.join(ENGINE_DIR, 'evidence/tune')
const HISTORY_FILE = path.join(__dirname, 'data', 'tune_history.json')

// 当前调参任务（全局单任务，防并发）
let task = null

function readAlgorithms() {
  try {
    return JSON.parse(fs.readFileSync(ALGO_FILE, 'utf8')).algorithms || {}
  } catch (e) {
    return {}
  }
}

function readHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) || []
  } catch { return [] }
}

function saveHistory(entry) {
  try {
    const list = readHistory()
    list.unshift(entry)
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(list.slice(0, 50), null, 2))
  } catch (e) { console.error('[tune] 历史写入失败:', e.message) }
}

// 从日志行解析进度 [i/N] best=...
function parseProgress(log) {
  let progress = null
  for (const line of log) {
    const m = line.match(/\[(\d+)\/(\d+)\].*best=([\d.]+)/)
    if (m) {
      progress = { done: Number(m[1]), total: Number(m[2]), best: Number(m[3]) }
    }
  }
  return progress
}

function registerTuneRoutes(app) {
  // ── 注册表 + 参数 Schema（前端自动渲染）──
  app.get('/api/tune/algorithms', (req, res) => {
    const algorithms = readAlgorithms()
    res.json({ ok: true, algorithms })
  })

  // ── 启动调参（后台任务）──
  app.post('/api/tune/run', (req, res) => {
    const { algId = 'straw_fire', method = 'grid', maxFpRate = 0.40, trials = 30, params } = req.body || {}
    const alg = readAlgorithms()[algId]
    if (!alg) return res.json({ ok: false, error: `未知算法 ${algId}` })
    if (task && task.status === 'running') {
      return res.json({ ok: false, error: '已有调参任务运行中，请等待完成或稍后再试' })
    }
    if (!fs.existsSync(RUNNER)) return res.json({ ok: false, error: `引擎不存在: ${RUNNER}` })

    const outFile = path.join(TUNE_DIR, `tune_${Date.now()}.json`)
    const args = ['--algId', algId, '--method', method, '--out', outFile]
    if (method === 'optuna') args.push('--trials', String(trials))
    if (method === 'grid') args.push('--max-fp-rate', String(maxFpRate))
    if (params) args.push('--params', JSON.stringify(params))

    const proc = spawn(RUNNER, args, { env: { ...process.env, PYTHONUNBUFFERED: '1' } })
    task = {
      algId, method, maxFpRate,
      pid: proc.pid, status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null, exitCode: null,
      log: [], outFile, out: null,
    }
    proc.stdout.on('data', d => {
      task.log.push(String(d)); if (task.log.length > 300) task.log.splice(0, 50)
    })
    proc.stderr.on('data', d => { task.log.push(String(d)) })
    proc.on('error', e => {
      task.status = 'failed'; task.exitCode = -1; task.finishedAt = new Date().toISOString()
      task.log.push('启动失败: ' + e.message)
      saveHistory({ ...task, log: task.log.slice(-20) })
    })
    proc.on('close', code => {
      task.exitCode = code
      task.finishedAt = new Date().toISOString()
      if (code === 0 && fs.existsSync(outFile)) {
        try { task.out = JSON.parse(fs.readFileSync(outFile, 'utf8')) } catch (e) { task.log.push('结果解析失败: ' + e.message) }
      }
      task.status = code === 0 ? 'done' : 'failed'
      saveHistory({ ...task, log: task.log.slice(-20) })
    })
    res.json({ ok: true, taskId: outFile, msg: '调参已启动' })
  })

  // ── 进度 / 结果 ──
  app.get('/api/tune/status', (req, res) => {
    if (!task) return res.json({ ok: true, running: false, task: null })
    res.json({
      ok: true,
      running: task.status === 'running',
      task: {
        algId: task.algId, method: task.method, status: task.status,
        startedAt: task.startedAt, finishedAt: task.finishedAt, exitCode: task.exitCode,
        progress: parseProgress(task.log),
        lastLog: task.log.slice(-12),
        out: task.out,
      },
    })
  })

  // ── 历史记录 ──
  app.get('/api/tune/history', (req, res) => {
    res.json({ ok: true, history: readHistory().slice(0, 20) })
  })

  // ── 应用参数（写回 config.json，需重启 straw-engine 生效）──
  app.post('/api/tune/apply', (req, res) => {
    const { params } = req.body || {}
    if (!params || typeof params !== 'object') return res.json({ ok: false, error: '参数必填' })
    try {
      const out = execFileSync(RUNNER, ['--algId', 'straw_fire', '--apply', JSON.stringify(params)], {
        encoding: 'utf8', timeout: 30000,
      })
      res.json({ ok: true, output: out.split('\n').filter(Boolean) })
    } catch (e) {
      res.json({ ok: false, error: e.stderr ? String(e.stderr).split('\n').slice(-3).join(' ') : e.message })
    }
  })

  // ── 回滚 ──
  app.post('/api/tune/rollback', (req, res) => {
    try {
      const out = execFileSync(RUNNER, ['--rollback'], { encoding: 'utf8', timeout: 30000 })
      res.json({ ok: true, output: out.split('\n').filter(Boolean) })
    } catch (e) {
      res.json({ ok: false, error: e.stderr ? String(e.stderr).split('\n').slice(-3).join(' ') : e.message })
    }
  })
}

module.exports = { registerTuneRoutes }
