# 在 v5_balance_report 块后插入 negverify_plan location（双端口）
import re

NEW = """    location = /negverify_plan_20260901.html {
        alias /video/llm_infer/negverify_plan_20260901.html;
        add_header Cache-Control "no-cache";
    }
"""

ANCHOR = re.compile(r"(    location = /v5_balance_report\.html \{\n(?:[^\n]*\n)*?    \}\n)")

for path in ["/etc/nginx/sites-enabled/uav-sites", "/etc/nginx/conf.d/skymonitor.conf"]:
    txt = open(path, encoding="utf-8").read()
    m = ANCHOR.search(txt)
    if not m:
        print(f"NOT FOUND: {path}")
        continue
    if "location = /negverify_plan_20260901.html" in txt:
        print(f"ALREADY: {path}")
        continue
    txt = txt.replace(m.group(1), m.group(1) + NEW, 1)
    open(path, "w", encoding="utf-8").write(txt)
    print(f"OK: {path}")
