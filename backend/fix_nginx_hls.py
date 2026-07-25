import re

with open('/etc/nginx/sites-enabled/uav-sites', 'r') as f:
    c = f.read()

# Check if already inserted
if 'JSC HLS' in c:
    print('ALREADY_EXISTS')
else:
    block = '''
    # ===== JSC HLS 流反代（ZLMediaKit .m3u8/.ts 分片） =====
    location ~ ^/jsc/([a-zA-Z0-9_-]+)/hls\\.m3u8$ {
        proxy_pass http://127.0.0.1:6080/jsc/$1/hls.m3u8;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_cache off;
        add_header Access-Control-Allow-Origin * always;
        add_header Access-Control-Allow-Methods "GET, OPTIONS" always;
        if ($request_method = OPTIONS) { return 204; }
    }

    location ~ ^/jsc/([a-zA-Z0-9_-]+)/(.+\\.ts)$ {
        proxy_pass http://127.0.0.1:6080/jsc/$1/$2;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_cache off;
        add_header Access-Control-Allow-Origin * always;
        add_header Access-Control-Allow-Methods "GET, OPTIONS" always;
        if ($request_method = OPTIONS) { return 204; }
    }

'''
    p = re.compile(r'(\n\s*location /jsc/ \{)')
    nc = p.sub(block + r'\1', c, count=1)
    
    with open('/etc/nginx/sites-enabled/uav-sites', 'w') as f:
        f.write(nc)
    print('INSERTED')
