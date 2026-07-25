import subprocess, json
r = subprocess.run(['curl', '-s', 'http://172.17.0.2:80/index/api/getMediaList?secret=035c73f7-bb6b-4889-a715-d9eb2d192xxx'], capture_output=True, text=True, timeout=10)
d = json.loads(r.stdout)
for m in d.get('data', []):
    tracks = m.get('tracks', [])
    codecs = [t.get('codec_id_name', '?') for t in tracks]
    print(f"{m['app']}/{m['stream']:35} codecs={codecs} alive={m.get('aliveSecond')}s bytesSpeed={m.get('bytesSpeed')}")
