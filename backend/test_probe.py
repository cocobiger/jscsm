import subprocess, json, time, os

def sh(cmd, timeout=20):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
    return r.stdout + r.stderr

os.chdir('/opt/jsc/backend')

# 1. 生成 admin token
print("=== 1. 生成 token ===")
token_js = """
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const s = new DatabaseSync('data/jsc.db');
const user = s.prepare("SELECT * FROM users WHERE username='admin'").get();
const token = crypto.randomBytes(32).toString('hex');
const expires_at = Date.now() + 3600000;
s.prepare("INSERT INTO sessions (token, user_id, username, role, expires_at) VALUES (?,?,?,?,?)").run(token, user.id, user.username, user.role, expires_at);
console.log(token);
"""
token = sh(f"/home/jsc/.nvm/versions/node/v22.22.3/bin/node -e '{token_js}'").strip()
print(f"  token: {token[:20]}...")

# 2. 测试智能探测: 苏商码头 H.264 UUID
print("\n=== 2. 智能探测: 苏商码头 H.264 (UUID=c5087b79-...) ===")
t0 = time.time()
resp = sh(f"""curl -s -X POST http://127.0.0.1:7170/api/stream/start \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer {token}' \
  -d '{{"id":"c5087b79-3beb-462d-9406-9f0570499ddc","url":"rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=2&subtype=0"}}'""")
elapsed = time.time() - t0
print(f"  耗时: {elapsed:.1f}s")
try:
    r = json.loads(resp)
    print(f"  ok: {r.get('ok')}")
    print(f"  engine: {r.get('engine')}")
    print(f"  autoDetected: {r.get('autoDetected')}")
    if 'probeTimeMs' in r:
        print(f"  probeTimeMs: {r.get('probeTimeMs')}")
    if 'hls' in r:
        hls = r['hls']
        print(f"  hls: {hls[:90]}...")
    if 'flv' in r:
        print(f"  flv: {r['flv'][:90]}...")
except:
    print(f"  raw: {resp[:300]}")

# 3. 日志
print("\n=== 3. 探码日志 ===")
log = sh("grep -E '探码成功|探码失败|smartAdd|智能注册|H.265 透明' /tmp/jsc-server.log | tail -8")
print(log[:1000])
