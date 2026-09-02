import shutil, sys

path = '/etc/nginx/sites-enabled/uav-sites'
bak = path + '.bak_0902_droneevt'
shutil.copy(path, bak)

with open(path, encoding='utf-8') as f:
    content = f.read()

anchor = '# 司空媒体在线播放（dji-openapi :17810 视频字节流端点'
if anchor not in content:
    print('ERROR: anchor not found')
    sys.exit(1)
if '/api/drone-events/' in content:
    print('ALREADY patched, skip')
    sys.exit(0)

block = """    # 无人机直播事件 SSE（弹窗需求 T1：SSE 长连接需关缓冲，心跳 25s）
    location /jsc/api/drone-events/ {
        proxy_pass http://127.0.0.1:7170/api/drone-events/;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_cache off;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
    }
    location /api/drone-events/ {
        proxy_pass http://127.0.0.1:7170/api/drone-events/;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_cache off;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
    }
"""

content = content.replace(anchor, block + anchor, 1)
with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
print('PATCHED OK, backup:', bak)
