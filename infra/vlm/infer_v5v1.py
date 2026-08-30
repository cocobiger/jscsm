#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
v5-v1 (YOLO11m, epoch14 best) 对 400 帧候选实测
对比: v3 (RT-DETR@960) 7992 fire 误报 / VLM 41 帧有烟
输出: v5v1_results.json + 终端混淆矩阵(多阈值)
用法: /opt/jsc/straw-engine/venv/bin/python infer_v5v1.py
"""
import json, os, glob, collections, sys
from ultralytics import YOLO

CAND = "/video/shujuji/datasets/v5_candidates"
PT = "/video/xunlian/runs/detect/v5_smoke_v1/base/weights/best.pt"
IMGSZ = 1280

frames = sorted(glob.glob(os.path.join(CAND, "record", "*", "f*.jpg")))
print(f"[info] 候选帧数: {len(frames)}", flush=True)

model = YOLO(PT)

results = {}
for fp in frames:
    r = model.predict(fp, imgsz=IMGSZ, conf=0.10, iou=0.5, verbose=False)[0]
    dets = []
    for box in r.boxes:
        cls = int(box.cls[0])
        conf = float(box.conf[0])
        if cls == 0:  # smoke
            dets.append({"conf": round(conf, 4)})
    results[fp] = dets
    if len(results) % 100 == 0:
        print(f"[progress] {len(results)}/{len(frames)}", flush=True)

out = os.path.join(CAND, "v5v1_results.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(results, f, ensure_ascii=False, indent=1)
print(f"[saved] {out}", flush=True)

# ---- 对比 VLM ----
vlm = json.load(open(os.path.join(CAND, "vlm_results.json")))
assert len(vlm) == len(frames), f"vlm {len(vlm)} vs frames {len(frames)}"

pos = {k for k, v in vlm.items() if v == "有烟"}
neg = set(vlm) - pos
print(f"\nVLM 基准: 有烟={len(pos)} 无烟={len(neg)}")

print(f"\n{'conf阈值':<8}{'检出帧':<8}{'TP(41真烟)':<12}{'召回':<8}{'FP(359无烟)':<12}{'误报率':<8}")
for thr in (0.10, 0.15, 0.20, 0.25, 0.30, 0.40):
    hit = {fp for fp, d in results.items() if any(x["conf"] >= thr for x in d)}
    tp = len(hit & pos)
    fp = len(hit & neg)
    rec = tp / len(pos) if pos else 0
    fpr = fp / len(neg) if neg else 0
    print(f"{thr:<10}{len(hit):<10}{tp:<14}{rec:<10.3f}{fp:<14}{fpr:<10.3f}")

# 阈值 0.25 详细: 漏检的真烟帧
thr = 0.25
hit = {fp for fp, d in results.items() if any(x["conf"] >= thr for x in d)}
miss = sorted(pos - hit)
print(f"\n[conf>=0.25] 漏检真烟帧({len(miss)}):")
for m in miss:
    confs = [x["conf"] for x in results[m]]
    print(f"  {m.split('/record/')[-1]}  conf={confs if confs else '—'}")
fph = sorted(hit & neg)
print(f"\n[conf>=0.25] 误报无烟帧({len(fph)}):")
for m in fph[:30]:
    confs = [x["conf"] for x in results[m]]
    print(f"  {m.split('/record/')[-1]}  conf={confs}")

# 与 v3 对比: v3 fire 误报帧中 v5-v1 的表现
v3 = json.load(open(os.path.join(CAND, "v3_candidates.json")))
v3_frames = {h["frame"] for h in v3["hits"]}
both = hit & v3_frames
print(f"\n[v3 误报 379 帧 ∩ v5-v1(>=0.25) 检出 {len(hit)}] = {len(both)} 帧同时命中")
print(f"v5-v1 检出的帧中 {len(hit & pos)} 帧 VLM 判有烟, {len(hit & neg)} 帧 VLM 判无烟(疑误报)")
print("done")
