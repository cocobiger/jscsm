import sys

path = '/opt/jsc/backend/index.js'
with open(path, 'r', encoding='utf-8') as f:
    src = f.read()

old = """  const h265Sources = [
    { streamId: 's9gt5zu', rtspUrl: 'rtsp://berfenrir:xxxxxxxx@172.16.8.213:554/cam/realmonitor?channel=1&subtype=1' },
    { streamId: 's2xqr8g', rtspUrl: 'rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=2&subtype=1' },
    // sqs45b3 暂时禁用：172.16.8.50 ch3 无 RTSP 信号源（ffmpeg 反复退码 183）
    // { streamId: 'sqs45b3', rtspUrl: 'rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=3&subtype=1' },
  ]"""

new = """  const h265Sources = [
    { streamId: 's9gt5zu', rtspUrl: 'rtsp://berfenrir:xxxxxxxx@172.16.8.213:554/cam/realmonitor?channel=1&subtype=1' },
    { streamId: 's2xqr8g', rtspUrl: 'rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=2&subtype=1' },
    // sqs45b3 暂时禁用：172.16.8.50 ch3 无 RTSP 信号源（ffmpeg 反复退码 183）
    // { streamId: 'sqs45b3', rtspUrl: 'rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=3&subtype=1' },
    // 172.16.8.50 ch6 彼迪 - 主码流 subtype=0 H.265 1280x720
    { streamId: 's2xqr8f', rtspUrl: 'rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=6&subtype=0' },
    // 172.16.8.50 ch7 万源玻璃 - 主码流 subtype=0 H.265 2560x1440
    { streamId: 'sqs45b4', rtspUrl: 'rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=7&subtype=0' },
  ]"""

if old not in src:
    print('NOT FOUND')
    sys.exit(1)

src = src.replace(old, new, 1)
with open(path, 'w', encoding='utf-8') as f:
    f.write(src)
print('OK')
