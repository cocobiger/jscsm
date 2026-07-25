import json, sys
d = json.load(sys.stdin)
print(f"total={len(d['data'])}")
for m in d['data']:
    print(f"  {m['app']:15} {m['stream']:35} {m.get('bytesSpeed',0):>8} B/s  readers={m.get('readers',0)}")
