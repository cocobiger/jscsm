#!/usr/bin/env python3
"""
通过 ZLM addStreamProxy 推流测试，验证6路RTSP在ZLM里能成功注册
"""
import urllib.request
import urllib.parse
import json
import time

SECRET = '035c73f7-bb6b-4889-a715-d9eb2d192xxx'
ZLM_API = 'http://172.17.0.2/index/api'

streams = [
    ("苏商码头",   "test_ch2",  "rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=2&subtype=0"),
    ("九龙沙场",   "test_ch4",  "rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=4&subtype=0"),
    ("龙泗路",     "test_ch5",  "rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=5&subtype=0"),
    ("彼迪",       "test_ch6",  "rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=6&subtype=0"),
    ("万源玻璃",   "test_ch7",  "rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=7&subtype=0"),
    ("华歌",       "test_hg",   "rtsp://berfenrir:xxxxxxxx@172.16.8.51:554/cam/realmonitor?channel=1&subtype=1"),
]

def call(path, **params):
    qs = urllib.parse.urlencode({**params, 'secret': SECRET})
    url = f"{ZLM_API}/{path}?{qs}"
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        return {'error': str(e)}

# 添加代理
print("=== 添加 ZLM 代理 ===")
for name, sid, url in streams:
    res = call('addStreamProxy', vhost='__defaultVhost__', app='jsc', stream=sid, url=url)
    code = res.get('code', -1)
    msg = res.get('msg', res.get('error', ''))
    print(f"  {name:8} [{sid:10}] code={code} {msg[:80]}")

# 等待 5 秒让流稳定
print("\n=== 等待 5 秒让流稳定 ===")
time.sleep(5)

# 查询媒体列表
print("\n=== ZLM 媒体列表（test_* 流） ===")
res = call('getMediaList')
for m in res.get('data', []):
    if m['stream'].startswith('test_'):
        print(f"  {m['app']}/{m['stream']:12} {m.get('bytesSpeed', 0):>8} B/s  readers={m.get('readers', 0)}")

# 探测每个流的实际编码
print("\n=== 探测转码后 HLS 编码 ===")
import subprocess
for name, sid, url in streams:
    hls = f"http://172.17.0.2/jsc/{sid}/hls.m3u8"
    try:
        r = subprocess.run(
            ["ffmpeg", "-i", hls, "-t", "2", "-f", "null", "-"],
            capture_output=True, text=True, timeout=12
        )
        out = r.stderr
        codec = "?"
        for line in out.split('\n'):
            s = line.strip()
            if 'Stream #0:0: Video:' in s and 'wrapped' not in s:
                codec = s.split('Video: ')[1].split(',')[0] if 'Video: ' in s else s
                break
        print(f"  {name:8} [{sid:10}] 编码: {codec}")
    except subprocess.TimeoutExpired:
        print(f"  {name:8} [{sid:10}] 编码: TIMEOUT (无法探测)")
    except Exception as e:
        print(f"  {name:8} [{sid:10}] 编码: ERR {e}")

# 清理
print("\n=== 清理 test_* 代理 ===")
for _, sid, _ in streams:
    res = call('delStreamProxy', vhost='__defaultVhost__', app='jsc', stream=sid)
    print(f"  {sid}: {res.get('code', -1)} {res.get('msg', '')[:50]}")
