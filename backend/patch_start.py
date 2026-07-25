import sys
path = '/opt/jsc/backend/index.js'
with open(path, 'r', encoding='utf-8') as f:
    src = f.read()

old = (
    "  streamMonitor.start({\n"
    "    loadStreams,\n"
    "    updateStreamStatus: (id, patch) => store.collPatchById('streams', id, patch),\n"
    "    logger: log, intervalMs: 60000, timeoutMs: 8000,\n"
    "  })\n"
    "})"
)
new = (
    "  streamMonitor.start({\n"
    "    loadStreams,\n"
    "    updateStreamStatus: (id, patch) => store.collPatchById('streams', id, patch),\n"
    "    logger: log, intervalMs: 60000, timeoutMs: 8000,\n"
    "  })\n"
    "  // 启动 H.265 转码 worker（仅作用于白名单 3 个 H.265 源，对其他流完全透明）\n"
    "  transcoder.init({ log, zlm, dataDir: DATA_DIR })\n"
    "  const h265Sources = [\n"
    "    { streamId: 's9gt5zu', rtspUrl: 'rtsp://berfenrir:xxxxxxxx@172.16.8.213:554/cam/realmonitor?channel=1&subtype=1' },\n"
    "    { streamId: 's2xqr8g', rtspUrl: 'rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=2&subtype=1' },\n"
    "    { streamId: 'sqs45b3', rtspUrl: 'rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=3&subtype=1' },\n"
    "  ]\n"
    "  transcoder.startAll(h265Sources).catch(e => log.error('transcoder 启动失败: ' + e.message))\n"
    "  // 优雅退出：只停自己的 worker，不动 ZLM 容器\n"
    "  for (const sig of ['SIGTERM', 'SIGINT']) {\n"
    "    process.on(sig, () => { transcoder.stopAll(); process.exit(0) })\n"
    "  }\n"
    "})"
)
if old not in src:
    print('ERR: block not found')
    sys.exit(1)
src = src.replace(old, new, 1)
with open(path, 'w', encoding='utf-8') as f:
    f.write(src)
print('OK')
