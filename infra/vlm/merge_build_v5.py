#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v5 3 类合并建集（方案B 第 2 批：合并审计 → 建集）
====================================================
只读源数据，输出全新 /video/shujuji/datasets/v5_train_merge/ 目录。
失败即删目录重跑，零副作用（不动任何源数据集）。

合并规则（依据 docs/秸秆v5合并审计_20260829.html）：
- 类别：0=smoke 1=fire 2=house（merged_v4 与 v5 线 smoke=0 天然一致，零重编号）
- train：
  * merged_v4 train 6390 − 71 硬拷贝 md5 去重 = 6319（含 7 条零宽框标签行剔除）
  * v5_syn 400（splits/train 引用，与 m4 零重复）
  * v5_candidates 286（含 v2_ai 真烟 26 帧带框）
  * dji_photo 4（人工标注，全进 train 不进 val）
  * v5_wechat 108：全部与 m4 同源 → 用 m4 图片 + 合成标注
    （smoke 以 v5 复核为准，fire/house 沿用 m4；v5 无 smoke 则保留 m4 smoke）
- val（重建，零泄漏）：
  * merged_v4 valid 1042 − 70 交叉重复 − 与合并 train 的任何 md5 交集 = 972±
  * v5 candidates 负样本 100（与 m4 零重复）
  * v5 val wechat 17 → 全部剔除（7 正 + 10 负均泄漏）
- 回归集：30 帧真烟 = v2_ai 26 + DJI 4，输出 regress_list.txt（不入 val，保 v3/v4 纵向可比）
- 标签质量：零宽框(w<=0|h<=0)剔除；坐标 clamp [0,1]；class 越界剔除

