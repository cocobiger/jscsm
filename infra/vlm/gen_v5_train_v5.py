#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v5 训练集组集 v5（2026-09-01 晚）：并入直播人工整框 182 帧真烟

新增源（相对 v4）：
- live_review 182 帧正样本（用户整框，288 烟框）→ 真实烟，全进 train
- live_review 10 帧无框（用户确认无烟）→ 同域负样本（DJI 域，对抗"域=无烟"误学）
- 1 帧 pending（09-54-03-0/f00046）→ 跳过

数据源汇总：
- v2_ai 27 帧（v3_spec.json）：有框→真烟 / 空框→难负
- dji_photo 5 帧：有框→真烟
- wechat 52 正 + 73 空标负
- syn 400 正
- v5_neg_v3_reviewed 354 ok 负（人工复核）
- live 182 正 + 10 负（本次新增）

负正比：v4 428:482=1:0.89 → v5 438:664=1:0.66（正样本翻倍，负比例自然健康，
不再执行"砍负"（B 原方案 254→100 是针对旧正样本量的，现真烟 208 vs 同域负 254 已 1:0.82）

用法: /data/HBJSC/train-venv/bin/python gen_v5_train_v5.py   （训练环境建法见 deploy/HBJSC/scripts/setup_train_env.sh）
输出: /video/shujuji/datasets/v5_train_v5/{splits,v5_smoke_v5.yaml,images/labels}
"""
import os, json, random, shutil
from collections import defaultdict

random.seed(42)
TRAIN_RATIO = 0.85
SPEC = '/video/llm_infer/v3_spec.json'
OUT_ROOT = '/video/shujuji/datasets/v5_train_v5'
SPLIT_DIR = f'{OUT_ROOT}/splits'

CAND_ROOT = '/video/shujuji/datasets/v5_candidates'
WECHAT_IMG = '/video/shujuji/datasets/v5_wechat/images'
WECHAT_LAB = '/video/shujuji/datasets/v5_wechat/labels'
SYN_IMG = '/video/shujuji/datasets/v5_syn/images'
SYN_LAB = '/video/shujuji/datasets/v5_syn/labels'
DJI_IMG_ROOT = '/video/llm_infer/v5_photos'
LIVE_FRAMES = '/video/shujuji/datasets/v5_live_frames'
LIVE_EXPORT = '/video/llm_infer/live_review_export_0901.json'


def main():
    spec = json.load(open(SPEC, encoding='utf-8'))
    frames = spec['frames']
    print(f'spec 总帧: {len(frames)}')

    # ---- 1. 帧分类（v2_ai / dji_photo） ----
    pos_real = []      # (img, rel_safe, src) 真实烟
    hardneg = []       # 空框 v2_ai（确认无烟）
    pending = []       # 空框 dji_photo（待人工标注）
    for fr in frames:
        rel = fr['rel']
        boxes = fr.get('boxes', []) or []
        src = fr.get('src', '')
        note = fr.get('note', '')
        if src == 'v2_ai':
            img = f'{CAND_ROOT}/images/record/{rel}'
            if boxes:
                pos_real.append((img, rel, 'r'))
            else:
                hardneg.append((img, rel))
        elif src == 'dji_photo':
            img = f'{DJI_IMG_ROOT}/{rel}.jpg'
            if boxes:
                pos_real.append((img, rel, 'd'))
            else:
                pending.append((img, rel, note))
    print(f'真实烟(有框): {len(pos_real)}  难负(空框v2): {len(hardneg)}  待标注(DJI空框): {len(pending)}')
    for img, rel, note in pending:
        print(f'  !! 待人工标注: {rel}  note={note[:40]}')

    # ---- 1b. live_review 整框（本次新增） ----
    live_export = json.load(open(LIVE_EXPORT, encoding='utf-8'))
    live_pos = []   # (src_img, rel_safe, boxes)
    live_neg = []   # (src_img, rel_safe)
    live_pend = []
    for rel, v in live_export.items():
        boxes = v.get('boxes', []) or []
        status = v.get('status', '')
        rel_safe = rel.replace('/', '_')  # 段名+帧名 唯一化
        src_img = f'{LIVE_FRAMES}/{rel}'
        if boxes and status == 'reviewed':
            live_pos.append((src_img, rel_safe, boxes))
        elif not boxes and status == 'reviewed':
            live_neg.append((src_img, rel_safe))
        else:
            live_pend.append((rel, v.get('verdict', '')))
    print(f'live 正: {len(live_pos)} (框 {sum(len(b) for _,_,b in live_pos)})  live 负: {len(live_neg)}  live 待定: {len(live_pend)}')
    for rel, verdict in live_pend:
        print(f'  !! live 待定: {rel} verdict={verdict}')

    # ---- 2. 写 live 标签 + 复制图片进训练集 ----
    n_live_lab = 0
    for src_img, rel_safe, boxes in live_pos:
        dst_img = f'{OUT_ROOT}/images/live_review/{rel_safe}'
        os.makedirs(os.path.dirname(dst_img), exist_ok=True)
        shutil.copy(src_img, dst_img)
        lab_path = f'{OUT_ROOT}/labels/live_review/{rel_safe[:-4]}.txt'
        os.makedirs(os.path.dirname(lab_path), exist_ok=True)
        with open(lab_path, 'w') as f:
            f.write('\n'.join(f'{int(c)} {x} {y} {w} {h}' for c, x, y, w, h in boxes) + '\n')
        n_live_lab += 1
    print(f'  -> live 正写入 {n_live_lab} 标签 + 复制图片')
    # live 负（无标签 = 空标签负样本，写空 txt 确保 ultralytics 识别）
    n_live_neg = 0
    for src_img, rel_safe in live_neg:
        dst_img = f'{OUT_ROOT}/images/live_neg/{rel_safe}'
        os.makedirs(os.path.dirname(dst_img), exist_ok=True)
        shutil.copy(src_img, dst_img)
        lab_path = f'{OUT_ROOT}/labels/live_neg/{rel_safe[:-4]}.txt'
        os.makedirs(os.path.dirname(lab_path), exist_ok=True)
        open(lab_path, 'w').close()
        n_live_neg += 1
    print(f'  -> live 负复制 {n_live_neg}（空标签）')

    # ---- 2b. DJI 图片复制 + 标签 ----
    n_dji = 0
    dji_pos = []
    for img, rel, src in pos_real:
        if src != 'd':
            continue
        dst_img = f'{OUT_ROOT}/images/dji_photo/{rel}.jpg'
        os.makedirs(os.path.dirname(dst_img), exist_ok=True)
        shutil.copy(img, dst_img)
        lab_path = f'{OUT_ROOT}/labels/dji_photo/{rel}.txt'
        os.makedirs(os.path.dirname(lab_path), exist_ok=True)
        boxes = [fr['boxes'] for fr in frames if fr['rel'] == rel][0]
        with open(lab_path, 'w') as f:
            f.write('\n'.join(f'{int(c)} {x} {y} {w} {h}' for c, x, y, w, h in boxes) + '\n')
        dji_pos.append((rel, src))
        n_dji += 1
    print(f'  -> DJI 复制 {n_dji} 张 + 标签')

    # ---- 3. 正样本列表 ----
    pos = []
    real_imgs = set()
    for img, rel, src in pos_real:
        if src == 'r':
            lab = f'{CAND_ROOT}/labels/record/{rel[:-4]}.txt'
            real_imgs.add(img)
        else:
            lab = f'{OUT_ROOT}/labels/dji_photo/{rel}.txt'
            img = f'{OUT_ROOT}/images/dji_photo/{rel}.jpg'
            real_imgs.add(img)
        pos.append((img, lab, src))
    # live 正
    for src_img, rel_safe, boxes in live_pos:
        img = f'{OUT_ROOT}/images/live_review/{rel_safe}'
        lab = f'{OUT_ROOT}/labels/live_review/{rel_safe[:-4]}.txt'
        real_imgs.add(img)
        pos.append((img, lab, 'l'))
    # live 负 → 负样本
    live_neg_pairs = []
    for src_img, rel_safe in live_neg:
        img = f'{OUT_ROOT}/images/live_neg/{rel_safe}'
        live_neg_pairs.append((img, None, 'l'))

    # wechat 正
    WECHAT_FIX_IMG = f'{OUT_ROOT}/images/wechat_fix'
    WECHAT_FIX_LAB = f'{OUT_ROOT}/labels/wechat_fix'
    for f in os.listdir(WECHAT_IMG):
        if not f.endswith('.png'):
            continue
        lab = f'{WECHAT_LAB}/{f[:-4]}.txt'
        if not (os.path.exists(lab) and os.path.getsize(lab) > 0):
            continue
        lines = [l for l in open(lab) if l.strip()]
        cls0 = [l for l in lines if l.split()[0] == '0']
        if len(cls0) == len(lines):
            pos.append((f'{WECHAT_IMG}/{f}', lab, 'w'))
        elif cls0:
            os.makedirs(WECHAT_FIX_IMG, exist_ok=True)
            os.makedirs(WECHAT_FIX_LAB, exist_ok=True)
            shutil.copy(f'{WECHAT_IMG}/{f}', f'{WECHAT_FIX_IMG}/{f}')
            with open(f'{WECHAT_FIX_LAB}/{f[:-4]}.txt', 'w') as fp:
                fp.write('\n'.join(cls0) + '\n')
            pos.append((f'{WECHAT_FIX_IMG}/{f}', f'{WECHAT_FIX_LAB}/{f[:-4]}.txt', 'w'))

    # syn 正（前 400 张）
    for f in sorted(os.listdir(SYN_IMG)):
        if not f.endswith('.jpg'):
            continue
        if int(f.split('_')[1].split('.')[0]) >= 400:
            continue
        lab = f'{SYN_LAB}/{f[:-4]}.txt'
        if os.path.exists(lab) and os.path.getsize(lab) > 0:
            pos.append((f'{SYN_IMG}/{f}', lab, 's'))

    # ---- 4. 负样本 ----
    review_manifest = json.load(
        open('/video/shujuji/datasets/v5_neg_v3_reviewed/manifest.json', encoding='utf-8'))
    vlm_neg = [x['frame_path'] for x in review_manifest['items']
               if x.get('review_status') == 'ok']
    if not vlm_neg:
        neg_list = json.load(open(f'{CAND_ROOT}/neg_list.json', encoding='utf-8'))
        vlm_neg = [x['frame'] for x in neg_list]
    vlm_neg = [p for p in vlm_neg if p not in real_imgs]
    random.shuffle(vlm_neg)
    neg = []
    val_real_neg = vlm_neg[:100]
    train_real_neg = vlm_neg[100:]
    for p in train_real_neg:
        neg.append((p, None, 'c'))
    for p in val_real_neg:
        neg.append((p, None, 'v'))
    for img, rel in hardneg:
        neg.append((img, None, 'h'))
    neg.extend(live_neg_pairs)
    for f in os.listdir(WECHAT_IMG):
        if not f.endswith('.png'):
            continue
        lab = f'{WECHAT_LAB}/{f[:-4]}.txt'
        if os.path.exists(lab) and os.path.getsize(lab) == 0:
            neg.append((f'{WECHAT_IMG}/{f}', lab, 'w'))

    # ---- 5. 桶划分（沿用 v3/v4） ----
    def bucket_key(item):
        img, lab, src = item
        if src in ('r', 'v'): return 'real_' + img.split('/')[-2]
        if src == 'd': return 'dji'
        if src == 'l': return 'live'
        if src == 'w': return 'w_all'
        if src == 's':
            return 's_' + img.split('/')[-1].split('_')[1][:2]
        if src == 'c': return 'c_' + img.split('/')[-2]
        if src == 'h': return 'hardneg'
        return 'x'

    buckets = defaultdict(lambda: {'pos': [], 'neg': []})
    for it in pos:
        buckets[bucket_key(it)]['pos'].append(it)
    for it in neg:
        buckets[bucket_key(it)]['neg'].append(it)

    train_pos, train_neg, val_pos, val_neg = [], [], [], []
    for k, v in buckets.items():
        random.shuffle(v['pos']); random.shuffle(v['neg'])
        if k.startswith('real_') or k.startswith('v_'):
            for it in v['pos']:
                (val_pos if it[2] == 'v' else train_pos).append(it)
            for it in v['neg']:
                (val_neg if it[2] == 'v' else train_neg).append(it)
            continue
        if k in ('dji', 'live'):
            train_pos.extend(v['pos'])  # 新形态全进 train
            train_neg.extend(v['neg'])
            continue
        if k.startswith('s_'):
            train_pos.extend(v['pos']); train_neg.extend(v['neg'])
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
        for img, lab, src in train:
            f.write(img + '\n')
    with open(f'{SPLIT_DIR}/val.txt', 'w') as f:
        for img, lab, src in val:
            f.write(img + '\n')

    yaml = (
        f'# v5 训练集配置 (v5: 直播整框 182 真烟回流, 从 v5_smoke_v3 续训)\n'
        f'path: {OUT_ROOT}\n'
        f'train: splits/train.txt\n'
        f'val: splits/val.txt\n'
        f'nc: 1\n'
        f"names: ['smoke']\n"
    )
    with open(f'{OUT_ROOT}/v5_smoke_v5.yaml', 'w', encoding='utf-8') as f:
        f.write(yaml)

    cnt = lambda lst, *ss: sum(1 for x in lst if x[2] in ss)
    print('\n====== v5 训练集 v5 ======')
    print(f'正({len(pos)}): 真实烟 {cnt(pos,"r","d","l")} (v2 {cnt(pos,"r")} + DJI {cnt(pos,"d")} + live {cnt(pos,"l")}) + wechat {cnt(pos,"w")} + syn {cnt(pos,"s")}')
    print(f'负({len(neg)}): 真实无烟 {cnt(neg,"c")} + 难负 {cnt(neg,"h")} + live无烟 {cnt(neg,"l")} + wechat空 {cnt(neg,"w")} + val {cnt(neg,"v")}')
    print(f'比例: 1:{len(neg)/max(len(pos),1):.2f}')
    print(f'训练: {len(train)} (pos {len(train_pos)} + neg {len(train_neg)})')
    print(f'验证: {len(val)} (pos {len(val_pos)} + neg {len(val_neg)})')
    print(f'输出: {OUT_ROOT}/')


if __name__ == '__main__':
    main()
