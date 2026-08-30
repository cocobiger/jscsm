"""合并训练集：FlameVision(fire) + buchong(smoke/fire) → 2 类数据集
类别映射：
  FlameVision: class 0 = fire → 映射为 class 1（与 D-Fire 一致）
  buchong: class 0 = smoke, class 1 = fire（D-Fire 2 类原样）
输出：/opt/jsc/straw-engine/train_data/merged/{images,labels}/{train,valid} + data.yaml
"""
import os
import shutil

FLAME = '/opt/jsc/straw-engine/train_data/flamevision'
BUCHONG = '/opt/jsc/straw-engine/train_data/buchong'
OUT = '/opt/jsc/straw-engine/train_data/merged'


def reset(dir_path):
    if os.path.exists(dir_path):
        shutil.rmtree(dir_path)
    os.makedirs(dir_path)


reset(OUT)
for split in ['train', 'valid']:
    os.makedirs(f'{OUT}/images/{split}')
    os.makedirs(f'{OUT}/labels/{split}')

# 1. FlameVision → 映射 class 0→1（fire），train/valid
for split in ['train', 'valid']:
    imgs = os.listdir(f'{FLAME}/images/{split}')
    n = 0
    for im in imgs:
        src_img = f'{FLAME}/images/{split}/{im}'
        src_lbl = f'{FLAME}/labels/{split}/{os.path.splitext(im)[0]}.txt'
        if not os.path.exists(src_lbl):
            continue
        shutil.copy(src_img, f'{OUT}/images/{split}/{im}')
        # 类映射 0→1
        with open(src_lbl) as fh:
            lines = [l.strip() for l in fh if l.strip()]
        mapped = []
        for l in lines:
            parts = l.split()
            if not parts:
                continue
            cls = int(parts[0])
            mapped.append('1 ' + ' '.join(parts[1:]) if cls == 0 else l)
        with open(f'{OUT}/labels/{split}/{os.path.splitext(im)[0]}.txt', 'w') as fh:
            fh.write('\n'.join(mapped))
        n += 1
    print(f'FlameVision {split}: {n} 张（class→fire=1）')

# 2. buchong（13 张已标注，D-Fire 2 类原样）→ train
n = 0
for im in sorted(os.listdir(f'{BUCHONG}/images')):
    base = os.path.splitext(im)[0]
    src_lbl = f'{BUCHONG}/labels/{base}.txt'
    if not os.path.exists(src_lbl):
        continue
    shutil.copy(f'{BUCHONG}/images/{im}', f'{OUT}/images/train/{im}')
    shutil.copy(src_lbl, f'{OUT}/labels/train/{base}.txt')
    n += 1
print(f'buchong train: {n} 张（smoke+fire 2 类）')

# 3. data.yaml
with open(f'{OUT}/data.yaml', 'w') as fh:
    fh.write('path: /opt/jsc/straw-engine/train_data/merged\n')
    fh.write('train: images/train\n')
    fh.write('val: images/valid\n')
    fh.write('names:\n  0: smoke\n  1: fire\n')

# 4. 统计
tot_img = 0
tot_lbl = 0
for split in ['train', 'valid']:
    ii = len(os.listdir(f'{OUT}/images/{split}'))
    ll = len(os.listdir(f'{OUT}/labels/{split}'))
    print(f'{split}: images={ii} labels={ll}')
    tot_img += ii
    tot_lbl += ll
print(f'--- 合并完成: {tot_img} 张 / {tot_lbl} 标注 ---')
