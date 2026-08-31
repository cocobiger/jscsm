#!/usr/bin/env python3
import json, os
data = json.load(open("/video/shujuji/datasets/v5_candidates/neg_classified.json", encoding="utf-8"))
print("=== 含 reflection 标签的 7 帧 ===")
for fp, v in data.items():
    if "reflection" in (v.get("cats") or []):
        print(f"  {fp}")
        print(f"    cats={v.get('cats')}  raw={v.get('raw','')[:60]!r}")
