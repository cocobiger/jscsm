# 在 v5_old_imgs 块后插入 v5_candidates 前缀 location（暴露 neg_classified.json，供 neg_verify.js fetch）
import re

NEW = """    location /v5_candidates/ {
        alias /video/shujuji/datasets/v5_candidates/;
        add_header Cache-Control "no-cache";
    }
"""

ANCHOR = re.compile(r"(    location /v5_old_imgs/ \{\n(?:[^\n]*\n)*?    \}\n)")

for path in ["/etc/nginx/sites-enabled/uav-sites", "/etc/nginx/conf.d/skymonitor.conf"]:
    txt = open(path, encoding="utf-8").read()
    m = ANCHOR.search(txt)
    if not m:
        print(f"NOT FOUND: {path}")
        continue
    if "location /v5_candidates/ {" in txt:
        print(f"ALREADY: {path}")
        continue
    txt = txt.replace(m.group(1), m.group(1) + NEW, 1)
    open(path, "w", encoding="utf-8").write(txt)
    print(f"OK: {path}")
