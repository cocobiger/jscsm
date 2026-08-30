#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
校验 v2 数据集标签加载：模拟 ultralytics img2label_paths 规则
对每个 split 图片路径计算期望标签路径，检查存在性/非空性，
重点统计真实烟(images/record)标签命中数。
"""
import os

SPLITS = {
    'train': '/video/shujuji/datasets/v5_train_v2/splits/train.txt',
    'val': '/video/shujuji/datasets/v5_train_v2/splits/val.txt',
}


def img2label_path(img_path):
    """与 ultralytics data/utils.py img2label_paths 完全一致的规则"""
    sa, sb = '/images/', '/labels/'
    return sb.join(img_path.rsplit(sa, 1)).rsplit('.', 1)[0] + '.txt'


for name, path in SPLITS.items():
    paths = [l.strip() for l in open(path, encoding='utf-8') if l.strip()]
    n_lab = n_nonempty = n_real_pos = 0
    missing = []
    for p in paths:
        lab = img2label_path(p)
        if os.path.exists(lab):
            n_lab += 1
            if os.path.getsize(lab) > 0:
                n_nonempty += 1
        if '/images/record/' in p:
            if os.path.exists(lab) and os.path.getsize(lab) > 0:
                n_real_pos += 1
            else:
                missing.append(p.split('/')[-2] + '/' + p.split('/')[-1])
    print(f'[{name}] total={len(paths)} 有标签={n_lab} 非空={n_nonempty} 真实烟命中={n_real_pos}')
    if missing:
        print(f'  真实烟未命中 {len(missing)}: {missing[:5]}')
