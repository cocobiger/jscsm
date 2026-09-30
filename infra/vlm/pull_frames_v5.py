#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v5 扩源：从 MinIO 直播段拉取 + ffmpeg 抽帧 + 立即删 mp4（数据盘红线：不囤视频）
用法:
  pull_frames_v5.py --key <object_key> --out <dir> --interval 5
  pull_frames_v5.py --list <清单文件> --out <dir> --interval 5   # 逐段处理
  pull_frames_v5.py --plan <csv: key,out_subdir> --interval 5    # 按计划批量
"""
import sys, os, re, json, time, subprocess, hashlib, hmac, datetime, urllib.request, urllib.parse

ENDPOINT = os.environ.get('MINIO_ENDPOINT', 'http://127.0.0.1:9000')
ACCESS   = os.environ.get('MINIO_ACCESS', 'Xka@123.')
SECRET   = os.environ.get('MINIO_SECRET', 'Xka@123.')
BUCKET   = 'test'
DL_DIR   = '/video/llm_infer/video_dl'
STATE    = '/video/llm_infer/pull_frames_state.json'


def sign(key, msg):
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def sigv4_headers(method, host, path, query, payload_hash, amz_date, now_dt):
    canonical_headers = 'host:' + host + '\n' + 'x-amz-date:' + amz_date + '\n'
    signed_headers = 'host;x-amz-date'
    canonical_request = '\n'.join([method, path, query, canonical_headers, signed_headers, payload_hash])
    scope = now_dt + '/us-east-1/s3/aws4_request'
    string_to_sign = 'AWS4-HMAC-SHA256\n' + amz_date + '\n' + scope + '\n' + hashlib.sha256(canonical_request.encode()).hexdigest()
    k = sign(('AWS4' + SECRET).encode(), now_dt)
    k = sign(k, 'us-east-1'); k = sign(k, 's3'); k = sign(k, 'aws4_request')
    sig = hmac.new(k, string_to_sign.encode(), hashlib.sha256).hexdigest()
    return ('AWS4-HMAC-SHA256 Credential=' + ACCESS + '/' + scope +
            ', SignedHeaders=' + signed_headers + ', Signature=' + sig)


def s3_get(key, local_path):
    """SigV4 流式下载（支持大对象）"""
    now = datetime.datetime.utcnow()
    now_dt = now.strftime('%Y%m%d')
    amz_date = now.strftime('%Y%m%dT%H%M%SZ')
    url_p = urllib.parse.quote(key, safe='/')
    host = urllib.parse.urlparse(ENDPOINT).netloc
    path = '/' + BUCKET + '/' + url_p
    payload_hash = hashlib.sha256(b'').hexdigest()
    auth = sigv4_headers('GET', host, path, '', payload_hash, amz_date, now_dt)
    req = urllib.request.Request(ENDPOINT + path, headers={
        'Authorization': auth, 'x-amz-date': amz_date, 'Host': host,
    })
    with urllib.request.urlopen(req, timeout=120) as r, open(local_path, 'wb') as f:
        sz = 0
        while True:
            chunk = r.read(65536)
            if not chunk:
                break
            f.write(chunk)
            sz += len(chunk)
    return sz


def extract_frames(video, out_dir, interval=5, max_frames=0):
    """ffmpeg 抽帧：每 interval 秒一帧"""
    os.makedirs(out_dir, exist_ok=True)
    # 先探时长
    prob = subprocess.run(['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
                           '-of', 'csv=p=0', video], capture_output=True, text=True)
    dur = float(prob.stdout.strip() or 0)
    if dur <= 0:
        print(f'  [warn] 无法读时长 {video}, 跳过抽帧')
        return 0, 0
    n_est = int(dur / interval)
    pat = os.path.join(out_dir, 'f%05d.jpg')
    cmd = ['ffmpeg', '-y', '-v', 'error', '-i', video, '-vf', f'fps=1/{interval}', '-q:v', '3']
    if max_frames:
        cmd += ['-frames:v', str(max_frames)]
    cmd.append(pat)
    r = subprocess.run(cmd, capture_output=True, text=True)
    n = len([x for x in os.listdir(out_dir) if x.endswith('.jpg')])
    return n, int(dur)


def load_state():
    if os.path.exists(STATE):
        try:
            return json.load(open(STATE, encoding='utf-8'))
        except Exception:
            pass
    return {'done': []}


def save_state(st):
    json.dump(st, open(STATE, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


def process(key, out_root, interval, keep_video=False):
    """处理单个对象：下载→抽帧→删mp4。返回 (帧数, 时长, 大小)"""
    base = os.path.basename(key).replace('.mp4', '')
    # 输出子目录：sn_日期_时段
    parts = key.split('/')
    sn = parts[2] if len(parts) > 3 else 'unknown'
    day = parts[3] if len(parts) > 4 else 'nodate'
    out_dir = os.path.join(out_root, f'{sn}_{day}_{base}')
    if os.path.exists(out_dir) and len([x for x in os.listdir(out_dir) if x.endswith('.jpg')]) > 0:
        n0 = len([x for x in os.listdir(out_dir) if x.endswith('.jpg')])
        print(f'[skip] {base} 已存在 {n0} 帧', flush=True)
        return n0, 0, 0
    os.makedirs(DL_DIR, exist_ok=True)
    video = os.path.join(DL_DIR, base + '.mp4')
    t0 = time.time()
    print(f'[dl] {key}', flush=True)
    try:
        sz = s3_get(key, video)
    except Exception as e:
        print(f'  [err] 下载失败: {e}', flush=True)
        return 0, 0, 0
    print(f'  [{sz/1024/1024:.1f}MB in {time.time()-t0:.0f}s]', flush=True)
    n, dur = extract_frames(video, out_dir, interval)
    print(f'  [frames] {n} 帧 (时长 {dur}s, 每{interval}s)', flush=True)
    if not keep_video and os.path.exists(video):
        os.remove(video)
        print(f'  [clean] 已删 {base}.mp4', flush=True)
    return n, dur, sz


def main():
    args = sys.argv[1:]
    interval = 5
    keep = False
    out_root = '/video/shujuji/datasets/v5_live_frames'
    plan = []
    if '--interval' in args:
        interval = int(args[args.index('--interval') + 1])
    if '--keep' in args:
        keep = True
    if '--out' in args:
        out_root = args[args.index('--out') + 1]
    if '--key' in args:
        plan = [args[args.index('--key') + 1]]
    elif '--list' in args:
        lst = args[args.index('--list') + 1]
        for line in open(lst):
            line = line.strip()
            if not line:
                continue
            if '\t' in line:
                line = line.split('\t', 1)[1]
            plan.append(line)
    elif '--plan' in args:
        for line in open(args[args.index('--plan') + 1]):
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            plan.append(line.split(',')[0].strip())

    st = load_state()
    os.makedirs(out_root, exist_ok=True)
    total_frames = 0
    for key in plan:
        if key in st['done']:
            print(f'[skip] {key} 已完成', flush=True)
            continue
        n, dur, sz = process(key, out_root, interval, keep)
        total_frames += n
        if sz > 0:
            st['done'].append(key)
            save_state(st)
    print(f'\n[all done] 总抽帧 {total_frames}', flush=True)


if __name__ == '__main__':
    main()
