import subprocess

def sh(cmd):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=15)
    return f"$ {cmd}\n{r.stdout}{r.stderr}\n"

# 1. 查 sqlite 数据库
out = sh("sqlite3 /opt/jsc/backend/data/jsc.db \"SELECT id, name, source_url, app, is_h265 FROM streams WHERE id='c5087b79-3beb-462d-9406-9f0570499ddc' OR source_url LIKE '%c5087b79%' LIMIT 5;\" 2>&1")
print("=== stream 配置 ===")
print(out)

# 2. 查所有H.265的流
out2 = sh("sqlite3 /opt/jsc/backend/data/jsc.db \"SELECT id, name, source_url, app, is_h265 FROM streams WHERE is_h265=1 OR app='jsc_h264' LIMIT 20;\" 2>&1")
print("=== H.265 流列表 ===")
print(out2)

# 3. 查 id=c5087b79 的来源
out3 = sh("sqlite3 /opt/jsc/backend/data/jsc.db \"SELECT * FROM streams WHERE id LIKE 'c5087b79%' LIMIT 3;\" 2>&1")
print("=== id c5087b79 详情 ===")
print(out3)

# 4. 查 zlm config
out4 = sh("docker exec zlmediakit cat /opt/media/conf/config.ini 2>&1 | grep -E 'secret|api|hook' | head -10")
print("=== ZLM API 密钥 ===")
print(out4)
