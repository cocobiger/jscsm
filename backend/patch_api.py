import sys
path = '/opt/jsc/backend/index.js'
with open(path, 'r', encoding='utf-8') as f:
    src = f.read()

old = (
    "app.get('/api/zlm/play-urls', (req, res) => {\n"
    "  const app = req.query.app || 'jsc'\n"
    "  const stream = req.query.stream || 'test'\n"
    "  res.json(zlm.playUrls(String(app), String(stream)))\n"
    "})\n"
)
new = (
    "app.get('/api/zlm/play-urls', (req, res) => {\n"
    "  const app = req.query.app || 'jsc'\n"
    "  const stream = req.query.stream || 'test'\n"
    "  res.json(zlm.playUrls(String(app), String(stream)))\n"
    "})\n"
    "\n"
    "// H.265 转码 worker 状态查询（管理用，不影响其他 API）\n"
    "app.get('/api/transcoder/status', (req, res) => {\n"
    "  res.json({ workers: transcoder.listWorkers() })\n"
    "})\n"
)
if old not in src:
    print('ERR')
    sys.exit(1)
src = src.replace(old, new, 1)
with open(path, 'w', encoding='utf-8') as f:
    f.write(src)
print('OK')
