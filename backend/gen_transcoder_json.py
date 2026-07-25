import json, os

# 迁移现有的4路H.265源配置到 transcoder.json
config = {
    "s9gt5zu": {
        "transcodeId": "s9gt5zu_h264",
        "rtspUrl": "rtsp://berfenrir:xxxxxxxx@172.16.8.213:554/cam/realmonitor?channel=1&subtype=1",
        "createdAt": "2026-06-17T00:00:00Z"
    },
    "s2xqr8g": {
        "transcodeId": "s2xqr8g_h264",
        "rtspUrl": "rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=2&subtype=1",
        "createdAt": "2026-06-17T00:00:00Z"
    },
    "s2xqr8f": {
        "transcodeId": "s2xqr8f_h264",
        "rtspUrl": "rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=6&subtype=0",
        "createdAt": "2026-06-17T00:00:00Z"
    },
    "sqs45b4": {
        "transcodeId": "sqs45b4_h264",
        "rtspUrl": "rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=7&subtype=0",
        "createdAt": "2026-06-17T00:00:00Z"
    }
}
print(json.dumps(config, ensure_ascii=False, indent=2))
