'use strict'
/**
 * 真烟样本工作台 · 采集后端（阶段1c）
 *   GET  /api/collect/records      列出历史录制（复用 dji-openapi media 归档）
 *   POST /api/collect/extract      触发录制抽帧 → 昼夜三分类归集到隔离区（调 quarantine_collect.py）
 *   GET  /api/collect/quarantine   查看隔离区清单（manifest.json）
 * 防污染：只写隔离区 quarantine/，绝不写训练 split。
 */
const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')

const PY = '/opt/jsc/straw-engine/venv/bin/python'
const SCRIPT = '/video/xunlian/quarantine_collect.py'
const QUAR = '/video/shujuji/datasets/v5_train_v5/quarantine'

function runExtract(recordPath, step) {
  return new Promise((resolve) => {
    execFile(PY, [SCRIPT, 'extract', recordPath, String(step)], { timeout: 20 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve({ ok: false, error: err.message })
        try { resolve(JSON.parse(String(stdout).trim().split('\n').pop())) }
        catch (e) { resolve({ ok: false, error: '解析失败', raw: String(stdout).slice(-200) }) }
      })
  })
}

const INGEST_SCRIPT = '/video/xunlian/quarantine_ingest.py'
function runIngest(cmd) {
  return new Promise((resolve) => {
    execFile(PY, [INGEST_SCRIPT, cmd], { timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve({ ok: false, error: err.message })
        try { resolve(JSON.parse(String(stdout).trim())) }
        catch (e) { resolve({ ok: false, error: '解析失败', raw: String(stdout).slice(-300) }) }
      })
  })
}

function registerCollectRoutes(app) {
  // 列出历史录制
  app.get('/api/collect/records', async (req, res) => {
    try {
      const j = await fetch('http://127.0.0.1:17810/api/media?kind=record&limit=100', { signal: AbortSignal.timeout(10000) }).then(r => r.json())
      res.json({ ok: true, items: (j && j.items) || [] })
    } catch (e) { res.status(502).json({ ok: false, error: e.message }) }
  })

  // 触发抽帧 → 归集隔离区
  app.post('/api/collect/extract', async (req, res) => {
    const p = req.body && (req.body.path || req.body.recordPath)
    const step = req.body && req.body.step ? Number(req.body.step) : 8
    if (!p) return res.status(400).json({ ok: false, error: 'missing path' })
    const r = await runExtract(p, step)
    res.json(r)
  })

  // 隔离区清单
  app.get('/api/collect/quarantine', async (req, res) => {
    try {
      const mf = path.join(QUAR, 'manifest.json')
      const items = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, 'utf8')) : []
      const byCat = { day: 0, dusk: 0, night: 0 }
      let invalidCount = 0, deletedCount = 0
      items.forEach(m => {
        if (m.invalid) invalidCount++
        if (m.deleted) deletedCount++
        if (!m.invalid && !m.deleted && byCat[m.cat] != null) byCat[m.cat]++
      })
      const limit = Math.min(parseInt(req.query.limit) || 2000, 5000)
      res.json({ ok: true, total: items.length - invalidCount - deletedCount, byCat, invalidCount, deletedCount, items: items.slice(-limit) })
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  // 隔离区图片（PUBLIC，供 <img> 直接加载；file 已 basename 防目录穿越）
  app.get('/api/collect/image', async (req, res) => {
    const cat = String(req.query.cat || 'day')
    const file = path.basename(String(req.query.file || ''))
    if (!/^(day|dusk|night)$/.test(cat)) return res.status(400).json({ ok: false, error: 'bad cat' })
    const p = path.join(QUAR, cat, 'images', file)
    if (!fs.existsSync(p)) return res.status(404).json({ ok: false, error: 'not found' })
    res.sendFile(p)
  })

  // 保存标注（判定 + 可选烟框/干扰框），写回 manifest
  app.post('/api/collect/annotate', async (req, res) => {
    try {
      const { cat, file, verdict, boxes } = req.body || {}
      if (!cat || !file || !verdict) return res.status(400).json({ ok: false, error: 'missing fields' })
      const mf = path.join(QUAR, 'manifest.json')
      const items = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, 'utf8')) : []
      const it = items.find(m => m.cat === cat && m.file === file)
      if (!it) return res.status(404).json({ ok: false, error: '样本不存在' })
      it.verdict = verdict
      it.boxes = boxes || []
      it.annotatedAt = new Date().toISOString()
      fs.writeFileSync(mf, JSON.stringify(items, null, 2))
      res.json({ ok: true })
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  // 体检（6 道防污染硬闸）
  app.get('/api/collect/inspect', async (req, res) => {
    res.json(await runIngest('inspect'))
  })

  // 入集（体检全过才执行）
  app.post('/api/collect/ingest', async (req, res) => {
    res.json(await runIngest('ingest'))
  })

  // 标记无效 / 软删除（移入回收站 _trash，可恢复）
  app.post('/api/collect/mark', async (req, res) => {
    try {
      const { items, action, reason } = req.body || {}
      if (!Array.isArray(items) || !items.length) return res.status(400).json({ ok: false, error: 'items 为空' })
      if (!['invalid', 'delete', 'restore'].includes(action)) return res.status(400).json({ ok: false, error: 'bad action' })
      const mf = path.join(QUAR, 'manifest.json')
      const mfItems = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, 'utf8')) : []
      let n = 0
      for (const it of items) {
        const m = mfItems.find(x => x.cat === it.cat && x.file === it.file)
        if (!m) continue
        if (action === 'invalid') {
          m.invalid = true; m.invalidAt = new Date().toISOString(); m.invalidReason = reason || ''
        } else if (action === 'delete') {
          const src = path.join(QUAR, m.cat, 'images', m.file)
          const trashDir = path.join(QUAR, '_trash', m.cat, 'images')
          fs.mkdirSync(trashDir, { recursive: true })
          if (fs.existsSync(src)) fs.renameSync(src, path.join(trashDir, m.file))
          // 标签一并移走
          const srcLbl = path.join(QUAR, m.cat, 'labels', path.basename(m.file, path.extname(m.file)) + '.txt')
          const trashLbl = path.join(QUAR, '_trash', m.cat, 'labels')
          fs.mkdirSync(trashLbl, { recursive: true })
          if (fs.existsSync(srcLbl)) fs.renameSync(srcLbl, path.join(trashLbl, path.basename(srcLbl)))
          m.deleted = true; m.deletedAt = new Date().toISOString(); m.delReason = reason || ''
        } else if (action === 'restore') {
          const src = path.join(QUAR, '_trash', m.cat, 'images', m.file)
          const dst = path.join(QUAR, m.cat, 'images', m.file)
          fs.mkdirSync(path.dirname(dst), { recursive: true })
          if (fs.existsSync(src)) fs.renameSync(src, dst)
          const srcLbl = path.join(QUAR, '_trash', m.cat, 'labels', path.basename(m.file, path.extname(m.file)) + '.txt')
          const dstLbl = path.join(QUAR, m.cat, 'labels', path.basename(m.file, path.extname(m.file)) + '.txt')
          fs.mkdirSync(path.dirname(dstLbl), { recursive: true })
          if (fs.existsSync(srcLbl)) fs.renameSync(srcLbl, dstLbl)
          m.deleted = false; m.invalid = false; delete m.deletedAt; delete m.invalidAt
        }
        n++
      }
      fs.writeFileSync(mf, JSON.stringify(mfItems, null, 2))
      res.json({ ok: true, affected: n })
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })
}

module.exports = { registerCollectRoutes }
