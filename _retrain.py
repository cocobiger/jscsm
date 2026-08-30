"""复检数据迭代训练脚本：读复检标注 → 合并训练集 → 增量训练 RT-DETR@960 → 评估"""
import os, sys, json, glob, shutil, sqlite3, random
import cv2
import numpy as np

sys.path.insert(0, 'app')
DB = '/opt/jsc/backend/data/jsc.db'
STRAW = '/opt/jsc/straw-engine'
MERGED = f'{STRAW}/train_data/merged_v3'
RETRAIN = '/video/xunlian/retrain'
EPOCHS = int(sys.argv[1]) if len(sys.argv) > 1 else 30
BATCH = int(sys.argv[2]) if len(sys.argv) > 2 else 8

def main():
    conn = sqlite3.connect(DB)
    rows = conn.execute(
        "SELECT id, stream_id, frame_path, boxes, label, review_status, max_conf FROM straw_detections "
        "WHERE review_status IN ('true','false') ORDER BY id").fetchall()
    conn.close()
    print(f'复检样本: true/false 共 {len(rows)} 条')

    # 版本号（自增）
    v = 1
    while os.path.exists(f'{RETRAIN}/v{v}'):
        v += 1
    out = f'{RETRAIN}/v{v}'
    train_img = f'{out}/images/train'
    train_lab = f'{out}/labels/train'
    os.makedirs(train_img, exist_ok=True)
    os.makedirs(train_lab, exist_ok=True)

    pos = neg = 0
    for (rid, sid, frame_path, boxes, label, status, max_conf) in rows:
        src = os.path.join(STRAW, frame_path)
        if not os.path.exists(src):
            continue
        stem = f'rv{rid}_{os.path.basename(frame_path).split(".")[0]}'
        shutil.copy2(src, f'{train_img}/{stem}.png')
        if status == 'true':
            bl = json.loads(boxes) if boxes else []
            img = cv2.imread(src)
            H, W = img.shape[:2] if img is not None else (1732, 2942)
            lines = []
            for b in bl:
                if b.get('x2', 0) - b.get('x1', 0) < 2 or b.get('y2', 0) - b.get('y1', 0) < 2:
                    continue
                cx = ((b['x1'] + b['x2']) / 2) / W
                cy = ((b['y1'] + b['y2']) / 2) / H
                bw = (b['x2'] - b['x1']) / W
                bh = (b['y2'] - b['y1']) / H
                lines.append(f"{int(b.get('cls', 1))} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}")
            if lines:
                with open(f'{train_lab}/{stem}.txt', 'w') as f:
                    f.write('\n'.join(lines))
                pos += 1
            else:
                open(f'{train_lab}/{stem}.txt', 'w').close()
                pos += 1  # 有标注无有效框 → 空正样本
        else:
            open(f'{train_lab}/{stem}.txt', 'w').close()
            neg += 1

    print(f'正样本(真烟): {pos} | 负样本(误报): {neg} | 共 {pos + neg}')

    if pos + neg < 5:
        print('复检样本不足（<5），跳过训练。先在复检页标注。')
        return

    # 合并 merged_v3 训练集（保留基础能力）+ 复检样本
    data_yaml = f'{out}/data.yaml'
    with open(data_yaml, 'w') as f:
        f.write(f"path: {out}\ntrain: images/train\nval: {MERGED}/images/val\n\nnames:\n  0: smoke\n  1: fire\n")

    # 复制 merged_v3 训练图到新数据集（软链接省空间）
    for fp in glob.glob(f'{MERGED}/images/train/*'):
        shutil.copy2(fp, f'{train_img}/{os.path.basename(fp)}')
    for fp in glob.glob(f'{MERGED}/labels/train/*'):
        shutil.copy2(fp, f'{train_lab}/{os.path.basename(fp)}')

    n_train = len(os.listdir(train_img))
    print(f'训练集: {n_train} 张（merged_v3 {n_train - pos - neg} + 复检 {pos + neg}）')
    print(f'数据集: {out}')

    # 训练（从 RT-DETR best 增量）
    from ultralytics import YOLO
    model = YOLO(f'{STRAW}/runs/detect/m6_rtdetr/weights/best.pt')
    model.train(
        data=data_yaml, epochs=EPOCHS, imgsz=960, batch=BATCH, device=0,
        project=f'{out}/runs', name='rtdetr_rv', exist_ok=True,
    )
    best = f'{out}/runs/rtdetr_rv/weights/best.pt'
    m = YOLO(best)
    path = m.export(format='onnx', imgsz=960, opset=16)
    print('迭代训练完成:', path)

if __name__ == '__main__':
    main()
