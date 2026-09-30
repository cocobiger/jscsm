#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""record_frames.py —— 从直播流「直录 + 抽帧」（替代已失效的 MinIO 抽帧路径）

背景
  原抽帧脚本 `pull_frames_v5.py` 依赖 MinIO 上的直播段（`s3_get` → ffmpeg 抽帧 → 删 mp4）。
  2026-09-30 生产机重建后 MinIO 不复存在（本地 :9000 与司空侧 172.28.0.90 均不可达），该路径跑不了。
  本脚本改为「**直接从流地址抽帧**」，不依赖任何对象存储。

两种模式
  · direct（默认，推荐）：`ffmpeg -i <流> -t N -vf fps=1/interval out_%05d.jpg`
      —— **完全不落视频**（零视频磁盘占用），也就绕开了 `-c copy` 到 TS 的 pts/dts 问题。
  · segment：`-c copy -f segment` 切小段 → 每段一落盘就抽帧、抽完立刻删段（**不囤视频**）。
      适合"想先录下来、稍后用不同 interval 反复抽"的场景。
      ⚠️ 某些 RTSP 源 `-c copy` 会报 `first pts and dts value must be set`，本脚本已加
      `-fflags +genpts -avoid_negative_ts make_zero` 缓解；仍失败就用 direct。

其它能力
  · RTSP 默认走 TCP（弱网更稳）；带读写超时，避免挂死
  · `--dedupe`：按「16×16 灰度图相邻帧平均绝对差」去掉近重复帧（省标注量）
  · `--audit`：入集前体检——按 **分辨率 × 宽高比** 标记可疑帧（超宽/非常规比例，如桌面截图），
    移入 `_quarantine/`（默认不入集）
  · 日志中 URL 自动脱敏（`//user:pass@` → `//***:***@`）

用法
  # 直接从流抽帧（推荐）：录 600s，每 2s 一帧
  record_frames.py --url "rtsp://..." --seconds 600 --interval 2 \
                   --out /data/video/shujuji/datasets/v5_live_frames --tag jiulongshachang

  # 免手抄含密码的 URL：按驾驶舱后端的 streamId 取地址
  record_frames.py --id <streamId> --api http://127.0.0.1:7170 --seconds 600 --interval 2

  # 批量（每行 `url[,tag]`，# 为注释）
  record_frames.py --url-file list.txt --seconds 300 --interval 2 --out DIR

  # 只抽已有的本地视频
  record_frames.py --local-video /tmp/x.mp4 --interval 2 --out DIR --tag xxx

  # 先录成段再抽（可反复抽不同间隔）
  record_frames.py --id <streamId> --mode segment --seconds 600 --seg 300 --interval 2
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request

DEFAULT_OUT = '/data/video/shujuji/datasets/v5_live_frames'
DEFAULT_TMP = '/data/video/rec_tmp'
DRONE_WHITELIST = {(960, 720), (1280, 720), (1440, 1080)}


def mask(u: str) -> str:
    return re.sub(r'//[^@/]+@', '//***:***@', u or '')


def log(*a):
    print(*a, flush=True)


def _ff_in_args(url: str):
    """输入侧公共参数。
    注意：**不要**在这里加 `-rw_timeout` / `-stimeout` —— 各 ffmpeg 版本命名不一致
    （4.4 会报 `Option rw_timeout not found`）。超时统一由 Python 层 subprocess timeout 控制。"""
    a = ['-hide_banner', '-loglevel', 'error', '-y']
    if url.lower().startswith('rtsp'):
        a += ['-rtsp_transport', 'tcp']
    return a


# ───────────────── 抽帧 / 去重 / 体检 ─────────────────
def extract_from_video(video: str, out_dir: str, interval: float):
    os.makedirs(out_dir, exist_ok=True)
    cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', video,
           '-vf', 'fps=1/%s' % interval, '-q:v', '3', os.path.join(out_dir, 'f%05d.jpg')]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        log('  [warn] 抽帧失败:', (r.stderr or '')[-200:])
    return sorted(glob.glob(os.path.join(out_dir, 'f*.jpg')))


