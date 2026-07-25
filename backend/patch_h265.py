import sys
path = '/opt/jsc/backend/index.js'
with open(path, 'r', encoding='utf-8') as f:
    src = f.read()
old = (
    "  const h265Sources = [\n"
    "    { streamId: 's9gt5zu', rtspUrl: 'rtsp://berfenrir:xxxxxxxx@172.16.8.213:554/cam/realmonitor?channel=1&subtype=1' },\n"
    "    { streamId: 's2xqr8g', rtspUrl: 'rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=2&subtype=1' },\n"
    "    { streamId: 'sqs45b3', rtspUrl: 'rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=3&subtype=1' },\n"
    "  ]\n"
)
new = (
    "  const h265Sources = [\n"
    "    { streamId: 's9gt5zu', rtspUrl: 'rtsp://berfenrir:xxxxxxxx@172.16.8.213:554/cam/realmonitor?channel=1&subtype=1' },\n"
    "    { streamId: 's2xqr8g', rtspUrl: 'rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=2&subtype=1' },\n"
    "    // sqs45b3 暂时禁用：172.16.8.50 ch3 无 RTSP 信号源（ffmpeg 反复退码 183）\n"
    "    // { streamId: 'sqs45b3', rtspUrl: 'rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=3&subtype=1' },\n"
    "  ]\n"
)
if old in src:
    src = src.replace(old, new, 1)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(src)
    print('OK')
else:
    print('NOT FOUND')
    sys.exit(1)
