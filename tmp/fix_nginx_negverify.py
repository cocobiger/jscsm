# 在 uav-sites 与 skymonitor.conf 的 v5checklist 块后插入 neg_verify location（双端口 :80/:81）
import re

NEW = """    location = /neg_verify.html {
        alias /video/llm_infer/neg_verify.html;
        add_header Cache-Control "no-cache";
    }
    location = /neg_verify.js {
        alias /video/llm_infer/neg_verify.js;
        add_header Cache-Control "no-cache";
    }
"""

ANCHOR = re.compile(r"(    location = /v5checklist\.html \{\n(?:[^\n]*\n)*?    \}\n)")

for path in ["/etc/nginx/sites-enabled/uav-sites", "/etc/nginx/conf.d/skymonitor.conf"]:
    txt = open(path, encoding="utf-8").read()
    m = ANCHOR.search(txt)
    if not m:
        print(f"NOT FOUND: {path}")
        continue
    if "/neg_verify.html" in txt:
        print(f"ALREADY: {path}")
        continue
    txt = txt.replace(m.group(1), m.group(1) + NEW, 1)
    open(path, "w", encoding="utf-8").write(txt)
    print(f"OK: {path}")
