#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""彻底重写两个 nginx 配置文件的 v5review 区域为正确版本"""
import re

CORRECT_REGION = """    location = /v5review.html {
        alias /video/llm_infer/v5review.html;
        add_header Cache-Control "no-cache";
    }
    # P3-2b 训练集配比报告
    location = /v5_balance_report.html {
        alias /video/llm_infer/v5_balance_report.html;
        add_header Cache-Control "no-cache";
    }
    # P3-2c 热成像通道接入评估
    location = /thermal_eval_20260901.html {
        alias /video/llm_infer/thermal_eval_20260901.html;
        add_header Cache-Control "no-cache";
    }

"""

for path in ["/etc/nginx/sites-enabled/uav-sites", "/etc/nginx/conf.d/skymonitor.conf"]:
    txt = open(path, encoding="utf-8").read()
    # 把 sed 留下的字面 \n 转为真换行
    txt = txt.replace("\\n", "\n")
    # 找到从 `location = /v5review.html {` 开始到下一个 `# === v5-v1` 之间的所有内容
    pattern = re.compile(
        r"location = /v5review\.html \{.*?(?=\n    # === v5-v1)",
        re.DOTALL,
    )
    txt, n = pattern.subn(CORRECT_REGION.rstrip() + "\n\n", txt, count=1)
    print(f"{path}: 替换次数={n}")
    open(path, "w", encoding="utf-8").write(txt)

# 验证
import subprocess
r = subprocess.run(["nginx", "-t"], capture_output=True, text=True)
print("nginx -t exit:", r.returncode)
print(r.stderr[-300:])