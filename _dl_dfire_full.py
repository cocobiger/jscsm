"""下载 D-Fire 全部 parquet → 解析为 YOLO 图片+标签（仅保留 smoke/fire 正样本）"""
import os, sys, io
os.environ['HF_ENDPOINT'] = 'https://hf-mirror.com'
from huggingface_hub import hf_hub_download
import pyarrow.parquet as pq

OUT = '/opt/jsc/datasets/dfire'
YOLO = '/opt/jsc/datasets/dfire_yolo'
os.makedirs(YOLO + '/images', exist_ok=True)
os.makedirs(YOLO + '/labels', exist_ok=True)

FILES = [f'data/train-0000{i}-of-00009.parquet' for i in range(9)] + \
        [f'data/test-0000{i}-of-00003.parquet' for i in range(3)]

def log(m):
    print(m, flush=True)

for i, f in enumerate(FILES):
    log(f'[{i+1}/{len(FILES)}] 下载 {f} …')
    p = hf_hub_download('badsaarow/d-fire', f, repo_type='dataset', local_dir=OUT)
    log(f'  完成 %.1fMB' % (os.path.getsize(p) / 1048576))

log('全部下载完成，开始解析…')

total_rows = 0
kept = 0
n_smoke = 0
n_fire = 0
for f in FILES:
    p = os.path.join(OUT, f)
    t = pq.read_table(p)
    imgs = t.column('image').to_pylist()
    labels = t.column('label').to_pylist()
    fns = t.column('filename').to_pylist()
    for im, lab, fn in zip(imgs, labels, fns):
        total_rows += 1
        if lab is None or str(lab).strip() == '':
            continue  # 丢弃 None 负样本图
        lines = [l.strip() for l in str(lab).strip().split('\n') if l.strip()]
        # 校验坐标合法
        ok = True
        for l in lines:
            parts = l.split()
            if len(parts) != 5:
                ok = False; break
            try:
                vals = [float(x) for x in parts[1:]]
                if any(v < 0 or v > 1 for v in vals):
                    ok = False; break
            except:
                ok = False; break
        if not ok:
            continue
        base = os.path.splitext(os.path.basename(fn))[0]
        # 去重文件名
        img_path = os.path.join(YOLO, 'images', base + '.jpg')
        lbl_path = os.path.join(YOLO, 'labels', base + '.txt')
        if os.path.exists(lbl_path):
            continue
        with open(lbl_path, 'w') as lf:
            lf.write('\n'.join(lines) + '\n')
        with open(img_path, 'wb') as imf:
            imf.write(im['bytes'])
        kept += 1
        for l in lines:
            if l.split()[0] == '0': n_smoke += 1
            else: n_fire += 1
    log(f'  已处理 {total_rows} 行, 保留 {kept} 张正样本 (smoke {n_smoke} / fire {n_fire})')

log(f'=== 完成: 总 {total_rows} 行 → 保留 {kept} 张 | smoke框 {n_smoke} / fire框 {n_fire} ===')
