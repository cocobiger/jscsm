# -*- coding: utf-8 -*-
"""stage4_0910 续训：在 stage3_0909 基础上加入补标的 45 帧（+7 真烟 / +26 负）"""
import os, sys
from ultralytics import YOLO

BASE = '/video/xunlian/runs/detect/v5_smoke_v5/stage3_0909/weights/best.pt'
DATA = '/video/shujuji/datasets/v5_train_v5/v5_smoke_v5_s2.yaml'
PROJ = '/video/xunlian/runs/detect/v5_smoke_v5'
NAME = 'stage4_0910'

sp = '/video/shujuji/datasets/v5_train_v5/splits/stage2_train.txt'
lines = [l.strip() for l in open(sp) if l.strip()]
miss = [l for l in lines if not os.path.exists(l)]
pos = neg = 0
for l in lines:
    lab = l.replace('/images/', '/labels/').rsplit('.', 1)[0] + '.txt'
    if os.path.exists(lab) and os.path.getsize(lab) > 0: pos += 1
    else: neg += 1
print('[自检] stage2_train.txt %d 行 | 缺失 %d | 正 %d / 负 %d' % (len(lines), len(miss), pos, neg))
assert not miss, 'split 有缺失文件，中止'
assert os.path.exists(BASE), 'base 权重不存在: ' + BASE
print('[自检] base =', BASE, os.path.getsize(BASE), 'bytes')
print('[自检] 服务器时间', __import__('time').strftime('%Y-%m-%d %H:%M:%S'), flush=True)

m = YOLO(BASE)
r = m.train(data=DATA, epochs=30, imgsz=1280, batch=6, lr0=0.002,
            mosaic=0.0, close_mosaic=50, copy_paste=0.3, amp=True,
            device='0', workers=4, patience=15,
            project=PROJ, name=NAME, exist_ok=True)
print('[训练] 完成:', r.save_dir, flush=True)

for cand in (os.path.join(PROJ, NAME, 'weights', 'best.pt'),
             os.path.join(str(r.save_dir), 'weights', 'best.pt')):
    if os.path.exists(cand):
        print('[导出] ONNX from', cand, '...', flush=True)
        YOLO(cand).export(format='onnx', imgsz=1280, opset=12, simplify=False)
        print('[导出] 完成', flush=True)
        break
