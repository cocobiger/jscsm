#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 v5 候选帧人工复核页面（自包含 HTML）+ 负样本清单
- 41 帧 VLM 判"有烟" → 人工复核（确认/改判/不确定），作为真实航拍正样本
- 359 帧 VLM 判"无烟" → 居民区负样本清单（neg_list.json）
"""
import json, base64, os
from collections import Counter

CAND = '/video/shujuji/datasets/v5_candidates'
REC = os.path.join(CAND, 'record')
TPL = '/video/llm_infer/review_template.html'
OUT = '/video/llm_infer/v5review.html'


def main():
    res = json.load(open(os.path.join(CAND, 'vlm_results.json'), encoding='utf-8'))
    v3 = json.load(open(os.path.join(CAND, 'v3_candidates.json'), encoding='utf-8'))
    fire_cnt = Counter(h['frame'] for h in v3['hits'])

    # 41 帧有烟
    smoke = sorted(k for k, v in res.items() if '烟' in v and '无烟' not in v)
    frames = []
    for i, k in enumerate(smoke, 1):
        rel = k[len(REC) + 1:]          # 10-27-39-0/f2.jpg
        d, fname = rel.split('/')
        b64 = base64.b64encode(open(k, 'rb').read()).decode()
        # 亮度（0-255，< 25 视为夜场低可信）
        try:
            from PIL import Image
            im = Image.open(k).convert('RGB').resize((120, 68))
            bright = round(sum(sum(p) for p in im.getdata()) / (120 * 68 * 3), 1)
        except Exception:
            bright = -1
        frames.append({
            'idx': i, 'dir': d, 'file': fname, 'path': k,
            'fire': fire_cnt.get(k, 0), 'vlm': res[k], 'b64': b64,
            'bright': bright,
        })

    # 359 帧无烟 → 负样本清单
    neg = sorted(k for k in res if not ('烟' in res[k] and '无烟' not in res[k]))
    neg_list = [{'frame': k, 'vlm': res[k], 'fire': fire_cnt.get(k, 0)} for k in neg]
    with open(os.path.join(CAND, 'neg_list.json'), 'w', encoding='utf-8') as f:
        json.dump(neg_list, f, ensure_ascii=False, indent=1)
    print(f'有烟帧 {len(frames)} / 负样本 {len(neg)} -> neg_list.json 已生成')

    # 渲染页面
    data = {'frames': frames}
    tpl = open(TPL, encoding='utf-8').read()
    html = (tpl
            .replace('{{DATA_JSON}}', json.dumps(data, ensure_ascii=False))
            .replace('{{TITLE}}', 'v5 候选帧人工复核 · 41 帧有烟帧'))
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f'页面已生成: {OUT} ({os.path.getsize(OUT) // 1024} KB)')


if __name__ == '__main__':
    main()
