import json, sys
d = json.load(sys.stdin)
seen = set()
for m in d['data']:
    k = (m['app'], m['stream'])
    if k not in seen:
        seen.add(k)
        print(f"{m['app']}/{m['stream']}  {m.get('bytesSpeed',0):>8} B/s")
