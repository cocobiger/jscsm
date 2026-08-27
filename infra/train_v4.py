"""merged_v4 RT-DETR@960 训练（从 m6 best.pt 增量，amp=False 防 nan）"""
from ultralytics import YOLO
import time

t0 = time.time()
BASE = '/video/xunlian/runs/detect/m6_rtdetr/weights/best.pt'
OUT_PROJECT = '/video/shujuji/xunlian/runs/detect'
NAME = 'm7_rtdetr_v4'

print(f'[v4] 基础权重: {BASE}')
print('[v4] 数据: /video/shujuji/datasets/merged_v4 (train 6390 / valid 1042)')
model = YOLO(BASE)
model.train(
    data='/video/shujuji/datasets/merged_v4/data.yaml',
    epochs=50, imgsz=960, batch=8, device=0,
    project=OUT_PROJECT, name=NAME, exist_ok=True,
    amp=False,          # 防 nan（历史教训）
    workers=8,
    patience=15,        # 早停
    save=True, val=True,
    plots=True,
)
best = f'{OUT_PROJECT}/{NAME}/weights/best.pt'
print(f'[v4] 训练完成，耗时 {(time.time()-t0)/60:.1f} 分钟，best: {best}')

# 导出 ONNX（生产格式）
m = YOLO(best)
onnx_path = m.export(format='onnx', imgsz=960, opset=16)
print('[v4] ONNX 导出:', onnx_path)

# 在同 valid 上评估（供 v3 vs v4 对比）
metrics = m.val(data='/video/shujuji/datasets/merged_v4/data.yaml', imgsz=960, batch=8)
print('[v4] valid mAP50-95:', metrics.box.map)
print('[v4] valid mAP50:', metrics.box.map50)
print('[v4] 各类 mAP50:', metrics.box.ap50)
print('[v4] 全部完成')
