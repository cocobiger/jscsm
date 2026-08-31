#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""统计 neg_classified.json 多标签真实情况（2026-09-01）
1. 每帧 cats 数量分布（0/1/2 类）
2. raw 被截断情况：raw 解析类别数 > cats 数
3. 2 类组合 TOP
4. 全标签计数（标签口径）
"""
import json, re
from collections import Counter

VALID = {"pole", "concrete", "cloud", "building", "reflection", "none", "other"}

d = json.load(open("/video/shujuji/datasets/v5_candidates/neg_classified.json", encoding="utf-8"))
total = len(d)

def parse_raw(raw):
    if not raw:
        return []
    return [p.strip() for p in raw.replace("，", ",").replace("、", ",").split(",") if p.strip() and p.strip() in VALID]

cat_count = Counter()       # 每帧 cats 数量
label_total = Counter()     # 标签口径
combos = Counter()          # 2 类组合
truncated = 0               # raw 类别数 > cats 数（被 [:2] 截断）
raw_gt2 = 0                 # raw 本身就有 3+ 类
multi = 0                   # 多标签帧（cats>=2）
none_frames = 0

for fp, v in d.items():
    cats = v.get("cats") or []
    raw = v.get("raw") or ""
    n = len(cats)
    cat_count[n] += 1
    for c in cats:
        label_total[c] += 1
    if n >= 2:
        multi += 1
        combos[tuple(sorted(cats))] += 1
    if "none" in cats:
        none_frames += 1
    # 截断检测
    raw_cats = parse_raw(raw)
    if len(raw_cats) > len(cats):
        truncated += 1
    if len(raw_cats) >= 3:
        raw_gt2 += 1

print(f"总帧数: {total}")
print(f"\n=== 每帧标签数分布 ===")
for n in sorted(cat_count):
    print(f"  {n} 类: {cat_count[n]:4d}  ({100*cat_count[n]/total:.1f}%)")
print(f"  多标签帧 (>=2): {multi}  ({100*multi/total:.1f}%)")

print(f"\n=== raw 被截断统计（模型输出 > 2 类被 [:2] 截断）===")
print(f"  raw 含 3+ 类: {raw_gt2} 帧 ({100*raw_gt2/total:.2f}%)")
print(f"  raw 类别数 > cats: {truncated} 帧 ({100*truncated/total:.2f}%)")

print(f"\n=== 标签口径分布（多标签帧重复计数）===")
for c, n in label_total.most_common():
    print(f"  {c:12s} {n:4d}  ({100*n/total:.1f}%)")

print(f"\n=== 2 类组合 TOP 15 ===")
for combo, n in combos.most_common(15):
    print(f"  {'+'.join(combo):30s} {n:4d}  ({100*n/total:.1f}%)")

print(f"\n=== 其他交叉观察 ===")
print(f"  含 none 的帧: {none_frames} ({100*none_frames/total:.1f}%)  [none 与其它类别共存的矛盾帧]")
# none 与其他类共存
none_mix = 0
for fp, v in d.items():
    cats = v.get("cats") or []
    if "none" in cats and len(cats) > 1:
        none_mix += 1
print(f"  none+其他类别共存帧: {none_mix}")

# 单类帧里 none 占比（真正的干净帧）
single_none = 0
for fp, v in d.items():
    cats = v.get("cats") or []
    if cats == ["none"]:
        single_none += 1
print(f"  纯 none 单类帧: {single_none} ({100*single_none/total:.1f}%)")
