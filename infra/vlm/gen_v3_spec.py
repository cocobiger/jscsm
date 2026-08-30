#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""准备 v3 工作台 INIT spec：27 旧 v2_ai + 4 新 dji_photo 混合"""
import json, os, subprocess, sys

# ---------- 路径 ----------
V2_AI   = '/video/llm_infer/boxes_v2_ai.json'
REVIEW  = '/video/llm_infer/v5_review_result.json'
SPEC    = '/video/llm_infer/v3_spec.json'

# 4 张新 dji_photo（手动 AI 预标，标注先放空由用户画整框）
NEW_FRAMES = [
    {
        'rel': 'dji_photo/DJI_20260826180830_0001_V',
        'url': '/v5_photos/dji_photo/DJI_20260826180830_0001_V.jpg',
        'src': 'dji_photo',
        'note': '8/26 18:08 远山烟雾（云霞 + 山坳零星烟）',
        'boxes': [],
    },
    {
        'rel': 'dji_photo/DJI_20260827191647_0001_V',
        'url': '/v5_photos/dji_photo/DJI_20260827191647_0001_V.jpg',
        'src': 'dji_photo',
        'note': '8/27 19:16:47 桥下山坳清晰白烟柱',
        'boxes': [],
    },
    {
        'rel': 'dji_photo/DJI_20260827191654_0003_V',
        'url': '/v5_photos/dji_photo/DJI_20260827191654_0003_V.jpg',
        'src': 'dji_photo',
        'note': '8/27 19:16:54 高铁桥下白烟升起',
        'boxes': [],
    },
    {
        'rel': 'dji_photo/DJI_20260827191659_0004_V',
        'url': '/v5_photos/dji_photo/DJI_20260827191659_0004_V.jpg',
        'src': 'dji_photo',
        'note': '8/27 19:16:59 高架桥右下方大型烟柱',
        'boxes': [],
    },
]

# ---------- 旧 27 帧 ----------
boxes  = json.load(open(V2_AI, encoding='utf-8'))
review = json.load(open(REVIEW, encoding='utf-8'))
smoke  = [x for x in review['frames'] if x['judge'] == 'smoke']
order_old = [f"{x['dir']}/{x['file']}" for x in smoke]

old_frames = []
for rel in order_old:
    f = next(x for x in smoke if f"{x['dir']}/{x['file']}" == rel)
    old_frames.append({
        'rel': rel,
        'url': f'/v5_old_imgs/{rel}',
        'src': 'v2_ai',
        'note': f.get('note', ''),
        'fire': str(f.get('fire', '-')),
        'boxes': boxes.get(rel, []),
    })

# ---------- 合并 ----------
spec = {
    'title': f'v3 多批 · {len(old_frames)} 旧 + {len(NEW_FRAMES)} 新',
    'frames': old_frames + NEW_FRAMES,
}

json.dump(spec, open(SPEC, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print(f'OK 写入 {SPEC}')
print(f'  旧 v2_ai: {len(old_frames)} 帧')
print(f'  新 dji_photo: {len(NEW_FRAMES)} 帧')
print(f'  总计: {len(spec["frames"])} 帧')
