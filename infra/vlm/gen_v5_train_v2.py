#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v5 训练集组集（v3：27 帧用户复核标注，含多框细分）
- 正样本: 真实烟 26(用户复核, 53-1=52 框) + wechat 69 + syn 400
- 负样本: 真实无烟 259 + 15 难负(14+用户删空 12-39-46-0/f3) + wechat 74 空标 + val 100
- val 真实帧 holdout (7 烟 + 100 无烟)，杜绝 syn 泄漏
- 用户空框帧（12-39-46-0/f3.jpg）自动从 smoke 移入难负样本
"""
import os, json, random
from collections import defaultdict

random.seed(42)
TRAIN_RATIO = 0.85
OUT_ROOT = '/video/shujuji/datasets/v5_train_v3'
SPLIT_DIR = f'{OUT_ROOT}/splits'

WECHAT_IMG = '/video/shujuji/datasets/v5_wechat/images'
WECHAT_LAB = '/video/shujuji/datasets/v5_wechat/labels'
SYN_IMG = '/video/shujuji/datasets/v5_syn/images'
SYN_LAB = '/video/shujuji/datasets/v5_syn/labels'
CAND_ROOT = '/video/shujuji/datasets/v5_candidates'
REVIEW = '/video/llm_infer/v5_review_result.json'
BOXES = '/video/llm_infer/boxes_v2_ai.json'


def main():
    os.makedirs(f'{CAND_ROOT}/labels/record', exist_ok=True)

    rev = json.load(open(REVIEW, encoding='utf-8'))
    smoke_frames = [f for f in rev['frames'] if f['judge'] == 'smoke']
    no_frames    = [f for f in rev['frames'] if f['judge'] == 'no']
    print(f'复核结果: 真烟 {len(smoke_frames)} / 否掉 {len(no_frames)}')

    # 1. 写真实烟标签（用户复核版）
    boxes = json.load(open(BOXES, encoding='utf-8'))
    # 用户删空的帧自动移入难负样本（如 12-39-46-0/f3.jpg）
    kept, moved = [], []
    for f in smoke_frames:
        rel = f"{f['dir']}/{f['file']}"
        if rel in boxes and boxes[rel]:
            kept.append(f)
        else:
            moved.append(f)
            no_frames.append(f)
    if moved:
        print(f'  !! 用户删空移入难负: {[f["dir"]+"/"+f["file"] for f in moved]}')
    smoke_frames = kept
    print(f'调整后: 真烟 {len(smoke_frames)} / 否掉(含难负) {len(no_frames)}')

    n_lab = 0
    for f in smoke_frames:
        rel = f"{f['dir']}/{f['file']}"
        if rel not in boxes:
            print(f'  !! 无框跳过: {rel}'); continue
        lab_dir = f'{CAND_ROOT}/labels/record/{f["dir"]}'
        os.makedirs(lab_dir, exist_ok=True)
        lab_path = f'{lab_dir}/{f["file"][:-4]}.txt'
        with open(lab_path, 'w') as fp:
            fp.write('\n'.join(f'{c} {x} {y} {w} {h}' for c, x, y, w, h in boxes[rel]))
        n_lab += 1
    # 删除已移出帧的旧标签，防止残留
    for f in moved:
        old = f'{CAND_ROOT}/labels/record/{f["dir"]}/{f["file"][:-4]}.txt'
        if os.path.exists(old):
            os.remove(old); print(f'  -> 删除旧标签: {old}')
    print(f'  -> 写入 {n_lab} 个真实烟标签到 {CAND_ROOT}/labels/record/')

    # 2. val holdout 真实烟 7 + 真实无烟 100
    random.shuffle(smoke_frames)
    val_smoke = smoke_frames[:7]
    train_smoke = smoke_frames[7:]
    print(f'  真实烟切分: train {len(train_smoke)} / val {len(val_smoke)}')

    pos, neg = [], []

    # 真实烟 train
    for f in train_smoke:
        rel = f"{f['dir']}/{f['file']}"
        pos.append((f'{CAND_ROOT}/images/record/{rel}',
                    f'{CAND_ROOT}/labels/record/{rel[:-4]}.txt', 'r'))
    # 真实烟 val
    for f in val_smoke:
        rel = f"{f['dir']}/{f['file']}"
        pos.append((f'{CAND_ROOT}/images/record/{rel}',
                    f'{CAND_ROOT}/labels/record/{rel[:-4]}.txt', 'v'))

    # wechat 正
    for f in os.listdir(WECHAT_IMG):
        if not f.endswith('.png'): continue
        lab = f'{WECHAT_LAB}/{f[:-4]}.txt'
        if os.path.exists(lab) and os.path.getsize(lab) > 0:
            pos.append((f'{WECHAT_IMG}/{f}', lab, 'w'))

    # syn 正（前 400 张）
    for f in sorted(os.listdir(SYN_IMG)):
        if not f.endswith('.jpg'): continue
        if int(f.split('_')[1].split('.')[0]) >= 400: continue
        lab = f'{SYN_LAB}/{f[:-4]}.txt'
        if os.path.exists(lab) and os.path.getsize(lab) > 0:
            pos.append((f'{SYN_IMG}/{f}', lab, 's'))

    # 真实无烟候选
    neg_list = json.load(open(f'{CAND_ROOT}/neg_list.json', encoding='utf-8'))
    vlm_neg_paths = [x['frame'] for x in neg_list]
    user_no_paths = {f"{CAND_ROOT}/images/record/{x['dir']}/{x['file']}" for x in no_frames}
    random.shuffle(vlm_neg_paths)
    val_real_neg = vlm_neg_paths[:100]
    train_real_neg = vlm_neg_paths[100:]
    for p in train_real_neg: neg.append((p, None, 'c'))
    for p in user_no_paths:  neg.append((p, None, 'h'))  # 14 难负
    for p in val_real_neg:   neg.append((p, None, 'v'))

    # wechat 空标
    for f in os.listdir(WECHAT_IMG):
        if not f.endswith('.png'): continue
        lab = f'{WECHAT_LAB}/{f[:-4]}.txt'
        if os.path.exists(lab) and os.path.getsize(lab) == 0:
            neg.append((f'{WECHAT_IMG}/{f}', lab, 'w'))

    # 桶划分
    def bucket_key(item):
        img, lab, src = item
        if src in ('r', 'v'): return 'real_' + img.split('/')[-2]
        if src == 'w': return 'w_all'
        if src == 's':
            num = img.split('/')[-1].split('_')[1].split('.')[0]
            return 's_' + num[:2]
        if src == 'c': return 'c_' + img.split('/')[-2]
        if src == 'h': return 'hardneg'
        return 'x'

    buckets = defaultdict(lambda: {'pos': [], 'neg': []})
    for it in pos: buckets[bucket_key(it)]['pos'].append(it)
    for it in neg: buckets[bucket_key(it)]['neg'].append(it)

    train_pos, train_neg, val_pos, val_neg = [], [], [], []
    for k, v in buckets.items():
        random.shuffle(v['pos']); random.shuffle(v['neg'])
        if k.startswith('real_') or k.startswith('v_'):
            for it in v['pos']:
                (val_pos if it[2] == 'v' else train_pos).append(it)
            for it in v['neg']:
                (val_neg if it[2] == 'v' else train_neg).append(it)
            continue
        # syn 桶强制全部进 train（避免合成泄漏到 val）
        if k.startswith('s_'):
            train_pos.extend(v['pos'])
            train_neg.extend(v['neg'])
            continue
        n_val_p = max(0, int(len(v['pos']) * (1 - TRAIN_RATIO)))
        n_val_n = max(0, int(len(v['neg']) * (1 - TRAIN_RATIO)))
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

    yaml = (
        f'# v5 训练集配置 (v3: 用户复核标注, 26 帧真实烟/52 框)\n'
        f'path: {OUT_ROOT}\n'
        f'train: splits/train.txt\n'
        f'val: splits/val.txt\n'
        f'nc: 1\n'
        f"names: ['smoke']\n"
    )
    with open(f'{OUT_ROOT}/v5_smoke_v3.yaml', 'w', encoding='utf-8') as f:
        f.write(yaml)

    cnt = lambda lst, *ss: sum(1 for x in lst if x[2] in ss)
    n_real = sum(1 for x in pos if x[2] in ('r','v'))
    n_w    = sum(1 for x in pos if x[2]=='w')
    n_s    = sum(1 for x in pos if x[2]=='s')
    n_c    = sum(1 for x in neg if x[2]=='c')
    n_h    = sum(1 for x in neg if x[2]=='h')
    n_wn   = sum(1 for x in neg if x[2]=='w')
    n_v    = sum(1 for x in neg if x[2]=='v')
    print('\n====== v5 v3 数据集（用户复核标注）======')
    print(f'正({len(pos)}): 真实烟 {n_real} + wechat {n_w} + syn {n_s}')
    print(f'负({len(neg)}): 真实无烟 {n_c} + 14难负 {n_h} + wechat空 {n_wn} + val {n_v}')
    print(f'比例: 1:{len(neg)/len(pos):.2f}')
    print(f'训练: {len(train)} (pos {len(train_pos)} + neg {len(train_neg)})')
    print(f'验证: {len(val)} (pos {len(val_pos)} + neg {len(val_neg)})')
    print(f'输出: {OUT_ROOT}/')


if __name__ == '__main__':
    main()
