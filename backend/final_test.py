import subprocess, json, time

def sh(cmd, timeout=20):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
    return r.stdout.strip()

os_cd = "cd /opt/jsc/backend && "
node = "/home/jsc/.nvm/versions/node/v22.22.3/bin/node"

# 1. 验证苏商码头 HLS (之前404)
print("=== 1. 验证苏商码头 HLS ===")
hls = sh("curl -sI 'http://127.0.0.1:6080/jsc/c5087b79-3beb-462d-9406-9f0570499ddc/hls.m3u8' 2>&1 | head -3")
print(f"  HEAD: {hls[:200]}")
m3u8 = sh("curl -s 'http://127.0.0.1:6080/jsc/c5087b79-3beb-462d-9406-9f0570499ddc/hls.m3u8' 2>&1 | head -5")
print(f"  m3u8: {m3u8[:200]}")

# 2. 生成 token
token = sh(f"{os_cd}{node} gen_token.js 2>/dev/null")
print(f"\n=== 2. Token: {token[:20]}...")

# 3. H.265 自动探测: 九龙沙场 UUID
print("\n=== 3. H.265 自动探测: 九龙沙场 ===")
t0 = time.time()
resp = sh(f"curl -s -X POST http://127.0.0.1:7170/api/stream/start "
    f"-H 'Content-Type: application/json' "
    f"-H 'Authorization: Bearer {token}' "
    f"-d '{{\"id\":\"43acf69b-1ac1-4c58-a6a5-5e9e9a6e84e8\",\"url\":\"rtsp://berfenrir:xxxxxxxx@172.16.8.213:554/cam/realmonitor?channel=1&subtype=1\"}}'")
elapsed = time.time() - t0
print(f"  耗时: {elapsed:.1f}s")
try:
    r = json.loads(resp)
    for k in ['ok', 'engine', 'autoDetected', 'probeTimeMs']:
        if k in r: print(f"  {k}: {r[k]}")
    if r.get('hls'):
        print(f"  hls: {r['hls'][:100]}...")
except:
    print(f"  raw: {resp[:300]}")

# 4. ZLM jsc_h264 状态
print("\n=== 4. ZLM jsc_h264 流 ===")
zlm = sh("docker exec zlmediakit curl -s 'http://127.0.0.1:80/index/api/getMediaList?secret=035c73f7-bb6b-4889-a715-d9eb2d192xxx'")
try:
    d = json.loads(zlm)
    for m in d.get('data', []):
        a = m.get('app', '')
        s = m.get('stream', '')
        if a == 'jsc_h264' or '43acf69b' in s or 'c5087b79' in s:
            codes = [t.get('codec_id_name', '?') for t in m.get('tracks', [])]
            alive = m.get('aliveSecond', 0)
            print(f"  {a}/{s:32} codes={codes} alive={alive}s")
except:
    pass

# 5. transcoder.json
print("\n=== 5. transcoder.json ===")
tj = sh("cat /opt/jsc/backend/data/transcoder.json")
try:
    d = json.loads(tj)
    print(f"  {len(d)} 个已注册流")
    for sid, entry in d.items():
        print(f"    {sid} -> {entry['transcodeId']}")
except:
    pass

# 6. 日志
print("\n=== 6. 最新日志 ===")
log = sh("grep -E '探码成功|探码失败|智能注册|H.265 透明|启动结果' /tmp/jsc-server.log | tail -10")
print(log[:1500])
