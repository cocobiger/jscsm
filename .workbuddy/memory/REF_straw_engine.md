# REF · 秸秆 straw-engine 运行时契约与历史改动

> **何时读**：改 straw-engine、排查"引擎为什么不出告警/告警为什么没推"、或对账历史优化时。
> MEMORY.md 只留重建事实 + 必挂 lifespan + 模型路径 + 端点速查；**细节在这里**。
> 安装/重写流程见 `REF_驾驶舱重新部署流程.md` §4 P4 与 §6；迭代结论见 `REF_smoke_far_iteration.md`。

---

## 一、部署与版本

| 项 | 值 |
|---|---|
| 端口 | **7200**（`app/main.py`，FastAPI + uvicorn） |
| 安装根 | `/data/HBJSC/straw-engine/` |
| venv | `/data/HBJSC/straw-engine/venv/`（numpy / opencv-python-headless / onnxruntime / fastapi / uvicorn[standard] / requests） |
| 代码 | `app/main.py`（**2026-09-30 重建版 819 行**）、`app/detector.py`（= 优化版，`tmp/detector_new.py`） |
| 配置 | `config/config.json`（热更新：`_load_cfg()` 10s TTL，改文件后最多 10s 生效） |
| 取证 | `evidence` → 软链 `/data/video/evidence`（按 `<YYYYMMDD>/` 分目录） |
| systemd | `straw-engine.service` → `venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 7200` |
| 源码回落 | `deploy/HBJSC/straw-engine/`（**改完必须同步回这里**） |

**🔴 必挂 ASGI lifespan**：`python -m uvicorn main:app` 只 import 模块，`if __name__ == '__main__'` **不执行**
⇒ worker / OSD 轮询 / 流 watcher 全挂 `app.router.lifespan_context`（症状：服务 active、端口在听、**0 个 worker**）。

**已加流热加载 watcher**（每 10s 重读 config 补起新流）⇒ 新流 **10s 内自动生效**，
不再依赖 dji-openapi 的 `restartEngine()`（原设计：起飞→司空推 mirror→ZLM→zlm-watcher 检测新流→
`strawSync.restartEngine()`（`dji-openapi/index.js:499`）→systemd restart，
**代价约 14s 空窗 + `detects` 归零**；**≠故障**；多机先后起飞后者中断前者 ~14s；起飞窗口 `/health` 无响应属**预期**）。

## 二、模型

- **路径**（训练产出后丢进去即生效，目录已建）：
  - 白天 `/data/video/shujuji/datasets/v5_smoke_v5/stage9_1920/weights/best.onnx`
  - 夜间 `/data/video/shujuji/datasets/v5_smoke_v5/stage3_0909/weights/best_1920.onnx`
- **当前无模型 ⇒ 空管线**（照常抽帧、可上报，但不出框）。
- **重建前基线（9/24 实测）**：`inputSize=1920`、`nc=1 ['smoke']`、`CUDAExecutionProvider`、6 路 worker `interval=2s`。
- ⚠️ `/health.model_version` 只反映 `config.model`（夜间那份）⇒ **判实际用哪个看 `workers[].model_used`**。
- 切换模型 = 改 `config/config.json`（保留 `.bak_*` 可回滚）。
- ⚠️ 手动用 venv python 跑推理**必须带 systemd 的 `LD_LIBRARY_PATH`**（8 个 nvidia/cublas），否则 CUDA **静默回退 CPU**。
- ⚠️ 新机 **onnxruntime 目前只有 CPU provider**（显卡驱动未装，RTX 3090 直通仍在；装驱动需重启，属需单独批准的步骤）。

## 三、端点（**排查走端点，不要解析日志** —— 日志被「读帧失败，3s 后重连」刷屏）

### `GET /health`
```
{ ok, model_version, model_path, nc, input_size, format, uptime_s,
  resource: { gpu:null|{util_pct,mem_used_mb,mem_total_mb}, mem_pct, mem_gb },
  workers: { <streamId>: { running, detects, alerts, last_conf, last_ms, stream_ok,
                           model_used, is_night, osd_skip, landing_suppress, suppressed,
                           sky_masked, sky_mask_skip_lookdown, cfm_hits, cfm_need, cfm_status, note } },
  osd: { enabled, last_poll, last_err, tracked } }
```

### `GET /metrics`
`{ ok, uptime_s, total_alerts, per_stream: { <sid>: { detects, alerts, last_ms, stream_ok,
  last_report_ok, last_report_err, sky_masked, suppressed } } }`
- **🔴 `last_report_ok` 初值是 `null`**，只在**真正上报过**之后才更新 ⇒
  **仅当 `alerts>0` 时才能用它判"上报失败"**（否则会把"还没上报过"误读成失败）。

### `GET /debug/snapshot`
`{ ok, now, streams: { <sid>: { frame_age_s, cfm:{hits,need,status}, detects, alerts, last_ms,
  of_flow, want_model, is_night, osd_skip, note } } }`
- **🔴 `frame_age_s` 帧龄 = 「是否真的在抽帧」的黄金指标**（越小越新鲜；`null` = 从未读到帧）。

