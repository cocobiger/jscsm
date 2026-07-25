#!/usr/bin/env python3
"""
修复服务器时区问题:
1. 修改 device-status SQL: datetime('now') → datetime('now','localtime')
2. 设置 TZ=Asia/Shanghai 重启 node 进程
3. 修复 systemd service 加入 TZ 环境变量
"""
import subprocess, os, time

def sh(cmd, timeout=15):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
    out = r.stdout + r.stderr
    return out.strip()

NODE = "/home/jsc/.nvm/versions/node/v22.22.3/bin/node"
INDEX_JS = "/opt/jsc/backend/index.js"

# === 1. 修补 index.js: datetime('now', '-' → datetime('now', 'localtime', '-' ===
print("=== 1. 修补 index.js device-status SQL ===")
with open(INDEX_JS, 'r', encoding='utf-8') as f:
    content = f.read()

old_sql = "datetime('now', '-' || ? || ' hours')"
new_sql = "datetime('now', 'localtime', '-' || ? || ' hours')"

if old_sql in content:
    content = content.replace(old_sql, new_sql, 1)  # 只替换第一处(第1090行)
    with open(INDEX_JS, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"  ✅ 已替换: {old_sql} → {new_sql}")
else:
    # 检查是否已经修过
    if new_sql in content:
        print(f"  ⚠️ 已经修改过，跳过")
    else:
        print(f"  ❌ 未找到目标字符串!")
        exit(1)

# === 2. 停止旧进程 ===
print("\n=== 2. 停止旧 node 进程 ===")
old_pid = sh("pgrep -f 'node.*index.js' | head -1")
if old_pid:
    sh(f"kill {old_pid}")
    time.sleep(3)
    sh(f"kill -9 {old_pid} 2>/dev/null")
    print(f"  已停止 PID {old_pid}")
else:
    print("  无运行中的 node 进程")
time.sleep(2)

# === 3. 用 TZ=Asia/Shanghai 重启 ===
print("\n=== 3. 用 TZ=Asia/Shanghai 重启 ===")
os.chdir("/opt/jsc/backend")
env = os.environ.copy()
env["TZ"] = "Asia/Shanghai"

# 用 setsid 脱离 SSH 会话
import subprocess as sp
proc = sp.Popen(
    f'TZ=Asia/Shanghai setsid {NODE} index.js > /tmp/jsc-server.log 2>&1 < /dev/null &',
    shell=True,
    cwd="/opt/jsc/backend"
)
time.sleep(1)
print(f"  启动命令: TZ=Asia/Shanghai setsid {NODE} index.js")

# 验证进程
time.sleep(4)
new_pid = sh("pgrep -f 'node.*index.js' | head -1")
if new_pid:
    print(f"  ✅ node 进程已启动 (PID {new_pid})")
else:
    print(f"  ❌ node 进程未启动!")

# 验证 TZ 环境变量
tz_check = sh(f"cat /proc/{new_pid}/environ 2>/dev/null | tr '\\0' '\\n' | grep TZ")
print(f"  TZ 环境变量: {tz_check}")

# === 4. 修复 systemd service ===
print("\n=== 4. 修复 systemd service ===")
service_path = "/etc/systemd/system/jsc-backend.service"
with open(service_path, 'r') as f:
    svc = f.read()

if "TZ=Asia/Shanghai" not in svc:
    # 在 [Service] 段添加 Environment=TZ=Asia/Shanghai
    if "[Service]" in svc:
        svc = svc.replace("[Service]", "[Service]\nEnvironment=TZ=Asia/Shanghai")
    else:
        svc += "\n[Service]\nEnvironment=TZ=Asia/Shanghai\n"
    with open(service_path, 'w') as f:
        f.write(svc)
    print("  ✅ 已添加 Environment=TZ=Asia/Shanghai")
else:
    print("  ⚠️ 已存在 TZ 设置，跳过")

sh("systemctl daemon-reload")
print("  已执行 systemctl daemon-reload")

# === 5. 验证 ===
print("\n=== 5. 验证 ===")
# 日志
log_tail = sh("tail -15 /tmp/jsc-server.log")
print(f"日志尾部:\n{log_tail}")

# 时区验证
server_tz = sh("date '+%Z %z'")
print(f"\n服务器系统时区: {server_tz}")
node_tz = sh(f"{NODE} -e \"console.log(process.env.TZ || '(not set)'); console.log(new Date().toString())\"")
print(f"Node 进程时区: {node_tz}")

print("\n=== 完成 ===")
print("等待下一个采集周期(最多5分钟)验证数据是否正常入库...")
