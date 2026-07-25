import subprocess, json, urllib.request

def sh(cmd):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=15)
    return f"$ {cmd}\n{r.stdout}{r.stderr}\n"

# 1. 容器内查ZLM API
out = sh("docker exec zlmediakit curl -s 'http://127.0.0.80/index/api/getMediaList?secret=035c9f2f02ca2c3c0e9c1d1ebfc7xxxx' 2>&1 | head -50")
print("=== 容器内 getMediaList ===")
print(out[:2000])

# 2. 容器内查 RTSP 流列表
out2 = sh("docker exec zlmediakit curl -s 'http://127.0.0.80/index/api/getRtpInfo?secret=035c9f2f02ca2c3c0e9c1d1ebfc7xxxx' 2>&1 | head -30")
print("=== getRtpInfo ===")
print(out2[:1500])

# 3. 后端进程
out3 = sh("ps -ef | grep -E 'node|ffmpeg' | grep -v grep | head -20")
print("=== 进程 ===")
print(out3)

# 4. 日志
out4 = sh("ls -la /opt/jsc/backend/ 2>/dev/null; tail -30 /opt/jsc/backend/log 2>/dev/null | head -40")
print("=== 日志 ===")
print(out4[:2000])
