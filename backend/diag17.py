import subprocess, json
# 查 c5087b79-test 的 track 详细
r = subprocess.run(['curl', '-s', 'http://172.17.0.2:80/index/api/getMediaList?secret=035c73f7-bb6b-4889-a715-d9eb2d192xxx'], capture_output=True, text=True, timeout=10)
d = json.loads(r.stdout)
for m in d.get('data', []):
    if 'c5087b79' in m.get('stream', ''):
        print(json.dumps(m, ensure_ascii=False, indent=2))
