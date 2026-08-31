# -*- coding: utf-8 -*-
"""dock-guard：大疆司空2 机场（dock）摄像头人员入侵检测服务
检测流程（每机场一线程）：
  拉流取帧(FLV) → 亮度判夜(夜间提阈) → YOLOv8s person 检测(imgsz960)
  → ROI 多边形中心点判定 → 尺寸过滤 → 连续 N 帧确认 + 冷却去重
  → POST /api/straw-alert（aiType=机场人员入侵）→ 驾驶舱 10s 内预警
配置：/opt/jsc/dock-guard/config.json
证据图：写共享 /opt/jsc/straw-engine/evidence（后端 /api/evidence 已代理）
"""
import json
import os
import sys
import threading
import time
import datetime
import cv2
import numpy as np
import httpx
from fastapi import FastAPI
from pydantic import BaseModel

DOCK_DIR = os.path.dirname(os.path.abspath(__file__))
CFG_PATH = os.path.join(DOCK_DIR, 'config.json')

app = FastAPI(title='dock-guard', version='0.2.2')

_docks = {}    # streamId -> state
_threads = {}  # streamId -> thread
_caps = {}     # streamId -> VideoCapture（热重载快停用：release 使 read 立即返回）
_reload_lock = threading.Lock()  # 防并发热重载


class ConfigPayload(BaseModel):
    """布防配置 PUT 载荷：{docks:[{streamId,url,name,enabled,conf,nightConf,
       nightBright,roi,frames,cooldown,minHeight,maxHeight,interval,hours}], ...}"""
    docks: list
    apiBase: str | None = None
    evidenceDir: str | None = None
    model: str | None = None
    device: str | None = None


def _load_config():
    try:
        with open(CFG_PATH) as f:
            return json.load(f)
    except Exception as e:
        print('[config] 读取失败:', e)
        return {'apiBase': 'http://127.0.0.1:7170', 'docks': []}


def _validate_cfg(new_cfg):
    """校验配置：docks 数组、必填字段、ROI 归一化坐标"""
    if not isinstance(new_cfg, dict):
        raise ValueError('配置必须是 JSON 对象')
    docks = new_cfg.get('docks')
    if not isinstance(docks, list):
        raise ValueError('docks 必须是数组')
    for i, dc in enumerate(docks):
        if not isinstance(dc, dict):
            raise ValueError(f'docks[{i}] 必须是对象')
        if not dc.get('streamId') or not dc.get('url'):
            raise ValueError(f"docks[{i}] 缺少 streamId/url")
        roi = dc.get('roi') or []
        if roi:
            if not isinstance(roi, list) or len(roi) < 3:
                raise ValueError(f'docks[{i}] ROI 至少 3 个点')
            for p in roi:
                if not (isinstance(p, (list, tuple)) and len(p) == 2):
                    raise ValueError(f'docks[{i}] ROI 点格式错误')
                try:
                    x, y = float(p[0]), float(p[1])
                except Exception:
                    raise ValueError(f'docks[{i}] ROI 点非数值')
                if not (0 <= x <= 1 and 0 <= y <= 1):
                    raise ValueError(f'docks[{i}] ROI 坐标必须为 [0,1] 归一化')
        for k in ('conf', 'nightConf', 'nightBright', 'frames', 'cooldown',
                  'minHeight', 'maxHeight', 'interval'):
            if k in dc:
                try:
                    float(dc[k])
                except Exception:
                    raise ValueError(f'docks[{i}] 字段 {k} 非数值')
    return True


def _reload_config(new_cfg):
    """校验 + 原子写 config.json + 异步热重载（请求立即返回，后台重启线程）"""
    _validate_cfg(new_cfg)
    tmp = CFG_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(new_cfg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, CFG_PATH)
    threading.Thread(target=_restart_workers, daemon=True).start()
    return True


