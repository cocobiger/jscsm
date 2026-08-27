#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
merged_v4 数据集合并脚本（秸秆焚烧 smoke/fire/house 3 类）
用法:
  python3 merge_v4.py            # dry-run：只输出统计报告，不写文件
  python3 merge_v4.py --apply    # 实际生成 /video/shujuji/datasets/merged_v4
组成:
  基底   = retrain/v1 全量（3 类标注升级版）
         + merged_v3 未被 retrain/v1 覆盖的图（2 类标注，id 兼容直接并入）
  增强   = dfire_yolo 含 smoke 框的图，按目标框数随机采样（默认 3500 框）
  负样本 = --bg-dir 指定目录的图片（空 label，背景图；可多次传入）
  验证集 = sikong_0821 + sikong_0822（无人机实拍）+ merged_v3/images/valid 中未入 train 的图
铁律:
  - valid 图绝不出现在 train（按文件名+MD5 双重去重）
  - 类 id 必须 ∈ {0:smoke, 1:fire, 2:house}
"""
import argparse, glob, hashlib, os, random, shutil, sys, collections

ROOT = '/video/shujuji'
RT = f'{ROOT}/xunlian/retrain/v1'                 # 复检回流（3 类）
M3 = f'{ROOT}/xunlian/train_data/merged_v3'       # 旧主训练集（2 类）
DF = f'{ROOT}/datasets/dfire_yolo'                # D-Fire（域外）
SIKONG = [f'{ROOT}/xunlian/train_data/sikong_0821', f'{ROOT}/xunlian/train_data/sikong_0822']
OUT = f'{ROOT}/datasets/merged_v4'
CLASSES = {0: 'smoke', 1: 'fire', 2: 'house'}
IMG_EXT = ('.jpg', '.jpeg', '.png')

random.seed(42)

def md5(p):
    h = hashlib.md5()
    with open(p, 'rb') as f:
        for c in iter(lambda: f.read(1 << 20), b''):
            h.update(c)
    return h.hexdigest()

def imgs_of(d):
    return sorted(f for f in glob.glob(os.path.join(d, '**', '*'), recursive=True) if f.lower().endswith(IMG_EXT))

def label_for(img, label_root_candidates):
    """在候选 labels 根下找同名 .txt"""
    stem = os.path.splitext(os.path.basename(img))[0]
    for lr in label_root_candidates:
        for f in glob.glob(os.path.join(lr, '**', stem + '.txt'), recursive=True):
            return f
    return None

def img_size(p):
    """纯 python 读 JPEG/PNG 宽高（无第三方依赖）"""
    import struct
    with open(p, 'rb') as f:
        head = f.read(32)
        if head[:8] == b'\x89PNG\r\n\x1a\n':
            w, h = struct.unpack('>II', head[16:24])
            return w, h
        if head[:2] == b'\xff\xd8':  # JPEG：扫 SOF 段
            f.seek(2)
            while True:
                b = f.read(1)
                if not b:
                    break
                if b != b'\xff':
                    continue
                marker = f.read(1)
                if marker in (b'\xc0', b'\xc1', b'\xc2'):
                    f.read(3)
                    h = int.from_bytes(f.read(2), 'big')
                    w = int.from_bytes(f.read(2), 'big')
                    return w, h
                else:
                    seg = int.from_bytes(f.read(2), 'big')
                    f.seek(seg - 2, 1)
    return None

def read_boxes(lf, img_path=None):
    """读 YOLO 标注；检测绝对像素坐标（>1.5）并自动归一化"""
    boxes = []
    if lf and os.path.exists(lf):
        wh = None
        for line in open(lf):
            p = line.split()
            if len(p) >= 5 and p[0].lstrip('-').isdigit():
                vals = [float(x) for x in p[1:5]]
                if any(v > 1.5 for v in vals):
                    if img_path and wh is None:
                        wh = img_size(img_path)
                    if wh:
                        w, h = wh
                        vals = [vals[0] / w, vals[1] / h, vals[2] / w, vals[3] / h]
                        if any(v > 1.0 or v < 0 for v in vals):
                            continue  # 归一化后仍越界 → 丢弃
                    else:
                        continue  # 读不到尺寸 → 丢弃
                boxes.append((int(p[0]), ' '.join(f'{v:.6f}' for v in vals)))
    return boxes

def scan_dataset(name, img_root, label_roots):
    """返回 [(img, label_file, boxes)]，并做类 id 校验"""
    items, bad = [], 0
    for img in imgs_of(img_root):
        lf = label_for(img, label_roots)
        boxes = read_boxes(lf, img)
        for cid, _ in boxes:
            if cid not in CLASSES:
                bad += 1
        items.append((img, lf, boxes))
    return items, bad

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--smoke-target', type=int, default=3500, help='D-Fire smoke 目标框数')
    ap.add_argument('--bg-dir', action='append', default=[], help='背景图目录（空 label）')
    args = ap.parse_args()

    print('=' * 64)
    print('merged_v4 合并%s' % ('【实际执行】' if args.apply else '【DRY-RUN 预演】'))
    print('=' * 64)

    # ── ① 基底：retrain/v1（严格只用 images/train + labels/train，排除 runs 训练可视化图）──
    rt_items, rt_bad = scan_dataset('retrain/v1', f'{RT}/images/train', [f'{RT}/labels/train'])
    rt_hashes = {md5(i) for i, _, _ in rt_items}
    rt_names = {os.path.basename(i) for i, _, _ in rt_items}
    print(f'\n[基底] retrain/v1 (images/train): {len(rt_items)} 图')

    # ── ② sikong 实拍：内容已在 train 的从 train 剔除 → 挪入 valid（继承 rt 的 3 类标注）──
    sk_items, _ = scan_dataset('sikong0821', SIKONG[0] + '/images', [SIKONG[0] + '/labels'])
    sk2_items, _ = scan_dataset('sikong0822', SIKONG[1] + '/images', [SIKONG[1] + '/labels'])
    sikong_all = sk_items + sk2_items
    sk_hashes = {md5(i) for i, _, _ in sikong_all}
    leaked_items = [(i, lf, b) for i, lf, b in rt_items if md5(i) in sk_hashes]
    if leaked_items:
        rt_items = [(i, lf, b) for i, lf, b in rt_items if md5(i) not in sk_hashes]
        rt_hashes = {md5(i) for i, _, _ in rt_items}
        rt_names = {os.path.basename(i) for i, _, _ in rt_items}
        print(f'[验证集] sikong 内容与 train 重复 {len(leaked_items)} 张（含 rt 内部同内容副本）→ 已挪入 valid 并继承 3 类标注')

    # ── ③ 基底补充：merged_v3 未覆盖图（按内容 hash + 文件名双重判重）──
    m3_items, m3_bad = scan_dataset('merged_v3', f'{M3}/images', [f'{M3}/labels'])
    m3_extra = [(i, lf, b) for i, lf, b in m3_items
                if os.path.basename(i) not in rt_names and md5(i) not in rt_hashes]
    m3_valid = [(i, lf, b) for i, lf, b in m3_extra if '/valid/' in i.replace(os.sep, '/')]
    m3_train_extra = [(i, lf, b) for i, lf, b in m3_extra if '/valid/' not in i.replace(os.sep, '/')]
    print(f'[基底] merged_v3 未覆盖: {len(m3_extra)} 图（train {len(m3_train_extra)} + 原 valid {len(m3_valid)}）')
    if rt_bad or m3_bad:
        print(f'  ⚠️ 非法类 id 行数: retrain {rt_bad}, merged_v3 {m3_bad}')

    # train 域（用于去重判定的集合）——不含 valid 源
    train_names = set(rt_names) | {os.path.basename(i) for i, _, _ in m3_train_extra}
    train_hashes = set(rt_hashes) | {md5(i) for i, _, _ in m3_train_extra}

    # ── ④ D-Fire smoke 采样 ──
    df_items, df_bad = scan_dataset('dfire_yolo', f'{DF}/images', [f'{DF}/labels'])
    df_smoke = [(i, lf, b) for i, lf, b in df_items if any(cid == 0 for cid, _ in b)]
    df_smoke_boxes = sum(sum(1 for cid, _ in b if cid == 0) for _, _, b in df_smoke)
    df_smoke = [(i, lf, b) for i, lf, b in df_smoke
                if os.path.basename(i) not in train_names and md5(i) not in train_hashes]
    random.shuffle(df_smoke)
    df_picked, picked_boxes = [], 0
    for item in df_smoke:
        if picked_boxes >= args.smoke_target:
            break
        df_picked.append(item)
        picked_boxes += sum(1 for cid, _ in item[2] if cid == 0)
    print(f'[增强] D-Fire 含 smoke 图: {len(df_smoke)} 可选（smoke 框 {df_smoke_boxes}）→ 采样 {len(df_picked)} 图（{picked_boxes} smoke 框，目标 {args.smoke_target}）')

    # ── ⑤ 背景图 ──
    bg_items = []
    for d in args.bg_dir:
        fs = [f for f in imgs_of(d) if os.path.basename(f) not in train_names and md5(f) not in train_hashes]
        bg_items += fs
        print(f'[负样本] {d}: {len(fs)} 张背景图（空 label）')

    # ── ⑥ 验证集：sikong 挪出项（继承 rt 3 类标注）+ merged_v3 原 valid（均未入 train）──
    valid_items = leaked_items + m3_valid
    print(f'[验证集] sikong 挪出 {len(leaked_items)} + merged_v3 原 valid {len(m3_valid)} → 共 {len(valid_items)} 图')

    # ── 统计汇总 ──
    def stats(items, tag):
        c = collections.Counter()
        for _, _, b in items:
            for cid, _ in b:
                c[CLASSES[cid]] += 1
        print(f'  {tag}: {len(items)} 图 | 框 ' + ', '.join(f'{k} {v}' for k, v in sorted(c.items())))

    train_all = rt_items + m3_train_extra + df_picked
    print('\n──── 汇总 ────')
    stats(rt_items, 'train: retrain/v1')
    stats(m3_train_extra, 'train: merged_v3 补充')
    stats(df_picked, 'train: D-Fire 采样')
    stats(train_all, 'train 合计（+背景图 %d 张无框）' % len(bg_items))
    stats(valid_items, 'valid 合计')

    if not args.apply:
        print('\nDRY-RUN 完成，未写文件。确认无误后加 --apply 生成数据集。')
        return

    # ── 实际生成（先清空旧输出，防残留）──
    if os.path.exists(OUT):
        shutil.rmtree(OUT)
    for sub in ('images/train', 'images/valid', 'labels/train', 'labels/valid'):
        os.makedirs(f'{OUT}/{sub}', exist_ok=True)

    def emit(items, split, bg=False):
        n = 0
        for img, lf, boxes in items:
            stem = os.path.splitext(os.path.basename(img))[0]
            # 防重名：加来源前缀
            dst_img = f'{OUT}/images/{split}/{stem}.jpg'
            if os.path.exists(dst_img):
                stem = stem + '_' + md5(img)[:6]
                dst_img = f'{OUT}/images/{split}/{stem}.jpg'
            shutil.copy2(img, dst_img)
            with open(f'{OUT}/labels/{split}/{stem}.txt', 'w') as f:
                if not bg:
                    for cid, rest in boxes:
                        f.write(f'{cid} {rest}\n')
            n += 1
        return n

    n1 = emit(rt_items, 'train')
    n2 = emit(m3_train_extra, 'train')
    n3 = emit(df_picked, 'train')
    n4 = emit([(f, None, []) for f in bg_items], 'train', bg=True)
    n5 = emit(valid_items, 'valid')
    with open(f'{OUT}/data.yaml', 'w') as f:
        f.write(f'path: {OUT}\ntrain: images/train\nval: images/valid\n\nnames:\n  0: smoke\n  1: fire\n  2: house\n')
    print(f'\n✅ 已生成 {OUT}: train {n1 + n2 + n3 + n4}（含背景 {n4}） valid {n5}')

if __name__ == '__main__':
    main()
