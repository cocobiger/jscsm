"""M5 微调：从 D-Fire 权重继续训练（FlameVision fire + buchong smoke）
产出：runs/detect/m5_finetune/weights/best.pt → 导出 best.onnx
"""
import sys
from ultralytics import YOLO

BASE = '/opt/jsc/straw-engine/models/fire-smoke-yolov8n.pt'
DATA = '/opt/jsc/straw-engine/train_data/merged/data.yaml'
OUT = '/opt/jsc/straw-engine/runs/detect/m5_finetune'

EPOCHS = int(sys.argv[1]) if len(sys.argv) > 1 else 30
BATCH = int(sys.argv[2]) if len(sys.argv) > 2 else 32

model = YOLO(BASE)
print(f'[train] 从 {BASE} 微调 · epochs={EPOCHS} batch={BATCH} imgsz=640')
results = model.train(
    data=DATA,
    epochs=EPOCHS,
    batch=BATCH,
    imgsz=640,
    project='/opt/jsc/straw-engine/runs/detect',
    name='m5_finetune',
    exist_ok=True,
    device='cpu',
    patience=8,
    workers=4,
    seed=42,
    verbose=True,
)
print('[train] 训练完成')

# 导出 ONNX
best = f'{OUT}/weights/best.pt'
print('[train] 导出 ONNX...')
model = YOLO(best)
path = model.export(format='onnx', imgsz=640, opset=12)
print('[train] 导出:', path)