def _restart_workers():
    """停旧线程 → 起新线程（后台执行，避免阻塞配置 API 请求）

    快停：先 release 各流的 VideoCapture（read 立即返回），再 join，
    避免旧 worker 阻塞在拉流导致线程残留（反复 PUT 堆积僵尸线程）。
    """
    with _reload_lock:
        for sid, st in _docks.items():
            st['running'] = False
        for sid, cap in _caps.items():
            try:
                cap.release()
            except Exception:
                pass
        for sid, t in _threads.items():
            if t.is_alive():
                t.join(timeout=6)
        _docks.clear()
        _threads.clear()
        _caps.clear()
        _start()


def _in_hours(hours, now=None):
    """布防时段 '0-24' / '6-22'（跨天用 '22-6'）"""
    if not hours:
        return True
    now = now or datetime.datetime.now().hour
    try:
        a, b = hours.split('-')
        a, b = int(a), int(b)
    except Exception:
        return True
    if a == b:
        return True
    if a < b:
        return a <= now < b
    return now >= a or now < b  # 跨天


def _point_in_roi(x, y, roi, w, h):
    """人框中心点是否落在 ROI 多边形（roi 为归一化坐标 [[x,y],...]）"""
    if not roi:
        return True
    pts = np.array([[p[0] * w, p[1] * h] for p in roi], dtype=np.float32)
    return cv2.pointPolygonTest(pts, (float(x), float(y)), False) >= 0


def _read_frame_timeout(cap, timeout=8.0):
    """带超时的 cap.read()（cv2 的 CAP_PROP_READ_TIMEOUT_MSEC 实测无效）。

    ZLM 对不存在的流 keep-alive 时 isOpened() 仍返回 True、read() 无限阻塞；
    这里用独立线程读帧 + join(timeout) 兜底：
      - 正常返回 (ok, frame)
      - 超时返回 (False, None)，主线程随后 release 唤醒阻塞的 read
    """
    result = {}

    def _do_read():
        try:
            ok, frame = cap.read()
            result['ok'] = ok
            result['frame'] = frame
        except Exception as e:
            result['ok'] = False
            result['err'] = e

    t = threading.Thread(target=_do_read, daemon=True)
    t.start()
    t.join(timeout=timeout)
    if t.is_alive():
        return False, None  # 超时：read 仍阻塞，由调用方 release 唤醒
    return result.get('ok', False), result.get('frame')


