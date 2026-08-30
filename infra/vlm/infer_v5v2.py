#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v2 best.pt 对 400 帧候选实测 + 三方对比（v3 / v5-v1 / v5-v2）
- v1: 复用历史 v5v1_results.json
- v2: 现场跑 best.pt（YOLO11m@1280, best@epoch92）
- v3: 从 v3_candidates.json（fire 长跑累加）抽取 400 帧 max fire conf
- VLM 基准: vlm_results.json 的 41 帧（27 真烟 + 14 否掉）
- 400 帧全集 = v5v1_results.json 的 key 集合
- 输出: v5v2_results.json + 终端对比表 + eval_compare.json
- 用法: /opt/jsc/straw-engine/venv/bin/python3 infer_v5v2.py
"""
import json, os, glob, collections
from ultralytics import YOLO

CAND = "/video/shujuji/datasets/v5_candidates"
V2_PT = "/video/xunlian/runs/detect/v5_smoke_v2/base/weights/best.pt"
IMGSZ = 1280

# ---- v2 实测 ----
frames = sorted(glob.glob(os.path.join(CAND, "record", "*", "f*.jpg")))
print(f"[info] 候选帧数: {len(frames)}", flush=True)

v2 = {}
model = YOLO(V2_PT)
for i, fp in enumerate(frames):
    r = model.predict(fp, imgsz=IMGSZ, conf=0.10, iou=0.5, verbose=False)[0]
    dets = []
    for box in r.boxes:
        if int(box.cls[0]) == 0:  # smoke
            dets.append({"conf": round(float(box.conf[0]), 4)})
    v2[fp] = dets
    if (i+1) % 100 == 0:
        print(f"[v2 progress] {i+1}/{len(frames)}", flush=True)
v2_out = os.path.join(CAND, "v5v2_results.json")
json.dump(v2, open(v2_out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"[saved] {v2_out}", flush=True)

# ---- 三方对比 ----
v1 = json.load(open(os.path.join(CAND, "v5v1_results.json")))
v3 = json.load(open(os.path.join(CAND, "v3_candidates.json")))
vlm = json.load(open(os.path.join(CAND, "vlm_results.json")))

# VLM 基准: 有烟帧 = 真烟
pos = {fp for fp, v in vlm.items() if v == "有烟"}
neg_vlm = {fp for fp, v in vlm.items() if v != "有烟"}
all_400 = set(frames)  # 400 帧全集
pos_in_400 = pos & all_400
neg_other = all_400 - pos_in_400  # 含 VLM 判云/否/未知（400 帧全集中的 373 帧非"有烟"）
print(f"\nVLM 基准: 有烟={len(pos_in_400)} (∈400)  非有烟(∈400)={len(neg_other)}")

# v3 按 frame 抽 max fire conf（口径提示：v3 是 fire 长跑累加）
v3_max = collections.defaultdict(float)
for h in v3["hits"]:
    fp = h["frame"]
    if fp in all_400:
        v3_max[fp] = max(v3_max[fp], h["conf"])

# 多阈值混淆矩阵（统一 list-of-dict 格式）
def stats_table(pred_unified, pos_set, neg_set, thrs):
    """pred_unified: {fp: [{"conf":c}] or []}"""
    rows = []
    for thr in thrs:
        hit = {fp for fp, ds in pred_unified.items() if any(d["conf"] >= thr for d in ds)}
        tp = len(hit & pos_set)
        fp_ = len(hit & neg_set)
        rec = tp / len(pos_set) if pos_set else 0
        fpr = fp_ / len(neg_set) if neg_set else 0
        rows.append({"thr": thr, "hit": len(hit), "tp": tp, "fp": fp_,
                     "recall": round(rec, 3), "fpr": round(fpr, 3)})
    return rows

# v3 max conf 统一为 list-of-dict
v3_unified = {fp: [{"conf": c}] for fp, c in v3_max.items()}
for fp in all_400: v3_unified.setdefault(fp, [])
v1_unified = v1
v2_unified = v2
thrs = (0.10, 0.15, 0.20, 0.25, 0.30, 0.40)
v1_rows = stats_table(v1_unified, pos_in_400, neg_other, thrs)
v2_rows = stats_table(v2_unified, pos_in_400, neg_other, thrs)
v3_rows = stats_table(v3_unified, pos_in_400, neg_other, thrs)

print(f"\n{'thr':<6}{'模型':<8}{'检出':<6}{'TP(真烟)':<10}{'召回':<8}{'FP(非真烟)':<12}{'误报率':<8}")
print("-" * 64)
for i, thr in enumerate(thrs):
    for name, rows in [("v1", v1_rows), ("v2", v2_rows), ("v3", v3_rows)]:
        r = rows[i]
        print(f"{thr:<6}{name:<8}{r['hit']:<6}{r['tp']:<10}{r['recall']:<8.3f}{r['fp']:<12}{r['fpr']:<8.3f}")
    print()

# 阈值 0.25 三方漏检 + 误报
thr = 0.25
def hit_set_v12(pred, t):
    return {fp for fp, ds in pred.items() if any(d["conf"] >= t for d in ds)}
def hit_set_v3(pred, t):
    return {fp for fp, c in pred.items() if c >= t}
miss = {
    "v1": sorted(pos_in_400 - hit_set_v12(v1, thr)),
    "v2": sorted(pos_in_400 - hit_set_v12(v2, thr)),
    "v3": sorted(pos_in_400 - hit_set_v3(v3_max, thr)),
}
print(f"\n[conf>={thr}] 漏检真烟帧（VLM 判有烟 但模型未触发）:")
for k, lst in miss.items():
    print(f"  {k}: {len(lst)} 帧")
    for fp in lst[:8]:
        rel = fp.split("/record/")[-1]
        # 找最大 conf
        if k == "v3":
            c = v3_max.get(fp, 0)
        else:
            ds = v1[fp] if k == "v1" else v2[fp]
            c = max((d["conf"] for d in ds), default=0)
        print(f"    {rel}  conf={c}")

# 阈值 0.25 三方误报（前 10）
fph = {
    "v1": sorted(hit_set_v12(v1, thr) & neg_other),
    "v2": sorted(hit_set_v12(v2, thr) & neg_other),
    "v3": sorted(hit_set_v3(v3_max, thr) & neg_other),
}
print(f"\n[conf>={thr}] 误报非真烟帧:")
for k, lst in fph.items():
    print(f"  {k}: {len(lst)} 帧")

# 保存聚合 JSON（供 HTML 报告读）
agg = {
    "meta": {"pos": len(pos_in_400), "neg_other": len(neg_other), "total": len(frames)},
    "thrs": list(thrs),
    "v1": v1_rows, "v2": v2_rows, "v3": v3_rows,
    "miss_25": {k: [fp.split("/record/")[-1] for fp in lst] for k, lst in miss.items()},
    "fph_25": {k: [fp.split("/record/")[-1] for fp in lst] for k, lst in fph.items()},
    "v3_note": "v3 数据来自 fire 类长跑累加 (v3_candidates.json)，非 400 帧 conf=0.10 单跑；按 frame 抽 max conf 做最大 conf 阈值对比",
    "v1_note": "v5-v1: YOLO11m@1280 epoch14 best（无真实烟训练）",
    "v2_note": "v5-v2: YOLO11m@1280 best@epoch92（含 27 真实烟训练）",
}
out_agg = os.path.join(CAND, "eval_compare.json")
json.dump(agg, open(out_agg, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"\n[saved] {out_agg}")
print("done")
