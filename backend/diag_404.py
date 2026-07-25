import urllib.request, json, sys, ssl

ZLM_API = "http://127.0.0.1:80"
SECRET = "035c9f2f02ca2c3c0e9c1d1ebfc7xxxx"

def call(api, **params):
    qs = f"{api}?secret={SECRET}"
    for k, v in params.items():
        qs += f"&{k}={v}"
    url = f"{ZLM_API}{qs}"
    print(f"\n=== {api} params={params}")
    try:
        r = urllib.request.urlopen(url, timeout=5)
        body = r.read().decode("utf-8", errors="ignore")
        print("HTTP", r.status)
        try:
            j = json.loads(body)
            print(json.dumps(j, ensure_ascii=False, indent=2)[:2500])
        except:
            print(body[:1500])
    except Exception as e:
        print("ERR", e)

# 列所有流
call("/index/api/getMediaList")
