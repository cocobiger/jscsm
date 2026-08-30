#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v5-v3 best.pt 对 400 帧候选实测 + 四模型对比（v3-RTDETR / v5-v1 / v5-v2 / v5-v3）
- v1: 复用历史 v5v1_results.json
- v2: 复用历史 v5v2_results.json（best@epoch92）
- v5-v3: 现场跑 v5_smoke_v3 best.pt（用户复核标注 26帧/53框，从 v2 续训）
- v3-RTDETR: 从 v3_candidates.json（fire 长跑累加）抽取 400 帧 max fire conf
- VLM 基准: vlm_results.json 的 41 帧（27 真烟 + 14 否掉）
- 400 帧全集 = v5v1_results.json 的 key 集合
- 输出: v5v3_results.json + 终端对比表 + eval_compare_v4.json
- 用法: /opt/jsc/straw-engine/venv/bin/python3 infer_v5v3.py
"""
import json, os, glob, collections
from ultralytics import YOLO

CAND = "/video/shujuji/datasets/v5_candidates"
V3_PT = "/video/xunlian/runs/detect/v5_smoke_v3/base/weights/best.pt"
IMGSZ = 1280

# ---- v5-v3 实测 ----
frames = sorted(glob.glob(os.path.join(CAND, "record", "*", "f*.jpg")))
print(f"[info] 候选帧数: {len(frames)}", flush=True)

v5v3 = {}
model = YOLO(V3_PT)
for i, fp in enumerate(frames):
    r = model.predict(fp, imgsz=IMGSZ, conf=0.10, iou=0.5, verbose=False)[0]
    dets = []
    for box in r.boxes:
        if int(box.cls[0]) == 0:  # smoke
            dets.append({"conf": round(float(box.conf[0]), 4)})
    v5v3[fp] = dets
    if (i+1) % 100 == 0:
        print(f"[v5-v3 progress] {i+1}/{len(frames)}", flush=True)
v3_out = os.path.join(CAND, "v5v3_results.json")
json.dump(v5v3, open(v3_out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"[saved] {v3_out}", flush=True)

# ---- 四模型对比 ----
v1 = json.load(open(os.path.join(CAND, "v5v1_results.json")))
v2 = json.load(open(os.path.join(CAND, "v5v2_results.json")))
v3rt = json.load(open(os.path.join(CAND, "v3_candidates.json")))
vlm = json.load(open(os.path.join(CAND, "vlm_results.json")))

# VLM 基准: 有烟帧 = 真烟
pos = {fp for fp, v in vlm.items() if v == "有烟"}
all_400 = set(frames)
pos_in_400 = pos & all_400
neg_other = all_400 - pos_in_400
print(f"\nVLM 基准: 有烟={len(pos_in_400)} (∈400)  非有烟(∈400)={len(neg_other)}")

# v3-RTDETR 按 frame 抽 max fire conf
v3rt_max = collections.defaultdict(float)
for h in v3rt["hits"]:
    fp = h["frame"]
    if fp in all_400:
        v3rt_max[fp] = max(v3rt_max[fp], h["conf"])

def stats_table(pred_unified, pos_set, neg_set, thrs):
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

v3rt_unified = {fp: [{"conf": c}] for fp, c in v3rt_max.items()}
for fp in all_400: v3rt_unified.setdefault(fp, [])
thrs = (0.10, 0.15, 0.20, 0.25, 0.30, 0.40)
rows = {
    "v1":  stats_table(v1,    pos_in_400, neg_other, thrs),
    "v2":  stats_table(v2,    pos_in_400, neg_other, thrs),
    "v5v3": stats_table(v5v3, pos_in_400, neg_other, thrs),
    "v3rt": stats_table(v3rt_unified, pos_in_400, neg_other, thrs),
}

print(f"\n{'thr':<6}{'模型':<8}{'检出':<6}{'TP(真烟)':<10}{'召回':<8}{'FP(非真烟)':<12}{'误报率':<8}")
print("-" * 64)
for i, thr in enumerate(thrs):
    for name in ("v1", "v2", "v5v3", "v3rt"):
        r = rows[name][i]
        print(f"{thr:<6}{name:<8}{r['hit']:<6}{r['tp']:<10}{r['recall']:<8.3f}{r['fp']:<12}{r['fpr']:<8.3f}")
    print()

# 阈值 0.25 四模型漏检 + 误报
thr = 0.25
def hit_set(pred, t):
    return {fp for fp, ds in pred.items() if any(d["conf"] >= t for d in ds)}
miss = {k: sorted(pos_in_400 - hit_set(pred, thr)) for k, pred in
        {"v1": v1, "v2": v2, "v5v3": v5v3, "v3rt": v3rt_unified}.items()}
print(f"\n[conf>={thr}] 漏检真烟帧:")
for k, lst in miss.items():
    print(f"  {k}: {len(lst)} 帧  {[fp.split('/record/')[-1] for fp in lst[:6]]}")

fph = {k: sorted(hit_set(pred, thr) & neg_other) for k, pred in
       {"v1": v1, "v2": v2, "v5v3": v5v3, "v3rt": v3rt_unified}.items()}
print(f"\n[conf>={thr}] 误报非真烟帧:")
for k, lst in fph.items():
    print(f"  {k}: {len(lst)} 帧")

agg = {
    "meta": {"pos": len(pos_in_400), "neg_other": len(neg_other), "total": len(frames)},
    "thrs": list(thrs),
    "v1": rows["v1"], "v2": rows["v2"], "v5v3": rows["v5v3"], "v3rt": rows["v3rt"],
    "miss_25": {k: [fp.split("/record/")[-1] for fp in lst] for k, lst in miss.items()},
    "fph_25": {k: [fp.split("/record/")[-1] for fp in lst] for k, lst in fph.items()},
    "v3rt_note": "v3-RTDETR 数据来自 fire 类长跑累加 (v3_candidates.json)，非 400 帧 conf=0.10 单跑；按 frame 抽 max conf 对比",
    "v1_note": "v5-v1: YOLO11m@1280 epoch14 best（无真实烟训练，合成烟域偏移）",
    "v2_note": "v5-v2: YOLO11m@1280 best@epoch92（含 27 真实烟 AI 框）",
    "v5v3_note": "v5-v3: YOLO11m@1280 best（用户复核标注 26帧/53框，从 v2 续训）",
}
out_agg = os.path.join(CAND, "eval_compare_v4.json")
json.dump(agg, open(out_agg, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"\n[saved] {out_agg}")
print("done")
