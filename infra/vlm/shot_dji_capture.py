#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
司空2 直播流截图采集器（v5 训练样本扩充：方案① 扩真实烟帧到 100+）

- 轮询 ZLM getMediaList（secret 参数直接可用，127.0.0.1 免登录）
- 排除已知常开流（sl27evw 海康球机），其余目标流（司空 RTMP 直推/拉流）在线时
  每 SNAP_INTERVAL 秒用 ZLM getSnap 抽一帧
- 输出: /video/llm_infer/v5_photos/liveYYYYMMDD/{app}_{stream}_{HHMMSS}.jpg
- 全时段采集（含夜间），文件名含时间戳可区分；日终可把非白昼帧清理掉
- 幂等：文件名含时间戳，重复运行不覆盖

用法:
  nohup /opt/jsc/straw-engine/venv/bin/python3 shot_dji_capture.py \
      >> /video/llm_infer/live_capture.log 2>&1 &
"""
import os, time, json, urllib.request, urllib.parse, datetime

ZLM = "http://127.0.0.1:6080"
SECRET = "035c73f7-bb6b-4889-a715-d9eb2d192abc"
EXCLUDE = {"sl27evw"}          # 海康常开流，非司空目标
OUT_ROOT = "/video/llm_infer/v5_photos"
SNAP_INTERVAL = 6              # 同一流两次抽帧最小间隔（秒）
POLL_INTERVAL = 30             # 轮询流列表周期（秒）


def get_json(url):
    with urllib.request.urlopen(url, timeout=15) as r:
        return json.loads(r.read().decode())


def media_list():
    d = get_json(f"{ZLM}/index/api/getMediaList?secret={SECRET}")
    if d.get("code") != 0:
        raise RuntimeError(f"getMediaList: {d.get('msg')}")
    return d["data"]


def snap(url):
    """ZLM getSnap 抽帧，返回可下载的临时图 URL"""
    q = urllib.parse.urlencode({"url": url, "timeout_sec": 10, "expire_sec": 60})
    d = get_json(f"{ZLM}/index/api/getSnap?secret={SECRET}&{q}")
    if d.get("code") != 0 or "data" not in d:
        return None
    img_url = d["data"].get("url")
    if not img_url:
        return None
    return img_url if img_url.startswith("http") else ZLM + img_url


def download(url, local):
    req = urllib.request.Request(url, headers={"User-Agent": "curl/8"})
    with urllib.request.urlopen(req, timeout=30) as r, open(local, "wb") as f:
        f.write(r.read())


def main():
    os.makedirs(OUT_ROOT, exist_ok=True)
    print(f"[start] {datetime.datetime.now():%F %T} ZLM={ZLM} 截图间隔={SNAP_INTERVAL}s 轮询={POLL_INTERVAL}s", flush=True)
    active = {}  # app_stream -> 上次截图时间
    while True:
        try:
            streams = media_list()
            targets = []
            for s in streams:
                st = s.get("stream", "")
                if st in EXCLUDE:
                    continue
                app = s.get("app", "")
                if not st:
                    continue
                targets.append((app, st))
            if targets:
                print(f"[poll] {datetime.datetime.now():%H:%M:%S} 目标流: {targets}", flush=True)
            now = time.time()
            for app, st in targets:
                key = f"{app}_{st}"
                if now - active.get(key, 0) < SNAP_INTERVAL:
                    continue
                rtsp = f"rtsp://127.0.0.1:5540/{app}/{st}"
                try:
                    img_url = snap(rtsp)
                    if img_url:
                        day = datetime.datetime.now().strftime("%Y%m%d")
                        ts = datetime.datetime.now().strftime("%H%M%S")
                        out_dir = os.path.join(OUT_ROOT, f"live{day}")
                        os.makedirs(out_dir, exist_ok=True)
                        local = os.path.join(out_dir, f"{key}_{ts}.jpg")
                        if not os.path.exists(local):
                            download(img_url, local)
                            print(f"[snap] {key} {ts} {os.path.getsize(local)}B -> {local}", flush=True)
                        active[key] = now
                except Exception as e:
                    print(f"[err] {key}: {e}", flush=True)
        except Exception as e:
            print(f"[err] poll: {e}", flush=True)
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
