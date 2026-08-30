#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
司空2 MinIO 任务照片自动回流（v5 训练样本扩充：方案① 100+ 帧目标）

- 只读 S3 API（:9000）ListObjectsV2 增量扫描 dock_media 任务媒体
- 新出现的 _V 可见光 jpeg → SigV4 下载 → PIL 缩放 1920 宽
  → /video/llm_infer/v5_photos/task_YYYYMMDD/{原名}
- 状态: /video/llm_infer/media_sync_state.json（last_key 字典序推进，幂等）
- 复用 minio_get.py 的 SigV4 下载实现（erasure 分片无法线性拼接的坑）
- _T 热成像 / 视频 / NAV 等忽略（非 smoke 训练目标）

用法:
  nohup /opt/jsc/straw-engine/venv/bin/python3 media_sync_v5.py \
      >> /video/llm_infer/media_sync.log 2>&1 &
或 crontab: */1 * * * * /opt/jsc/straw-engine/venv/bin/python3 /video/llm_infer/media_sync_v5.py --once >> /video/llm_infer/media_sync.log 2>&1
"""
import os, sys, json, time, hashlib, hmac, datetime, urllib.request, urllib.parse
import xml.etree.ElementTree as ET
from PIL import Image

# ---- S3 凭据（同 minio_get.py） ----
ENDPOINT = os.environ.get("MINIO_ENDPOINT", "http://127.0.0.1:9000")
ACCESS   = os.environ.get("MINIO_ACCESS", "Xka@123.")
SECRET   = os.environ.get("MINIO_SECRET", "Xka@123.")
BUCKET   = "test"
PREFIX   = "tenantResource/special/1435364026368000/dock_media/"
OUT_ROOT = "/video/llm_infer/v5_photos"
STATE    = "/video/llm_infer/media_sync_state.json"
TMP      = "/video/llm_infer/.media_tmp"
WIDTH    = 1920
POLL     = 60  # 秒；--once 模式忽略


def sign(key, msg):
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def sigv4_headers(method, host, path, query, payload_hash, amz_date, now_dt):
    canonical_headers = "host:" + host + "\n" + "x-amz-date:" + amz_date + "\n"
    signed_headers = "host;x-amz-date"
    canonical_request = "\n".join([method, path, query, canonical_headers, signed_headers, payload_hash])
    scope = now_dt + "/us-east-1/s3/aws4_request"
    string_to_sign = "AWS4-HMAC-SHA256\n" + amz_date + "\n" + scope + "\n" + hashlib.sha256(canonical_request.encode()).hexdigest()
    k = sign(("AWS4" + SECRET).encode(), now_dt)
    k = sign(k, "us-east-1"); k = sign(k, "s3"); k = sign(k, "aws4_request")
    sig = hmac.new(k, string_to_sign.encode(), hashlib.sha256).hexdigest()
    return ("AWS4-HMAC-SHA256 Credential=" + ACCESS + "/" + scope +
            ", SignedHeaders=" + signed_headers + ", Signature=" + sig)


def s3_request(method, path, query=""):
    now = datetime.datetime.utcnow()
    now_dt = now.strftime("%Y%m%d")
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    host = urllib.parse.urlparse(ENDPOINT).netloc
    payload_hash = hashlib.sha256(b"").hexdigest()
    auth = sigv4_headers(method, host, path, query, payload_hash, amz_date, now_dt)
    url = ENDPOINT + path + ("?" + query if query else "")
    req = urllib.request.Request(url, method=method, headers={
        "Authorization": auth, "x-amz-date": amz_date, "Host": host,
    })
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def list_objects(bucket, prefix):
    """ListObjectsV2 全量返回 (key, size) 列表（分页拉全）"""
    out = []
    token = None
    while True:
        params = {"list-type": "2", "prefix": prefix, "max-keys": "1000"}
        if token:
            params["continuation-token"] = token
        # SigV4 S3 规则：canonical query 中 "/" 必须编码 %2F（与 path 不同）
        qs = urllib.parse.urlencode(sorted(params.items()), quote_via=urllib.parse.quote, safe="-_.~")
        xml = s3_request("GET", "/" + bucket, qs)
        root = ET.fromstring(xml)
        # 去 namespace 取 localname
        def local(tag):
            return tag.split("}")[-1]
        for c in root:
            if local(c.tag) == "Contents":
                key = size = None
                for ch in c:
                    if local(ch.tag) == "Key": key = ch.text
                    if local(ch.tag) == "Size": size = int(ch.text)
                if key:
                    out.append((key, size))
            elif local(c.tag) == "IsTruncated" and c.text == "true":
                pass
            elif local(c.tag) == "NextContinuationToken":
                token = c.text
        if not any(local(c.tag) == "IsTruncated" and c.text == "true" for c in root):
            break
        if not token:
            break
    return out


def download(bucket, key, local_path):
    url_p = urllib.parse.quote(key, safe="/")
    data = s3_request("GET", "/" + bucket + "/" + url_p)
    with open(local_path, "wb") as f:
        f.write(data)
    return len(data)


def load_state():
    if os.path.exists(STATE):
        try:
            return json.load(open(STATE, encoding="utf-8"))
        except Exception:
            pass
    return {"last_key": "", "done": [], "count": 0}


def save_state(st):
    json.dump(st, open(STATE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


def is_v_photo(key):
    """dock_media 可见光照片：_V.jpeg / _V.jpg；排除 _T 热成像与视频/NAV"""
    base = os.path.basename(key).lower()
    if not (base.endswith(".jpeg") or base.endswith(".jpg")):
        return False
    return "_v" in base and "_t" not in base


def sync_once():
    os.makedirs(OUT_ROOT, exist_ok=True)
    os.makedirs(TMP, exist_ok=True)
    st = load_state()
    keys = list_objects(BUCKET, PREFIX)
    print(f"[list] {datetime.datetime.now():%F %T} dock_media 对象: {len(keys)}", flush=True)

    new = [(k, s) for k, s in keys if k > st["last_key"] and k not in st["done"]]
    if not new:
        if keys:
            st["last_key"] = keys[-1][0]
            save_state(st)
        print(f"[noop] 无新对象（last_key={st['last_key']}）", flush=True)
        return 0

    n = 0
    for key, size in new:
        if not is_v_photo(key):
            continue
        name = os.path.basename(key)
        day = datetime.datetime.now().strftime("%Y%m%d")
        out_dir = os.path.join(OUT_ROOT, f"task_{day}")
        os.makedirs(out_dir, exist_ok=True)
        dst = os.path.join(out_dir, name)
        if os.path.exists(dst):
            st["done"].append(key)
            continue
        tmp = os.path.join(TMP, name)
        try:
            download(BUCKET, key, tmp)
            im = Image.open(tmp)
            if im.width > WIDTH:
                im = im.resize((WIDTH, int(im.height * WIDTH / im.width)), Image.LANCZOS)
            im.convert("RGB").save(dst, "JPEG", quality=92)
            sz = os.path.getsize(dst)
            print(f"[sync] {name} ({size}B -> {sz}B, {im.width}x{im.height}) -> {dst}", flush=True)
            n += 1
        except Exception as e:
            print(f"[err] {name}: {e}", flush=True)
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)
        st["done"].append(key)
        st["last_key"] = key
        save_state(st)

    print(f"[done] 本轮回流照片: {n}（累计 {st['count'] + n}）", flush=True)
    st["count"] += n
    save_state(st)
    return n


def main():
    if "--once" in sys.argv:
        sync_once()
        return
    print(f"[start] {datetime.datetime.now():%F %T} 轮询 {POLL}s", flush=True)
    while True:
        try:
            sync_once()
        except Exception as e:
            print(f"[err] {e}", flush=True)
        time.sleep(POLL)


if __name__ == "__main__":
    main()
