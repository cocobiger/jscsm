#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从司空2 MinIO(S3 API :9000)下载对象，解决 erasure 分片无法线性拼接的问题
用法:
  python3 minio_get.py <bucket> <object_key> <local_path> [endpoint]
示例:
  python3 minio_get.py test tenantResource/special/.../DJI_xxx_V.jpeg /video/llm_infer/photo_merge/x.jpg
"""
import sys, os, hashlib, hmac, datetime, urllib.request, urllib.parse

ENDPOINT = os.environ.get('MINIO_ENDPOINT', 'http://127.0.0.1:9000')
ACCESS   = os.environ.get('MINIO_ACCESS', 'Xka@123.')
SECRET   = os.environ.get('MINIO_SECRET', 'Xka@123.')

def sign(key, msg):
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()

def sigv4_headers(method, host, path, query, payload_hash, amz_date, now_dt):
    # 只签 host/x-amz-date 两个 header
    canonical_headers = 'host:' + host + '\n' + 'x-amz-date:' + amz_date + '\n'
    signed_headers = 'host;x-amz-date'
    canonical_request = '\n'.join([method, path, query, canonical_headers, signed_headers, payload_hash])
    scope = now_dt + '/' + 'us-east-1' + '/' + 's3' + '/' + 'aws4_request'
    string_to_sign = 'AWS4-HMAC-SHA256\n' + amz_date + '\n' + scope + '\n' + hashlib.sha256(canonical_request.encode()).hexdigest()
    k = sign(('AWS4' + SECRET).encode(), now_dt)
    k = sign(k, 'us-east-1'); k = sign(k, 's3'); k = sign(k, 'aws4_request')
    sig = hmac.new(k, string_to_sign.encode(), hashlib.sha256).hexdigest()
    return ('AWS4-HMAC-SHA256 Credential=' + ACCESS + '/' + scope + ', SignedHeaders=' + signed_headers + ', Signature=' + sig)

def download(bucket, key, local_path):
    now = datetime.datetime.utcnow()
    now_dt = now.strftime('%Y%m%d')
    amz_date = now.strftime('%Y%m%dT%H%M%SZ')
    url_p = urllib.parse.quote(key, safe='/')
    host = urllib.parse.urlparse(ENDPOINT).netloc
    path = '/' + bucket + '/' + url_p
    payload_hash = hashlib.sha256(b'').hexdigest()
    auth = sigv4_headers('GET', host, path, '', payload_hash, amz_date, now_dt)
    req = urllib.request.Request(ENDPOINT + path, headers={
        'Authorization': auth,
        'x-amz-date': amz_date,
        'Host': host,
    })
    with urllib.request.urlopen(req, timeout=60) as r, open(local_path, 'wb') as f:
        sz = 0
        while True:
            chunk = r.read(65536)
            if not chunk: break
            f.write(chunk); sz += len(chunk)
    print(f'OK {bucket}/{key} -> {local_path} ({sz} bytes)')

if __name__ == '__main__':
    if len(sys.argv) < 4:
        print(__doc__); sys.exit(1)
    bucket, key, local = sys.argv[1], sys.argv[2], sys.argv[3]
    if len(sys.argv) > 4:
        ENDPOINT = sys.argv[4]
    download(bucket, key, local)
