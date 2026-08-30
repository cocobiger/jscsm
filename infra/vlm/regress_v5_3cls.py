#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v5 3 类回归验证（方案B 第2批）: m6 生产 vs v5_3cls 双口径对比
口径① 30 帧真烟回归集（v2_ai 26 + DJI 4）: 逐帧 smoke 检出对比（conf 0.10/0.25）
口径② 合并 val(1000, 零泄漏): 同数据 mAP50/P/R 公平对比（m6 重跑 vs v5_3cls）
口径③ m6 存档 results.csv（merged_v4 valid 1042 泄漏口径，参考）

用法: python regress_v5_3cls.py [conf] [v5_model_path]  (默认 conf=0.10, v5=当前 v5_smoke_3cls best)
"""
import os, sys, json
from ultralytics import YOLO

CONF = float(sys.argv[1]) if len(sys.argv) > 1 else 0.10
IOU = 0.5
BASE = '/video/xunlian/runs/detect'
M6 = f'{BASE}/m6_rtdetr/weights/best.pt'
V5 = sys.argv[2] if len(sys.argv) > 2 else f'{BASE}/v5_smoke_3cls/weights/best.pt'
MERGE = '/video/shujuji/datasets/v5_train_merge'
REG_LIST = f'{MERGE}/regress_list.txt'
V5_TAG = V5.split('/')[-3] if V5.count('/') >= 3 else 'v5_custom'
OUT_JSON = f'/video/llm_infer/regress_v5_3cls_{V5_TAG}_{CONF}.json'

print(f'===== v5 3cls 回归验证 conf={CONF} =====', flush=True)

# ---------- 口径① 30 帧回归 ----------
imgs = []   # (src, img, gt_boxes)
for line in open(REG_LIST):
    line = line.strip()
    if not line:
        continue
    src, img, lab = line.split('\t')
    gt = []
    for l in open(lab):
        sp = l.split()
        if sp and int(sp[0]) == 0:   # smoke GT
            gt.append([float(sp[1]), float(sp[2]), float(sp[3]), float(sp[4])])
    if os.path.exists(img):
        imgs.append((src, img, gt))
print(f'[口径①] 回归集 {len(imgs)} 帧 (smoke GT 框 {sum(len(g) for _,_,g in imgs)})', flush=True)

m6 = YOLO(M6)
v5 = YOLO(V5)

def predict_boxes(model, img):
    r = model.predict(img, imgsz=960, conf=CONF, iou=IOU, verbose=False)[0]
    out = []
    for b in r.boxes:
        if int(b.cls[0]) == 0:   # 只看 smoke
            x1, y1, x2, y2 = [float(v) for v in b.xyxy[0]]
            W, H = r.orig_shape[1], r.orig_shape[0]
            cx, cy = (x1 + x2) / 2 / W, (y1 + y2) / 2 / H
            w, h = (x2 - x1) / W, (y2 - y1) / H
            out.append((cx, cy, w, h, float(b.conf[0])))
    return out

rows = []
hit6 = hit5 = 0
sum6 = sum5 = 0
for src, img, gt in imgs:
    d6 = predict_boxes(m6, img)
    d5 = predict_boxes(v5, img)
    c6 = [round(x[4], 3) for x in d6]
    c5 = [round(x[4], 3) for x in d5]
    sum6 += len(c6); sum5 += len(c5)
    hit6 += 1 if c6 else 0; hit5 += 1 if c5 else 0
    tag = 'm6漏/v5检 ✓' if (not c6 and c5) else ('m6检/v5漏 ✗' if (c6 and not c5) else ('双检出' if (c6 and c5) else '双漏 ✗'))
    rows.append({'src': src, 'img': os.path.basename(img), 'gt': len(gt),
                 'm6': c6, 'v5': c5, 'tag': tag})
    print(f"  {os.path.basename(img):<42} GT:{len(gt)} | m6:{len(c6)} {c6} | v5:{len(c5)} {c5} | {tag}", flush=True)

print(f'[口径①] 帧检出: m6 {hit6}/{len(imgs)} ({hit6/len(imgs)*100:.0f}%)  v5_3cls {hit5}/{len(imgs)} ({hit5/len(imgs)*100:.0f}%)', flush=True)
print(f'[口径①] 框总数: m6 {sum6}  v5_3cls {sum5}', flush=True)

# ---------- 口径② 合并 val 公平对比 ----------
print(f'[口径②] 合并 val(1000) 公平对比 ...', flush=True)
val6 = m6.val(data=f'{MERGE}/data.yaml', split='val', imgsz=960, verbose=False)
val5 = v5.val(data=f'{MERGE}/data.yaml', split='val', imgsz=960, verbose=False)
def pick(m):
    return {'map50': round(float(m.box.map50), 4),
            'map50_95': round(float(m.box.map), 4),
            'P': round(float(m.box.mp), 4),
            'R': round(float(m.box.mr), 4),
            'per_class': {k: round(float(v), 4) for k, v in zip(m.names.values(), m.box.maps) if v is not None}}
r6 = pick(val6); r5 = pick(val5)
print(f'[口径②] m6     val: {r6}', flush=True)
print(f'[口径②] v5_3cls val: {r5}', flush=True)

# ---------- 口径③ m6 存档基线 ----------
archived = None
csv_p = f'{BASE}/m6_rtdetr/results.csv'
if os.path.exists(csv_p):
    lines = [l.strip() for l in open(csv_p) if l.strip()][1:]
    last = lines[-1].split(',')
    # 列: epoch, train/box_loss, ..., metrics/precision, metrics/recall, metrics/mAP50, metrics/mAP50-95
    try:
        archived = {'epoch': last[0], 'P': last[3], 'R': last[4], 'map50': last[5], 'map50_95': last[6]}
    except Exception:
        archived = {'epoch': last[0], 'raw': last}
print(f'[口径③] m6 存档(results.csv 末行, merged_v4 valid 1042 泄漏口径): {archived}', flush=True)

# ---------- 汇总 JSON ----------
out = {
    'conf': CONF,
    'regress30': {
        'total': len(imgs), 'm6_hit': hit6, 'v5_hit': hit5,
        'm6_boxes': sum6, 'v5_boxes': sum5,
        'rows': rows,
    },
    'merge_val_1000': {'m6': r6, 'v5_3cls': r5},
    'm6_archived': archived,
}
json.dump(out, open(OUT_JSON, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print(f'[done] 结果存档: {OUT_JSON}', flush=True)