def _save_evidence(frame, boxes, stream_id, evidence_dir, label):
    """保存带框证据图，返回相对访问路径 /api/evidence/YYYYMMDD/<file> 或 None"""
    try:
        today = datetime.datetime.now().strftime('%Y%m%d')
        ts = datetime.datetime.now().strftime('%H%M%S')
        d = os.path.join(evidence_dir, today)
        os.makedirs(d, exist_ok=True)
        img = frame.copy()
        for b in boxes:
            x1, y1, x2, y2, score = [int(v) if i < 4 else float(v) for i, v in enumerate(b)]
            cv2.rectangle(img, (x1, y1), (x2, y2), (0, 255, 255), 2)
            cv2.putText(img, f'person {score:.2f}', (x1, max(0, y1 - 6)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
        fname = f'{stream_id}_guard_{ts}.jpg'
        fp = os.path.join(d, fname)
        ok = cv2.imwrite(fp, img, [cv2.IMWRITE_JPEG_QUALITY, 85])
        if ok:
            return f'/api/evidence/{today}/{fname}'
    except Exception as e:
        print(f'[evidence] 保存失败: {e}')
    return None


def _report_alert(cfg, dc, box, pic):
    """上报人员入侵告警到后端 /api/straw-alert（PUBLIC 无需 token）"""
    try:
        with httpx.Client(timeout=8) as c:
            r = c.post(cfg.get('apiBase', 'http://127.0.0.1:7170') + '/api/straw-alert', json={
                'streamId': dc['streamId'],
                'aiType': '机场人员入侵',
                'confidence': round(float(box[4]), 3),
                'bbox': [round(box[0]), round(box[1]), round(box[2]), round(box[3])],
                'sensor': 'visible',
                'firstSeenAt': datetime.datetime.now().astimezone().isoformat(),
                'label': 'person',
                'imageUrl': pic or '',
            })
            return r.status_code == 200
    except Exception as e:
        print(f'[report:{dc["streamId"]}] 上报失败: {e}')
        return False


def _worker(cfg, dc):
    sid = dc['streamId']
    url = dc['url']
    interval = float(dc.get('interval', 1.0))
    conf_day = float(dc.get('conf', 0.35))
    conf_night = float(dc.get('nightConf', 0.45))
    night_bright = float(dc.get('nightBright', 25))
    roi = dc.get('roi') or []
    frames_need = int(dc.get('frames', 3))
    cooldown = float(dc.get('cooldown', 60))
    min_h = float(dc.get('minHeight', 0.02))
    max_h = float(dc.get('maxHeight', 0.60))
    evidence_dir = cfg.get('evidenceDir') or '/opt/jsc/straw-engine/evidence'

    st = _docks[sid]
    from ultralytics import YOLO
    model = YOLO(cfg.get('model') or '/opt/jsc/straw-engine/yolov8s.pt')
    print(f'[worker] 启动 {sid}: {url} conf(day={conf_day}/night={conf_night}) '
          f'roi={roi} frames={frames_need} cooldown={cooldown}s')

    cap = None
    hit = 0
    cooldown_until = 0.0
    while st['running']:
        t0 = time.time()
        try:
            # 布防时段检查（非布防时段不检测，但仍维持连接）
            if not _in_hours(dc.get('hours', '0-24')):
                if cap is not None:
                    cap.release()
                    cap = None
                    _caps.pop(sid, None)
                st['armed'] = False
                time.sleep(interval * 2)
                continue
            st['armed'] = True
            if cap is None or not cap.isOpened():
                cap = cv2.VideoCapture(url)
                if not cap.isOpened():
                    print(f'[stream:{sid}] 打开失败，5s 后重试')
                    st['stream_ok'] = False
                    time.sleep(5)
                    continue
                cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                # 拉流看门狗：FLV 无数据时 read 会无限阻塞，
                # READ_TIMEOUT_MSEC 实测无效 → 手写 _read_frame_timeout 兜底
                cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 8000)
                cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, 8000)
                _caps[sid] = cap
            ok, frame = _read_frame_timeout(cap, timeout=8.0)
            if not ok:
                st['stream_ok'] = False
                print(f'[stream:{sid}] 读帧失败/超时(8s)，3s 后重连')
                try:
                    cap.release()  # 唤醒阻塞中的 read
                except Exception:
                    pass
                cap = None
                _caps.pop(sid, None)
                time.sleep(3)
                continue
            st['stream_ok'] = True
            st['last_frame_ts'] = time.time()

            # 夜间判定 + 动态阈值
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            bright = float(gray.mean())
            is_night = bright < night_bright
            conf = conf_night if is_night else conf_day

            t_det = time.time()
            results = model.predict(frame, conf=conf, imgsz=960, classes=[0],
                                    verbose=False, device=cfg.get('device'))
            st['last_ms'] = int((time.time() - t_det) * 1000)
            st['is_night'] = is_night
            st['bright'] = round(bright, 1)

            h, w = frame.shape[:2]
            inside = []
            if results and results[0].boxes is not None and len(results[0].boxes) > 0:
                for det in results[0].boxes.data.cpu().numpy():
                    x1, y1, x2, y2, score, cls_id = det
                    if int(cls_id) != 0:
                        continue
                    bh = float(y2 - y1)
                    ratio = bh / h
                    if not (min_h <= ratio <= max_h):
                        continue
                    cx = (float(x1) + float(x2)) / 2
                    cy = (float(y1) + float(y2)) / 2
                    if not _point_in_roi(cx, cy, roi, w, h):
                        continue
                    inside.append([float(x1), float(y1), float(x2), float(y2), float(score)])
            st['persons'] = len(inside)
            st['last_boxes'] = [[round(b[0]), round(b[1]), round(b[2]), round(b[3]), round(b[4], 3)]
                                for b in inside[:5]]

            # 连续帧确认 + 冷却
            now = time.time()
            if inside:
                hit += 1
            else:
                hit = 0
            if hit >= frames_need and now >= cooldown_until:
                box = max(inside, key=lambda b: b[4])
                st['hit_confirm'] = True
                pic = _save_evidence(frame, [box], sid, evidence_dir, 'person')
                ok_report = _report_alert(cfg, dc, box, pic)
                st['alerts'] += 1
                st['last_alert_ts'] = now
                st['last_report_ok'] = ok_report
                cooldown_until = now + cooldown
                hit = 0  # 冷却期内重新累积，冷却结束若人仍在会再次告警
                print(f'[alert:{sid}] person conf={box[4]:.2f} bright={bright:.0f} night={is_night} '
                      f'reported={ok_report} pic={pic}')
        except Exception as e:
            print(f'[worker:{sid}] error: {e}')
            time.sleep(2)
        el = time.time() - t0
        if el < interval:
            time.sleep(interval - el)


