#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 9/9 补标工作台 v4（仅 45 帧未标注帧，带上一批标注种子 + 新版模型建议框）"""
import os, json, glob, re

TPL   = '/tmp/_review_buchong_tpl.html'
FR_DIR= '/opt/jsc/frontend/train_0909/frames'
SUG   = '/video/xunlian/train_0909/suggest_stage3.json'
SEED  = '/video/xunlian/train_0909/train_0909_labels_v3.json'
OUT   = '/opt/jsc/frontend/train_0909/review_buchong.html'
VIDEOS = ['064U_1036', '0S4G_1132']

# --- 全量帧序（318）---
allf = sorted(os.path.basename(p) for p in glob.glob(FR_DIR + '/*.jpg'))
print('帧总数 =', len(allf))

# --- 种子标注 ---
seed = json.load(open(SEED, encoding='utf-8'))
labeled = set()
for k in ('smokeFrames', 'negativeFrames', 'invalidFrames', 'unsureFrames', 'distractorFrames'):
    labeled |= set(seed.get(k) or [])
print('种子已标注 =', len(labeled))

todo = sorted(set(allf) - labeled)
print('待补标 =', len(todo))

# --- 模型建议 ---
sug = json.load(open(SUG, encoding='utf-8')) if os.path.exists(SUG) else {}

frames = []
missing_meta = 0
for f in todo:
    m = re.match(r'(.+?)_f(\d+)\.jpg', f)
    vid = m.group(1) if m else '?'
    s = sug.get(f)
    if s is None:
        missing_meta += 1
        s = {'boxes': [], 'bright': 0, 'std': 0, 'night': False, 'bad': False}
    frames.append({
        'file': f, 'vid': vid,
        'bright': s.get('bright', 0),
        'night': bool(s.get('night')),
        'bad': bool(s.get('bad')),
        'sug': s.get('boxes') or [],
    })

print(f'带建议框帧 = {sum(1 for x in frames if x["sug"])}  缺元数据帧 = {missing_meta}')
print(f'全黑帧 = {sum(1 for x in frames if x["bad"])}  夜帧 = {sum(1 for x in frames if x["night"])}')

# 校验：所有帧文件真实存在
for x in frames:
    assert os.path.exists(os.path.join(FR_DIR, x['file'])), f'缺帧 {x["file"]}'
print('帧文件校验 ✅')

# --- 填模板 ---
html = open(TPL, encoding='utf-8').read()
subs = [
    ('/*__FRAMES__*/[]',  '/*__FRAMES__*/' + json.dumps(frames, ensure_ascii=False)),
    ('/*__ALLFILES__*/[]','/*__ALLFILES__*/' + json.dumps(allf, ensure_ascii=False)),
    ('/*__SEED__*/{}',    '/*__SEED__*/' + json.dumps(seed, ensure_ascii=False)),
    ('/*__VIDEOS__*/[]',  '/*__VIDEOS__*/' + json.dumps(VIDEOS, ensure_ascii=False)),
    ('/*__TOTALALL__*/0', '/*__TOTALALL__*/' + str(len(allf))),
]
for a, b in subs:
    assert a in html, f'模板占位符缺失: {a}'
    html = html.replace(a, b)

open(OUT, 'w', encoding='utf-8').write(html)
print('已生成:', OUT, os.path.getsize(OUT), 'bytes')

# 自检：HTML 里不该残留占位符
left = re.findall(r'/\*__[A-Z]+__\*/[\[\{]?\}?\]?', html)
print('残留占位符:', left[:5] if left else '无 ✅')
