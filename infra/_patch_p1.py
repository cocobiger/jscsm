# -*- coding: utf-8 -*-
"""P1 场景过滤补丁（straw-engine）：
1. config.json: 8UUXN 系 dock 流 enabled=false（停秸秆推理，流留给 dock-guard）
2. main.py: worker 循环加夜间亮度判断 → 动态提阈（confSmoke+0.15 / confFire 0.45->0.60）
   夜间基准亮度 config.nightBright（默认 25），夜间阈值从流配置或全局兜底读取。
执行方式: python3 /tmp/_patch_p1.py  （服务器端执行，先自动备份）
"""
import json, os, shutil, sys

ENGINE = '/opt/jsc/straw-engine'
CFG = os.path.join(ENGINE, 'config', 'config.json')
MAIN = os.path.join(ENGINE, 'app', 'main.py')

# ---------- 1. config.json：dock 流停推理 ----------
cfg = json.load(open(CFG))
changed = []
for s in cfg.get('streams', []):
    sid = s.get('streamId', '')
    if sid.startswith('sikong_8UUXN'):  # dock 机场流
        if s.get('enabled', True):
            s['enabled'] = False
            changed.append(sid)
json.dump(cfg, open(CFG, 'w'), ensure_ascii=False, indent=2)
print(f'[config] dock 流停推理: {changed}')

# ---------- 2. main.py：夜间提阈 ----------
src = open(MAIN).read()

# 备份
bak = MAIN + '.bak_nightthr'
if not os.path.exists(bak):
    shutil.copy(MAIN, bak)
    print('[main] 备份 ->', bak)

# 2a. 在 worker 读取阈值之后（conf_house 行后）插入夜间阈值读取 + 亮度状态变量
anchor = "    conf_house = float(stream_cfg.get('confHouse', 0.35))"
assert anchor in src, 'anchor conf_house not found'
night_block = anchor + """
    # 夜间策略（P1 场景过滤）：亮度 < nightBright 判夜 → 动态提阈（灯光/反光/夜间干扰误报）
    night_bright = float(stream_cfg.get('nightBright', 25.0))
    conf_smoke_night = float(stream_cfg.get('confSmokeNight', conf_smoke + 0.15))
    conf_fire_night = float(stream_cfg.get('confFireNight', 0.60))
    _is_night = False"""
src = src.replace(anchor, night_block, 1)

# 2b. 在 predict 前插入亮度计算与阈值切换（读帧成功后、det.predict 前）
anchor2 = """            st['stream_ok'] = True
            st['last_frame_ts'] = time.time()
            t_detect = time.time()
            boxes = det.predict(frame)"""
assert anchor2 in src, 'anchor2 predict not found'
night_apply = """            st['stream_ok'] = True
            st['last_frame_ts'] = time.time()
            # 夜间亮度判定（每 5 帧算一次，避免每帧开销；亮度<阈值→夜间提阈）
            if st['detects'] % 5 == 0:
                _is_night = float(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).mean()) < night_bright
            det.conf_smoke = conf_smoke_night if _is_night else conf_smoke
            det.conf_fire = conf_fire_night if _is_night else conf_fire
            t_detect = time.time()
            boxes = det.predict(frame)"""
src = src.replace(anchor2, night_apply, 1)

# 2c. 状态快照里带出夜间标记（方便 /health 观测）
anchor3 = """            st['cfm_hits'] = res[3] if res[3] is not None else 0"""
assert anchor3 in src, 'anchor3 cfm not found'
src = src.replace(anchor3, """            st['is_night'] = _is_night
            st['night_bright'] = round(night_bright, 1)
            st['cfm_hits'] = res[3] if res[3] is not None else 0""", 1)

open(MAIN, 'w').write(src)
print('[main] 夜间提阈已注入: confSmoke %.2f->%.2f / confFire 0.45->%.2f @bright<%.0f' %
      (cfg['streams'][0].get('confSmoke', 0.30) if cfg.get('streams') else 0.30,
       cfg['streams'][0].get('confSmokeNight', 0.45) if cfg.get('streams') else 0.45,
       0.60, cfg.get('nightBright', 25)))
print('P1 patch done.')
