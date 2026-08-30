#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v5 smoke v4 回归验证: v3 best vs v4 best 在 DJI 真烟照片 + v2_ai 复核帧上的检出对比
用法: python regress_v5_v4.py [conf]  (默认 conf=0.10)
"""
import os, sys, json
from ultralytics import YOLO

CONF = float(sys.argv[1]) if len(sys.argv) > 1 else 0.10
IOU = 0.5

V3 = '/video/xunlian/runs/detect/v5_smoke_v3/base/weights/best.pt'
V4 = '/video/xunlian/runs/detect/v5_smoke_v4/base/weights/best.pt'
RECORD = '/video/shujuji/datasets/v5_candidates/record'   # v2_ai 帧目录
DJI = '/video/llm_infer/v5_photos/dji_photo'              # DJI 真烟照片
SPEC = '/video/llm_infer/v3_spec.json'

# 1) 组测试集: 真实烟帧(带框) 全部进
spec = json.load(open(SPEC, encoding='utf-8'))
imgs = []   # (rel, path, n_gt)
for f in spec['frames']:
    if not f.get('boxes'):
        continue
    if f['src'] == 'v2_ai':
        p = os.path.join(RECORD, f['rel'])
    else:  # dji_photo
        p = os.path.join(DJI, f['rel'].split('/')[-1] + '.jpg')
    if os.path.exists(p):
        imgs.append((f['rel'], p, len(f['boxes'])))

print(f'测试集: {len(imgs)} 真实烟帧 (conf={CONF})')
print(f"{'图片':<44} {'GT':>2} | {'v3检':>3} {'v3均conf':>8} | {'v4检':>3} {'v4均conf':>8} | 结果")
print('-' * 100)

m3 = YOLO(V3)
m4 = YOLO(V4)
sum3 = sum4 = 0
hit3 = hit4 = 0
for rel, p, n in imgs:
    r3 = m3.predict(p, imgsz=1280, conf=CONF, iou=IOU, verbose=False)[0]
    r4 = m4.predict(p, imgsz=1280, conf=CONF, iou=IOU, verbose=False)[0]
    d3 = [b for b in r3.boxes if int(b.cls[0]) == 0]
    d4 = [b for b in r4.boxes if int(b.cls[0]) == 0]
    c3 = [round(float(b.conf[0]), 3) for b in d3]
    c4 = [round(float(b.conf[0]), 3) for b in d4]
    sum3 += len(c3); sum4 += len(c4)
    hit3 += 1 if c3 else 0; hit4 += 1 if c4 else 0
    avg3 = f"{sum(c3)/len(c3):.3f}" if c3 else '  -  '
    avg4 = f"{sum(c4)/len(c4):.3f}" if c4 else '  -  '
    tag = 'v3漏/v4检 ✓' if (not c3 and c4) else ('v3检/v4漏 ✗' if (c3 and not c4) else ('双检出' if (c3 and c4) else '双漏 ✗'))
    print(f"{rel:<44} {n:>2} | {len(c3):>3} {avg3:>8} | {len(c4):>3} {avg4:>8} | {tag}")

print('-' * 100)
print(f'帧级检出率: v3 {hit3}/{len(imgs)} ({hit3/len(imgs)*100:.0f}%)  v4 {hit4}/{len(imgs)} ({hit4/len(imgs)*100:.0f}%)')
print(f'框总数: v3 {sum3}  v4 {sum4}')
