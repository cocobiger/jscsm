# -*- coding: utf-8 -*-
"""
train_0909 入集（P1）
- 源: 复检页标注 JSON + 帧图 /opt/jsc/frontend/train_0909/frames
- 出: /video/shujuji/datasets/v5_train_v5/{images,labels}/{tr0909,va0909}
- 分层留出 val-A（含昼/夜），其余入 train
- 连续纯负样本段做轻度降采样（每 2 帧取 1），降低冗余
- 备份后把 train 行追加到 splits/stage2_train.txt
"""
import json, os, re, shutil

LBL = '/tmp/train_0909_labels_v3.json'
SRC = '/opt/jsc/frontend/train_0909/frames'
OUT = '/video/shujuji/datasets/v5_train_v5'
VAL_POS_PER_VID = {'064U_1036': 5, '0S4G_1132': 15}   # 共 20 正样本留出
VAL_NEG_PER_VID = {'064U_1036': 30, '0S4G_1132': 3}   # 共 33 负样本留出
NEG_DECIMATE_RUN = 6        # 连续负样本段 >=6 帧时，每 2 帧取 1
DECIMATE_STEP = 2

d = json.load(open(LBL, encoding='utf-8'))
GT = d['yolo_norm_0_1000']
pos = sorted(set(d['smokeFrames']), key=lambda f: (f.split('_f')[0], int(re.search(r'_f(\d+)', f).group(1))))
neg = sorted(set(d['negativeFrames']), key=lambda f: (f.split('_f')[0], int(re.search(r'_f(\d+)', f).group(1))))
skip = set(d['invalidFrames'])

# ── 1. 分层留出 val ──
def pick_even(lst, k):
    if k <= 0 or not lst:
        return []
    if k >= len(lst):
        return list(lst)
    idx = [round(i * (len(lst) - 1) / (k - 1)) for i in range(k)] if k > 1 else [len(lst) // 2]
    seen, out = set(), []
    for i in idx:
        if i not in seen:
            seen.add(i); out.append(lst[i])
    return out

val_files = set()
for vid, k in VAL_POS_PER_VID.items():
    val_files |= set(pick_even([f for f in pos if f.startswith(vid)], k))
for vid, k in VAL_NEG_PER_VID.items():
    val_files |= set(pick_even([f for f in neg if f.startswith(vid)], k))

# ── 2. 负样本降采样（仅 train 侧、连续段 >=6 帧）──
def runs(fs):
    out, cur = [], []
    for f in fs:
        i = int(re.search(r'_f(\d+)', f).group(1))
        v = f.split('_f')[0]
        same_vid = cur and v == cur[-1].split('_f')[0]
        prev_i = int(re.search(r'_f(\d+)', cur[-1]).group(1)) if cur else -99
        if same_vid and i == prev_i + 1:
            cur.append(f)
        else:
            if cur: out.append(cur)
            cur = [f]
    if cur: out.append(cur)
    return out

drop = set()
for r in runs(neg):
    if len(r) >= NEG_DECIMATE_RUN:
        for i, f in enumerate(r):
            if f in val_files:
                continue
            if i % DECIMATE_STEP == 1:
                drop.add(f)

train_pos = [f for f in pos if f not in val_files]
train_neg_all = [f for f in neg if f not in val_files]
train_neg = [f for f in train_neg_all if f not in drop]
val_pos = [f for f in pos if f in val_files]
val_neg = [f for f in neg if f in val_files]

print('=' * 64)
print('源: 真烟 %d / 负 %d / 无效 %d' % (len(pos), len(neg), len(skip)))
print('留出 val-A: 正 %d + 负 %d = %d' % (len(val_pos), len(val_neg), len(val_pos) + len(val_neg)))
print('train : 正 %d + 负 %d = %d  (负样本降采样丢弃 %d)' % (
    len(train_pos), len(train_neg), len(train_pos) + len(train_neg), len(drop)))
print('  留出 val 正样本:', ', '.join(val_pos))
print('  负样本降采样示例:', ', '.join(sorted(drop)[:5]), '...' if len(drop) > 5 else '')

# ── 3. 落盘 ──
def emit(files, tag, is_pos_map):
    idir = os.path.join(OUT, 'images', tag)
    ldir = os.path.join(OUT, 'labels', tag)
    os.makedirs(idir, exist_ok=True); os.makedirs(ldir, exist_ok=True)
    lines = []
    for f in files:
        src = os.path.join(SRC, f)
        if not os.path.exists(src):
            print('  [MISS]', f); continue
        shutil.copy2(src, os.path.join(idir, f))
        txt = os.path.join(ldir, f.rsplit('.', 1)[0] + '.txt')
        bs = is_pos_map.get(f, [])
        with open(txt, 'w') as fh:
            for b in bs:
                cx = min(1.0, max(0.0, b['cx'] / 1000)); cy = min(1.0, max(0.0, b['cy'] / 1000))
                w = min(1.0, max(0.0, b['w'] / 1000)); h = min(1.0, max(0.0, b['h'] / 1000))
                fh.write('0 %.6f %.6f %.6f %.6f\n' % (cx, cy, w, h))
        lines.append(os.path.join(idir, f))
    return lines

tr = emit(train_pos + train_neg, 'tr0909', GT)
va = emit(val_pos + val_neg, 'va0909', GT)
tr_pos = len(train_pos); tr_box = sum(len(GT.get(f, [])) for f in train_pos)
va_pos = len(val_pos); va_box = sum(len(GT.get(f, [])) for f in val_pos)
print()
print('已写 images/labels: tr0909 %d 帧(%d 正/%d 框) | va0909 %d 帧(%d 正/%d 框)' % (
    len(tr), tr_pos, tr_box, len(va), va_pos, va_box))

# ── 4. 追加 split ──
sp = os.path.join(OUT, 'splits')
open(os.path.join(sp, 'tr0909_train.txt'), 'w').write('\n'.join(tr) + '\n')
open(os.path.join(sp, 'va0909.txt'), 'w').write('\n'.join(va) + '\n')

bl = os.path.join(sp, 'stage2_train.txt')
bak = bl + '.bak_0909'
if not os.path.exists(bak):
    shutil.copy2(bl, bak)
    print('已备份:', bak)
old = [l for l in open(bl).read().splitlines() if l.strip()]
newset = set(old) | set(tr)
with open(bl, 'w') as fh:
    fh.write('\n'.join(old + [l for l in tr if l not in set(old)]) + '\n')
print('stage2_train.txt: %d → %d 行' % (len(old), len(set(old) | set(tr))))

# 反查最终正负
p = n = 0
for line in open(bl):
    line = line.strip()
    if not line: continue
    lab = line.replace('/images/', '/labels/').rsplit('.', 1)[0] + '.txt'
    if os.path.exists(lab) and os.path.getsize(lab) > 0: p += 1
    else: n += 1
print('最终 stage2_train.txt: 正样本 %d / 负样本 %d' % (p, n))
