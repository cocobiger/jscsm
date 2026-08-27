'use strict'
/**
 * 司空媒体文件归档监视器（2026-08-27 第 3 批）
 * 只读宿主机 MinIO 挂载目录（/video/xka/docker_volumes/minio/data/test），不违反隔离红线：
 *   ① dock_media/**     任务媒体（_T 热成像/_V 可见光照片、_T/_S 视频、NAV/MRK 导航文件）→ 训练样本+证据
 *   ② __defaultVhost__/**  ZLM 录制 mp4（多 part 分片，记录元数据）
 *   ③ fly_record_osd_file/**  飞行 OSD json（机场 OSD 序列，776 条/次任务）
 * MinIO 对象存储格式：<对象目录>/xl.meta + <uuid>/part.N（单 part 小文件 part.1 即完整内容）
 * 照片自动回流：单 part jpeg → 复制到 straw-engine evidence/media/（训练样本候选）
 */
const fs = require('fs')
const path = require('path')

module.exports = (config, opts = {}) => {
  const root = config.minioDataRoot || '/video/xka/docker_volumes/minio/data/test'
  const evidenceDir = opts.evidenceDir || '/opt/jsc/straw-engine/evidence/media'
  const seen = new Map() // relPath -> meta
  let timer = null
  let lastScan = null
  let lastError = ''

  function kindOf(rel) {
    if (rel.includes('/dock_media/')) {
      if (/\.(jpe?g|png)$/i.test(rel)) return 'photo'
      if (/\.mp4$/i.test(rel)) return 'video'
      return 'media-file'
    }
    if (rel.startsWith('/__defaultVhost__/')) return 'record'
    if (rel.includes('/fly_record_osd_file/')) return 'osd-json'
    if (rel.includes('/fly_record_file/')) return 'fly-record'
    if (rel.includes('/route_file/') || rel.includes('/route_thumbnail/')) return 'route'
    return 'other'
  }

  function extractSn(rel) {
    const m = rel.match(/(8UU[XD][A-Z0-9]{8,}|1581F[A-Z0-9]{10,})/)
    return m ? m[1] : ''
  }

  /** 递归扫描 MinIO 对象目录（含 xl.meta 的目录即对象） */
  function scanDir(dir, base, out) {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { return }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const fp = path.join(dir, e.name)
      const rel = base + '/' + e.name
      if (fs.existsSync(path.join(fp, 'xl.meta'))) {
        out.push(rel)
      } else {
        scanDir(fp, rel, out)
      }
    }
  }

  /** 读对象分片信息（part.N 列表 + 总大小） */
  function objectInfo(objDir) {
    const parts = []
    try {
      for (const u of fs.readdirSync(objDir)) {
        const pd = path.join(objDir, u)
        if (!fs.statSync(pd).isDirectory()) continue
        for (const f of fs.readdirSync(pd)) {
          if (f.startsWith('part.')) {
            const n = parseInt(f.slice(5), 10)
            if (n > 0) parts.push({ n, fp: path.join(pd, f), size: fs.statSync(path.join(pd, f)).size })
          }
        }
      }
    } catch (e) {}
    parts.sort((a, b) => a.n - b.n)
    return {
      parts: parts.length,
      totalSize: parts.reduce((s, p) => s + p.size, 0),
      singlePart: parts.length === 1,
      firstPart: parts[0] ? parts[0].fp : null,
    }
  }

  /** 提取单 part 对象的纯净负载（剥离 MinIO XL2 头部 padding：JPEG 按 magic 截取 SOI→EOI） */
  function extractPayload(buf, kind) {
    if (kind === 'photo') {
      const s = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff])) // JPEG SOI
      if (s >= 0) {
        const e = buf.lastIndexOf(Buffer.from([0xff, 0xd9])) // JPEG EOI
        return e > s ? buf.slice(s, e + 2) : buf.slice(s)
      }
    }
    return buf
  }

  async function tick() {
    lastError = ''
    try {
      const objs = []
      scanDir(root, '', objs)
      for (const rel of objs) {
        const kind = kindOf(rel)
        if (kind === 'other' || kind === 'media-file' || kind === 'route') continue
        const objDir = path.join(root, rel)
        let st
        try { st = fs.statSync(objDir) } catch (e) { continue }
        const prev = seen.get(rel)
        if (prev && prev.mtimeMs === st.mtimeMs) continue
        const info = objectInfo(objDir)
        const meta = {
          kind,
          path: rel.replace(/^\//, ''),
          name: rel.split('/').pop(),
          size: info.totalSize,
          parts: info.parts,
          mtime: st.mtime.toISOString(),
          sn: extractSn(rel),
        }
        seen.set(rel, { mtimeMs: st.mtimeMs, ...meta })

        // 新照片自动回流（单 part jpeg → evidence/media，训练样本候选；剥离 XL2 头部）
        if (!prev && kind === 'photo' && info.singlePart && opts.archivePhotos !== false) {
          try {
            fs.mkdirSync(evidenceDir, { recursive: true })
            const dst = path.join(evidenceDir, meta.name)
            const payload = extractPayload(fs.readFileSync(info.firstPart), kind)
            fs.writeFileSync(dst, payload)
            meta.archived = dst
            opts.onEvent && opts.onEvent({ ts: meta.mtime, type: 'FILE_UPLOAD_COMPLETE', classified: 'media', deviceSn: meta.sn, detail: `媒体照片归档 ${meta.name}（${(meta.size / 1024).toFixed(0)}KB）→ evidence/media`, source: 'media-watcher' })
          } catch (e) { meta.archiveError = e.message }
        }
        if (!prev && (kind === 'record' || kind === 'video')) {
          opts.onEvent && opts.onEvent({ ts: meta.mtime, type: 'FILE_UPLOAD_COMPLETE', classified: 'media', deviceSn: meta.sn, detail: `${kind === 'record' ? '录制' : '任务视频'} ${meta.name}（${(meta.size / 1048576).toFixed(1)}MB, ${info.parts} parts）`, source: 'media-watcher' })
        }
      }
      lastScan = new Date().toISOString()
    } catch (e) {
      lastError = e.message
    }
  }

  return {
    start() { timer = setInterval(tick, 60000); tick() },
    stop() { if (timer) clearInterval(timer) },
    list(limit = 200, kind = null) {
      const arr = []
      for (const { mtimeMs, ...m } of seen.values()) {
        if (kind && m.kind !== kind) continue
        arr.push(m)
      }
      return arr.slice(-limit).reverse()
    },
    status() {
      const byKind = {}
      for (const v of seen.values()) byKind[v.kind] = (byKind[v.kind] || 0) + 1
      return { running: !!timer, count: seen.size, byKind, lastScan, lastError, evidenceDir }
    },
  }
}
