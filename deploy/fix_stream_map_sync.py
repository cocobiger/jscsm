import re

filepath = r'/opt/jsc/backend/index.js'
with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

# ---- 1. Insert helper function before "const loadStreams" ----
marker = 'const loadStreams'
helper = r"""
// ── 视频流→地图点位同步 ──────────────────────────────
// 新增/修改/删除视频流时，同步维护 coll_map_points 表
function syncStreamMapPoint(action, stream) {
  // action: 'upsert' | 'delete'
  if (!stream || !stream.id) return;
  const Database = require('better-sqlite3');
  const dbPath = '/opt/jsc/backend/data/jsc.db';
  let db = null;
  try {
    db = new Database(dbPath);
    if (action === 'delete') {
      db.prepare('DELETE FROM coll_map_points WHERE id = ?').run(stream.id);
      console.log('[map-point] deleted:', stream.id);
    } else {
      const lat = Number(stream.lat);
      const lon = Number(stream.lon);
      if (lat && lon) {
        const pt = JSON.stringify({ id: stream.id, type: 'camera', name: stream.name || '', lat, lon });
        db.prepare('INSERT OR REPLACE INTO coll_map_points (id, data_json) VALUES (?, ?)').run(stream.id, pt);
        console.log('[map-point] upserted:', stream.id, stream.name);
      } else {
        db.prepare('DELETE FROM coll_map_points WHERE id = ?').run(stream.id);
        console.log('[map-point] cleared (no lat/lon):', stream.id);
      }
    }
  } catch(e) {
    console.warn('[map-point] sync failed:', e.message);
  } finally {
    if (db) db.close();
  }
}

"""

if '// ── 视频流→地图点位同步' in content:
    print('⚠️ 同步函数已存在，跳过插入')
else:
    if marker in content:
        idx = content.index(marker)
        content = content[:idx] + helper + '\n' + content[idx:]
        print('✅ 辅助函数已插入')
    else:
        print('❌ 找不到插入位置（const loadStreams）')
        raise SystemExit(1)

# ---- 2. Modify POST /api/streams ----
old_post = """app.post('/api/streams', (req, res) => {
  const { name, location = '', lat = '', lon = '', url = '', group = '道路监控', offline = false, protocol = 'rtsp', thumbnail = '', gb28181Config } = req.body
  if (!name) return res.status(400).json({ error: '缺少 name' })
  const stream = { id: uuidv4(), name, location, lat, lon, url, group, offline: !!offline, protocol, ...(thumbnail ? { thumbnail } : {}), ...(gb28181Config ? { gb28181Config } : {}) }
  const streams = loadStreams()
  streams.push(stream)
  saveStreams(streams)
  res.status(201).json(stream)
})"""

new_post = """app.post('/api/streams', (req, res) => {
  const { name, location = '', lat = '', lon = '', url = '', group = '道路监控', offline = false, protocol = 'rtsp', thumbnail = '', gb28181Config } = req.body
  if (!name) return res.status(400).json({ error: '缺少 name' })
  const stream = { id: uuidv4(), name, location, lat, lon, url, group, offline: !!offline, protocol, ...(thumbnail ? { thumbnail } : {}), ...(gb28181Config ? { gb28181Config } : {}) }
  const streams = loadStreams()
  streams.push(stream)
  saveStreams(streams)
  // 同步到地图点位
  syncStreamMapPoint('upsert', stream)
  res.status(201).json(stream)
})"""

if old_post in content:
    content = content.replace(old_post, new_post, 1)
    print('✅ POST /api/streams 已修改')
else:
    print('❌ 找不到 POST /api/streams （内容可能已变动）')

# ---- 3. Modify PATCH /api/streams/:id ----
old_patch = """app.patch('/api/streams/:id', (req, res) => {
  const streams = loadStreams()
  const idx = streams.findIndex(s => s.id === req.params.id)
  if (idx === -1) return res.status(404).json({ error: '未找到' })
  streams[idx] = { ...streams[idx], ...req.body, id: streams[idx].id }
  saveStreams(streams)
  res.json(streams[idx])
})"""

new_patch = """app.patch('/api/streams/:id', (req, res) => {
  const streams = loadStreams()
  const idx = streams.findIndex(s => s.id === req.params.id)
  if (idx === -1) return res.status(404).json({ error: '未找到' })
  streams[idx] = { ...streams[idx], ...req.body, id: streams[idx].id }
  saveStreams(streams)
  // 同步到地图点位
  syncStreamMapPoint('upsert', streams[idx])
  res.json(streams[idx])
})"""

if old_patch in content:
    content = content.replace(old_patch, new_patch, 1)
    print('✅ PATCH /api/streams/:id 已修改')
else:
    print('❌ 找不到 PATCH /api/streams/:id （内容可能已变动）')

# ---- 4. Modify DELETE /api/streams/:id ----
old_delete = """app.delete('/api/streams/:id', (req, res) => {
  const streams = loadStreams()
  const next = streams.filter(s => s.id !== req.params.id)
  if (next.length === streams.length) return res.status(404).json({ error: '未找到' })
  saveStreams(next)
  if (activeForwards.has(req.params.id)) { activeForwards.get(req.params.id).proc.kill(); activeForwards.delete(req.params.id) }
  res.json({ ok: true })
})"""

new_delete = """app.delete('/api/streams/:id', (req, res) => {
  const streams = loadStreams()
  const toDelete = streams.find(s => s.id === req.params.id)
  const next = streams.filter(s => s.id !== req.params.id)
  if (next.length === streams.length) return res.status(404).json({ error: '未找到' })
  saveStreams(next)
  // 同步删除地图点位
  if (toDelete) syncStreamMapPoint('delete', toDelete)
  if (activeForwards.has(req.params.id)) { activeForwards.get(req.params.id).proc.kill(); activeForwards.delete(req.params.id) }
  res.json({ ok: true })
})"""

if old_delete in content:
    content = content.replace(old_delete, new_delete, 1)
    print('✅ DELETE /api/streams/:id 已修改')
else:
    print('❌ 找不到 DELETE /api/streams/:id （内容可能已变动）')

# ---- 5. Write back ----
with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)

print('\n✅ index.js 修改完成')
PYEOF