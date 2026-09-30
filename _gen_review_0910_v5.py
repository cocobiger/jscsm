#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 9/10 防污染复核台 v5：模板 + data.json"""
import os, json, re

TPL = '/video/xunlian/_review_0910_v5_tpl.html'
DATA = '/opt/jsc/frontend/train_0910/data.json'
OUT = '/opt/jsc/frontend/train_0910/review.html'

html = open(TPL, encoding='utf-8').read()
data = json.load(open(DATA, encoding='utf-8'))

marker = '/*__DATA__*/{}'
assert marker in html, '模板占位符缺失'
html = html.replace(marker, '/*__DATA__*/' + json.dumps(data, ensure_ascii=False))

os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, 'w', encoding='utf-8').write(html)

n = len(data.get('frames') or [])
legacy = len(((data.get('legacySeed') or {}).get('yolo_norm_0_1000') or {}))
print('本批帧 =', n, ' 历史烟帧 =', legacy)
print('已生成:', OUT, os.path.getsize(OUT), 'bytes')

left = re.findall(r'/\*__[A-Z]+__\*/\{\}', html)
print('残留占位符:', left if left else '无 ✅')
