#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成 27 帧 AI 画框预览页 v5ai_boxes.html
- 显示原图 + AI 画框（红色 smoke 框）
- 部署 :81 让用户目视复核框质量
"""
import os, json, base64, glob
from PIL import Image, ImageDraw, ImageFont
from io import BytesIO

ROOT = '/video/shujuji/datasets/v5_candidates/record'
BOXES = '/video/llm_infer/boxes_v2_ai.json'
REVIEW = '/video/llm_infer/v5_review_result.json'

boxes = json.load(open(BOXES, encoding='utf-8'))
review = json.load(open(REVIEW, encoding='utf-8'))
smoke = {f"{x['dir']}/{x['file']}": x for x in review['frames'] if x['judge'] == 'smoke'}

# 缩略图
def thumb_b64(fp, max_w=560):
    im = Image.open(fp).convert('RGB')
    if im.width > max_w:
        im = im.resize((max_w, int(im.height * max_w / im.width)), Image.LANCZOS)
    draw = ImageDraw.Draw(im)
    rel = fp.split('/record/')[-1]
    if rel in boxes:
        W, H = Image.open(fp).size
        scale = max_w / W if W > max_w else 1.0
        for cls, cx, cy, w, h in boxes[rel]:
            x1, y1 = (cx - w/2) * W * scale, (cy - h/2) * H * scale
            x2, y2 = (cx + w/2) * W * scale, (cy + h/2) * H * scale
            draw.rectangle([x1, y1, x2, y2], outline=(220, 38, 38), width=3)
    buf = BytesIO()
    im.save(buf, 'JPEG', quality=78)
    return base64.b64encode(buf.getvalue()).decode()

cards = []
for rel, f in smoke.items():
    fp = f"{ROOT}/{rel}"
    b64 = thumb_b64(fp)
    note = f.get('note', '')
    fire = f.get('fire', '-')
    cards.append((rel, b64, note, fire))

html = ['<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>27 帧 AI 画框预览</title>']
html.append('<style>body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f5f6f8;color:#1f2937;padding:24px;margin:0}')
html.append('.wrap{max-width:1100px;margin:0 auto}h1{font-size:22px;margin-bottom:6px}.meta{color:#6b7280;font-size:13px;margin-bottom:20px}')
html.append('.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}')
html.append('.card{background:#fff;border:1px solid #e2e5ea;border-radius:10px;padding:12px;display:flex;gap:12px;align-items:flex-start}')
html.append('.card img{border-radius:6px;max-width:100%;height:auto;background:#0f172a}')
html.append('.info{flex:1;font-size:13px}.info b{color:#1f2937}.info .n{color:#6b7280;font-size:12px;margin-top:4px}')
html.append('.nbox{color:#dc2626;font-weight:600;margin-top:4px}.badge{display:inline-block;background:#fef2f2;color:#dc2626;padding:1px 8px;border-radius:10px;font-size:11px;margin-left:6px}')
html.append('.amb{background:#fffbeb;border:1px solid #fcd34d;padding:6px 10px;border-radius:6px;color:#92400e;font-size:12px;margin-top:4px}</style></head><body><div class=wrap>')
html.append('<h1>v2 训练 - 27 帧 AI 画框预览</h1>')
html.append(f'<div class=meta>生成时间: 2026-08-28 · AI 视觉看图定位 · 框统一 smoke 单类 · 部署 <code>:81/v5ai_boxes.html</code></div>')
html.append('<div class=grid>')
for rel, b64, note, fire in cards:
    amb = '<div class=amb>⚠ 用户注释: ' + note + '</div>' if note else ''
    html.append(f'<div class=card><img src="data:image/jpeg;base64,{b64}"/><div class=info><b>{rel}</b><div class=n>fire={fire}</div>{amb}</div></div>')
html.append('</div></div></body></html>')
open('/video/llm_infer/v5ai_boxes.html', 'w', encoding='utf-8').write('\n'.join(html))
print(f'已生成 v5ai_boxes.html ({len(cards)} 帧)')
