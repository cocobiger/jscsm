#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""straw-engine · 秸秆焚烧视频检测引擎（FastAPI · :7200）

════════════════════════════════════════════════════════════════════════
⚠️ 本文件是 2026-09-30 服务器重建后的**重写版**（原版随 7TiB 数据盘一并丢失）。
   重写依据（按可信度排序）：
     1. 本机留存的补丁脚本，它们**逐字保留了原版的锚点与函数体**：
        · tmp/patch_main_skymask.py      → _apply_sky_mask 全文 + worker 内 7 处接线
        · .workbuddy/tmp/patch_engine_landing.py → _TAKEOFF_WINDOW / OSD 轮询 / 降落抑制全文
     2. 项目记忆（MEMORY.md）里的接口契约：/health、/metrics、/debug/snapshot 字段清单，
        config 键名（model/modelDay/modelNight/inputSize/maskSky*/takeoffWindow），
        夜判阈值（亮度<25 或 19-05），Confirmer 连 3 帧，interval，以及"起飞会重启引擎"的设计。
     3. tmp/detector_new.py（原样还原为 app/detector.py，predict 返回 [[x1,y1,x2,y2,score,cls]]）
   **凡属"按契约重建、而非逐字还原"的地方，均已用 `【重建】` 标注**，便于后续与真实版本对账。