def dedupe_and_rename(frames, out_dir, tag, counter, thresh):
    kept, prev, cv2 = 0, None, None
    try:
        import cv2 as _cv2
        import numpy as _np
        cv2 = _cv2
    except Exception:
        pass
    for f in frames:
        dst = os.path.join(out_dir, '%s_%06d.jpg' % (tag, counter[0]))
        if cv2 is None:
            shutil.move(f, dst); counter[0] += 1; kept += 1; continue
        img = cv2.imread(f)
        if img is None:
            os.remove(f); continue
        g = cv2.resize(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), (16, 16)).astype('float32')
        if prev is not None and float(_np.mean(_np.abs(g - prev))) < thresh:
            os.remove(f)                       # 与上一张几乎相同 → 丢
        else:
            shutil.move(f, dst); counter[0] += 1; kept += 1; prev = g
    return kept


def move_plain(frames, out_dir, tag, counter):
    for f in frames:
        shutil.move(f, os.path.join(out_dir, '%s_%06d.jpg' % (tag, counter[0])))
        counter[0] += 1
    return len(frames)


def audit(out_dir, quarantine=True):
    """入集前体检。

    判据只抓**真污染**，不误杀合法摄像头分辨率：
      · 宽度 ≥ 2000 —— 桌面截图特征（已知污染样本 2968×1732 / 2560×1329 / 2942×1732 全部命中）
      · 宽高比 > 2.1 或 < 0.8 —— 明显异常/撕裂
    ⚠️ 曾经用「必须等于 4:3 或 16:9」当判据，会把 **704×576(D1)**、800×600 等合法尺寸误杀。
    """
    from PIL import Image
    sizes, susp = {}, []
    for f in sorted(glob.glob(os.path.join(out_dir, '*.jpg'))):
        try:
            with Image.open(f) as im:
                w, h = im.size
        except Exception:
            continue
        sizes[(w, h)] = sizes.get((w, h), 0) + 1
        ar = w / h
        bad = (w >= 2000) or (ar > 2.1) or (ar < 0.8)
        if bad and (w, h) not in DRONE_WHITELIST:
            susp.append(f)
    log('  [audit] 分辨率分布: %s' % {('%dx%d' % k): v for k, v in sorted(sizes.items(), key=lambda x: -x[1])})
    log('  [audit] 可疑帧(超宽≥2000 或 比例异常): %d' % len(susp))
    if susp and quarantine:
        qd = os.path.join(out_dir, '_quarantine')
        os.makedirs(qd, exist_ok=True)
        for f in susp:
            shutil.move(f, os.path.join(qd, os.path.basename(f)))
        log('  [audit] 已移入 %s' % qd)
    return sizes, len(susp)


# ───────────────── 主流程 ─────────────────
def run_direct(url, seconds, interval, out_dir, tag, dedupe, thresh, do_audit, tmp_root):
    """直接从流抽帧：不落任何视频"""
    work = os.path.join(tmp_root, '_fr_' + tag)
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work, exist_ok=True)
    cmd = ['ffmpeg'] + _ff_in_args(url) + ['-i', url, '-t', str(seconds),
           '-vf', 'fps=1/%s' % interval, '-q:v', '3', os.path.join(work, 'f%05d.jpg')]
    log('[rec/direct] 录 %.0fs，每 %ss 一帧（不落视频） → %s' % (seconds, interval, mask(url)))
    t0 = time.time()
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=seconds + 60)
        rc, err = r.returncode, (r.stderr or '')
    except subprocess.TimeoutExpired:
        rc, err = -1, 'ffmpeg 超时(%ds)，强制结束' % (seconds + 60)
    frames = sorted(glob.glob(os.path.join(work, 'f*.jpg')))
    if rc != 0 and not frames:
        log('  [err] ffmpeg 失败:', err[-300:])
    elif rc != 0:
        log('  [warn] ffmpeg 退出码 %s（已抽到 %d 帧，继续）' % (rc, len(frames)))
    elapsed = time.time() - t0
    counter = [1]
    kept = dedupe_and_rename(frames, out_dir, tag, counter, thresh) if dedupe else move_plain(frames, out_dir, tag, counter)
    shutil.rmtree(work, ignore_errors=True)
    log('  → 抽到 %d 帧，去重后留 %d 帧，用时 %.0fs' % (len(frames), kept, elapsed))
    return len(frames), kept, elapsed


