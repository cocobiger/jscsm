"""M5 对比验证：v1(D-Fire) vs v2(微调) 在 FlameVision test + buchong 真实样本"""
import sys
import os
from ultralytics import YOLO

V1 = '/opt/jsc/straw-engine/models/fire-smoke-yolov8n.onnx'
V2 = '/opt/jsc/straw-engine/runs/detect/m5_finetune/weights/best.onnx'
DATA = '/opt/jsc/straw-engine/train_data/merged/data.yaml'
BUCHONG = '/tmp/buchong'

print('=' * 60)
print('1. FlameVision test 集 mAP 对比 (450 张)')
print('=' * 60)
for name, path in [('v1 (D-Fire)', V1), ('v2 (微调)', V2)]:
    m = YOLO(path)
    r = m.val(data=DATA, split='test', imgsz=640, conf=0.001, iou=0.6, verbose=False)
    print(f'  {name:14} | mAP50={r.box.map50:.4f} | mAP50-95={r.box.map:.4f} | P={r.box.mp:.4f} | R={r.box.mr:.4f}')

print()
print('=' * 60)
print('2. buchong 真实样本检出对比 (35 张, conf=0.30)')
print('=' * 60)
files = sorted(os.listdir(BUCHONG))
for name, path in [('v1 (D-Fire)', V1), ('v2 (微调)', V2)]:
    m = YOLO(path)
    hits = 0
    total_boxes = 0
    max_conf = 0
    for f in files:
        r = m.predict(os.path.join(BUCHONG, f), imgsz=640, conf=0.30, verbose=False)
        boxes = r[0].boxes
        if boxes is not None and len(boxes):
            hits += 1
            total_boxes += len(boxes)
            max_conf = max(max_conf, float(boxes.conf.max()))
    print(f'  {name:14} | 检出 {hits}/35 张 ({hits/35*100:.1f}%) | 总框 {total_boxes} | 最高置信 {max_conf:.2f}')
