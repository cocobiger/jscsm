#!/bin/bash
# ============================================================
# v5 3 类训练（方案B 第2批）：从 m6 生产 best 续训
# 架构: RT-DETR-L @960（与生产 m6 同架构同分辨率，可对比可替换）
# 数据: /video/shujuji/datasets/v5_train_merge（7079 train / 1000 val 零泄漏）
# 参数: 沿用 m6/m7 配置（mosaic=1.0/close_mosaic=10/copy_paste=0/scale=0.5/fliplr=0.5）
#       epochs=100 patience=20（审计第七节） cache=ram（7079图@960≈79GB 内存安全）
# 输出: /video/xunlian/runs/detect/v5_smoke_3cls/
# ============================================================
cd /video/llm_infer
export PYTHONUNBUFFERED=1
/opt/jsc/straw-engine/venv/bin/python3 - << 'PY'
from ultralytics import YOLO

BASE = '/video/xunlian/runs/detect'
M6_BEST = f'{BASE}/m6_rtdetr/weights/best.pt'
DATA = '/video/shujuji/datasets/v5_train_merge/data.yaml'

print(f'[train] 从 m6 生产 best 续训: {M6_BEST}', flush=True)
model = YOLO(M6_BEST)
print(f'[train] 架构/类别: {model.task} / {model.names}', flush=True)

results = model.train(
    data=DATA,
    epochs=100,
    patience=20,
    batch=8,
    imgsz=960,
    cache='ram',
    device=0,
    workers=8,
    seed=42,
    optimizer='auto',
    mosaic=1.0,
    close_mosaic=10,
    copy_paste=0.0,
    scale=0.5,
    fliplr=0.5,
    project=BASE,
    name='v5_smoke_3cls',
    verbose=True,
)
print('====== v5 3cls 训练完成 ======', flush=True)

# 导出 ONNX（生产替换用，RT-DETR@960 动态）
best = f'{BASE}/v5_smoke_3cls/weights/best.pt'
print(f'[train] 导出 ONNX...', flush=True)
m = YOLO(best)
p = m.export(format='onnx', imgsz=960, opset=12, simplify=True)
print(f'[train] ONNX: {p}', flush=True)
PY
