import sys
block = '''    # === v5 AI 画框预览 ===
    location = /v5ai_boxes.html {
        alias /video/llm_infer/v5ai_boxes.html;
        add_header Cache-Control "no-cache";
    }
'''
for p in ['/etc/nginx/sites-enabled/uav-sites', '/etc/nginx/conf.d/skymonitor.conf']:
    s = open(p).read()
    if '/v5ai_boxes.html' in s:
        print(p, 'already has')
        continue
    anchor = '    # === v5 人工复核清单 ==='
    if anchor not in s:
        print('!! anchor not found in', p); sys.exit(1)
    s = s.replace(anchor, block + anchor)
    open(p, 'w').write(s)
    print(p, 'updated')
