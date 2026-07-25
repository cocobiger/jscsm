import subprocess, json, urllib.request, sys

def sh(cmd):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=15)
    return r.stdout + r.stderr

# 1. ZLM 流状态
print("=== ZLM 推流状态 ===")
zlm = sh("docker exec zlmediakit curl -s 'http://127.0.0.1:80/index/api/getMediaList?secret=035c73f7-bb6b-4889-a715-d9eb2d192xxx'")
try:
    d = json.loads(zlm)
    for m in d.get('data', []):
        tracks = m.get('tracks', [])
        codes = [t.get('codec_id_name', '?') for t in tracks]
        app = m.get('app', '')
        stream = m.get('stream', '')
        alive = m.get('aliveSecond', 0)
        print(f"  {app}/{stream:32} codes={codes} alive={alive}s")
    if not d.get('data'):
        print("  (无在线流)")
except json.JSONDecodeError as e:
    print(f"  JSON解析失败: {e}\n  原始输出: {zlm[:200]}")

# 2. ffmpeg 进程
print("\n=== ffmpeg worker 进程 ===")
out = sh("ps -ef | grep ffmpeg | grep -v grep")
count = len([l for l in out.strip().split('\n') if l])
print(f"  {count} 个 ffmpeg 进程")
for l in out.strip().split('\n'):
    if 'jsc_h264' in l:
        print(f"  {l[80:160]}")

# 3. API 认证获取
print("\n=== API 认证 ===")
login = sh("curl -s http://127.0.0.1:7170/api/auth/login -H 'Content-Type: application/json' -d '{\"username\":\"admin\",\"password\":\"admin123\"}'")
print(f"  登录: {login[:200]}")
try:
    tok = json.loads(login)
    token = tok.get('token', '')
except:
    token = ""

# 4. API 智能探测测试（苏商码头 ch2 subtype=0 H.264）
if token:
    print("\n=== 智能探测: 苏商码头 H.264 (new UUID) ===")
    resp = sh(f"""curl -s -X POST http://127.0.0.1:7170/api/stream/start \
      -H 'Content-Type: application/json' \
      -H 'Authorization: Bearer {token}' \
      -d '{{"id":"c5087b79-3beb-462d-9406-9f0570499ddc","url":"rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=2&subtype=0"}}'""")
    print(f"  响应: {resp[:500]}")
    try:
        r = json.loads(resp)
        for k in ['ok', 'engine', 'autoDetected', 'probeTimeMs', 'hls', 'flv']:
            if k in r:
                print(f"    {k}: {r[k]}")
    except:
        pass

# 5. transcoder.json 当前内容
print("\n=== transcoder.json ===")
out = sh("cat /opt/jsc/backend/data/transcoder.json")
print(f"  {len(json.loads(out))} 个注册流")
for sid, entry in json.loads(out).items():
    print(f"    {sid} -> {entry['transcodeId']}")

# 6. 日志
print("\n=== 最新日志 ===")
out = sh("grep -E '启动结果|smartAdd|探码成功|探码失败|智能|probe' /tmp/jsc-server.log | tail -10")
print(out[:1000])
