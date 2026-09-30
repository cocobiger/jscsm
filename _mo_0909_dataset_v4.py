# -*- coding: utf-8 -*-
"""
train_0909 增量入集 v4（P1-2）
- 源: train_0909_labels_v4.json（318 帧全量，含补标的 45 帧）
- 关键约束: **va0909 冻结**（沿用 splits/va0909.txt 的 53 帧），保证 stage3 vs stage4 可比
- 只把「v4 新增的 45 帧」中非无效的帧增量写入 tr0909 + stage2_train.txt
- 新负样本连续段做同样的每 2 帧取 1 降采样（与 v3 同规则）
"""
import json, os, re, shutil, sys

LBL = '/tmp/train_0909_labels_v4.json'
SRC = '/opt/jsc/frontend/train_0909/frames'
OUT = '/video/shujuji/datasets/v5_train_v5'
NEG_DECIMATE_RUN = 6
DECIMATE_STEP = 2

d = json.load(open(LBL, encoding='utf-8'))
GT = d['yolo_norm_0_1000']
pos_all = set(d['smokeFrames'])
neg_all = set(d['negativeFrames'])
inv_all = set(d['invalidFrames'])
print('v4 全量: 真烟 %d / 负 %d / 无效 %d' % (len(pos_all), len(neg_all), len(inv_all)))

sp = os.path.join(OUT, 'splits')
# ── 冻结的 val ──
va_files = [l.strip() for l in open(os.path.join(sp, 'va0909.txt')) if l.strip()]
va_names = set(os.path.basename(x) for x in va_files)
print('冻结 val-A: %d 帧' % len(va_names))

# ── 已在 tr0909 的帧（v3 入集结果）──
tr_dir = os.path.join(OUT, 'images', 'tr0909')
already = set(os.listdir(tr_dir)) if os.path.isdir(tr_dir) else set()
print('已在 tr0909: %d 帧' % len(already))

# ── 新增帧 = v4 全量 - 已在 tr0909 - 在 val ──
new_all = sorted((pos_all | neg_all | inv_all) - already - va_names)
# 45 = 本次新标注；其余 = v3 入集时被降采样丢弃的负样本（本轮按同规则再判一次）
print('待增量入集: %d 帧' % len(new_all))
assert len(new_all) >= 45, '新增帧数不足: %d' % len(new_all)

new_pos = sorted([f for f in new_all if f in pos_all])
new_neg = sorted([f for f in new_all if f in neg_all])
new_inv = sorted([f for f in new_all if f in inv_all])
print('  其中真烟 %d / 负 %d / 无效 %d(跳过)' % (len(new_pos), len(new_neg), len(new_inv)))

# ── 新负样本降采样（同 v3 规则：连续段 >=6 → 每 2 帧取 1）──
def runs(fs):
    out, cur = [], []
    for f in fs:
        i = int(re.search(r'_f(\d+)', f).group(1)); v = f.split('_f')[0]
        same = cur and v == cur[-1].split('_f')[0]
        prev = int(re.search(r'_f(\d+)', cur[-1]).group(1)) if cur else -99
        if same and i == prev + 1: cur.append(f)
        else:
            if cur: out.append(cur)
            cur = [f]
    if cur: out.append(cur)
    return out

drop = set()
for r in runs(new_neg):
    if len(r) >= NEG_DECIMATE_RUN:
        for i, f in enumerate(r):
            if i % DECIMATE_STEP == 1:
                drop.add(f)
print('  负样本降采样丢弃 %d 帧' % len(drop))
new_neg_keep = [f for f in new_neg if f not in drop]

# ── 落盘 ──
idir = os.path.join(OUT, 'images', 'tr0909')
ldir = os.path.join(OUT, 'labels', 'tr0909')
os.makedirs(idir, exist_ok=True); os.makedirs(ldir, exist_ok=True)

emit = new_pos + new_neg_keep
lines = []
for f in emit:
    src = os.path.join(SRC, f)
    if not os.path.exists(src):
        print('  [MISS]', f); continue
    shutil.copy2(src, os.path.join(idir, f))
    txt = os.path.join(ldir, f.rsplit('.', 1)[0] + '.txt')
    with open(txt, 'w') as fh:
        for b in GT.get(f, []):
            cx = min(1.0, max(0.0, b['cx'] / 1000)); cy = min(1.0, max(0.0, b['cy'] / 1000))
            w = min(1.0, max(0.0, b['w'] / 1000)); h = min(1.0, max(0.0, b['h'] / 1000))
            fh.write('0 %.6f %.6f %.6f %.6f\n' % (cx, cy, w, h))
    lines.append(os.path.join(idir, f))
print('已写入 tr0909: %d 帧 (%d 正 / %d 框)' % (
    len(lines), len(new_pos), sum(len(GT.get(f, [])) for f in new_pos)))

# ── 追加 split ──
bl = os.path.join(sp, 'stage2_train.txt')
bak = bl + '.bak_v4'
if not os.path.exists(bak):
    shutil.copy2(bl, bak); print('已备份:', bak)
old = [l for l in open(bl).read().splitlines() if l.strip()]
olds = set(old)
add = [l for l in lines if l not in olds]
with open(bl, 'w') as fh:
    fh.write('\n'.join(old + add) + '\n')
print('stage2_train.txt: %d → %d 行 (+%d)' % (len(old), len(old) + len(add), len(add)))

# ── 反查 ──
p = n = 0
for line in open(bl):
    line = line.strip()
    if not line: continue
    lab = line.replace('/images/', '/labels/').rsplit('.', 1)[0] + '.txt'
    if os.path.exists(lab) and os.path.getsize(lab) > 0: p += 1
    else: n += 1
print('最终 stage2_train.txt: 正样本 %d / 负样本 %d / 合计 %d' % (p, n, p + n))

# ── 一致性护栏：val 未被污染 ──
trs = set(open(bl).read().splitlines())
leak = va_names & set(os.path.basename(x) for x in trs)
print('val 泄漏检查: %d %s' % (len(leak), '✅ 无泄漏' if not leak else '❌ ' + str(list(leak)[:5])))

# ── 记录 val 指纹（供复用）──
json.dump({'val_names': sorted(va_names), 'n': len(va_names),
           'frozen_at': '2026-09-10', 'note': 'stage3 起冻结，供 stage3/stage4 对比'},
          open(os.path.join(sp, 'va0909_fingerprint.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)
print('已写 val 指纹: va0909_fingerprint.json')
