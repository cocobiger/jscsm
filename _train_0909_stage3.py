# -*- coding: utf-8 -*-
"""stage3_0909 续训：在 stage2_dilute 基础上加入 9/9 真机标注数据"""
import os, sys
from ultralytics import YOLO

BASE = '/video/xunlian/runs/detect/v5_smoke_v5/stage2/weights/best.pt'
DATA = '/video/shujuji/datasets/v5_train_v5/v5_smoke_v5_s2.yaml'
PROJ = '/video/xunlian/runs/detect/v5_smoke_v5'
NAME = 'stage3_0909'

# ── 前置自检 ──
sp = '/video/shujuji/datasets/v5_train_v5/splits/stage2_train.txt'
lines = [l.strip() for l in open(sp) if l.strip()]
miss = [l for l in lines if not os.path.exists(l)]
pos = neg = 0
for l in lines:
    lab = l.replace('/images/', '/labels/').rsplit('.', 1)[0] + '.txt'
    if os.path.exists(lab) and os.path.getsize(lab) > 0:
        pos += 1
    else:
        neg += 1
print('[自检] stage2_train.txt %d 行 | 文件缺失 %d | 正 %d / 负 %d' % (len(lines), len(miss), pos, neg))
if miss:
    print('[自检] 缺失示例:', miss[:3])

# 抽查一个新标注
sample = '/video/shujuji/datasets/v5_train_v5/labels/tr0909/0S4G_1132_f0040.txt'
print('[自检] 样本标签 %s ->' % os.path.basename(sample), repr(open(sample).read()) if os.path.exists(sample) else 'MISSING')
vb = '/video/shujuji/datasets/v5_train_v5/va0909_probe'
print('[自检] base 权重 %s (%d bytes)' % (BASE, os.path.getsize(BASE)))
assert not miss, 'split 有缺失文件，中止'

print('[训练] 开始 ...', flush=True)
m = YOLO(BASE)
r = m.train(data=DATA, epochs=30, imgsz=1280, batch=6, lr0=0.002,
            mosaic=0.0, close_mosaic=50, copy_paste=0.3, amp=True,
            device='0', workers=4, patience=15,
            project=PROJ, name=NAME, exist_ok=True)
print('[训练] 完成:', r.save_dir, flush=True)

best = os.path.join(PROJ, NAME, 'weights', 'best.pt')
if os.path.exists(best):
    print('[导出] ONNX ...', flush=True)
    YOLO(best).export(format='onnx', imgsz=1280, opset=12, simplify=False)
    print('[导出] 完成', flush=True)
