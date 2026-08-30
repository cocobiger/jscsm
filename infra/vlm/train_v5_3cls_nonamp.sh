#!/bin/bash
# ============================================================
# v5 3 类重训（方案C B线）：amp=False 修复 AMP 溢出（epoch 8+ nan 教训）
# 起点: v5_smoke_3cls best（epoch 6 干净权重）续训
# 架构: RT-DETR-L @960（与生产 m6 同架构同分辨率）
# 数据: /video/shujuji/datasets/v5_train_merge（7079 train / 1000 val 零泄漏）
# 差异: amp=False（其余参数与首轮一致: mosaic=1.0/close_mosaic=10/copy_paste=0/scale=0.5/fliplr=0.5）
#       epochs=100 patience=20 cache=ram 输出独立目录 v5_smoke_3cls_nonamp（不覆盖首轮）
# 导出: ONNX opset=16（RT-DETR 硬性要求 >=16，首轮 opset=12 失败教训）
# 输出: /video/xunlian/runs/detect/v5_smoke_3cls_nonamp/
# ============================================================
cd /video/llm_infer
export PYTHONUNBUFFERED=1
/opt/jsc/straw-engine/venv/bin/python3 - << 'PY'
from ultralytics import YOLO

BASE = '/video/xunlian/runs/detect'
PREV_BEST = f'{BASE}/v5_smoke_3cls/weights/best.pt'
DATA = '/video/shujuji/datasets/v5_train_merge/data.yaml'

print(f'[nonamp] 从 v5_smoke_3cls best 续训(amp=False): {PREV_BEST}', flush=True)
model = YOLO(PREV_BEST)
print(f'[nonamp] 架构/类别: {model.task} / {model.names}', flush=True)

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
    amp=False,
    mosaic=1.0,
    close_mosaic=10,
    copy_paste=0.0,
    scale=0.5,
    fliplr=0.5,
    project=BASE,
    name='v5_smoke_3cls_nonamp',
    verbose=True,
)
print('====== v5 3cls nonamp 训练完成 ======', flush=True)

# 导出 ONNX（opset=16 修正，RT-DETR 硬性要求 >=16）
best = f'{BASE}/v5_smoke_3cls_nonamp/weights/best.pt'
print('[nonamp] 导出 ONNX (opset=16)...', flush=True)
m = YOLO(best)
p = m.export(format='onnx', imgsz=960, opset=16, simplify=True)
print(f'[nonamp] ONNX: {p}', flush=True)
PY
