#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_v5_neg_from_reviews.py
============================
从后端 straw_neg_reviews 表消费人工抽检结果，导出训练负样本。

用途：驾驶舱「抽检标注」tab 落地人工判定（✅ 正确/❌ 错误/❓ 不确定）后，
本脚本读取 ok 帧（VLM 干扰物分类判对，标注为真负样本），拷贝到训练目录作为空标注负样本。

数据流：
  VLM 分类 (neg_classified.json)
    ↓
  驾驶舱抽检标注（人工 ✅/❌/❓）
    ↓
  straw_neg_reviews 表（SQLite）
    ↓
  本脚本读取 + 过滤 review_status='ok'
    ↓
  /video/shujuji/datasets/v5_neg_v3_reviewed/
    ├── images/<stem>.jpg
    └── labels/<stem>.txt    （空文件 = 负样本）
    └── manifest.json         （frame_path, cats, reviewer, reviewed_at）

输入：
  --api  GET 端点（默认 http://127.0.0.1:7170/api/straw/neg-classify）
  --token  会话 token（gen_token.js 生成；亦可走 LOGIN_TOKEN 环境变量）
  --status  复选 review_status 集合（默认 'ok'）

输出：
  --out  训练目录（默认 /video/shujuji/datasets/v5_neg_v3_reviewed/）
  --copy  复制图片（默认 True；False 仅生成清单不复制）

依赖：requests（apt: python3-requests）。无需 GPU/onnx。
"""
import argparse, json, os, shutil, sys
from pathlib import Path
from datetime import datetime

DEFAULT_API = 'http://127.0.0.1:7170/api/straw/neg-classify'
DEFAULT_OUT = '/video/shujuji/datasets/v5_neg_v3_reviewed'


def fetch_catalog(api: str, token: str) -> dict:
    import requests
    h = {'Authorization': f'Bearer {token}'} if token else {}
    r = requests.get(api, headers=h, timeout=30)
    r.raise_for_status()
    d = r.json()
    if not d.get('ok'):
        raise SystemExit(f'API 错误: {d.get("error")}')
    return d


def main():
    ap = argparse.ArgumentParser(description='从 straw_neg_reviews 导出训练负样本')
    ap.add_argument('--api', default=os.environ.get('NEG_API', DEFAULT_API))
    ap.add_argument('--token', default=os.environ.get('LOGIN_TOKEN', ''))
    ap.add_argument('--status', default='ok', help='复选 review_status（默认 ok）')
    ap.add_argument('--out', default=DEFAULT_OUT)
    ap.add_argument('--no-copy', action='store_true', help='不复制图片，只生成清单')
    args = ap.parse_args()

    want_status = set(s.strip() for s in args.status.split(',') if s.strip())
    print(f'[1/4] 拉取抽检数据: {args.api}')
    d = fetch_catalog(args.api, args.token)
    catalog = d.get('catalog', {})
    reviews = d.get('reviews', [])
    stats = d.get('stats', {})
    print(f'      catalog 帧数: {len(catalog)} | reviews 记录: {len(reviews)} | stats: {stats}')

    reviews_by_fp = {r['frame_path']: r for r in reviews}
    selected = [fp for fp, rv in reviews_by_fp.items() if rv.get('review_status') in want_status]
    print(f'[2/4] 按 status={want_status} 筛选: {len(selected)} 帧')

    if not selected:
        print('⚠️  无符合条件的帧，先去驾驶舱「秸秆焚烧监控 → 抽检标注」tab 复核')
        return

    out_root = Path(args.out)
    img_dir = out_root / 'images'
    lab_dir = out_root / 'labels'
    img_dir.mkdir(parents=True, exist_ok=True)
    lab_dir.mkdir(parents=True, exist_ok=True)

    manifest = []
    copied, skipped, missing = 0, 0, 0
    for fp in selected:
        if not os.path.exists(fp):
            print(f'      [缺图] {fp}')
            missing += 1
            continue
        rv = reviews_by_fp[fp]
        cat = catalog.get(fp, {})
        # 文件名：取 record 之后的相对路径，去 /，避免过深
        rel = fp.split('/record/')[-1] if '/record/' in fp else os.path.basename(fp)
        stem = f'nv_{rel.replace("/", "_")}'
        if not args.no_copy:
            dst_img = img_dir / (stem + '.jpg')
            try:
                shutil.copy2(fp, dst_img)
            except OSError as e:
                print(f'      [复制失败] {fp} ({e})')
                skipped += 1
                continue
            # 负样本：空标注文件
            (lab_dir / (stem + '.txt')).write_text('', encoding='utf-8')
            copied += 1
        manifest.append({
            'frame_path': fp,
            'stem': stem,
            'cats': cat.get('cats', []),
            'raw': cat.get('raw', ''),
            'review_status': rv.get('review_status'),
            'reviewer': rv.get('reviewer', ''),
            'reviewed_at': rv.get('reviewed_at', ''),
            'note': rv.get('note', ''),
            'ts': cat.get('ts', ''),
        })

    manifest_path = out_root / 'manifest.json'
    manifest_path.write_text(json.dumps({
        'created_at': datetime.now().isoformat(timespec='seconds'),
        'source_api': args.api,
        'filter_status': sorted(want_status),
        'total_selected': len(selected),
        'copied': copied if not args.no_copy else 0,
        'skipped': skipped,
        'missing_src': missing,
        'items': manifest,
    }, ensure_ascii=False, indent=2), encoding='utf-8')

    print(f'[3/4] 复制图片: {copied}（失败 {skipped} | 源图缺失 {missing}）' if not args.no_copy else f'[3/4] 跳过复制（--no-copy）')
    print(f'[4/4] 清单: {manifest_path}  ({len(manifest)} 条)')
    if copied:
        print(f'✅ 负样本目录: {out_root}')
        print(f'   images: {img_dir}  labels: {lab_dir}  manifest: {manifest_path}')
    if not args.no_copy and copied:
        print(f'\n训练侧接入：')
        print(f'  1) 把 {out_root}/images 与 {out_root}/labels 接入 v5 v6 训练配置')
        print(f'  2) classes 仍是 0/1/2 (smoke/fire/house)，空 .txt = 负样本')


if __name__ == '__main__':
    main()
