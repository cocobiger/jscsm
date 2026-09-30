#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v5 两阶段训练 splits 生成（C 方案：syn 预训 + 真烟微调）
2026-09-01 晚

Stage 1 (syn 预训)   : syn 400 正 + 全部负样本   —— 不含真烟母带，学烟形态+负样本抑制
Stage 2 (真烟微调)   : 真烟 264 (live182+v2 26+dji 4+wechat 52) + 全部负样本 —— 剔除 syn，真烟主导
val 沿用 v5_train_v5/splits/val.txt (117, 含 7 真烟 holdout, 横向可比)

用法: /opt/jsc/straw-engine/venv/bin/python3 gen_v5_stage_splits.py
输出: /video/shujuji/datasets/v5_train_v5/splits/{stage1_train,stage2_train}.txt
      /video/shujuji/datasets/v5_train_v5/v5_smoke_v5_{s1,s2}.yaml
"""
import os
from collections import Counter

OUT_ROOT = '/video/shujuji/datasets/v5_train_v5'
SPLIT_DIR = f'{OUT_ROOT}/splits'

# 正/负判定：label 文件非空 = 正（有烟）；空或缺失 = 负（background）
# 注意路径三态：v2_ai=`v5_candidates/images/record/`(label→labels/record)、
#            负样本=`v5_candidates/record/`(label→labels/record)、其余 images→labels 同级
def label_for(img_path):
    d, fn = os.path.split(img_path)
    if '/v5_candidates/images/record/' in img_path:
        lab_dir = d.replace('/images/record/', '/labels/record/')
    elif '/v5_candidates/record/' in img_path:
        rel = img_path.split('/v5_candidates/record/')[1]
        lab_dir = '/video/shujuji/datasets/v5_candidates/labels/record/' + os.path.dirname(rel)
    else:
        # images 常为路径末组件(如 v5_syn/images)，'/'+images+'/' 子串不存在 → 不带尾斜杠替换
        lab_dir = d.replace('/images', '/labels')
    base = os.path.splitext(fn)[0]
    return os.path.join(lab_dir, base + '.txt')

def main():
    train = [l.strip() for l in open(f'{SPLIT_DIR}/train.txt') if l.strip()]
    print(f'train.txt 总条目: {len(train)}')

    s1, s2 = [], []      # stage1 / stage2 train 行
    negs = []            # 负样本行（两阶段共用）
    stat = Counter()

    for img in train:
        lab = label_for(img)
        is_syn = '/v5_syn/' in img
        if os.path.exists(lab) and os.path.getsize(lab) > 0:
            # 正样本
            if is_syn:
                s1.append(img); stat['syn_pos'] += 1
            else:
                s2.append(img); stat['real_pos'] += 1
        else:
            # 负样本（空标签或标签缺失——v4 体系里负样本=空标签）
            negs.append(img); stat['neg'] += 1

    print(f'  正: syn {stat["syn_pos"]} / 真烟+wechat {stat["real_pos"]} / 负 {stat["neg"]}')
    assert len(s1) + len(s2) + len(negs) == len(train), '条目数不一致!'

    s1_all = s1 + negs
    s2_all = s2 + negs
    print(f'Stage1 train: {len(s1_all)} (syn {len(s1)} + neg {len(negs)})')
    print(f'Stage2 train: {len(s2_all)} (real {len(s2)} + neg {len(negs)})  [真烟占比 {len(s2)/max(len(s2)+len(negs),1)*100:.0f}%]')

    # 校验 label 可配对（抽样）
    import random
    random.seed(7)
    for lst, tag in [(s1_all, 's1'), (s2_all, 's2')]:
        miss = [l for l in random.sample(lst, min(30, len(lst))) if not os.path.exists(label_for(l))]
        print(f'  {tag} 抽查 30 条 label 缺失: {len(miss)}')

    with open(f'{SPLIT_DIR}/stage1_train.txt', 'w') as f:
        f.write('\n'.join(s1_all) + '\n')
    with open(f'{SPLIT_DIR}/stage2_train.txt', 'w') as f:
        f.write('\n'.join(s2_all) + '\n')

    val_txt = f'{SPLIT_DIR}/val.txt'
    for name, tr in [('v5_smoke_v5_s1.yaml', 'stage1_train.txt'), ('v5_smoke_v5_s2.yaml', 'stage2_train.txt')]:
        yaml = (
            f'# v5 两阶段训练 {name.split("_")[-1][:2]}\n'
            f'path: {OUT_ROOT}\n'
            f'train: splits/{tr}\n'
            f'val: splits/val.txt\n'
            f'nc: 1\n'
            f"names: ['smoke']\n"
        )
        with open(f'{OUT_ROOT}/{name}', 'w', encoding='utf-8') as f:
            f.write(yaml)
    print('OK: splits/stage1_train.txt + stage2_train.txt + v5_smoke_v5_s1/s2.yaml')

if __name__ == '__main__':
    main()
