#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v5 训练集组集脚本（v1：不包含 41 帧人工复核待入）
- 正样本: v5_wechat(69) + v5_syn(800) = 869
- 负样本: v5_wechat 空标签(74) + v5_candidates VLM-无烟(359) = 433
- 比例 1:0.50（v1 基线；v2 待 41 帧加入后调整）
- 输出: v5_train/{v5_smoke.yaml, splits/{train,val}.txt}
- 不复制图像，纯路径列表（YOLO 支持 file list 模式）
"""
import os, json, random
from collections import defaultdict

random.seed(42)
TRAIN_RATIO = 0.85
OUT_ROOT = '/video/shujuji/datasets/v5_train'
SPLIT_DIR = f'{OUT_ROOT}/splits'

WECHAT_IMG = '/video/shujuji/datasets/v5_wechat/images'
WECHAT_LAB = '/video/shujuji/datasets/v5_wechat/labels'
SYN_IMG = '/video/shujuji/datasets/v5_syn/images'
SYN_LAB = '/video/shujuji/datasets/v5_syn/labels'
CAND_NEG = '/video/shujuji/datasets/v5_candidates/neg_list.json'


def main():
    pos, neg = [], []

    for f in os.listdir(WECHAT_IMG):
        if not f.endswith('.png'): continue
        lab = f'{WECHAT_LAB}/{f[:-4]}.txt'
        if os.path.exists(lab) and os.path.getsize(lab) > 0:
            pos.append((f'{WECHAT_IMG}/{f}', lab, 'w'))
    for f in os.listdir(SYN_IMG):
        if not f.endswith('.jpg'): continue
        lab = f'{SYN_LAB}/{f[:-4]}.txt'
        if os.path.exists(lab) and os.path.getsize(lab) > 0:
            pos.append((f'{SYN_IMG}/{f}', lab, 's'))

    for f in os.listdir(WECHAT_IMG):
        if not f.endswith('.png'): continue
        lab = f'{WECHAT_LAB}/{f[:-4]}.txt'
        if os.path.exists(lab) and os.path.getsize(lab) == 0:
            neg.append((f'{WECHAT_IMG}/{f}', lab, 'w'))
    for n in json.load(open(CAND_NEG, encoding='utf-8')):
        neg.append((n['frame'], None, 'c'))

    def bucket_key(item):
        img, lab, src = item
        if src == 'w': return 'w_all'  # wechat 整体一桶（避免 8 字符分桶过细）
        if src == 's':
            # syn_00000.jpg 编号 00000-00799，按前 2 位分 80 桶（每桶 10 张）
            num = img.split('/')[-1].split('_')[1].split('.')[0]
            return 's_' + num[:2]
        if src == 'c': return 'c_' + img.split('/')[-2]
        return 'x'

    buckets = defaultdict(lambda: {'pos': [], 'neg': []})
    for it in pos: buckets[bucket_key(it)]['pos'].append(it)
    for it in neg: buckets[bucket_key(it)]['neg'].append(it)

    train_pos, train_neg, val_pos, val_neg = [], [], [], []
    for k, v in buckets.items():
        random.shuffle(v['pos'])
        random.shuffle(v['neg'])
        n_val_p = max(1, int(len(v['pos']) * (1 - TRAIN_RATIO)))
        n_val_n = max(1, int(len(v['neg']) * (1 - TRAIN_RATIO)))
        val_pos.extend(v['pos'][:n_val_p]); train_pos.extend(v['pos'][n_val_p:])
        val_neg.extend(v['neg'][:n_val_n]); train_neg.extend(v['neg'][n_val_n:])

    train = train_pos + train_neg
    val = val_pos + val_neg
    random.shuffle(train); random.shuffle(val)

    os.makedirs(SPLIT_DIR, exist_ok=True)
    with open(f'{SPLIT_DIR}/train.txt', 'w') as f:
        for img, lab, src in train: f.write(img + '\n')
    with open(f'{SPLIT_DIR}/val.txt', 'w') as f:
        for img, lab, src in val: f.write(img + '\n')

    train_pos_set = set((x[0], x[1], x[2]) for x in train_pos)
    val_pos_set = set((x[0], x[1], x[2]) for x in val_pos)
    with open(f'{SPLIT_DIR}/train_meta.txt', 'w') as f:
        f.write('# idx\tsplit\tcls\timg\tlabel\tsrc\n')
        for i, (img, lab, src) in enumerate(train, 1):
            kind = 'pos' if (img, lab, src) in train_pos_set else 'neg'
            f.write(f'{i}\ttrain\t{kind}\t{img}\t{lab or "-"}\t{src}\n')
        for i, (img, lab, src) in enumerate(val, 1):
            kind = 'pos' if (img, lab, src) in val_pos_set else 'neg'
            f.write(f'{i}\tval\t{kind}\t{img}\t{lab or "-"}\t{src}\n')

    yaml = (
        f'# v5 训练集配置 (v1: 不含 41 帧待复核)\n'
        f'path: {OUT_ROOT}\n'
        f'train: splits/train.txt\n'
        f'val: splits/val.txt\n'
        f'nc: 1\n'
        f"names: ['smoke']\n"
    )
    with open(f'{OUT_ROOT}/v5_smoke.yaml', 'w', encoding='utf-8') as f:
        f.write(yaml)

    print('====== v5 v1 数据集 ======')
    print(f'正: {len(pos)} | 负: {len(neg)} | 比例 1:{len(neg)/len(pos):.2f}')
    print(f'训练: {len(train)} (pos {len(train_pos)} + neg {len(train_neg)})')
    print(f'验证: {len(val)} (pos {len(val_pos)} + neg {len(val_neg)})')
    n_w = sum(1 for x in train+val if x[2]=='w')
    n_s = sum(1 for x in train+val if x[2]=='s')
    n_c = sum(1 for x in train+val if x[2]=='c')
    print(f'源分布: wechat {n_w} | syn {n_s} | candidates {n_c}')
    print(f'\n输出: {OUT_ROOT}/v5_smoke.yaml + splits/')


if __name__ == '__main__':
    main()
