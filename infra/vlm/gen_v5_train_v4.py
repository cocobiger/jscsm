#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v5 训练集组集（v4：27 用户复核 + 5 DJI 真烟照片；方案① 100+ 帧目标第 1 步）

数据源（权威 = v3 工作台 spec）：
- v2_ai 27 帧：用户复核框（boxes 非空 → 真实烟正样本；空框如"月夜下的云" → 难负样本）
- dji_photo 5 帧：DJI 真烟照片（人工整框标注后 → 真实烟正样本；未标注 → 跳过并提示）
- wechat 125 / syn 800 / 负样本 = 人工复核 ok 354 帧（v5_neg_v3_reviewed，替代 VLM 初筛 neg_list）

与 v3 差异：
- DJI 新形态帧全部进 train（不进 val：数量少、形态单一，防波动）
- val 真实烟 holdout 7 与 v3 同源同量 → 横向可比
- DJI 图片复制进训练集 images/（外部路径不入 YOLO labels 查找规则）

用法: /opt/jsc/straw-engine/venv/bin/python3 gen_v5_train_v4.py
输出: /video/shujuji/datasets/v5_train_v4/{splits,v5_smoke_v4.yaml,images/labels}
"""
import os, json, random, shutil
from collections import defaultdict

random.seed(42)
TRAIN_RATIO = 0.85
SPEC = '/video/llm_infer/v3_spec.json'
OUT_ROOT = '/video/shujuji/datasets/v5_train_v4'
SPLIT_DIR = f'{OUT_ROOT}/splits'

CAND_ROOT = '/video/shujuji/datasets/v5_candidates'
WECHAT_IMG = '/video/shujuji/datasets/v5_wechat/images'
WECHAT_LAB = '/video/shujuji/datasets/v5_wechat/labels'
SYN_IMG = '/video/shujuji/datasets/v5_syn/images'
SYN_LAB = '/video/shujuji/datasets/v5_syn/labels'
DJI_IMG_ROOT = '/video/llm_infer/v5_photos'


def main():
    spec = json.load(open(SPEC, encoding='utf-8'))
    frames = spec['frames']
    print(f'spec 总帧: {len(frames)}')

    # ---- 1. 帧分类 ----
    pos_real = []      # (img, label_txt_path, src) 真实烟
    hardneg = []       # 空框 v2_ai（确认无烟）
    pending = []       # 空框 dji_photo（待人工标注）
    for fr in frames:
        rel = fr['rel']
        boxes = fr.get('boxes', []) or []
        src = fr.get('src', '')
        note = fr.get('note', '')
        if src == 'v2_ai':
            # 注意：图片路径必须含 /images/ 段（与 v3 一致），
            # 否则 ultralytics img2label_paths 无法把 /images/ 替换为 /labels/，
            # 标签会被解析到 record/ 同目录（不存在）→ 真实烟被当空标签负样本，正样本全部丢失！
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

    # ---- 2. 写标签 ----
    # v2_ai 标签沿用 CAND/labels/record（v3 已写入）；DJI 标签写到训练集 labels/
    n_lab = 0
    dji_pairs = []  # (src_img, dst_img, rel)
    for fr in frames:
        rel = fr['rel']
        boxes = fr.get('boxes', []) or []
        if not boxes:
            continue
        src = fr.get('src', '')
        if src == 'v2_ai':
            lab_dir = f'{CAND_ROOT}/labels/record/{os.path.dirname(rel)}'
            os.makedirs(lab_dir, exist_ok=True)
            lab_path = f'{lab_dir}/{os.path.basename(rel)[:-4]}.txt'
        else:  # dji_photo
            lab_dir = f'{OUT_ROOT}/labels/dji_photo'
            os.makedirs(lab_dir, exist_ok=True)
            lab_path = f'{lab_dir}/{os.path.basename(rel)}.txt'
            # 复制图片进训练集
            src_img = f'{DJI_IMG_ROOT}/{rel}.jpg'
            dst_img = f'{OUT_ROOT}/images/dji_photo/{os.path.basename(rel)}.jpg'
            os.makedirs(os.path.dirname(dst_img), exist_ok=True)
            shutil.copy(src_img, dst_img)
            dji_pairs.append((src_img, dst_img, rel))
        with open(lab_path, 'w') as f:
            f.write('\n'.join(f'{int(c)} {x} {y} {w} {h}' for c, x, y, w, h in boxes))
        n_lab += 1
    print(f'  -> 写入 {n_lab} 个真实烟标签（DJI 复制 {len(dji_pairs)} 张入训练集 images/）')

    # ---- 3. 正样本列表 ----
    pos = []
    real_imgs = set()
    for img, rel, src in pos_real:
        if src == 'r':
            lab = f'{CAND_ROOT}/labels/record/{rel[:-4]}.txt'
            real_imgs.add(img)
        else:
            lab = f'{OUT_ROOT}/labels/dji_photo/{os.path.basename(rel)}.txt'
            img = f'{OUT_ROOT}/images/dji_photo/{os.path.basename(rel)}.jpg'
            real_imgs.add(img)
        pos.append((img, lab, src))

    # wechat 正（过滤 class1=fire 残留：单类 nc=1 下 class1 帧会被 ultralytics 整帧忽略）
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
            # 纯 class0 → 直接引用源标签
            pos.append((f'{WECHAT_IMG}/{f}', lab, 'w'))
        elif cls0:
            # 含 class1 残留：只保留 class0 行，复制图片+过滤标签进训练集
            os.makedirs(WECHAT_FIX_IMG, exist_ok=True)
            os.makedirs(WECHAT_FIX_LAB, exist_ok=True)
            shutil.copy(f'{WECHAT_IMG}/{f}', f'{WECHAT_FIX_IMG}/{f}')
            with open(f'{WECHAT_FIX_LAB}/{f[:-4]}.txt', 'w') as fp:
                fp.write('\n'.join(cls0) + '\n')
            pos.append((f'{WECHAT_FIX_IMG}/{f}', f'{WECHAT_FIX_LAB}/{f[:-4]}.txt', 'w'))
        # 纯 class1（无 smoke 框）→ 跳过

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
    # v4.1（2026-09-01）：负样本源升级为人工复核权威版 v5_neg_v3_reviewed/manifest.json
    #   （354 帧 review_status=ok，驾驶舱「抽检标注」tab 人工判定 ✅；替代 VLM 初筛
    #    neg_list.json 的 359 帧——其中 4 no + 1 dn 为模型判错/不确定，不进负样本）
    review_manifest = json.load(
        open('/video/shujuji/datasets/v5_neg_v3_reviewed/manifest.json', encoding='utf-8'))
    vlm_neg = [x['frame_path'] for x in review_manifest['items']
               if x.get('review_status') == 'ok']
    # 兜底：若人工复核清单缺失/为空，回退 VLM 初筛
    if not vlm_neg:
        neg_list = json.load(open(f'{CAND_ROOT}/neg_list.json', encoding='utf-8'))
        vlm_neg = [x['frame'] for x in neg_list]
    # 去重：无烟帧若已被标为真实烟（pos_real）→ 移出负样本
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
    # wechat 空标
    for f in os.listdir(WECHAT_IMG):
        if not f.endswith('.png'):
            continue
        lab = f'{WECHAT_LAB}/{f[:-4]}.txt'
        if os.path.exists(lab) and os.path.getsize(lab) == 0:
            neg.append((f'{WECHAT_IMG}/{f}', lab, 'w'))

    # ---- 5. 桶划分（沿用 v3） ----
    def bucket_key(item):
        img, lab, src = item
        if src in ('r', 'v'): return 'real_' + img.split('/')[-2]
        if src == 'd': return 'dji'
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
        if k == 'dji':
            train_pos.extend(v['pos'])  # DJI 全部进 train
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
        f'# v5 训练集配置 (v4: 27 用户复核 + 5 DJI 真烟 + 负样本 354 人工复核帧, 从 v5_smoke_v3 续训)\n'
        f'path: {OUT_ROOT}\n'
        f'train: splits/train.txt\n'
        f'val: splits/val.txt\n'
        f'nc: 1\n'
        f"names: ['smoke']\n"
    )
    with open(f'{OUT_ROOT}/v5_smoke_v4.yaml', 'w', encoding='utf-8') as f:
        f.write(yaml)

    cnt = lambda lst, *ss: sum(1 for x in lst if x[2] in ss)
    print('\n====== v5 v4 数据集 ======')
    print(f'正({len(pos)}): 真实烟 {cnt(pos,"r","d")} (v2 {cnt(pos,"r")} + DJI {cnt(pos,"d")}) + wechat {cnt(pos,"w")} + syn {cnt(pos,"s")}')
    print(f'负({len(neg)}): 真实无烟 {cnt(neg,"c")} + 难负 {cnt(neg,"h")} + wechat空 {cnt(neg,"w")} + val {cnt(neg,"v")}')
    print(f'比例: 1:{len(neg)/max(len(pos),1):.2f}')
    print(f'训练: {len(train)} (pos {len(train_pos)} + neg {len(train_neg)})')
    print(f'验证: {len(val)} (pos {len(val_pos)} + neg {len(val_neg)})')
    print(f'输出: {OUT_ROOT}/')


if __name__ == '__main__':
    main()
