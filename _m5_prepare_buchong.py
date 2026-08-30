"""buchong 真实样本数据准备：
司空2 截图裁剪（OSD 条 / 右侧地图+俯视干扰）+ D-Fire 自动标注 → YOLO 格式
产出：/opt/jsc/straw-engine/train_data/buchong/{images,labels}/
      + 待人工复核清单（模型漏报的疑似烟雾图）
"""
import os
import sys
import shutil
import numpy as np
import cv2

sys.path.insert(0, '/opt/jsc/straw-engine/app')
from detector import Detector

SRC = '/tmp/buchong'
OUT = '/opt/jsc/straw-engine/train_data/buchong'
MODEL = '/opt/jsc/straw-engine/models/fire-smoke-yolov8n.onnx'
TOP_CROP = 80       # 顶部 OSD 条高度
BOTTOM_CROP = 0     # 底部罗盘（保留，避免误切）
CONF = 0.30

os.makedirs(f'{OUT}/images', exist_ok=True)
os.makedirs(f'{OUT}/labels', exist_ok=True)

det = Detector(MODEL, conf=CONF, input_size=640)
files = sorted(os.listdir(SRC))
made, no_hit, ui_cropped = 0, 0, 0

print(f'文件: {len(files)}  模型 conf={CONF}  顶部裁剪 {TOP_CROP}px')
for f in files:
    fp = os.path.join(SRC, f)
    img = cv2.imread(fp)
    if img is None:
        continue
    h, w = img.shape[:2]
    # 1. 裁顶部 OSD 条
    if h > TOP_CROP + 100:
        img = img[TOP_CROP:, :]
    # 2. 检测右侧 1/3 是否含地图/俯视（高饱和色块）→ 只保留左 3/4
    h2, w2 = img.shape[:2]
    right = img[:, int(w2 * 0.75):]
    sat = cv2.cvtColor(right, cv2.COLOR_BGR2HSV)[:, :, 1]
    high_sat_ratio = (sat > 120).mean()
    if high_sat_ratio > 0.08:   # 右侧高饱和（地图彩色）占比高 → 三窗布局
        img = img[:, :int(w2 * 0.75)]
        ui_cropped += 1
    # 3. D-Fire 检测
    boxes = det.predict(img)
    if not boxes:
        no_hit += 1
        continue
    # 4. 写 YOLO 标注（0=smoke, 1=fire；归一化）
    h3, w3 = img.shape[:2]
    out_img = f'{OUT}/images/{os.path.splitext(f)[0]}.jpg'
    out_txt = f'{OUT}/labels/{os.path.splitext(f)[0]}.txt'
    cv2.imwrite(out_img, img, [cv2.IMWRITE_JPEG_QUALITY, 90])
    lines = []
    for b in boxes:
        x1, y1, x2, y2, score, cls = b
        cx = ((x1 + x2) / 2) / w3
        cy = ((y1 + y2) / 2) / h3
        bw = (x2 - x1) / w3
        bh = (y2 - y1) / h3
        lines.append(f'{int(cls)} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}')
    with open(out_txt, 'w') as fh:
        fh.write('\n'.join(lines))
    made += 1
    print(f'  {f[:26]:26} → {len(boxes)} 框')

print(f'--- 完成: 标注 {made} 张 | 无检出 {no_hit} 张 | 三窗裁剪 {ui_cropped} 张 ---')
print(f'产出目录: {OUT}/')
print(f'待人工复核（无检出，可能漏报重点）: {no_hit} 张 → 需人工查看 /tmp/buchong/')