## 四、运行链路与判定规则

抽帧 → `Detector.predict()` →（`_apply_sky_mask`）→ `Confirmer.update()` 连 3 帧 → `/api/straw-alert` → 企微 + 复检 gate。

| 规则 | 口径 |
|---|---|
| 单路循环 | `interval` 默认 2s；拉流用 `cv2.VideoCapture(src, CAP_FFMPEG)` + `BUFFERSIZE=1`（直播要"最新帧"） |
| **夜判** | 平均亮度 **< 25**（缩到 160×90 算灰度均值）**或**本地时间在 **19:00–05:00**（两者取或）；亮度取夜/昼模型 |
| **连帧确认** | `cfmNeed=3`：同位置连续 3 帧命中才升级为 alert；断帧超 `gapSec`(12s) 计数清零 |
| **落地上报抑制** | 依据 `height`/`verticalSpeed`（来自 `/api/internal/drone-osd`）：<br>· 下降速率 < −0.3 m/s 且 **高度÷速率 ≤ 30s**（预计 30s 内落地）⇒ 抑制<br>· 兜底 **高度 < 30m** ⇒ 抑制<br>· 只对 `sikong_<droneSn>` 流生效；**无遥测数据 → 不抑制**（保持原行为） |
| **起飞窗口** | `_TAKEOFF_WINDOW = 30s`（原 60s，9/11 调整）：刚起飞/在仓未起飞的告警放过（检测照常） |
| **在仓判定** | `droneInDock`：**0 = 在飞 / 1 = 在仓**；无 `_osd_state` → 不跳过（宁可多判） |
| 表 | `straw_detections`（**时间列 `ts`**，`lat`/`lng` 全空） |
| OSD 密钥 | `config.internalOsdSecret` 或 `/data/HBJSC/backend/.internal-secret`；端点 `/api/internal/drone-osd?deviceSn=` + 头 `x-internal-secret` |

## 五、🔴 数据统计铁律（做分布统计前必读）

- `straw_detections` 里 **`source='alert'` 有 74% 是 `scene='sim'` 模拟器帧** ⇒ **统计必须先过滤**。
- **`picall` 是「驾驶舱 UI 录屏截图」**（坐标体系与视频帧完全不同，视频仅占左侧约 62% 宽）⇒ 不能当原始帧用。
- **干净口径 = `stream_id LIKE 'sikong_%' AND exclude=0`**。
- 真实 alert 的 `frame_path` 是 **URL**（`/api/evidence/YYYYMMDD/sikong_*.jpg`）⇒ 映射 `/data/video/evidence/<rest>` 才能读图。
- **SIM_SMOKE + 机场直连流禁入训练集。**

## 六、已上线的历史改动（含回滚）

### `predict()` 性能优化（2026-09-27，P0-④）
- 结果：**328.5 → 105.9ms（3.10×）**，与旧实现**逐框一致 minIoU = 1.0000**；md5 `1b10260920a2c6af19dc0abe743813d5`。
- 三处开销（1920 输入下）：① **Python 逐行循环解码 75600 anchor = 190ms（主因，占 55%）** → 向量化后 1.1ms（168×）；
  ② `canvas.astype(float32)/255` 产生 44MB float32 且 `transpose` 后是**非连续视图**喂 ORT 需再拷 → 省 43ms；
  ③ 改为「先 resize 再转色」+ 预分配 float32 缓冲 + 只转粘贴区 → 再省 ~30ms。
- 回滚：`cp app/detector.py.bak_perf_20260927_143328 app/detector.py && systemctl restart straw-engine`。

### L0 天空带屏蔽（2026-09-28，P0-②）
- `_apply_sky_mask()` 位于 `predict` 与 `cfm.update` **之间**，**只作用于告警判定**；
  `_boxes_raw`（全量框）仍交给 `maybe_record` 落库 ⇒ **屏蔽区自动变成"难负样本矿"**。
- 俯视/舱内帧自动禁用（判据：整帧检测框**中位 y 中心 > 0.70**）。
- 配置：`maskSkyEnabled` / `maskSkyRatio:0.10` / `maskSkySkipLookdown:true`（支持按流覆盖 > 全局）。
- 离线门禁（2026-09-27，只算真实机场流 597 框）：落在上方 10% 的仅 3 框（0.50%），且全部 `review=pending`、conf 0.13~0.30。
- 回滚：`cp app/main.py.bak_skymask_20260928_003959 main.py && systemctl restart straw-engine`。

### 引擎健康宽限期（2026-09-26）
`flight_monitor_daemon.mjs` 的引擎 FAIL 判定加 **90s 宽限期**（环境变量 `WXBRIDGE_ENGINE_GRACE_S` 可调），
避免"起飞加流导致的短暂无响应"被误报成 `🚨 算法监控FAIL · engine`。

## 七、4 路 sikong 流实测状态

`S4J 职教` / `S4JM 经开` / `064U 环保局` **已实测跑通**（"064U detects=0" 只是**从未在该机场飞过**）；
`S4G 三峡` **未经飞行验证**。