@app.on_event('startup')
def _start():
    cfg = _load_config()
    for dc in cfg.get('docks', []):
        sid = dc.get('streamId')
        if not sid:
            continue
        _docks[sid] = {
            'running': True, 'armed': False, 'stream_ok': False,
            'detects': 0, 'alerts': 0, 'persons': 0,
            'last_frame_ts': 0, 'last_ms': 0, 'last_alert_ts': 0,
            'is_night': False, 'bright': 0, 'last_report_ok': False,
            'last_boxes': [], 'hit_confirm': False,
        }
        t = threading.Thread(target=_worker, args=(cfg, dc), daemon=True)
        _threads[sid] = t
        t.start()
    print(f'[startup] 启动 {len(_docks)} 路 dock 守护检测')


@app.get('/health')
def health():
    return {
        'ok': True,
        'version': app.version,
        'docks': {
            sid: {
                'armed': st['armed'], 'stream_ok': st['stream_ok'],
                'detects': st['detects'], 'alerts': st['alerts'],
                'persons': st['persons'], 'is_night': st['is_night'],
                'bright': st['bright'], 'last_ms': st['last_ms'],
                'last_frame_ts': st['last_frame_ts'],
                'last_alert_ts': st['last_alert_ts'],
                'last_report_ok': st['last_report_ok'],
                'last_boxes': st['last_boxes'],
                'hit_confirm': st['hit_confirm'],
            } for sid, st in _docks.items()
        },
        'gpu': _gpu_info(),
    }


@app.get('/api/config')
def get_config():
    """布防配置读取（供驾驶舱配置页）"""
    try:
        with open(CFG_PATH, encoding='utf-8') as f:
            return {'ok': True, 'config': json.load(f), 'path': CFG_PATH}
    except Exception as e:
        return {'ok': False, 'error': str(e)}


@app.put('/api/config')
def put_config(payload: ConfigPayload):
    """布防配置保存：校验 + 原子写 + 热重载（不停服务）"""
    try:
        new_cfg = payload.dict(exclude_none=True)
        _reload_config(new_cfg)
        return {'ok': True, 'config': new_cfg, 'reloaded': True}
    except ValueError as e:
        return {'ok': False, 'error': str(e)}
    except Exception as e:
        return {'ok': False, 'error': f'热重载失败: {e}'}


def _gpu_info():
    try:
        import subprocess
        out = subprocess.run(['nvidia-smi', '--query-gpu=memory.used,memory.total',
                              '--format=csv,noheader,nounits'],
                             capture_output=True, text=True, timeout=5).stdout.strip()
        return out or 'n/a'
    except Exception:
        return 'n/a'
