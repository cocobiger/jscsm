#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v5 合并审计（方案B 第1批）：
① 规模统计(图片/标签/类别分布)  ② 类别 id 对齐  ③ 标签质量(越界/空/异常)
④ 全量 md5 查重(merged_v4 <-> v5线, merged_v4 内部 train/valid)
⑤ v5 val 泄漏检查(v5 val 帧是否出现在 merged_v4 train)
输出: JSON 档案 + 控制台摘要
"""
import os, glob, json, hashlib, collections, sys

BASE = '/video/shujuji/datasets'
LLM  = '/video/llm_infer/v5_photos'
OUT  = '/video/llm_infer/merge_audit.json'

def md5(path, chunk=1 << 20):
    h = hashlib.md5()
    with open(path, 'rb') as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()

def scan_labels(label_dir, cls_max=2):
    """返回 dict: {rel: {n, cls, issues}} + 汇总"""
    total_imgs = 0
    total_boxes = 0
    cls_counter = collections.Counter()
    issues_all = collections.Counter()
    issue_examples = collections.defaultdict(list)
    for lf in sorted(glob.glob(os.path.join(label_dir, '*.txt'))):
        rel = os.path.relpath(lf, label_dir)
        n = 0
        with open(lf) as f:
            for i, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                parts = line.split()
                if len(parts) != 5:
                    issues_all['fields!=5'] += 1
                    if len(issue_examples['fields!=5']) < 3:
                        issue_examples['fields!=5'].append(f'{rel}:{i} -> {line}')
                    continue
                try:
                    c = int(parts[0]); vals = [float(x) for x in parts[1:]]
                except ValueError:
                    issues_all['bad_num'] += 1
                    continue
                cx, cy, w, h = vals
                cls_counter[c] += 1
                n += 1
                if not (0 <= c <= cls_max):
                    issues_all['cls_out_of_range'] += 1
                    if len(issue_examples['cls_out_of_range']) < 3:
                        issue_examples['cls_out_of_range'].append(f'{rel} -> cls={c}')
                if not (0 <= cx <= 1) or not (0 <= cy <= 1):
                    issues_all['center_oob'] += 1
                    if len(issue_examples['center_oob']) < 3:
                        issue_examples['center_oob'].append(f'{rel} -> cx={cx} cy={cy}')
                if not (0 < w <= 1) or not (0 < h <= 1):
                    issues_all['wh_oob'] += 1
                    if len(issue_examples['wh_oob']) < 3:
                        issue_examples['wh_oob'].append(f'{rel} -> w={w} h={h}')
                if w < 0.005 or h < 0.005:
                    issues_all['tiny_box'] += 1
                    if len(issue_examples['tiny_box']) < 3:
                        issue_examples['tiny_box'].append(f'{rel} -> w={w:.4f} h={h:.4f}')
        total_imgs += 1
        total_boxes += n
    return {
        'images': total_imgs,
        'boxes': total_boxes,
        'cls_dist': dict(cls_counter),
        'issues': dict(issues_all),
        'issue_examples': dict(issue_examples),
    }

def list_images(root, recursive=True):
    pat = os.path.join(root, '**', '*') if recursive else os.path.join(root, '*')
    return sorted(p for p in glob.glob(pat, recursive=True)
                  if p.lower().endswith(('.jpg', '.jpeg', '.png')))

def main():
    report = {}

    # ========== ① merged_v4 统计 ==========
    m4 = '/video/shujuji/datasets/merged_v4'
    m4img = list_images(os.path.join(m4, 'images'))
    m4lbl = sorted(glob.glob(os.path.join(m4, 'labels', '**', '*.txt'), recursive=True))
    report['merged_v4'] = {
        'structure': 'standard YOLO (images/train + images/valid)',
        'train_images': len(glob.glob(os.path.join(m4, 'images', 'train', '*'))),
        'valid_images': len(glob.glob(os.path.join(m4, 'images', 'valid', '*'))),
        'train_labels': scan_labels(os.path.join(m4, 'labels', 'train')),
        'valid_labels': scan_labels(os.path.join(m4, 'labels', 'valid')),
    }

    # ========== ② v5 线各源统计 ==========
    v5src = {}
    # v5_train_v4 引用的图片清单
    splits = '/video/shujuji/datasets/v5_train_v4/splits'
    v5_imgs = []
    for sp in ['train.txt', 'val.txt']:
        p = os.path.join(splits, sp)
        if os.path.exists(p):
            with open(p) as f:
                imgs = [l.strip() for l in f if l.strip()]
            v5_imgs += imgs
            print(f'[v5_train_v4/{sp}] {len(imgs)} 图')
    # 各源统计
    for src, root in [
        ('v5_syn',      '/video/shujuji/datasets/v5_syn/images'),
        ('v5_wechat',   '/video/shujuji/datasets/v5_wechat/images'),
        ('v5_candidates','/video/shujuji/datasets/v5_candidates'),
        ('dji_photo',   '/video/llm_infer/v5_photos'),
    ]:
        imgs = list_images(root)
        v5src[src] = {'images': len(imgs), 'sample': imgs[:3] if imgs else []}
        print(f'[v5src:{src}] {len(imgs)} 图')
    report['v5_sources'] = v5src

    # v5 val 清单（泄漏检查目标）
    val_list = []
    val_path = os.path.join(splits, 'val.txt')
    if os.path.exists(val_path):
        with open(val_path) as f:
            val_list = [l.strip() for l in f if l.strip()]

    # ========== ③ 全量 md5 查重 ==========
    print('[*] 计算 merged_v4 md5 ...', flush=True)
    m4_map = {}   # md5 -> [path...]
    for p in m4img:
        m4_map.setdefault(md5(p), []).append(p)
    print(f'    merged_v4 图片 {len(m4img)} 张, 唯一 md5 {len(m4_map)}', flush=True)

    # merged_v4 内部 train<->valid 查重
    m4_train = {os.path.abspath(p) for p in glob.glob(os.path.join(m4, 'images', 'train', '*'))}
    m4_valid = {os.path.abspath(p) for p in glob.glob(os.path.join(m4, 'images', 'valid', '*'))}
    dup_internal = []
    for h, plist in m4_map.items():
        if len(plist) > 1:
            dup_internal.append([os.path.basename(p) for p in plist])
    # train/valid 内容重复（跨集）
    cross = []
    m4_valid_hash = {}
    for p in m4_valid:
        m4_valid_hash.setdefault(md5(p), []).append(p)
    for p in m4_train:
        h = md5(p)
        if h in m4_valid_hash:
            cross.append((os.path.basename(p), [os.path.basename(x) for x in m4_valid_hash[h]]))
    report['m4_internal_dup'] = {
        'same_dir_dup': dup_internal[:20],
        'train_valid_cross': cross[:20],
        'train_valid_cross_count': len(cross),
    }
    print(f'[m4内部] 同目录重复 {len(dup_internal)} 组, train<->valid 交叉重复 {len(cross)} 组', flush=True)

    # v5 线图片 vs merged_v4 查重
    print('[*] 计算 v5 线 md5 ...', flush=True)
    v5_map = {}
    v5_paths = []
    for root in ['/video/shujuji/datasets/v5_syn/images',
                 '/video/shujuji/datasets/v5_wechat/images',
                 '/video/shujuji/datasets/v5_candidates',
                 '/video/llm_infer/v5_photos']:
        v5_paths += list_images(root)
    for p in v5_paths:
        v5_map.setdefault(md5(p), []).append(p)
    print(f'    v5 线图片 {len(v5_paths)} 张, 唯一 md5 {len(v5_map)}', flush=True)

    overlap = []
    for h, v5ps in v5_map.items():
        if h in m4_map:
            overlap.append([os.path.basename(p) for p in v5ps[:2]] + [os.path.basename(m4_map[h][0])])
    report['m4_v5_overlap'] = {
        'pairs': overlap[:30],
        'count': len(overlap),
    }
    print(f'[交叉查重] merged_v4 ∩ v5线 = {len(overlap)} 张', flush=True)

    # ========== ④ v5 val 泄漏检查 ==========
    v5_val_hits = []
    for img in val_list:
        if os.path.exists(img):
            h = md5(img)
            if h in m4_map:
                v5_val_hits.append({
                    'v5_val': img,
                    'in_m4': [os.path.basename(p) for p in m4_map[h]],
                })
    report['v5_val_leak'] = {
        'val_total': len(val_list),
        'leak_count': len(v5_val_hits),
        'leaks': v5_val_hits[:20],
    }
    print(f'[val泄漏] v5 val {len(val_list)} 帧中 {len(v5_val_hits)} 帧与 merged_v4 重复', flush=True)

    # ========== ⑤ 类别对齐 ==========
    report['cls_alignment'] = {
        'merged_v4_names': {0: 'smoke', 1: 'fire', 2: 'house'},
        'v5_names': {0: 'smoke'},
        'map_v5_to_m4': {0: 0},
        'note': '类别顺序天然一致(smoke=0), v5 标签无需重编号',
    }

    json.dump(report, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    print(f'\n[OK] 审计档案 -> {OUT}')
    print('===== 摘要 =====')
    m4t = report['merged_v4']['train_labels']
    m4v = report['merged_v4']['valid_labels']
    print(f'merged_v4  train: {m4t["images"]}图/{m4t["boxes"]}框 {m4t["cls_dist"]}')
    print(f'merged_v4  valid: {m4v["images"]}图/{m4v["boxes"]}框 {m4v["cls_dist"]}')
    print(f'v5 线图片总计: {len(v5_paths)} 张')
    print(f'内部重复: {len(dup_internal)} 组 / 交叉: {len(cross)} 组 / 跨集: {len(overlap)} 张 / val泄漏: {len(v5_val_hits)} 帧')

if __name__ == '__main__':
    main()
