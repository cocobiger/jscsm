import urllib.request, json, subprocess

def sh(cmd):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=10)
    print(f"$ {cmd}\n{r.stdout}{r.stderr}\n")

# 1. 容器状态
sh("docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | head -20")
# 2. 端口监听
sh("ss -tlnp 2>/dev/null | grep -E '6080|1935|1936|80' | head -20")
