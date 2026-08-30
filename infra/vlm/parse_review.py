import json, collections
d = json.load(open(r"E:\AI xm\CC jsc\data zu\v5_review_result.json"))
fs = d["frames"]
print("总帧数:", len(fs))
cnt = collections.Counter(f["judge"] for f in fs)
print("三态分布:", dict(cnt))
smoke = [f for f in fs if f["judge"] == "smoke"]
no = [f for f in fs if f["judge"] == "no"]
print(f"\n确认真烟 {len(smoke)} 帧:")
for f in smoke:
    print(f"  {f['idx']:>2} {f['dir']}/{f['file']}  fire={f['fire']}  note={f['note']}")
print(f"\n否掉 {len(no)} 帧:")
for f in no:
    print(f"  {f['idx']:>2} {f['dir']}/{f['file']}  fire={f['fire']}  note={f['note']}")
print("\nVLM 41 帧全判有烟 -> 用户确认 27 (65.9%) / 否掉 14 (34.1%)")
print("\n带注释帧:", [(f['dir'], f['file'], f['judge'], f['note']) for f in fs if f['note']])
for idx in (4, 34, 33):
    f = fs[idx-1]
    print(f"P0 帧 idx{idx}: {f['dir']}/{f['file']} fire={f['fire']} judge={f['judge']}")
