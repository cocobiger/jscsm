/**
 * AI 复检模块 - 驾驶舱
 * 人工复检 → 数据回流 → 算法迭代
 *
 * 功能：
 *  1. straw_detections 表：持久化检测帧/框/判定
 *  2. 复检 API：列表/提交/统计/导出
 *  3. 标注导出：生成 YOLO 格式训练数据
 *
 * 第 3 批（复检↔推送联动闭环）：
 *  - straw_detections.warning_id 精确关联告警（替代第 1 批时间窗近似）
 *  - registerReviewRoutes(app, ctx)：ctx.onVerdict(det, verdict, note, reviewer)
 *    由宿主（index.js）实现联动——复检通过释放 held 推送 / 误报追发更正推送
 */
const path = require('path')

let db = null
let evidenceRoot = '/opt/jsc/straw-engine'
// 宿主上下文：{ store, onVerdict }；onVerdict 为异步回调，fire-and-forget 不阻塞复检响应
let ctx = {}

function initReviewDb(database) {
  db = database
  db.exec(`
    CREATE TABLE IF NOT EXISTS straw_detections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stream_id TEXT,
      ts TEXT DEFAULT (datetime('now','localtime')),
      frame_path TEXT,
      boxes TEXT,
      label TEXT,
      source TEXT DEFAULT 'alert',
      max_conf REAL,
      review_status TEXT DEFAULT 'pending',
      reviewer TEXT,
      reviewed_at TEXT,
      note TEXT,
      lat REAL,
      lng REAL,
      scene TEXT DEFAULT '',
      exclude INTEGER DEFAULT 0
    )
  `)
  // 老库兼容：已存在的表补坐标/告警关联字段
  const cols = db.prepare(`PRAGMA table_info(straw_detections)`).all().map(c => c.name)
  if (!cols.includes('lat')) db.exec('ALTER TABLE straw_detections ADD COLUMN lat REAL')
  if (!cols.includes('lng')) db.exec('ALTER TABLE straw_detections ADD COLUMN lng REAL')
  if (!cols.includes('warning_id')) db.exec('ALTER TABLE straw_detections ADD COLUMN warning_id TEXT')
  // P2 场景治理：scene 场景标签(dock机场期/sim模拟流/night夜间/day白天/urban城区) + exclude 人工"不纳入判例"标记
  if (!cols.includes('scene')) db.exec("ALTER TABLE straw_detections ADD COLUMN scene TEXT DEFAULT ''")
  if (!cols.includes('exclude')) db.exec('ALTER TABLE straw_detections ADD COLUMN exclude INTEGER DEFAULT 0')
  db.exec('CREATE INDEX IF NOT EXISTS idx_review_scene ON straw_detections(scene)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_review_status ON straw_detections(review_status)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_review_warning ON straw_detections(warning_id)')
  // 第 4 批：标注导出历史（数据资产台账，供报表与追溯）
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_exports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      exporter TEXT,
      base_dir TEXT,
      exported INTEGER,
      smoke_boxes INTEGER DEFAULT 0,
      fire_boxes INTEGER DEFAULT 0,
      house_boxes INTEGER DEFAULT 0,
      trigger_type TEXT DEFAULT 'manual'
    )
  `)
  // P3-2a 负样本抽检：VLM 干扰物分类人工复核（ok=正确 / no=错误 / dn=不确定）
  // frame_path 为 neg_classified.json 的键（图片绝对路径），UNIQUE 防重复提交
  db.exec(`
    CREATE TABLE IF NOT EXISTS straw_neg_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      frame_path TEXT UNIQUE,
      cats TEXT DEFAULT '',
      raw TEXT DEFAULT '',
      ts TEXT DEFAULT '',
      review_status TEXT DEFAULT 'pending',
      reviewer TEXT DEFAULT '',
      reviewed_at TEXT,
      note TEXT DEFAULT ''
    )
  `)
}

function parseBoxes(boxes) {
  try { return JSON.parse(boxes || '[]') } catch { return [] }
}

function registerReviewRoutes(app, reviewCtx = {}) {
  ctx = reviewCtx || {}

  // 复检判定联动：fire-and-forget 通知宿主（复检通过→释放 held 推送；误报→追发更正推送）
  const notifyVerdict = (det, verdict, note, reviewer) => {
    if (typeof ctx.onVerdict !== 'function') return
    ctx.onVerdict(det, verdict, note, reviewer).catch(e => console.error('[review-linkage]', e.message))
  }

  // 待复检列表（支持过滤 source/min_conf + 排序）
  app.get('/api/review/list', (req, res) => {
    try {
      const status = req.query.status || 'pending'
      const limit = Math.min(parseInt(req.query.limit) || 20, 500)
      const offset = parseInt(req.query.offset) || 0
      const source = req.query.source ? String(req.query.source) : null
      const minConf = req.query.min_conf ? Number(req.query.min_conf) : null
      const sort = req.query.sort === 'conf' ? 'max_conf DESC, ts DESC' : 'ts DESC'
      const cond = []
      const args = []
      cond.push('review_status = ?'); args.push(status)
      if (source) { cond.push('source = ?'); args.push(source) }
      if (minConf) { cond.push('max_conf >= ?'); args.push(minConf) }
      const where = cond.join(' AND ')
      const rows = db.prepare(
        `SELECT * FROM straw_detections WHERE ${where} ORDER BY ${sort} LIMIT ? OFFSET ?`
      ).all(...args, limit, offset)
      rows.forEach(r => r.boxes = parseBoxes(r.boxes))
      const total = db.prepare(`SELECT COUNT(*) c FROM straw_detections WHERE ${where}`).get(...args).c
      res.json({ ok: true, rows, total })
    } catch (e) { res.json({ ok: false, error: e.message }) }
  })

  // 复核人归属：优先服务端从 token 解析的登录用户（防伪造），其次请求体传入值
  const reviewerOf = (req, fallback = '') => (req.user && req.user.username) || fallback || ''

  // 提交判定（联动：判定后回调宿主执行复检↔推送联动）
  app.post('/api/review/submit', (req, res) => {
    try {
      const { id, review_status, reviewer, note, lat, lng } = req.body || {}
      if (!id || !['true', 'false', 'uncertain'].includes(review_status)) {
        return res.json({ ok: false, error: '参数错误' })
      }
      const det = db.prepare(`SELECT * FROM straw_detections WHERE id = ?`).get(id)
      if (!det) return res.json({ ok: false, error: '记录不存在' })
      const rv = reviewerOf(req, reviewer)
      db.prepare(
        `UPDATE straw_detections SET review_status=?, reviewer=?, reviewed_at=datetime('now','localtime'), note=?, lat=COALESCE(?, lat), lng=COALESCE(?, lng) WHERE id=?`
      ).run(review_status, rv, note || '',
        Number.isFinite(lat) ? lat : null, Number.isFinite(lng) ? lng : null, id)
      // 联动：仅 true(复检通过) / false(误报) 需要通知宿主（uncertain 不联动）
      if (review_status === 'true' || review_status === 'false') {
        notifyVerdict(det, review_status, note || '', rv)
      }
      res.json({ ok: true })
    } catch (e) { res.json({ ok: false, error: e.message }) }
  })

  // 人工画框补标（漏报补标：手动画框覆盖/新增框）
  app.post('/api/review/box', (req, res) => {
    try {
      const { id, boxes, label, reviewer, lat, lng } = req.body || {}
      if (!id || !Array.isArray(boxes)) return res.json({ ok: false, error: '参数错误' })
      const row = db.prepare(`SELECT * FROM straw_detections WHERE id = ?`).get(id)
      if (!row) return res.json({ ok: false, error: '记录不存在' })
      const max_conf = boxes.length ? Math.max(...boxes.map(b => b.conf || 0)) : (row.max_conf || 0)
      db.prepare(
        `UPDATE straw_detections SET boxes=?, label=?, max_conf=?, review_status='true', reviewer=?, reviewed_at=datetime('now','localtime'), lat=COALESCE(?, lat), lng=COALESCE(?, lng) WHERE id=?`
      ).run(JSON.stringify(boxes), label || row.label || 'fire', max_conf, reviewerOf(req, reviewer),
        Number.isFinite(lat) ? lat : null, Number.isFinite(lng) ? lng : null, id)
      // 画框补标 = 复检通过（漏报确认）→ 联动宿主（释放 held 推送 / 无则不动）
      notifyVerdict(row, 'true', '画框补标', reviewerOf(req, reviewer))
      res.json({ ok: true })
    } catch (e) { res.json({ ok: false, error: e.message }) }
  })

  // 批量把记录框类别标为 smoke（无人机视角秸秆判定以烟为主）
  // 接收 ids 数组或 status（如 'true'）：把所选记录的 boxes 全部改为 cls=0(smoke)，label='smoke'
  app.post('/api/review/bulk-class', (req, res) => {
    try {
      const { ids, status } = req.body || {}
      let rows = []
      if (Array.isArray(ids) && ids.length) {
        const marks = ids.map(() => '?').join(',')
        rows = db.prepare(`SELECT id, boxes FROM straw_detections WHERE id IN (${marks})`).all(...ids)
      } else if (status) {
        rows = db.prepare(`SELECT id, boxes FROM straw_detections WHERE review_status = ?`).all(status)
      } else return res.json({ ok: false, error: '需传 ids 数组或 status' })
      let changed = 0, boxesChanged = 0
      for (const row of rows) {
        const bs = parseBoxes(row.boxes)
        if (!bs.length) continue
        const newBoxes = bs.map(b => ({ ...b, cls: 0, conf: b.conf || 1.0 }))
        db.prepare(`UPDATE straw_detections SET boxes=?, label='smoke' WHERE id=?`).run(JSON.stringify(newBoxes), row.id)
        changed++; boxesChanged += newBoxes.length
      }
      res.json({ ok: true, changed, boxesChanged })
    } catch (e) { res.json({ ok: false, error: e.message }) }
  })

  // 撤销上一步判定（回退 pending，清空复核人/时间/备注）
  app.post('/api/review/undo', (req, res) => {    try {
      const { id } = req.body || {}
      if (!id) return res.json({ ok: false, error: '参数错误' })
      const r = db.prepare(`UPDATE straw_detections SET review_status='pending', reviewer='', reviewed_at=NULL, note='' WHERE id=?`).run(id)
      res.json({ ok: true, changes: r.changes })
    } catch (e) { res.json({ ok: false, error: e.message }) }
  })

  // P2：批量"不纳入判例"标记（exclude=1 后导出重训默认剔除；再传 exclude:false 可恢复）
  app.post('/api/review/exclude', (req, res) => {
    try {
      const { ids, exclude } = req.body || {}
      if (!Array.isArray(ids) || !ids.length) return res.json({ ok: false, error: '需传 ids 数组' })
      const v = exclude === false ? 0 : 1
      const marks = ids.map(() => '?').join(',')
      const r = db.prepare(`UPDATE straw_detections SET exclude = ? WHERE id IN (${marks})`).run(v, ...ids)
      res.json({ ok: true, changed: r.changes, exclude: v })
    } catch (e) { res.json({ ok: false, error: e.message }) }
  })

  // 复检统计
  app.get('/api/review/stats', (req, res) => {
    try {
      const rows = db.prepare(
        `SELECT review_status, COUNT(*) c, ROUND(AVG(max_conf),3) avg_conf FROM straw_detections GROUP BY review_status`
      ).all()
      const total = db.prepare(`SELECT COUNT(*) c FROM straw_detections`).get().c
      const bySource = db.prepare(`SELECT source, COUNT(*) c FROM straw_detections GROUP BY source`).all()
      res.json({ ok: true, total, byStatus: rows, bySource })
    } catch (e) { res.json({ ok: false, error: e.message }) }
  })

  // 复检图片（支持 ?w= 生成缩略图，大幅降低网格加载带宽）
  // 统一发送：原图直出 or sharp 缩略图 + 磁盘缓存（中文路径用 sha1 做缓存名）
  const sendImg = async (abs, keyPath, w, res) => {
    if (w <= 0 || w >= 3000) return res.sendFile(abs)
    const cacheDir = path.join(__dirname, 'data', 'review_thumbs')
    const crypto = require('crypto')
    const key = crypto.createHash('sha1').update(keyPath + '|' + w).digest('hex')
    const cacheFile = path.join(cacheDir, key + '.jpg')
    if (!require('fs').existsSync(cacheFile)) {
      require('fs').mkdirSync(cacheDir, { recursive: true })
      try {
        const sharp = require('sharp')
        await sharp(abs).resize({ width: w, withoutEnlargement: true }).jpeg({ quality: 72 }).toFile(cacheFile)
      } catch (e) {
        // sharp 失败时回退原图
        return res.sendFile(abs)
      }
    }
    res.sendFile(cacheFile)
  }

  app.get('/api/review/image', async (req, res) => {
    try {
      const p = String(req.query.path || '')
      const w = parseInt(req.query.w || '0', 10) || 0
      if (!p || p.includes('..')) return res.status(400).end('bad path')
      // P3-2a 负样本抽检白名单：record/ 前缀 → v5_candidates/record
      if (p.startsWith('record/')) {
        const negRoot = '/video/shujuji/datasets/v5_candidates/record'
        const rel = p.slice('record/'.length)
        const absNeg = path.normalize(path.join(negRoot, rel))
        if (!absNeg.startsWith(negRoot)) return res.status(403).end('forbidden')
        return sendImg(absNeg, p, w, res)
      }
      const abs = path.normalize(path.join(evidenceRoot, p))
      if (!abs.startsWith(evidenceRoot)) return res.status(403).end('forbidden')
      return sendImg(abs, p, w, res)
    } catch (e) { res.status(500).end('err:' + e.message) }
  })

  // ── 导出标注数据（YOLO 格式，供重训）──
  // 真烟(true) → 正样本；误报(false) → 负样本（空标注）
  // 第 4 批：抽公共 doExport；POST 一键导出并记录历史（review_exports），GET 保留兼容旧调用
  // P2 场景治理：默认剔除 人工"不纳入判例"(exclude=1) + 场景无效帧(dock机场期/sim模拟流)；includeAll=1 可全量导出
  const doExport = async (base, exporter = '', triggerType = 'manual', includeAll = false) => {
    const whereAll = `WHERE review_status IN ('true','false')`
    const whereClean = `WHERE review_status IN ('true','false')
      AND (exclude IS NULL OR exclude = 0)
      AND (scene IS NULL OR scene = '' OR scene NOT IN ('dock','sim'))`
    const rows = db.prepare(`SELECT * FROM straw_detections ${includeAll ? whereAll : whereClean} ORDER BY ts`).all()
    const fs = require('fs')
    const train = path.join(base, 'v1', 'images', 'train')
    const labels = path.join(base, 'v1', 'labels', 'train')
    fs.mkdirSync(train, { recursive: true })
    fs.mkdirSync(labels, { recursive: true })
    let exported = 0, skipped = 0, smokeBoxes = 0, fireBoxes = 0, houseBoxes = 0
    for (const r of rows) {
      // 解析源图路径：兼容 'evidence/xxx' 与 '/api/evidence/xxx' 两种存储格式
      const rel = String(r.frame_path || '').replace(/^\/api\/evidence\//, '')
      if (!rel) continue
      const src = path.join(evidenceRoot, rel.startsWith('evidence') ? rel : path.join('evidence', rel))
      if (!fs.existsSync(src)) continue
      const stem = `rv_${r.id}_${r.stream_id || 'x'}`
      // 单文件失败（源图被删除/权限不足）只跳过该帧，不中断整体导出
      try {
        fs.copyFileSync(src, path.join(train, stem + '.png'))
      } catch (e) {
        skipped++
        console.error(`[review-export] 复制失败跳过: ${src} (${e.message})`)
        continue
      }
      if (r.review_status === 'true') {
        // 正样本：写框标注（按图片实际尺寸归一化，sharp 读取，避免坐标错位）
        const boxes = parseBoxes(r.boxes)
        let sizeW = 2942, sizeH = 1732
        try {
          const sharp = require('sharp')
          const meta = await sharp(src).metadata()
          if (meta.width && meta.height) { sizeW = meta.width; sizeH = meta.height }
        } catch (e) {}
        const lines = []
        for (const b of boxes) {
          const cx = ((b.x1 + b.x2) / 2) / sizeW
          const cy = ((b.y1 + b.y2) / 2) / sizeH
          const bw = (b.x2 - b.x1) / sizeW
          const bh = (b.y2 - b.y1) / sizeH
          const clsId = Number(b.cls) || 0   // 0=smoke 1=fire 2=house（原样保留）
          if (clsId === 0) smokeBoxes++;
          else if (clsId === 1) fireBoxes++;
          else houseBoxes++;
          lines.push(`${clsId} ${cx.toFixed(6)} ${cy.toFixed(6)} ${bw.toFixed(6)} ${bh.toFixed(6)}`)
        }
        try {
          fs.writeFileSync(path.join(labels, stem + '.txt'), lines.join('\n'))
        } catch (e) {
          skipped++
          console.error(`[review-export] 标注写失败: ${stem} (${e.message})`)
        }
      } else {
        try {
          fs.writeFileSync(path.join(labels, stem + '.txt'), '')
        } catch (e) {
          skipped++
          console.error(`[review-export] 空标注写失败: ${stem} (${e.message})`)
        }
      }
      exported++
    }
    // 导出历史台账（数据资产追溯）
    try {
      db.prepare(
        `INSERT INTO review_exports (exporter, base_dir, exported, smoke_boxes, fire_boxes, house_boxes, trigger_type) VALUES (?,?,?,?,?,?,?)`
      ).run(exporter || '', base, exported, smokeBoxes, fireBoxes, houseBoxes, triggerType)
    } catch (e) { console.error('[review-export] 历史记录失败:', e.message) }
    return { exported, skipped, dir: base, smokeBoxes, fireBoxes, houseBoxes, filter: includeAll ? 'all' : 'clean' }
  }

  // GET 兼容（旧调用方；触发方式记 api）
  app.get('/api/review/export', async (req, res) => {
    try {
      const base = req.query.base || '/video/xunlian/retrain'
      const out = await doExport(base, (req.user && req.user.username) || 'api', 'api', req.query.include_all === '1')
      res.json({ ok: true, ...out })
    } catch (e) { res.json({ ok: false, error: e.message }) }
  })

  // POST 一键导出（第 4 批：前端报表页触发，记录 manual）
  app.post('/api/review/export', async (req, res) => {
    try {
      const base = (req.body && req.body.base) || '/video/xunlian/retrain'
      const out = await doExport(base, (req.user && req.user.username) || '', 'manual', !!(req.body && req.body.include_all))
      res.json({ ok: true, ...out })
    } catch (e) { res.json({ ok: false, error: e.message }) }
  })

  // ── 检测结果统一视图（三合一：全量检测 + 推送状态 + 复检状态）──
  // 主表 straw_detections；推送状态关联 straw 告警(warnings)：
  //   精确路径：straw_detections.warning_id 外键（第 3 批起 straw-engine 落库，替代时间窗近似）
  //   回退路径：无 warning_id 的老记录按 (stream_id + 时间窗 ±90s) 近似关联（第 1 批逻辑保留兼容）
  app.get('/api/straw/results', (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 50, 500)
      const offset = parseInt(req.query.offset) || 0
      const wantPush = req.query.push ? String(req.query.push) : null
      const cond = []
      const args = []
      if (req.query.status) { cond.push('review_status = ?'); args.push(String(req.query.status)) }
      if (req.query.label) { cond.push('label = ?'); args.push(String(req.query.label)) }
      if (req.query.source) { cond.push('source = ?'); args.push(String(req.query.source)) }
      if (req.query.min_conf) { cond.push('max_conf >= ?'); args.push(Number(req.query.min_conf)) }
      if (req.query.stream) { cond.push('stream_id = ?'); args.push(String(req.query.stream)) }
      if (req.query.max_conf) { cond.push('max_conf < ?'); args.push(Number(req.query.max_conf)) }
      if (req.query.from) { cond.push('ts >= ?'); args.push(String(req.query.from)) }
      if (req.query.to) { cond.push('ts <= ?'); args.push(String(req.query.to)) }
      if (req.query.scene) { cond.push('scene = ?'); args.push(String(req.query.scene)) }   // P2 场景筛选（dock/sim/night/day/urban）
      if (req.query.exclude) { cond.push('exclude = 1') }                                    // P2 只看"不纳入判例"标记
      const where = cond.length ? 'WHERE ' + cond.join(' AND ') : ''

      // 告警索引：①id → 告警（精确关联）②streamId → [{t, w}]（时间窗回退）
      const warns = db.prepare(`SELECT id, data_json FROM warnings WHERE id LIKE 'straw-%'`).all()
      const warnById = {}
      const byStream = {}
      for (const row of warns) {
        let w; try { w = JSON.parse(row.data_json) } catch { continue }
        const t = Date.parse(w.createdAt || row.created_at || '')
        if (!isFinite(t) || !w.streamId) continue
        warnById[row.id] = { t, w }
        ;(byStream[w.streamId] = byStream[w.streamId] || []).push({ t, w })
      }
      for (const k of Object.keys(byStream)) byStream[k].sort((a, b) => a.t - b.t)
      const WINDOW = 90 * 1000
      const wpState = (wp) => ({
        pushed: !!wp.pushed,
        held: !!wp.held,
        reason: wp.reason || '',
        cardUrl: wp.cardUrl || '',
        town: wp.town || '',
        unit: wp.unit || '',
        correctedAt: wp.correctedAt || '',
        correctionNote: wp.correctionNote || '',
        correctedBy: wp.correctedBy || '',
        correctionReason: wp.correctionReason || '',
      })
      // 关联推送状态：精确 warning_id 优先，否则同流时间窗内最近告警
      const pushState = (sid, ts, wid) => {
        const t = Date.parse(String(ts).replace(' ', 'T') + '+08:00')
        let best = null
        if (wid && warnById[wid]) best = warnById[wid]
        if (!best && isFinite(t)) {
          const list = byStream[sid] || []
          let bestDiff = WINDOW
          for (const item of list) {
            const d = Math.abs(item.t - t)
            if (d < bestDiff) { best = item; bestDiff = d }
          }
        }
        if (!best) return { status: 'none' }
        const w = best.w
        const wp = w.wechatPush || {}
        const ps = wpState(wp)
        let status
        if (ps.held) status = 'held'                       // ⏸ 待复核后推送（gate=pre 低置信度）
        else if (ps.pushed) status = 'pushed'
        else if (ps.reason) status = 'failed'
        else status = 'pending'
        return {
          status,
          warning_id: w.id,
          ...ps,
          review: w.review || null,
          reviewReason: w.reviewReason || '',
          reviewedBy: w.reviewedBy || '',
        }
      }
      // 三列轻量取全量 → JS 关联/过滤/排序/分页 → 回查完整行（数据量小，SQLite 毫秒级）
      const brief = db.prepare(`SELECT id, stream_id, ts, warning_id, review_status, max_conf, scene, exclude FROM straw_detections ${where}`).all(...args)
      const pushDist = { none: 0, pending: 0, failed: 0, pushed: 0, held: 0 }
      let ids = brief.map(r => {
        const ps = pushState(r.stream_id, r.ts, r.warning_id)
        pushDist[ps.status] = (pushDist[ps.status] || 0) + 1
        return { id: r.id, ts: r.ts, push: ps.status, rs: r.review_status, mc: r.max_conf || 0 }
      })
      if (wantPush) ids = ids.filter(x => x.push === wantPush)
      const sortBy = String(req.query.sort || '')
      if (sortBy === 'pending') ids.sort((a, b) => {
        const pa = a.rs === 'pending' ? 0 : 1, pb = b.rs === 'pending' ? 0 : 1
        return pa !== pb ? pa - pb : (a.ts === b.ts ? b.id - a.id : (a.ts < b.ts ? 1 : -1))
      })
      else if (sortBy === 'conf_desc') ids.sort((a, b) => b.mc - a.mc || (a.ts === b.ts ? b.id - a.id : (a.ts < b.ts ? 1 : -1)))
      else if (sortBy === 'conf_asc') ids.sort((a, b) => a.mc - b.mc || (a.ts === b.ts ? b.id - a.id : (a.ts < b.ts ? 1 : -1)))
      else ids.sort((a, b) => (a.ts === b.ts ? b.id - a.id : (a.ts < b.ts ? 1 : -1)))
      const total = ids.length
      const pageIds = ids.slice(offset, offset + limit).map(x => x.id)
      const rows = pageIds.length
        ? db.prepare(`SELECT * FROM straw_detections WHERE id IN (${pageIds.map(() => '?').join(',')})`).all(...pageIds)
        : []
      rows.sort(sortBy === 'pending'
        ? (a, b) => { const pa = a.review_status === 'pending' ? 0 : 1, pb = b.review_status === 'pending' ? 0 : 1; return pa !== pb ? pa - pb : (a.ts === b.ts ? b.id - a.id : (a.ts < b.ts ? 1 : -1)) }
        : sortBy === 'conf_desc' ? (a, b) => (b.max_conf || 0) - (a.max_conf || 0) || (a.ts === b.ts ? b.id - a.id : (a.ts < b.ts ? 1 : -1))
        : sortBy === 'conf_asc' ? (a, b) => (a.max_conf || 0) - (b.max_conf || 0) || (a.ts === b.ts ? b.id - a.id : (a.ts < b.ts ? 1 : -1))
        : (a, b) => (a.ts === b.ts ? b.id - a.id : (a.ts < b.ts ? 1 : -1)))
      rows.forEach(r => { r.boxes = parseBoxes(r.boxes); r.push = pushState(r.stream_id, r.ts, r.warning_id) })
      const stats = {
        total: db.prepare('SELECT COUNT(*) c FROM straw_detections').get().c,
        pending: db.prepare("SELECT COUNT(*) c FROM straw_detections WHERE review_status='pending'").get().c,
        trueCount: db.prepare("SELECT COUNT(*) c FROM straw_detections WHERE review_status='true'").get().c,
        falseCount: db.prepare("SELECT COUNT(*) c FROM straw_detections WHERE review_status='false'").get().c,
        push: pushDist,
        streams: db.prepare("SELECT DISTINCT stream_id FROM straw_detections WHERE stream_id IS NOT NULL AND stream_id != '' LIMIT 200").all().map(r => r.stream_id),
        // P2 场景分布（前端下拉选项 + 统计卡）
        scenes: db.prepare(`SELECT scene, COUNT(*) c FROM straw_detections GROUP BY scene ORDER BY c DESC`).all(),
      }
      res.json({ ok: true, total, rows, stats })
    } catch (e) { res.json({ ok: false, error: e.message }) }
  })

  // 供 straw-engine 记录检测结果（同机 HTTP 调用）；返回入库 id 供告警精确关联
  app.post('/api/review/record', (req, res) => {
    try {
      const { stream_id, frame_path, boxes, label, source, max_conf } = req.body || {}
      if (!frame_path) return res.json({ ok: false, error: '缺 frame_path' })
      const r = db.prepare(
        `INSERT INTO straw_detections (stream_id, frame_path, boxes, label, source, max_conf) VALUES (?,?,?,?,?,?)`
      ).run(stream_id || '', frame_path, JSON.stringify(boxes || []), label || '', source || 'alert', max_conf || 0)
      res.json({ ok: true, id: Number(r.lastInsertRowid) })
    } catch (e) { res.json({ ok: false, error: e.message }) }
  })

  // ── 复检数据资产报表（第 4 批）──
  // 面向运营/算法迭代的数据资产视图：复检分布、类别分布、复检员工作量、按流/按月统计、置信度分桶、导出历史
  app.get('/api/straw/stats', (req, res) => {
    try {
      const Q = (sql) => db.prepare(sql).all()
      const one = (sql) => db.prepare(sql).get()
      // 1. 复检状态分布
      const verdict = {
        total: one('SELECT COUNT(*) c FROM straw_detections').c,
        pending: one("SELECT COUNT(*) c FROM straw_detections WHERE review_status='pending'").c,
        trueCount: one("SELECT COUNT(*) c FROM straw_detections WHERE review_status='true'").c,
        falseCount: one("SELECT COUNT(*) c FROM straw_detections WHERE review_status='false'").c,
        uncertain: one("SELECT COUNT(*) c FROM straw_detections WHERE review_status='uncertain'").c,
      }
      // 2. label 分布（记录级，按检测结果 label）
      const labels = Q("SELECT label, COUNT(*) c FROM straw_detections GROUP BY label ORDER BY c DESC")
      // 3. 框类别分布（已判真烟的框，从 boxes JSON 统计 cls）
      const boxCls = { smoke: 0, fire: 0, house: 0 }
      for (const r of db.prepare("SELECT boxes FROM straw_detections WHERE review_status='true'").all()) {
        for (const b of parseBoxes(r.boxes)) {
          if (Number(b.cls) === 0) boxCls.smoke++
          else if (Number(b.cls) === 1) boxCls.fire++
          else boxCls.house++
        }
      }
      // 4. 复检员工作量（按 reviewer 各判定计数）
      const reviewers = Q(`SELECT reviewer,
          SUM(CASE WHEN review_status='true' THEN 1 ELSE 0 END) true_cnt,
          SUM(CASE WHEN review_status='false' THEN 1 ELSE 0 END) false_cnt,
          SUM(CASE WHEN review_status='uncertain' THEN 1 ELSE 0 END) uncertain_cnt,
          COUNT(*) total
        FROM straw_detections WHERE reviewer IS NOT NULL AND reviewer != '' GROUP BY reviewer ORDER BY total DESC`)
      // 5. 按流统计 TOP12
      const streams = Q(`SELECT stream_id, COUNT(*) total,
          SUM(CASE WHEN review_status='true' THEN 1 ELSE 0 END) true_cnt,
          SUM(CASE WHEN review_status='false' THEN 1 ELSE 0 END) false_cnt
        FROM straw_detections GROUP BY stream_id ORDER BY total DESC LIMIT 12`)
      // 6. 按月趋势（检测/真烟/误报，近 12 个月）
      const months = Q(`SELECT substr(ts,1,7) ym, COUNT(*) total,
          SUM(CASE WHEN review_status='true' THEN 1 ELSE 0 END) true_cnt,
          SUM(CASE WHEN review_status='false' THEN 1 ELSE 0 END) false_cnt
        FROM straw_detections GROUP BY ym ORDER BY ym DESC LIMIT 12`)
      // 7. 置信度分桶（检测帧 max_conf）
      const confRow = one(`SELECT
          SUM(CASE WHEN max_conf < 0.3 THEN 1 ELSE 0 END) lt03,
          SUM(CASE WHEN max_conf >= 0.3 AND max_conf < 0.5 THEN 1 ELSE 0 END) m03_05,
          SUM(CASE WHEN max_conf >= 0.5 AND max_conf < 0.7 THEN 1 ELSE 0 END) m05_07,
          SUM(CASE WHEN max_conf >= 0.7 AND max_conf < 0.9 THEN 1 ELSE 0 END) m07_09,
          SUM(CASE WHEN max_conf >= 0.9 THEN 1 ELSE 0 END) ge09
        FROM straw_detections`) || {}
      const confs = {
        lt03: confRow.lt03 || 0, m03_05: confRow.m03_05 || 0, m05_07: confRow.m05_07 || 0,
        m07_09: confRow.m07_09 || 0, ge09: confRow.ge09 || 0,
      }
      // 8. 导出历史（数据资产台账）
      const exports = Q('SELECT * FROM review_exports ORDER BY id DESC LIMIT 20')
      res.json({ ok: true, verdict, labels, boxCls, reviewers, streams, months, confs, exports })
    } catch (e) { res.json({ ok: false, error: e.message }) }
  })

  // ── P3-2a 负样本抽检（VLM 干扰物分类 → 人工复核 → 训练负样本）──
  // 数据源：/video/shujuji/datasets/v5_candidates/neg_classified.json（VLM 分类产物）
  // 人工复核结果持久化到 straw_neg_reviews，供 gen_v5_neg_from_reviews.py 消费
  const NEG_CATALOG = '/video/shujuji/datasets/v5_candidates/neg_classified.json'
  const NEG_VALID = { ok: 1, no: 1, dn: 1, pending: 1 }

  const loadNegCatalog = () => {
    try {
      const fs = require('fs')
      if (!fs.existsSync(NEG_CATALOG)) return {}
      return JSON.parse(fs.readFileSync(NEG_CATALOG, 'utf8'))
    } catch (e) {
      console.error('[neg-classify] catalog 读取失败:', e.message)
      return {}
    }
  }

  // 抽检清单 + 复核记录 + 统计（一次拉全，前端本地合并渲染）
  app.get('/api/straw/neg-classify', (req, res) => {
    try {
      const catalog = loadNegCatalog()
      const reviews = db.prepare(`SELECT frame_path, cats, raw, ts, review_status, reviewer, reviewed_at, note FROM straw_neg_reviews`).all()
      const byStatus = { ok: 0, no: 0, dn: 0, pending: 0 }
      let reviewed = 0
      for (const r of reviews) {
        if (r.review_status !== 'pending') reviewed++
        if (byStatus[r.review_status] != null) byStatus[r.review_status]++
      }
      const total = Object.keys(catalog).length
      byStatus.pending = Math.max(0, total - reviewed)
      res.json({ ok: true, catalog, reviews, stats: { total, reviewed, byStatus } })
    } catch (e) { res.json({ ok: false, error: e.message }) }
  })

  // 提交单帧复核（upsert：同一帧重复提交覆盖旧判定）
  app.post('/api/review/neg-classify', (req, res) => {
    try {
      const { frame_path, review_status, note, reviewer } = req.body || {}
      if (!frame_path || !NEG_VALID[review_status]) return res.json({ ok: false, error: '参数错误' })
      const catalog = loadNegCatalog()
      const v = catalog[frame_path] || {}
      const rv = reviewerOf(req, reviewer)
      const r = db.prepare(`
        INSERT INTO straw_neg_reviews (frame_path, cats, raw, ts, review_status, reviewer, reviewed_at, note)
        VALUES (?,?,?,?,?,?,datetime('now','localtime'),?)
        ON CONFLICT(frame_path) DO UPDATE SET
          cats=excluded.cats, raw=excluded.raw, ts=excluded.ts,
          review_status=excluded.review_status, reviewer=excluded.reviewer,
          reviewed_at=excluded.reviewed_at, note=excluded.note
      `).run(frame_path, JSON.stringify(v.cats || []), v.raw || '', v.ts || '', review_status, rv, note || '')
      res.json({ ok: true, saved: r.changes, reviewer: rv })
    } catch (e) { res.json({ ok: false, error: e.message }) }
  })

  // 抽检统计（独立端点，供报表/自动化）
  app.get('/api/straw/neg-classify/stats', (req, res) => {
    try {
      const total = Object.keys(loadNegCatalog()).length
      const rows = db.prepare(`SELECT review_status, COUNT(*) c FROM straw_neg_reviews GROUP BY review_status`).all()
      const byStatus = { ok: 0, no: 0, dn: 0 }
      let reviewed = 0
      for (const r of rows) {
        if (byStatus[r.review_status] != null) byStatus[r.review_status] = r.c
        if (r.review_status !== 'pending') reviewed += r.c
      }
      res.json({ ok: true, stats: { total, reviewed, pending: Math.max(0, total - reviewed), byStatus } })
    } catch (e) { res.json({ ok: false, error: e.message }) }
  })
}

module.exports = { initReviewDb, registerReviewRoutes }