def run_segment(url, seconds, seg, interval, out_dir, tag, dedupe, thresh, do_audit, keep_video, tmp_root):
    """切段录制 + 边录边抽 + 抽完删段"""
    segdir = os.path.join(tmp_root, 'seg_' + tag)
    shutil.rmtree(segdir, ignore_errors=True)
    os.makedirs(segdir, exist_ok=True)
    cmd = ['ffmpeg'] + _ff_in_args(url) + ['-fflags', '+genpts', '-i', url, '-t', str(seconds),
           '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-f', 'segment',
           '-segment_time', str(seg), '-reset_timestamps', '1',
           os.path.join(segdir, 'seg_%04d.ts')]
    log('[rec/segment] 录 %.0fs（每段 %ds，c-copy） → %s' % (seconds, seg, mask(url)))
    p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    counter = [1]
    raw = kept = 0
    done_segs = set()
    work = os.path.join(segdir, '_fr')
    t0 = time.time()
    try:
        while True:
            segs = sorted(glob.glob(os.path.join(segdir, 'seg_*.ts')))
            alive = p.poll() is None
            ready = segs[:-1] if alive else segs
            for s in ready:
                if s in done_segs:
                    continue
                done_segs.add(s)
                fr = extract_from_video(s, work, interval)
                raw += len(fr)
                k = dedupe_and_rename(fr, out_dir, tag, counter, thresh) if dedupe else move_plain(fr, out_dir, tag, counter)
                kept += k
                if not keep_video:
                    try:
                        os.remove(s)
                    except OSError:
                        pass
                log('  [seg] %s → 抽出 %d / 留 %d（累计 %d）%s' % (os.path.basename(s), len(fr), k, kept,
                                                                   '' if keep_video else '，已删段'))
            if not alive and all(s in done_segs for s in segs):
                break
            time.sleep(2)
    finally:
        if p.poll() is None:
            p.terminate()
            try:
                p.wait(timeout=15)
            except Exception:
                p.kill()
        err = ''
        try:
            err = (p.stderr.read() or '')[-300:]
        except Exception:
            pass
        shutil.rmtree(work, ignore_errors=True)
        if not keep_video:
            shutil.rmtree(segdir, ignore_errors=True)
        if err.strip():
            log('  [ffmpeg] %s' % err.strip())
    return raw, kept, time.time() - t0


def run_one(url, opt):
    out_dir = os.path.join(opt.out, opt.tag)
    os.makedirs(out_dir, exist_ok=True)
    if opt.mode == 'direct':
        raw, kept, el = run_direct(url, opt.seconds, opt.interval, out_dir, opt.tag,
                                   opt.dedupe, opt.dedupe_thresh, opt.audit, opt.tmp)
    else:
        raw, kept, el = run_segment(url, opt.seconds, opt.seg, opt.interval, out_dir, opt.tag,
                                    opt.dedupe, opt.dedupe_thresh, opt.audit, opt.keep_video, opt.tmp)
    sizes, n_susp = (audit(out_dir) if opt.audit else (None, None))
    meta = {'url': mask(url), 'tag': opt.tag, 'mode': opt.mode, 'seconds': opt.seconds,
            'interval': opt.interval, 'dedupe': bool(opt.dedupe), 'raw_frames': raw,
            'kept_frames': kept, 'elapsed_s': round(el, 1), 'suspicious': n_susp,
            'out_dir': out_dir, 'at': time.strftime('%F %T')}
    with open(os.path.join(out_dir, 'meta.json'), 'w', encoding='utf-8') as f:
        json.dump({'meta': meta, 'sizes': {('%dx%d' % k): v for k, v in (sizes or {}).items()}},
                  f, ensure_ascii=False, indent=1)
    log('[done] 原始 %d → 留 %d 帧 ｜ %.0fs ｜ %s' % (raw, kept, el, out_dir))


