import urllib.request, json, base64

# 用新 secret 测 getMediaList
SECRET = "035c73f7-bb6b-4889-a715-d9eb2d192xxx"
ZLM_API = "http://127.0.0.1:80"
# ZLM容器 IP 172.17.0.2
# 但我们走宿主机 nginx 80 -> 容器 80
# 用 base64 解密 secret 后看是否能用
# ZLM HTTP API 默认需要 ?secret=xxx 走 getMediaList 是 GET 即可

def call(path, **params):
    qs = f"secret={SECRET}"
    for k, v in params.items():
        qs += f"&{k}={v}"
    url = f"{ZLM_API}{path}?{qs}"
    print(f"\n=== {path}?{params}")
    try:
        r = urllib.request.urlopen(url, timeout=5)
        body = r.read().decode("utf-8", errors="ignore")
        try:
            j = json.loads(body)
            print(json.dumps(j, ensure_ascii=False, indent=2)[:3000])
        except:
            print(body[:500])
    except Exception as e:
        print("ERR", e)

call("/index/api/getMediaList")
call("/index/api/getServerConfig")
