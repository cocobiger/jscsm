#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""VLM 预标 92 帧烟雾 bbox（Qwen2.5-VL，ollama）
对人工确认有烟的 92 帧，用 VLM 框出烟雾区域，输出 YOLO 格式标注。
"""
import json, base64, urllib.request, os, glob, sys

OLLAMA = 'http://127.0.0.1:11434/api/generate'
MODEL = 'qwen2.5vl:7b'
FRAMES_DIR = '/video/shujuji/xunlian/verify_20260908/frames'
REVIEW_JSON = '/video/shujuji/xunlian/verify_20260908/detect_result.json'
OUT_JSON = '/video/shujuji/xunlian/verify_20260908/vlm_labels.json'

# 人工确认有烟的帧（从复核结果读，或传 smokeFrames 列表）
SMOKE_FRAMES = json.load(open('/video/shujuji/xunlian/verify_20260908/human_review.json'))['smokeFrames'] if os.path.exists('/video/shujuji/xunlian/verify_20260908/human_review.json') else None

PROMPT = ('这张无人机航拍图里如果有烟雾（秸秆焚烧产生的白烟/灰烟，可能呈薄雾状、扩散状），'
          '请框出烟雾区域，输出 JSON 数组 [{"bbox":[x1,y1,x2,y2],"label":"smoke"}]，'
          '坐标为 0-1000 归一化整数。烟雾通常是局部、有方向、半透明的白色/灰色雾状区域，'
          '与均匀的天空/远山背景不同。如果没有烟雾，输出 []。只输出 JSON，不要任何其他文字。')

def vlm_label(img_path):
    with open(img_path, 'rb') as f:
        b64 = base64.b64encode(f.read()).decode()
    body = json.dumps({
        'model': MODEL,
        'prompt': PROMPT,
        'images': [b64],
        'stream': False,
        'options': {'temperature': 0.1, 'num_predict': 400},
    }).encode()
    req = urllib.request.Request(OLLAMA, data=body, headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            d = json.loads(r.read())
        resp = (d.get('response') or '').strip()
        # 提取 JSON 数组
        import re
        m = re.search(r'\[.*\]', resp, re.DOTALL)
        if m:
            arr = json.loads(m.group(0))
            return arr if isinstance(arr, list) else []
        return []
    except Exception as e:
        return {'error': str(e)}

def main():
    # 取人工确认有烟的帧
    if SMOKE_FRAMES:
        frames = [os.path.join(FRAMES_DIR, f) for f in SMOKE_FRAMES if os.path.exists(os.path.join(FRAMES_DIR, f))]
    else:
        frames = sorted(glob.glob(FRAMES_DIR + '/*.jpg'))
    print('待 VLM 预标帧数:', len(frames))
    results = {}
    for i, fp in enumerate(frames):
        name = os.path.basename(fp)
        r = vlm_label(fp)
        results[name] = r
        n = len(r) if isinstance(r, list) else 0
        err = r.get('error') if isinstance(r, dict) else None
        print(f'[{i+1}/{len(frames)}] {name}: {n} 框' + (f' ERR:{err}' if err else ''))
        sys.stdout.flush()
    json.dump(results, open(OUT_JSON, 'w'), ensure_ascii=False, indent=2)
    total = sum(len(v) for v in results.values() if isinstance(v, list))
    print('完成。总框数:', total, '→', OUT_JSON)

main()
