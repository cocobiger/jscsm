#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""nginx 双配置插入 v5 静态 location（与之前的 nginx_add_*.py 一致风格）"""
import re
p1 = '/etc/nginx/sites-enabled/uav-sites'
p2 = '/etc/nginx/conf.d/skymonitor.conf'
loc = """
    # v5 训练素材静态服务（视频抽帧 + 司空2 任务照片）
    location /v5_photos/ {
        alias /video/llm_infer/v5_photos/;
        expires 1d;
        add_header Cache-Control "public, max-age=86400";
        try_files $uri $uri/ =404;
    }
    # v2 训练素材静态服务（27 帧原图）
    location /v5_old_imgs/ {
        alias /video/shujuji/datasets/v5_candidates/record/;
        expires 1d;
        add_header Cache-Control "public, max-age=86400";
        try_files $uri $uri/ =404;
    }
"""
for p in [p1, p2]:
    if not open(p).read().count('/v5_photos/'):
        s = open(p).read()
        s = re.sub(r'(server\s*\{[^}]*?listen\s+\d+[^}]*?)(location\s+\/\s*\{)',
                   r'\1' + loc + r'\n    \2', s, count=1, flags=re.S)
        if loc not in s:
            s = s.replace('server {', 'server {' + loc, 1)
        open(p, 'w').write(s)
        print(f'已更新 {p}')
    else:
        print(f'{p} 已含 v5_photos，跳过')
