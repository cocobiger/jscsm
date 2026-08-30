#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""用生产 v3 (RT-DETR@960) 为 27 帧用户确认真烟生成 smoke 框
输出: /video/llm_infer/v3_boxes_v2.json {frame: [[x1,y1,x2,y2,score,cls],...]} (原图坐标)
预览: /tmp/box_preview/<dir>_<file>.jpg (画框)
"""
import sys, os, json, cv2
sys.path.insert(0, '/opt/jsc/straw-engine')
sys.path.insert(0, '/opt/jsc/straw-engine/app')
from detector import Detector

review = json.load(open('/video/llm_infer/v5_review_result.json'))
smoke_frames = [f['path'] for f in review['frames'] if f['judge'] == 'smoke']
print(f'确认真烟帧: {len(smoke_frames)}', flush=True)

d = Detector('/opt/jsc/straw-engine/runs/detect/m6_rtdetr/weights/best.onnx',
             conf_smoke=0.25, conf_fire=0.40, conf_house=0.35,
             input_size=960, format='rtdetr')

os.makedirs('/tmp/box_preview', exist_ok=True)
out = {}
for fp in smoke_frames:
    img = cv2.imread(fp)
    if img is None:
        print('  !!! 读取失败:', fp); continue
    boxes = d.predict(img)
    out[fp] = boxes
    vis = img.copy()
    for b in boxes:
        x1, y1, x2, y2, s, cls = [float(v) for v in b]
        color = (0, 0, 255) if cls == 0 else (0, 165, 255)
        cv2.rectangle(vis, (int(x1), int(y1)), (int(x2), int(y2)), color, 2)
        cv2.putText(vis, f'{s:.2f}c{int(cls)}', (int(x1), max(0, int(y1)-6)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)
    name = fp.split('/record/')[-1].replace('/', '_')
    cv2.imwrite(f'/tmp/box_preview/{name}', vis)
    print(f'  {name}  boxes={len(boxes)}  ' +
          ', '.join(f'({b[4]:.2f},c{int(b[5])})' for b in boxes), flush=True)

json.dump(out, open('/video/llm_infer/v3_boxes_v2.json', 'w'), ensure_ascii=False, indent=1)
nobox = [fp for fp in smoke_frames if not out.get(fp)]
print(f'\n无框帧({len(nobox)}):', [fp.split('/record/')[-1] for fp in nobox])
print('saved /video/llm_infer/v3_boxes_v2.json')
