#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""9/9 5段视频：下载(MinIO) + 抽帧 + stage2_dilute 检测，统计检出/漏检选最有价值视频"""
import sys, os, glob, subprocess
sys.path.insert(0, '/video/venvs/vlm/lib/python3.10/site-packages')
from minio import Minio

BASE = '/video/shujuji/xunlian/train_0909'
os.makedirs(BASE, exist_ok=True)
client = Minio('127.0.0.1:9000', access_key='Xka@123.', secret_key='Xka@123.', secure=False)

videos = [
    ('__defaultVhost__/live/1581F8HGX253U00A064U/20260909/10-36-10-0.mp4', '064U_1036'),
    ('__defaultVhost__/live/1581F8HGX258600A0S4J/20260909/10-50-23-0.mp4', '0S4J_1050'),
    ('__defaultVhost__/live/1581F8HGX258600A0S4G/20260909/11-05-16-0.mp4', '0S4G_1105'),
    ('__defaultVhost__/live/1581F8HGX253U00A064U/20260909/11-18-50-0.mp4', '064U_1118'),
    ('__defaultVhost__/live/1581F8HGX258600A0S4G/20260909/11-32-17-0.mp4', '0S4G_1132'),
]

# 1. 下载 + 抽帧（960x720 fps=1/5）
for obj, name in videos:
    src = f'{BASE}/src_{name}.mp4'
    frames = f'{BASE}/frames_{name}'
    os.makedirs(frames, exist_ok=True)
    if not os.path.exists(src) or os.path.getsize(src) < 1000000:
        try:
            client.fget_object('test', obj, src)
            print(f'下载 {name}: {os.path.getsize(src)/1024/1024:.0f}MB')
        except Exception as e:
            print(f'下载 {name} 失败: {e}'); continue
    else:
        print(f'{name} 已存在')
    if not glob.glob(f'{frames}/*.jpg'):
        subprocess.run(['ffmpeg','-v','error','-i',src,'-vf','fps=1/5','-q:v','3', f'{frames}/f%04d.jpg','-y'], capture_output=True)
    n = len(glob.glob(f'{frames}/*.jpg'))
    print(f'  抽帧 {name}: {n} 帧')

# 2. stage2_dilute 检测（统计每段检出帧数）
sys.path.insert(0, '/opt/jsc/straw-engine/app')
import cv2
from detector import Detector
det = Detector('/video/xunlian/runs/detect/v5_smoke_v5/stage2/weights/best.onnx', conf=0.15, conf_smoke=0.15, conf_fire=0.45, conf_house=0.35, input_size=1280, format='yolo', use_gpu=False)

print()
print('=== stage2_dilute 检测统计（检出帧数/总帧数） ===')
results = {}
for obj, name in videos:
    frames = f'{BASE}/frames_{name}'
    files = sorted(glob.glob(f'{frames}/*.jpg'))
    hit = 0
    hit_frames = []
    for fp in files:
        img = cv2.imread(fp)
        if img is None: continue
        boxes = det.predict(img)
        smoke = [b for b in boxes if int(b[5]) == 0]
        if smoke:
            hit += 1
            hit_frames.append((os.path.basename(fp), round(max(float(b[4]) for b in smoke), 3)))
    results[name] = {'total': len(files), 'hit': hit, 'frames': hit_frames}
    print(f'{name}: {hit}/{len(files)} 检出  {hit_frames[:5]}')

import json
json.dump(results, open(f'{BASE}/detect_stat.json', 'w'), ensure_ascii=False, indent=2)
print()
print('统计已存 detect_stat.json')
