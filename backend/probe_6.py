import subprocess

streams = [
    ("苏商码头",   "rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=2&subtype=0"),
    ("九龙沙场",   "rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=4&subtype=0"),
    ("龙泗路",     "rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=5&subtype=0"),
    ("彼迪",       "rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=6&subtype=0"),
    ("万源玻璃",   "rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=7&subtype=0"),
    ("华歌",       "rtsp://berfenrir:xxxxxxxx@172.16.8.51:554/cam/realmonitor?channel=1&subtype=1"),
]

for name, url in streams:
    print(f"=== {name} ===")
    try:
        r = subprocess.run(
            ["ffmpeg", "-rtsp_transport", "tcp", "-i", url, "-t", "2", "-f", "null", "-"],
            capture_output=True, text=True, timeout=18
        )
        out = r.stderr
    except subprocess.TimeoutExpired as e:
        out = (e.stderr.decode('utf-8', errors='ignore') if e.stderr else '') + '\n[TIMEOUT]'
    # 关键信息
    for line in out.split('\n'):
        s = line.strip()
        if any(k in s for k in ['Stream #0:0', 'Stream #0:1', 'Video:', 'Input #', 'h264', 'h265', 'hevc', 'Duration', 'Error', '401', 'Unauthorized', 'RTSP', 'Connection']):
            if s:
                print(f"  {s[:170]}")
    print()