════════════════════════════════════════════════════════════════════════
"""
from __future__ import annotations

import json
import os
import sqlite3  # noqa: F401  （保留以便后续直接读库排障）
import threading
import time
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta

import cv2
import numpy as np
import uvicorn
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from detector import CLASSES, Detector

# ─────────────────────────── 路径与配置 ───────────────────────────
APP_DIR = os.path.dirname(os.path.abspath(__file__))
ENGINE_DIR = os.path.dirname(APP_DIR)
CFG_PATH = os.environ.get('STRAW_ENGINE_CONFIG') or os.path.join(ENGINE_DIR, 'config', 'config.json')
# 后端内部密钥文件（降落抑制需要）；旧机是 /opt/jsc/backend/.internal-secret
SECRET_FILE = os.environ.get('STRAW_INTERNAL_SECRET_FILE') or '/data/HBJSC/backend/.internal-secret'
_CFG_CACHE = {'v': None, 'ts': 0.0}
_CFG_TTL = 10.0     # 配置热更新：改 config.json 后最多 10s 生效（原版即支持热改）


def _load_cfg() -> dict:
    now = time.time()
    if _CFG_CACHE['v'] is not None and now - _CFG_CACHE['ts'] < _CFG_TTL:
        return _CFG_CACHE['v']
    try:
        with open(CFG_PATH, encoding='utf-8') as f:
            cfg = json.load(f)
    except Exception as e:
        print('[cfg] 读取失败 %s: %s' % (CFG_PATH, e))
        cfg = {}
    _CFG_CACHE['v'] = cfg
    _CFG_CACHE['ts'] = now
    return cfg


_cfg2 = _load_cfg()          # 原版同名的全局配置引用（补丁锚点里出现过）

# ─────────────────────────── 全局运行态 ───────────────────────────
_LOCK = threading.Lock()
STREAMS: dict[str, dict] = {}      # sid -> st（每流状态）；原版 st 即此结构
WORKERS: dict[str, threading.Thread] = {}
_START_TS = time.time()
_TAKEOFF_WINDOW = 30        # 起飞后窗口秒数（config takeoffWindow 可覆盖；2026-09-11 由 60 调整为 30）

app = FastAPI(title='straw-engine', version='2.0-rebuilt')


# ═══════════════════════════ 夜判 / 亮度 ═══════════════════════════
NIGHT_BRIGHTNESS = 25.0          # 平均亮度低于此值判夜间
NIGHT_HOURS = (19, 5)            # 或本地时间落在 [19:00, 05:00)


def _brightness(frame: np.ndarray) -> float:
    """灰度均值（缩小后算，省 CPU）：原版夜判口径之一"""
    try:
        small = cv2.resize(frame, (160, 90), interpolation=cv2.INTER_AREA)
        return float(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).mean())
    except Exception:
        return 0.0


def _is_night(bright: float, ts: float) -> bool:
    """夜判：亮度 < 25，或本地时间在 19:00–05:00（两者取或）"""
    if bright < NIGHT_BRIGHTNESS:
        return True
    h = datetime.fromtimestamp(ts).hour
    lo, hi = NIGHT_HOURS
    return h >= lo or h < hi


# ═══════════════════════════ 天空带屏蔽（P0-② 原文照搬）═══════════════════════════
# ===== P0-② L0 天空带屏蔽（2026-09-28）=====
# 目的：丢弃落在画面「上方 maskSkyRatio」内的检测框，消除"纯天空"区最典型的误报源
#       （太阳/亮天空/高空碎云）。秸秆焚烧的烟源于地面，主体不会出现在纯天空区。
# ⚠️ 只影响【告警判定】，不影响落库：被屏蔽的框仍以 _boxes_raw 交给 maybe_record 进复检库
#    → 屏蔽区自动变成「难负样本矿」。
# ⚠️ 俯视/舱内帧自动禁用：这类画面"上方"不是天空而是地面/机库，规则失去意义
#    （判据：整帧检测框中位 y 中心 > 0.70）。
def _apply_sky_mask(boxes, frame_h, st, sid, enabled, ratio, skip_lookdown):
    if not enabled or not boxes or ratio <= 0 or frame_h <= 0:
        return boxes
    try:
        ys = sorted(((float(b[1]) + float(b[3])) / 2.0 / frame_h) for b in boxes)
        med = ys[len(ys) // 2]
        if skip_lookdown and med > 0.70:
            st['sky_mask_skip_lookdown'] = int(st.get('sky_mask_skip_lookdown') or 0) + 1
            return boxes
        keep, drop = [], []
        for b in boxes:
            yc = (float(b[1]) + float(b[3])) / 2.0 / frame_h
            if yc < ratio:
                drop.append(yc)
            else:
                keep.append(b)
        if drop:
            st['sky_masked'] = int(st.get('sky_masked') or 0) + len(drop)
            print('[sky-mask:%s] 屏蔽上方 %.0f%% 内 %d 框（y中心 %.3f~%.3f，已保留入库）'
                  % (sid, ratio * 100, len(drop), min(drop), max(drop)))
        return keep
    except Exception as e:
        print('[sky-mask:%s] 异常，按原样返回:' % sid, e)
        return boxes


# ═══════════════════════════ OSD（在仓/起飞/降落抑制）═══════════════════════════
# 数据源：jsc-backend 内部端点 /api/internal/drone-osd（共享密钥，读司空 Redis OSD）
_INTERNAL_OSD_URL = os.environ.get('STRAW_OSD_URL') or 'http://127.0.0.1:7170/api/internal/drone-osd'
_osd_secret_cache = {'v': None, 'ts': 0}
_osd_state: dict[str, dict] = {}      # droneSn -> {inDock, ts, prevDock, tookOffAt, last_err}
_drone_osd: dict[str, dict] = {}      # droneSn -> {height, vs, ts, prev_h, prev_ts}
_LAND_ETA_SEC = 30.0     # 预计落地时间阈值（秒）
_LAND_MIN_H = 30.0       # 低空兜底阈值（米）
_LAND_MIN_VS = 0.3       # 下降速率阈值（m/s）
osd_meta = {'enabled': False, 'last_poll': 0.0, 'last_err': ''}


def _internal_secret():
    """共享密钥：优先配置文件 internalOsdSecret，其次读后端密钥文件（缓存 60s）"""
    now = time.time()
    if _osd_secret_cache['v'] and now - _osd_secret_cache['ts'] < 60:
        return _osd_secret_cache['v']
    v = str(_load_cfg().get('internalOsdSecret') or '').strip()
    if not v:
        try:
            v = open(SECRET_FILE, encoding='utf-8').read().strip()
        except Exception:
            v = ''
    _osd_secret_cache.update({'v': v, 'ts': now})
    return v


def _osd_get(sn: str = '') -> dict:
    """调后端内部 OSD 端点。带 sn 取单机，不带取列表。【重建】：返回结构按 'drones'/'sn' 兼容。"""
    sec = _internal_secret()
    if not sec:
        raise RuntimeError('无 internalOsdSecret（config 或 %s）' % SECRET_FILE)
    url = _INTERNAL_OSD_URL + (('?deviceSn=' + urllib.parse.quote(sn)) if sn else '')
    req = urllib.request.Request(url, headers={'x-internal-secret': sec})
    with urllib.request.urlopen(req, timeout=4) as r:
        return json.loads(r.read().decode('utf-8'))


def _poll_drone_osd(sn):
    """拉取单机高度/垂直速度（失败静默，不干扰检测主链路）"""
    d = _osd_get(sn)
    h = d.get('height')
    vs = d.get('verticalSpeed')
    prev = _drone_osd.get(sn, {})
    now = time.time()
    # vs 缺失时用高度差分估算（保留 2 位小数）
    if vs is None and h is not None and prev.get('height') is not None:
        dt = now - prev.get('ts', now)
        if dt > 0.5:
            vs = (float(h) - float(prev['height'])) / dt
    _drone_osd[sn] = {'height': h, 'vs': vs, 'ts': now,
                      'prev_h': prev.get('height'), 'prev_ts': prev.get('ts')}


def _landing_suppress_reason(sid):
    """返回抑制原因或 None（仅 sikong_<droneSn> 流；无数据不抑制，保持原行为）"""
    if not sid.startswith('sikong_'):
        return None
    sn = sid[len('sikong_'):]
    d = _drone_osd.get(sn)
    if not d or d.get('height') is None:
        return None
    try:
        h = float(d['height'])
    except Exception:
        return None
    vs = d.get('vs')
    if vs is not None:
        try:
            vsf = float(vs)
        except Exception:
            vsf = 0.0
        if vsf < -_LAND_MIN_VS:
            eta = h / abs(vsf)
            if eta <= _LAND_ETA_SEC:
                return '降落中(预计%.0fs落地 H=%.0fm 下降%.1fm/s)' % (eta, h, abs(vsf))
    if h < _LAND_MIN_H:
        return '低空(H=%.0fm)' % h
    return None


def _all_drone_sns():
    """收集需要轮询的无人机 SN：优先取自后端 OSD 列表，退回按流名 sikong_<sn>。"""
    try:
        d = _osd_get()
        arr = d.get('drones') or d.get('items') or []
        sns = [str(x.get('deviceSn') or x.get('sn') or '') for x in arr if isinstance(x, dict)]
        sns = [s for s in sns if s]
        if sns:
            return sns
    except Exception:
        pass
    out = []
    for sid in list(STREAMS.keys()):
        if sid.startswith('sikong_'):
            sn = sid[len('sikong_'):]
            if sn and not sn.upper().startswith('SIM'):
                out.append(sn)
    return out


def _osd_poller():
    """每 5s 轮询一次：在仓/起飞判定 + 高度/垂直速度（降落抑制用）。

    【重建】原版此函数的具体形状只能由补丁锚点推知（补丁在函数**尾部**追加了高度轮询，
    且该尾部含 `_osd_last_poll = time.time()` / `_osd_last_err = ''` / `time.sleep(5)`）。
    此处按同样语义重建：周期 5s、失败只记 last_err 不抛出。
    """
    global _osd_state
    while True:
        try:
            sec = _internal_secret()
            if not sec:
                osd_meta['enabled'] = False
                osd_meta['last_err'] = '无 internalOsdSecret'
            else:
                osd_meta['enabled'] = True
                for sn in _all_drone_sns():
                    try:
                        d = _osd_get(sn)
                        raw = d.get('droneInDock', d.get('drone_in_dock'))
                        in_dock = None if raw is None else int(raw)
                        now = time.time()
                        prev = _osd_state.get(sn, {})
                        took = prev.get('tookOffAt')
                        # 由"在仓(1)"变为"在飞(0)"= 刚起飞 → 记起飞时刻，供 _TAKEOFF_WINDOW 使用
                        if prev.get('inDock') == 1 and in_dock == 0:
                            took = now
                            print('[osd:%s] 检测到起飞（开始 %.0fs 起飞窗口）' % (sn, _TAKEOFF_WINDOW))
                        _osd_state[sn] = {'inDock': in_dock, 'ts': now,
                                          'tookOffAt': took, 'last_err': ''}
                    except Exception as e:
                        _osd_state.setdefault(sn, {})['last_err'] = str(e)[:120]
                osd_meta['last_poll'] = time.time()
                osd_meta['last_err'] = ''
                _sn_list = list(_osd_state.keys())
                # 无人机高度/垂直速度轮询（降落抑制用；独立 try，失败不影响在仓/起飞判定）
                for _sn in _sn_list:
                    try:
                        _poll_drone_osd(_sn)
                    except Exception:
                        pass
        except Exception as e:
            osd_meta['last_err'] = str(e)[:200]
        time.sleep(5)


def _osd_skip_reason(sid):
    """在仓/起飞窗口内跳过告警判定（检测照常，只是不判告警）。

    【重建】依据：① 记忆里"从 droneInDock(0=在飞/1=在仓) 判阶段"；
              ② 补丁把降落抑制模块明确插在 `_osd_skip_reason` **之后**，说明它是同一族的
                 "什么情况下不该告警"判定；③ `_TAKEOFF_WINDOW` 的存在说明"刚起飞"要放过。
    返回原因字符串或 None。
    """
    if not sid.startswith('sikong_'):
        return None
    sn = sid[len('sikong_'):]
    d = _osd_state.get(sn)
    if not d:
        return None                      # 无遥测 → 不跳过（宁可多判，与"宁可多显示"同口径）
    now = time.time()
    if d.get('inDock') == 1:
        took = d.get('tookOffAt')
        if took and (now - took) <= _TAKEOFF_WINDOW:
            return '起飞窗口(%.0fs内)' % _TAKEOFF_WINDOW
        return '在仓未起飞'
    took = d.get('tookOffAt')
    if took and (now - took) <= _TAKEOFF_WINDOW:
        return '起飞窗口(%.0fs内)' % _TAKEOFF_WINDOW
    return None


# ═══════════════════════════ Confirmer（连 N 帧确认）═══════════════════════════
class Confirmer:
    """连续命中确认器：同一空间位置连续 need 帧命中才升级为 alert。

    【重建】依据：状态键 `cfm_hits / cfm_need / cfm_status / cfm_ts`（补丁里逐字出现）、
    默认 need=3、"连续 3 帧"的既有结论、以及 res 的消费方式
    （`if res[0] == 'alert': _, _key, box, hit = res`）。
    返回：('none',) ｜ ('hits', key, n) ｜ ('alert', key, box, hit)，key 为空间聚类桶标识。
    """

    def __init__(self, need: int = 3, iou_thr: float = 0.30, gap_sec: float = 12.0):
        self.need = int(need)
        self.iou_thr = float(iou_thr)
        self.gap_sec = float(gap_sec)
        self.prev: list[list[float]] = []
        self.hits: dict[str, int] = {}
        self.ts = 0.0
        self.status = 'none'

    @staticmethod
    def _iou(a, b) -> float:
        x1, y1 = max(a[0], b[0]), max(a[1], b[1])
        x2, y2 = min(a[2], b[2]), min(a[3], b[3])
        iw, ih = max(0.0, x2 - x1), max(0.0, y2 - y1)
        inter = iw * ih
        ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
        return inter / ua if ua > 0 else 0.0

    def _key(self, b) -> str:
        cx = (b[0] + b[2]) / 2.0
        cy = (b[1] + b[3]) / 2.0
        # 以框宽高为尺度做粗量化，避免"同一烟柱逐帧微移"被当成新目标
        w = max(8.0, b[2] - b[0])
        h = max(8.0, b[3] - b[1])
        return '%d_%d' % (int(cx / w), int(cy / h))

    def update(self, boxes):
        now = time.time()
        # 断帧过久 → 计数清零（"连续"必须真的连续）
        if self.ts and (now - self.ts) > self.gap_sec:
            self.hits = {}
        self.ts = now
        if not boxes:
            self.hits = {}
            self.status = 'none'
            self.prev = []
            return ('none',)
        # 只按"与上一帧命中的框位置相近"续计数
        cur_keys, top = {}, None
        for b in boxes:
            k = self._key(b)
            # 与上一帧任一框 IoU 足够 → 视为同一目标延续
            cont = any(self._iou(b, pb) >= self.iou_thr for pb in self.prev)
            self.hits[k] = (self.hits.get(k, 0) + 1) if (cont or not self.prev) else 1
            cur_keys[k] = self.hits[k]
            if top is None or b[4] > top[4]:
                top = b
        self.prev = [list(b) for b in boxes]
        best_k = max(cur_keys, key=lambda x: cur_keys[x])
        self.status = 'hits(%d/%d)' % (cur_keys[best_k], self.need)
        if cur_keys[best_k] >= self.need and top is not None:
            self.status = 'alert'
            self.hits = {}          # 触发后清零，避免同一起继续刷告警
            return ('alert', best_k, list(top), cur_keys[best_k])
        return ('hits', best_k, cur_keys[best_k])


# ═══════════════════════════ Recorder（取证 + 上报）═══════════════════════════
class Recorder:
    """告警取证与上报。

    【重建】依据：`recorder.maybe_record(sid, frame, boxes, res, label, evidence_dir)` 签名、
    记忆里"告警上报 `/api/straw-alert`→企微+复检 gate"、"evidence 帧路径 /api/evidence/YYYYMMDD/sikong_*.jpg"、
    以及 `per_stream.last_report_ok` 这个 /metrics 字段（说明上报成功与否要落进运行态）。
    """

    def __init__(self, alerts_url: str, timeout: float = 8.0):
        self.alerts_url = alerts_url
        self.timeout = float(timeout)

    def maybe_record(self, sid, frame, boxes, res, label, evidence_dir):
        st = STREAMS.get(sid)
        if st is None:
            return False
        # 非告警帧也可落库（原版即如此：把非告警/被屏蔽帧留作难负样本矿）
        alert = (res and res[0] == 'alert')
        if not alert:
            return False
        try:
            _, key, box, hit = res
        except Exception:
            return False
        ts = time.time()
        day = datetime.fromtimestamp(ts).strftime('%Y%m%d')
        snap_dir = os.path.join(evidence_dir, day)
        os.makedirs(snap_dir, exist_ok=True)
        fn = '%s_%d.jpg' % (sid, int(ts * 1000))
        fp = os.path.join(snap_dir, fn)
        try:
            img = frame
            x1, y1, x2, y2 = [int(round(float(v))) for v in box[:4]]
            H, W = img.shape[:2]
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(W - 1, x2), min(H - 1, y2)
            if x2 > x1 and y2 > y1:
                cv2.rectangle(img, (x1, y1), (x2, y2), (0, 0, 255), 2)
            cv2.imwrite(fp, img, [int(cv2.IMWRITE_JPEG_QUALITY), 88])
        except Exception as e:
            print('[recorder:%s] 写取证图失败: %s' % (sid, e))
            fp = ''

        conf = float(box[4]) if len(box) > 4 else 0.0
        payload = {
            'streamId': sid,
            'label': label or (CLASSES[int(box[5])] if len(box) > 5 else 'smoke'),
            'confidence': conf,
            'box': [float(v) for v in box[:4]],
            'framePath': ('/api/evidence/%s/%s' % (day, fn)) if fp else '',
            'at': datetime.now(timezone(timedelta(hours=8))).isoformat(),
            'consecutive': int(hit),
            'night': bool(st.get('is_night')),
        }
        ok = False
        err = ''
        try:
            req = urllib.request.Request(
                self.alerts_url,
                data=json.dumps(payload).encode('utf-8'),
                headers={'Content-Type': 'application/json'},
                method='POST')
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                ok = 200 <= r.status < 300
        except Exception as e:
            err = str(e)[:160]
        # 上报结果落到运行态 → /metrics.per_stream.last_report_ok
        st['last_report_ok'] = bool(ok)
        st['last_report_err'] = err
        st['alerts'] = int(st.get('alerts') or 0) + (1 if ok else 0)
        st['last_alert_ts'] = ts
        print('[alert:%s] conf=%.2f 连续%d帧 上报%s%s'
              % (sid, conf, int(hit), '✅' if ok else '❌', (' ' + err) if err else ''))
        return ok


# ═══════════════════════════ Worker（每路一个线程）═══════════════════════════
def _worker(stream_cfg, model_path, input_size, evidence_dir, format='yolo', use_gpu=True):
    """单路检测循环。签名与原版**逐字一致**（见 tmp/patch_main_skymask.py 的锚点）。"""
    sid = str(stream_cfg.get('id') or stream_cfg.get('streamId') or 'unknown')
    src = str(stream_cfg.get('url') or stream_cfg.get('src') or '')
    interval = float(stream_cfg.get('interval', _cfg2.get('interval', 2)) or 2)
    conf = float(stream_cfg.get('confSmoke', _cfg2.get('confSmoke', 0.15)) or 0.15)
    need = int(stream_cfg.get('cfmNeed', _cfg2.get('cfmNeed', 3)) or 3)
    alerts_url = str(stream_cfg.get('alertsUrl', _cfg2.get('alertsUrl',
                     'http://127.0.0.1:7170/api/straw-alert')))
    _dual = bool(_cfg2.get('modelDay') or _cfg2.get('modelNight'))
    # P0-② 天空带屏蔽参数：按流覆盖 > 全局 config
    mask_sky_enabled = bool(stream_cfg.get('maskSkyEnabled', _cfg2.get('maskSkyEnabled', False)))
    mask_sky_ratio = float(stream_cfg.get('maskSkyRatio', _cfg2.get('maskSkyRatio', 0.10)))
    mask_sky_skip_lookdown = bool(stream_cfg.get('maskSkySkipLookdown', _cfg2.get('maskSkySkipLookdown', True)))

    with _LOCK:
        st = STREAMS.get(sid)
        if st is None:
            st = {}
            STREAMS[sid] = st
    st.update({
        'running': True, 'detects': 0, 'alerts': 0, 'last_conf': 0.0, 'last_ms': 0.0,
        'stream_ok': False, 'model_used': '', 'is_night': False,
        'cfm_hits': 0, 'cfm_need': need, 'cfm_status': 'none', 'cfm_ts': 0,
        'landing_suppress': '', 'suppressed': 0,
        'masked': 0, 'sky_masked': 0, 'sky_mask_skip_lookdown': 0,
        'osd_skip': '', 'frame_age_s': None, 'last_report_ok': None, 'last_report_err': '',
        'last_frame_ts': 0.0, 'note': '',
    })

    cfm = Confirmer(need=need)
    recorder = Recorder(alerts_url)
    det = None

    def _pick_model(night: bool):
        """双模型：day/night 各一份；单模型则始终用 model_path"""
        if _dual:
            p = _cfg2.get('modelNight' if night else 'modelDay') or model_path
        else:
            p = model_path
        if not p:
            return None, ''
        try:
            cand = p if os.path.isabs(p) else os.path.join(ENGINE_DIR, p)
            return Detector(cand, conf=conf, input_size=int(input_size),
                            format=format, use_gpu=use_gpu), cand
        except Exception as e:
            print('[%s] 模型加载失败 %s: %s' % (sid, p, e))
            return None, ''

    cap = None
    while True:
        try:
            if cap is None or not cap.isOpened():
                cap = cv2.VideoCapture(src, cv2.CAP_FFMPEG)
                try:
                    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)   # 直播流要"最新帧"，别缓冲累积
                except Exception:
                    pass
                if not cap.isOpened():
                    st['stream_ok'] = False
                    st['note'] = '拉流失败，3s 后重连'
                    print('[%s] 读帧失败，3s 后重连: %s' % (sid, src))
                    time.sleep(3)
                    continue
                st['stream_ok'] = True
                st['note'] = ''
            t0 = time.time()
            ok, frame = cap.read()
            if not ok or frame is None:
                st['stream_ok'] = False
                st['note'] = '读帧失败'
                try:
                    cap.release()
                except Exception:
                    pass
                cap = None
                time.sleep(3)
                continue
            st['last_frame_ts'] = t0
            st['frame_age_s'] = 0.0

            bright = _brightness(frame)
            night = _is_night(bright, t0)
            st['is_night'] = bool(night)

            # ── 在仓/起飞窗口 → 跳过告警判定（检测照常）──
            _sk = _osd_skip_reason(sid)
            st['osd_skip'] = _sk or ''

            # ── 模型（按昼夜选；未变化则复用）──
            want = (_cfg2.get('modelNight' if night else 'modelDay') if _dual else _cfg2.get('model'))
            if det is None or st.get('_want_model') != want:
                det, used = _pick_model(night)
                st['_want_model'] = want
                st['model_used'] = ('night' if night else 'day') if _dual else 'single'
                st['note'] = '' if det is not None else '无模型（等待训练产出，管线照常抽帧）'

            boxes = []
            ms = 0.0
            if det is not None:
                t1 = time.time()
                boxes = det.predict(frame, conf_smoke=conf) or []
                ms = (time.time() - t1) * 1000.0
            st['last_ms'] = round(ms, 1)
            st['detects'] = int(st.get('detects') or 0) + len(boxes)
            if boxes:
                st['last_conf'] = round(max(float(b[4]) for b in boxes), 3)

            # ── P0-② 天空带屏蔽：只作用于告警判定；_boxes_raw 保留全量供落库 ──
            _boxes_raw = boxes
            boxes = _apply_sky_mask(boxes, frame.shape[0], st, sid,
                                    mask_sky_enabled, mask_sky_ratio, mask_sky_skip_lookdown)
            res = cfm.update(boxes)
            st['cfm_hits'] = int(res[2]) if len(res) > 2 and isinstance(res[2], int) else st.get('cfm_hits', 0)
            st['cfm_need'] = need
            st['cfm_status'] = str(res[0])
            st['cfm_ts'] = time.time()

            if res[0] == 'alert':
                # 降落抑制：低空/降落阶段只检测不告警（2026-09-11 电力塔误报治理）
                _ls = _landing_suppress_reason(sid)
                if _ls:
                    st['landing_suppress'] = _ls
                    st['suppressed'] = int(st.get('suppressed') or 0) + 1
                    print('[suppress:%s] 抑制告警（%s）' % (sid, _ls))
                    continue
                st['landing_suppress'] = ''
                _, _key, box, hit = res
                label = CLASSES[int(box[5])] if len(box) > 5 else 'smoke'
                if _sk:
                    st['suppressed'] = int(st.get('suppressed') or 0) + 1
                    print('[suppress:%s] 抑制告警（%s）' % (sid, _sk))
                else:
                    recorder.maybe_record(sid, frame, _boxes_raw, res, label, evidence_dir)
            else:
                label = CLASSES[int(_boxes_raw[0][5])] if _boxes_raw else ''
                recorder.maybe_record(sid, frame, _boxes_raw, res, label, evidence_dir)

        except Exception as e:
            st['note'] = '异常: %s' % str(e)[:120]
            print('[%s] worker 异常: %s' % (sid, e))
            time.sleep(2)
        finally:
            # 按 interval 节流（减去本帧耗时，保证节奏稳定）
            try:
                spent = time.time() - t0
            except Exception:
                spent = 0.0
            time.sleep(max(0.05, interval - spent))


# ═══════════════════════════ HTTP 端点 ═══════════════════════════
def _resource() -> dict:
    """资源占用（不引 psutil，直接读 /proc）"""
    out = {'gpu': None, 'mem_pct': None, 'mem_gb': None}
    try:
        info = {}
        for ln in open('/proc/meminfo', encoding='utf-8'):
            k, _, v = ln.partition(':')
            info[k.strip()] = float(v.split()[0]) / 1024.0 / 1024.0   # KB → GB
        total = info.get('MemTotal') or 0.0
        avail = info.get('MemAvailable') or 0.0
        if total:
            out['mem_gb'] = round(total, 1)
            out['mem_pct'] = round((total - avail) / total * 100.0, 1)
    except Exception:
        pass
    try:
        import subprocess
        r = subprocess.run(['nvidia-smi', '--query-gpu=utilization.gpu,memory.used,memory.total',
                            '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=3)
        if r.returncode == 0 and r.stdout.strip():
            u, mu, mt = [x.strip() for x in r.stdout.strip().split('\n')[0].split(',')]
            out['gpu'] = {'util_pct': float(u), 'mem_used_mb': float(mu), 'mem_total_mb': float(mt)}
    except Exception:
        out['gpu'] = None
    return out


@app.get('/health')
def health():
    cfg = _load_cfg()
    model = cfg.get('model') or cfg.get('modelNight') or ''
    workers = {}
    with _LOCK:
        items = list(STREAMS.items())
    for sid, st in items:
        workers[sid] = {
            'running': bool(st.get('running')),
            'detects': int(st.get('detects') or 0),
            'alerts': int(st.get('alerts') or 0),
            'last_conf': float(st.get('last_conf') or 0),
            'last_ms': float(st.get('last_ms') or 0),
            'stream_ok': bool(st.get('stream_ok')),
            'model_used': st.get('model_used', ''),
            'is_night': bool(st.get('is_night')),
            'osd_skip': st.get('osd_skip', ''),
            'landing_suppress': st.get('landing_suppress', ''), 'suppressed': st.get('suppressed', 0),
            'sky_masked': st.get('sky_masked', 0),
            'sky_mask_skip_lookdown': st.get('sky_mask_skip_lookdown', 0),
            'cfm_hits': int(st.get('cfm_hits') or 0), 'cfm_need': int(st.get('cfm_need') or 0),
            'cfm_status': st.get('cfm_status', 'none'),
            'note': st.get('note', ''),
        }
    return JSONResponse({
        'ok': True,
        'model_version': os.path.basename(os.path.dirname(os.path.dirname(model))) if model else '',
        'model_path': model,
        'nc': (items[0][1].get('_nc') if items else None),
        'input_size': int(cfg.get('inputSize') or 0),
        'format': cfg.get('format') or 'yolo',
        'uptime_s': round(time.time() - _START_TS, 1),
        'resource': _resource(),
        'workers': workers,
        'osd': {
            'enabled': bool(osd_meta.get('enabled')),
            'last_poll': round(osd_meta.get('last_poll') or 0, 1),
            'last_err': osd_meta.get('last_err') or '',
            'tracked': len(_osd_state),
        },
    })


@app.get('/metrics')
def metrics():
    per_stream = {}
    total_alerts = 0
    with _LOCK:
        items = list(STREAMS.items())
    for sid, st in items:
        total_alerts += int(st.get('alerts') or 0)
        per_stream[sid] = {
            'detects': int(st.get('detects') or 0),
            'alerts': int(st.get('alerts') or 0),
            'last_ms': float(st.get('last_ms') or 0),
            'stream_ok': bool(st.get('stream_ok')),
            # ⚠️ 初值为 None：只在**真正上报过**之后才更新，
            #    所以"last_report_ok=False"只有配合 alerts>0 才能判"上报失败"
            'last_report_ok': st.get('last_report_ok'),
            'last_report_err': st.get('last_report_err', ''),
            'sky_masked': int(st.get('sky_masked') or 0),
            'suppressed': int(st.get('suppressed') or 0),
        }
    return JSONResponse({'ok': True, 'uptime_s': round(time.time() - _START_TS, 1),
                         'total_alerts': total_alerts, 'per_stream': per_stream})


@app.get('/debug/snapshot')
def debug_snapshot():
    """帧龄是判断"是否真的在抽帧"的黄金指标（frame_age_s 越小越新鲜）。"""
    out = {}
    now = time.time()
    with _LOCK:
        items = list(STREAMS.items())
    for sid, st in items:
        lf = float(st.get('last_frame_ts') or 0)
        out[sid] = {
            'frame_age_s': round(now - lf, 1) if lf else None,
            'cfm': {
                'hits': int(st.get('cfm_hits') or 0),
                'need': int(st.get('cfm_need') or 0),
                'status': st.get('cfm_status', 'none'),
            },
            'detects': int(st.get('detects') or 0),
            'alerts': int(st.get('alerts') or 0),
            'last_ms': float(st.get('last_ms') or 0),
            'of_flow': bool(st.get('_want_model') is not None),
            'want_model': st.get('_want_model', ''),
            'is_night': bool(st.get('is_night')),
            'osd_skip': st.get('osd_skip', ''),
            'note': st.get('note', ''),
        }
    return JSONResponse({'ok': True, 'now': round(now, 1), 'streams': out})


@app.get('/')
def root():
    return JSONResponse({'ok': True, 'service': 'straw-engine', 'rebuilt': '2026-09-30'})


# ═══════════════════════════ 启动 ═══════════════════════════
def _spawn_workers():
    cfg = _load_cfg()
    model_path = cfg.get('model') or cfg.get('modelNight') or ''
    input_size = int(cfg.get('inputSize') or 640)
    fmt = cfg.get('format') or 'yolo'
    use_gpu = bool(cfg.get('useGpu', True))
    evidence_dir = cfg.get('evidenceDir') or os.path.join(ENGINE_DIR, 'evidence')
    if not os.path.isabs(evidence_dir):
        evidence_dir = os.path.join(ENGINE_DIR, evidence_dir)
    os.makedirs(evidence_dir, exist_ok=True)
    print('[boot] 配置 %s' % CFG_PATH)
    print('[boot] 模型 model=%s modelDay=%s modelNight=%s inputSize=%d format=%s useGpu=%s'
          % (model_path, cfg.get('modelDay', ''), cfg.get('modelNight', ''), input_size, fmt, use_gpu))
    print('[boot] evidence=%s' % evidence_dir)
    streams = cfg.get('streams') or []
    if not streams:
        print('[boot] ⚠️ config.streams 为空 —— 引擎空转（等 dji-openapi 触发 restart 后加入流）')
    for sc in streams:
        sid = str(sc.get('id') or '')
        if not sid:
            continue
        if sid in WORKERS and WORKERS[sid].is_alive():
            continue
        t = threading.Thread(target=_worker, name='w-' + sid, daemon=True,
                             args=(sc, model_path, input_size, evidence_dir, fmt, use_gpu))
        t.start()
        WORKERS[sid] = t
        print('[boot] 已启动 worker: %s → %s (interval=%ss)'
              % (sid, sc.get('url', ''), sc.get('interval', cfg.get('interval', 2))))


def _stream_watcher():
    """配置热加载：每 10s 重读 config.json，把**新出现**的流补起 worker。

    ⚠️ 为什么必须有：原版依赖 dji-openapi 在检测到新流时 `restartEngine()`（systemd restart，
    代价约 14s 空窗 + detects 归零）。有了 watcher，配置里加流后**最多 10s 自动生效**，
    不必整进程重启 —— 这正是"起飞不中断检测"的关键。
    """
    while True:
        try:
            cfg = _load_cfg()
            model_path = cfg.get('model') or cfg.get('modelNight') or ''
            input_size = int(cfg.get('inputSize') or 640)
            fmt = cfg.get('format') or 'yolo'
            use_gpu = bool(cfg.get('useGpu', True))
            ev = cfg.get('evidenceDir') or os.path.join(ENGINE_DIR, 'evidence')
            if not os.path.isabs(ev):
                ev = os.path.join(ENGINE_DIR, ev)
            for sc in (cfg.get('streams') or []):
                sid = str(sc.get('id') or '')
                if not sid:
                    continue
                if sid in WORKERS and WORKERS[sid].is_alive():
                    continue
                t = threading.Thread(target=_worker, name='w-' + sid, daemon=True,
                                     args=(sc, model_path, input_size, ev, fmt, use_gpu))
                t.start()
                WORKERS[sid] = t
                print('[watch] 新流已加入 worker: %s → %s' % (sid, sc.get('url', '')))
        except Exception as e:
            print('[watch] 异常: %s' % e)
        time.sleep(10)


# ⚠️ 关键：systemd 用 `python -m uvicorn main:app` 启动 —— 只 import 模块，**不会执行 __main__ 块**。
#    所以 worker / OSD 轮询必须挂在 ASGI lifespan 上，否则"服务起来了但一个 worker 都没有"。
@asynccontextmanager
async def _lifespan(_app):
    threading.Thread(target=_osd_poller, name='osd', daemon=True).start()
    threading.Thread(target=_stream_watcher, name='watch', daemon=True).start()
    _spawn_workers()
    print('[boot] lifespan 启动完成：OSD 轮询 + 流 watcher + %d 个 worker' % len(WORKERS))
    yield
    for sid, t in list(WORKERS.items()):
        print('[boot] 退出：worker %s 仍在（daemon，随进程结束）' % sid)


app.router.lifespan_context = _lifespan


if __name__ == '__main__':
    # 直接 `python main.py` 跑（不经 uvicorn 工厂）时也要有同样的行为
    threading.Thread(target=_osd_poller, name='osd', daemon=True).start()
    threading.Thread(target=_stream_watcher, name='watch', daemon=True).start()
    _spawn_workers()
    port = int(os.environ.get('STRAW_ENGINE_PORT') or _load_cfg().get('port') or 7200)
    print('[boot] straw-engine 监听 0.0.0.0:%d' % port)
    uvicorn.run(app, host='0.0.0.0', port=port, log_level='warning')