用法: /opt/jsc/straw-engine/venv/bin/python3 merge_build_v5.py
输出: /video/shujuji/datasets/v5_train_merge/{images,labels}/{train,val} + data.yaml + regress_list.txt
"""
import os, re, sys, shutil, hashlib, collections

BASE = '/video/shujuji/datasets'
M4 = f'{BASE}/merged_v4'
V4 = f'{BASE}/v5_train_v4'
OUT = f'{BASE}/v5_train_merge'

CAND = f'{BASE}/v5_candidates'
WECHAT_IMG = f'{BASE}/v5_wechat/images'
WECHAT_LAB = f'{BASE}/v5_wechat/labels'
SYN_IMG = f'{BASE}/v5_syn/images'
SYN_LAB = f'{BASE}/v5_syn/labels'
DJI_IMG = f'{V4}/images/dji_photo'
DJI_LAB = f'{V4}/labels/dji_photo'

IMG_EXT = ('.jpg', '.jpeg', '.png')


def md5(path, chunk=1 << 20):
    h = hashlib.md5()
    with open(path, 'rb') as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def parse_label(path):
    """解析标签文件 -> [(cls, x, y, w, h)]，剔除非法行"""
    out = []
    if not path or not os.path.exists(path):
        return out
    for line in open(path):
        p = line.split()
        if len(p) < 5:
            continue
        try:
            c, x, y, w, h = int(p[0]), float(p[1]), float(p[2]), float(p[3]), float(p[4])
        except ValueError:
            continue
        if c not in (0, 1, 2):
            continue  # 类别越界剔除
        if w <= 0 or h <= 0:
            continue  # 零宽框剔除
        x = max(0.0, min(1.0, x)); y = max(0.0, min(1.0, y))
        w = max(0.0001, min(1.0, w)); h = max(0.0001, min(1.0, h))
        # 中心点模式：x±w/2 可能越界, clamp 后反算
        x1, y1 = max(0.0, x - w / 2), max(0.0, y - h / 2)
        x2, y2 = min(1.0, x + w / 2), min(1.0, y + h / 2)
        if x2 - x1 <= 0 or y2 - y1 <= 0:
            continue
        out.append((c, (x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1))
    return out


def write_label(path, boxes):
    with open(path, 'w') as f:
        for c, x, y, w, h in boxes:
            f.write(f'{c} {x:.6f} {y:.6f} {w:.6f} {h:.6f}\n')


def copy_image(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy(src, dst)


def main():
    if os.path.exists(OUT):
        shutil.rmtree(OUT)
    os.makedirs(f'{OUT}/images/train')
    os.makedirs(f'{OUT}/images/val')
    os.makedirs(f'{OUT}/labels/train')
    os.makedirs(f'{OUT}/labels/val')

    # ---------- 1. merged_v4 md5 索引 ----------
    print('[1] 索引 merged_v4 ...', flush=True)
    m4_tr = sorted(f'{M4}/images/train/{f}' for f in os.listdir(f'{M4}/images/train') if f.lower().endswith(IMG_EXT))
    m4_va = sorted(f'{M4}/images/valid/{f}' for f in os.listdir(f'{M4}/images/valid') if f.lower().endswith(IMG_EXT))
    tr_hash = {}   # md5 -> [paths]
    va_hash = {}
    for p in m4_tr:
        tr_hash.setdefault(md5(p), []).append(p)
    for p in m4_va:
        va_hash.setdefault(md5(p), []).append(p)

    # m4 train 内部 md5 去重（硬拷贝 71 组 → 保留一份）
    train_kept = []
    for h, ps in tr_hash.items():
        train_kept.append(ps[0])
    print(f'    m4 train {len(m4_tr)} -> 去重后 {len(train_kept)}', flush=True)

    # m4 valid 与 m4 train 重复的剔除（70 组交叉）
    valid_kept = []
    for p in m4_va:
        if md5(p) in tr_hash:
            continue
        valid_kept.append(p)
    print(f'    m4 valid {len(m4_va)} -> 剔除 train 交叉后 {len(valid_kept)}', flush=True)

    # ---------- 2. v5 侧划分读取（权威 = v5_train_v4/splits） ----------
    train_files = [l.strip() for l in open(f'{V4}/splits/train.txt') if l.strip()]
    val_files = [l.strip() for l in open(f'{V4}/splits/val.txt') if l.strip()]
    print(f'[2] v5 侧划分: train {len(train_files)} / val {len(val_files)}', flush=True)

    def src_of(path):
        for key in ('v5_syn', 'v5_wechat', 'v5_candidates', 'dji_photo'):
            if key in path:
                return key
        return 'other'

    train_src = collections.Counter(src_of(p) for p in train_files)
    val_src = collections.Counter(src_of(p) for p in val_files)
    print(f'    train 源分布: {dict(train_src)}', flush=True)
    print(f'    val 源分布:   {dict(val_src)}', flush=True)

    # ---------- 3. wechat 同源图定位（md5 命中 m4） ----------
    print('[3] 定位 v5_wechat 同源图 ...', flush=True)
    # 建立 m4 全图 md5 -> (train路径, valid路径) 反向索引
    m4_all_hash = {}
    for p in train_kept:
        m4_all_hash.setdefault(md5(p), ('tr', p))
    for p in valid_kept:
        h = md5(p)
        if h not in m4_all_hash:
            m4_all_hash[h] = ('va', p)
        # 若 valid 图与 train 重复, 已在上面剔除
    wechat_train = [p for p in train_files if 'v5_wechat' in p]
    wechat_val = [p for p in val_files if 'v5_wechat' in p]
    same_src = []   # (wechat_png, m4_side, m4_path)
    m4_to_wechat = {}   # m4_path -> wechat_png（同源合成标注用）
    wechat_md5 = {}     # md5 -> wechat_png（全量 125 张，补扫用）
    for p in wechat_train + wechat_val:
        h = md5(p)
        wechat_md5[h] = p
        if h in m4_all_hash:
            side, m4p = m4_all_hash[h]
            same_src.append((p, side, m4p))
            m4_to_wechat[m4p] = p
    print(f'    wechat train {len(wechat_train)} + val {len(wechat_val)} = {len(wechat_train)+len(wechat_val)}; 同源命中 m4: {len(same_src)}; 全量 md5 索引: {len(wechat_md5)}', flush=True)

    # 同源图若落在 m4 valid → 从 valid 移除（内容进 train 后不可留 val）
    same_m4_valid = set(m4p for _, side, m4p in same_src if side == 'va')
    if same_m4_valid:
        valid_kept = [p for p in valid_kept if p not in same_m4_valid]
        print(f'    !! 同源图命中 m4 valid {len(same_m4_valid)} 张 → 已从 val 剔除', flush=True)

    # ---------- 4. 复制 train ----------
    print('[4] 构建 train ...', flush=True)
    train_pairs = []   # (img_dst, label_boxes) 登记统计用
    train_img_set = set()

    # 4.1 m4 train（含 7 零宽框剔除 + 同源合成标注）
    n_m4 = 0
    n_syn_lab = 0
    for p in train_kept:
        name = os.path.basename(p)
        dst_img = f'{OUT}/images/train/{name}'
        if dst_img in train_img_set:  # 防命名冲突（极罕见）
            name = f'm4_{n_m4}_{name}'
            dst_img = f'{OUT}/images/train/{name}'
        copy_image(p, dst_img)
        train_img_set.add(dst_img)
        # 标签：优先合成标注（同源 wechat 图），否则 m4 原标签
        synth = m4_to_wechat.get(p)
        if synth:
            v5b = parse_label(f'{WECHAT_LAB}/{os.path.splitext(os.path.basename(synth))[0]}.txt')
            m4b = parse_label(p.replace('/images/', '/labels/', 1).replace('.jpg', '.txt'))
            m4b = m4b if m4b else parse_label(p.replace('/images/', '/labels/', 1).replace('.jpeg', '.txt'))
            v5_smoke = [(0, x, y, w, hh) for c, x, y, w, hh in v5b if c == 0]
            m4_smoke = [(0, x, y, w, hh) for c, x, y, w, hh in m4b if c == 0]
            smoke = v5_smoke if v5_smoke else m4_smoke
            rest = [(c, x, y, w, hh) for c, x, y, w, hh in m4b if c in (1, 2)]
            boxes = smoke + rest
            write_label(f'{OUT}/labels/train/{name[:-4]}.txt', boxes)
            n_syn_lab += 1
        else:
            lbl = p.replace('/images/', '/labels/', 1)
            lbl = lbl[:-4] + '.txt'
            if not os.path.exists(lbl):
                lbl = lbl.replace('.jpeg.txt', '.jpg.txt')
            boxes = parse_label(lbl)
            write_label(f'{OUT}/labels/train/{name[:-4]}.txt', boxes)
        n_m4 += 1
    print(f'    m4 train 已入 {n_m4}（其中同源合成标注 {n_syn_lab}）', flush=True)

    # 4.2 v5_syn 400
    n_syn = 0
    for p in train_files:
        if 'v5_syn' not in p:
            continue
        name = os.path.basename(p)
        dst_img = f'{OUT}/images/train/{name}'
        copy_image(p, dst_img)
        train_img_set.add(dst_img)
        boxes = parse_label(f'{SYN_LAB}/{name[:-4]}.txt')
        write_label(f'{OUT}/labels/train/{name[:-4]}.txt', boxes)
        n_syn += 1
    print(f'    v5_syn 已入 {n_syn}', flush=True)

    # 4.3 v5_candidates 286（含 v2_ai 真烟 26 带框）
    n_cand = 0
    n_cand_pos = 0
    for p in train_files:
        if 'v5_candidates' not in p:
            continue
        rel = p.replace(f'{CAND}/record/', '')          # 如 12-39-46-0/f3.jpg
        name = rel.replace('/', '__')
        dst_img = f'{OUT}/images/train/{name}'
        copy_image(p, dst_img)
        train_img_set.add(dst_img)
        # v2_ai 标签在 candidates/labels/record/<rel>.txt（gen_v5_train_v4.py 写入）
        rel_noext = os.path.splitext(rel)[0]
        lbl = f'{CAND}/labels/record/{rel_noext}.txt'
        boxes = parse_label(lbl)
        if boxes:
            n_cand_pos += 1
        write_label(f'{OUT}/labels/train/{name[:-4]}.txt', boxes)
        n_cand += 1
    print(f'    v5_candidates 已入 {n_cand}（带框真烟 {n_cand_pos}）', flush=True)

    # 4.4 dji_photo 4
    n_dji = 0
    for f in sorted(os.listdir(DJI_IMG)):
        if not f.lower().endswith(IMG_EXT):
            continue
        dst_img = f'{OUT}/images/train/{f}'
        copy_image(f'{DJI_IMG}/{f}', dst_img)
        train_img_set.add(dst_img)
        boxes = parse_label(f'{DJI_LAB}/{os.path.splitext(f)[0]}.txt')
        write_label(f'{OUT}/labels/train/{os.path.splitext(f)[0]}.txt', boxes)
        n_dji += 1
    print(f'    dji_photo 已入 {n_dji}', flush=True)

    # 4.5 补扫同源合成标注（覆盖 3 张缺口：对应 m4 图在去重/剔除路径上）
    print('[4.5] 补扫同源合成标注 ...', flush=True)
    n_fix = 0
    for f in os.listdir(f'{OUT}/images/train'):
        if not f.lower().endswith(IMG_EXT):
            continue
        p = f'{OUT}/images/train/{f}'
        h = md5(p)
        if h not in wechat_md5:
            continue
        wp = wechat_md5[h]
        wb = parse_label(f'{WECHAT_LAB}/{os.path.splitext(os.path.basename(wp))[0]}.txt')
        w_smoke = [b for b in wb if b[0] == 0]
        if not w_smoke:
            continue
        cur = parse_label(f'{OUT}/labels/train/{f[:-4]}.txt')
        cur_smoke = [b for b in cur if b[0] == 0]
        if cur_smoke == w_smoke:
            continue  # 已合成
        merged = w_smoke + [b for b in cur if b[0] in (1, 2)]
        write_label(f'{OUT}/labels/train/{f[:-4]}.txt', merged)
        n_fix += 1
        print(f'      [补合成] {f}: wechat smoke {len(w_smoke)} 框 (原 {len(cur_smoke)})', flush=True)
    print(f'    补合成修复 {n_fix} 张', flush=True)

    # ---------- 5. 构建 val ----------
    print('[5] 构建 val ...', flush=True)
    n_val = 0
    val_img_set = set()

    # 5.1 m4 valid（972±）
    n_vm4 = 0
    for p in valid_kept:
        name = os.path.basename(p)
        dst_img = f'{OUT}/images/val/{name}'
        copy_image(p, dst_img)
        val_img_set.add(dst_img)
        lbl = p.replace('/images/', '/labels/', 1)[:-4] + '.txt'
        boxes = parse_label(lbl)
        write_label(f'{OUT}/labels/val/{name[:-4]}.txt', boxes)
        n_vm4 += 1
    print(f'    m4 valid 已入 {n_vm4}', flush=True)

    # 5.2 candidates val 负样本 100
    n_vc = 0
    for p in val_files:
        if 'v5_candidates' not in p:
            continue
        rel = p.replace(f'{CAND}/record/', '')
        name = rel.replace('/', '__')
        dst_img = f'{OUT}/images/val/{name}'
        copy_image(p, dst_img)
        val_img_set.add(dst_img)
        write_label(f'{OUT}/labels/val/{name[:-4]}.txt', [])   # 负样本空标签
        n_vc += 1
    print(f'    candidates val 负样本已入 {n_vc}', flush=True)

    # 5.3 wechat val 17 → 全部剔除（泄漏）
    print(f'    wechat val 17 帧已全部剔除（泄漏）', flush=True)

    # ---------- 6. 零泄漏终检 ----------
    print('[6] 零泄漏终检 ...', flush=True)
    tr_hash2 = {}
    for p in os.listdir(f'{OUT}/images/train'):
        tr_hash2[md5(f'{OUT}/images/train/{p}')] = p
    leak = []
    for p in os.listdir(f'{OUT}/images/val'):
        if md5(f'{OUT}/images/val/{p}') in tr_hash2:
            leak.append(p)
    print(f'    train {len(tr_hash2)} / val {len(os.listdir(f"{OUT}/images/val"))} / 泄漏交集: {len(leak)}', flush=True)
    for p in leak:
        os.remove(f'{OUT}/images/val/{p}')
        os.remove(f'{OUT}/labels/val/{p[:-4]}.txt')
        print(f'      [剔除] {p}', flush=True)

    # ---------- 7. 回归集 30 帧 ----------
    print('[7] 构建回归集 (30 帧真烟 = v2_ai 26 + DJI 4) ...', flush=True)
    regress = []
    for p in train_files:
        if 'v5_candidates' not in p:
            continue
        rel = p.replace(f'{CAND}/record/', '')
        lbl = f'{CAND}/labels/record/{os.path.splitext(rel)[0]}.txt'
        if os.path.exists(lbl) and os.path.getsize(lbl) > 0:
            regress.append(('v2_ai', p, lbl))
    for f in sorted(os.listdir(DJI_IMG)):
        if f.lower().endswith(IMG_EXT):
            regress.append(('dji', f'{DJI_IMG}/{f}', f'{DJI_LAB}/{os.path.splitext(f)[0]}.txt'))
    with open(f'{OUT}/regress_list.txt', 'w') as fo:
        for src, img, lab in regress:
            fo.write(f'{src}\t{img}\t{lab}\n')
    n_v2 = sum(1 for s, _, _ in regress if s == 'v2_ai')
    print(f'    回归集 {len(regress)} 帧 = v2_ai {n_v2} + DJI {len(regress)-n_v2}', flush=True)

    # ---------- 8. data.yaml ----------
    yaml = (
        f'# v5 3 类合并集（方案B 第2批 2026-08-29）: m4 6319+ + v5_syn 400 + candidates 286 + dji 4 + wechat 合成\n'
        f'path: {OUT}\n'
        f'train: images/train\n'
        f'val: images/val\n'
        f'nc: 3\n'
        f"names: ['smoke', 'fire', 'house']\n"
    )
    with open(f'{OUT}/data.yaml', 'w', encoding='utf-8') as f:
        f.write(yaml)

    # ---------- 9. 汇总统计 ----------
    print('\n====== v5_train_merge 汇总 ======', flush=True)
    def stats(d):
        n_img = len([f for f in os.listdir(f'{OUT}/images/{d}') if f.lower().endswith(IMG_EXT)])
        boxes = collections.Counter()
        n_pos_img = 0
        for f in os.listdir(f'{OUT}/labels/{d}'):
            if not f.endswith('.txt'):
                continue
            c = parse_label(f'{OUT}/labels/{d}/{f}')
            if c:
                n_pos_img += 1
            boxes.update(x[0] for x in c)
        return n_img, n_pos_img, boxes
    ti, tpi, tb = stats('train')
    vi, vpi, vb = stats('val')
    print(f'train: {ti} 图 / 正样本图 {tpi} / 框分布 {dict(tb)}')
    print(f'val:   {vi} 图 / 正样本图 {vpi} / 框分布 {dict(vb)}')
    print(f'合计: {ti+vi} 图 | 输出 {OUT}/')

    # 校验预期
    print('\n[校验]', flush=True)
    print(f'  train 实际 {ti}  (期望≈7024, {"OK" if 6900 <= ti <= 7150 else "偏离!"})', flush=True)
    print(f'  val 实际 {vi}  (期望≈1000 零泄漏, {"OK" if 950 <= vi <= 1100 else "偏离!"})', flush=True)
    print(f'  smoke 框合计 = {tb.get(0,0)+vb.get(0,0)} (v4 基线 915 框, 预期提升)', flush=True)
    print(f'  泄漏交集 = {len(leak)} (必须 0)', flush=True)


if __name__ == '__main__':
    main()
