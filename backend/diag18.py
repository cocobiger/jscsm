import subprocess, json, urllib.request, urllib.parse

SECRET = "035c73f7-bb6b-4889-a715-d9eb2d192xxx"
BASE = "http://172.17.0.2:80"

# 清理测试流
for s in ['c5087b79-test', 's2xqr8g', 's9gt5zu', 's2xqr8f', 'sqs45b4']:
    try:
        key = f"__defaultVhost__/jsc/{s}"
        r = urllib.request.urlopen(f"{BASE}/index/api/delStreamProxy?secret={SECRET}&key={urllib.parse.quote(key)}", timeout=3)
        print(f"del {s}: {r.read().decode()}")
    except: pass
    try:
        key = f"__defaultVhost__/jsc_h264/{s}"
        r = urllib.request.urlopen(f"{BASE}/index/api/delStreamProxy?secret={SECRET}&key={urllib.parse.quote(key)}", timeout=3)
        print(f"del jsc_h264/{s}: {r.read().decode()}")
    except: pass