def fetch_url_by_id(api, sid, user, pw):
    body = json.dumps({'username': user, 'password': pw}).encode()
    req = urllib.request.Request(api.rstrip('/') + '/api/auth/login', data=body,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=15) as r:
        tok = json.loads(r.read().decode()).get('token', '')
    req2 = urllib.request.Request(api.rstrip('/') + '/api/streams',
                                  headers={'Authorization': 'Bearer ' + tok})
    with urllib.request.urlopen(req2, timeout=20) as r:
        d = json.loads(r.read().decode())
    arr = d if isinstance(d, list) else d.get('items', d.get('data', []))
    for s in arr:
        if s.get('id') == sid:
            return s.get('url') or '', s.get('name') or sid
    raise SystemExit('未在 /api/streams 找到 id=%s' % sid)


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--url')
    g.add_argument('--url-file')
    g.add_argument('--id')
    g.add_argument('--local-video')
    ap.add_argument('--api', default='http://127.0.0.1:7170')
    ap.add_argument('--user', default=os.environ.get('JSC_USER', 'admin'))
    ap.add_argument('--passwd', default=os.environ.get('JSC_PASS', 'admin123'))
    ap.add_argument('--mode', choices=['direct', 'segment'], default='direct')
    ap.add_argument('--seconds', type=int, default=600)
    ap.add_argument('--seg', type=int, default=300)
    ap.add_argument('--interval', type=float, default=2)
    ap.add_argument('--out', default=DEFAULT_OUT)
    ap.add_argument('--tmp', default=DEFAULT_TMP)
    ap.add_argument('--tag', default=None)
    ap.add_argument('--dedupe', action='store_true')
    ap.add_argument('--dedupe-thresh', type=float, default=2.0)
    ap.add_argument('--audit', action='store_true')
    ap.add_argument('--keep-video', action='store_true', help='segment 模式下保留段文件（默认抽完即删）')
    a = ap.parse_args()
    os.makedirs(a.tmp, exist_ok=True)

    if a.local_video:
        tag = a.tag or os.path.splitext(os.path.basename(a.local_video))[0]
        a.tag = tag
        out_dir = os.path.join(a.out, tag)
        os.makedirs(out_dir, exist_ok=True)
        fr = extract_from_video(a.local_video, os.path.join(a.tmp, '_fr_' + tag), a.interval)
        counter = [1]
        kept = dedupe_and_rename(fr, out_dir, tag, counter, a.dedupe_thresh) if a.dedupe else move_plain(fr, out_dir, tag, counter)
        log('[local] %s → %d 帧' % (a.local_video, kept))
        if a.audit:
            audit(out_dir)
        return 0

    if a.url:
        jobs = [(a.url, a.tag or 'single')]
    elif a.id:
        u, nm = fetch_url_by_id(a.api, a.id, a.user, a.passwd)
        jobs = [(u, a.tag or re.sub(r'\W+', '_', nm)[:40])]
    else:
        jobs = []
        for line in open(a.url_file, encoding='utf-8'):
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            parts = line.split(',', 1)
            u = parts[0].strip()
            tg = parts[1].strip() if len(parts) > 1 else 'job%d' % (len(jobs) + 1)
            jobs.append((u, tg))

    for i, (u, tg) in enumerate(jobs, 1):
        a.tag = tg
        log('=== [%d/%d] tag=%s ===' % (i, len(jobs), tg))
        try:
            run_one(u, a)
        except KeyboardInterrupt:
            log('中断'); break
        except Exception as e:
            log('  [err] %s: %s' % (type(e).__name__, e))
    return 0


if __name__ == '__main__':
    sys.exit(main())
