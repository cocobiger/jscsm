# dock-guard 机场人员入侵检测 — 真机联调 SOP

> 版本：v0.2.2（2026-08-31 第三批离线预演全部通过后交付）
> 服务：`dock-guard`（systemd，:7210）｜ 配置：`/opt/jsc/dock-guard/config.json`
> 一键验证：`bash /opt/jsc/dock-guard/verify.sh`

---

## 一、联调前提

| # | 前提 | 检查方式 |
|---|------|----------|
| 1 | 机场/dock 在线且推流到 ZLM | `bash /opt/jsc/dock-guard/verify.sh` 第 2 节显示 4 路 `sikong_8UUXN*` 且 B/s > 0 |
| 2 | dock-guard 服务运行 | `systemctl is-active dock-guard` = active |
| 3 | 驾驶舱后端在线 | `curl -s http://127.0.0.1:7170/health` 正常 |
| 4 | 布防时段覆盖当前时间 | config.json 各 dock `hours`（默认 `0-24`） |

**说明**：dock 摄像头画面 = 无人机在仓时的机库内部画面。非任务时段（无人机在外）画面可能无推流或为盖板画面，属正常。

---

## 二、联调步骤（按序执行）

### 步骤 1：服务就绪检查
```bash
bash /opt/jsc/dock-guard/verify.sh
```
预期：`✅ 联调就绪：生产流全部在线`，4 路 `[OK ]`。

### 步骤 2：确认拉流与亮度判定
```bash
curl -s http://127.0.0.1:7210/health | python3 -m json.tool
```
逐路确认：
- `stream_ok=true`：拉流正常
- `is_night`：白天 `false`（bright > 25），夜间 `true`（bright < 25）
- `bright`：与现场光照大致吻合（机库内 100~160 白天正常）

### 步骤 3：人员走场测试（核心）
1. 安排 1~2 名人员进入 dock 摄像头画面（机库内/停机坪区域）
2. 停留 ≥3 秒（默认 `frames=3` 连续帧确认）
3. 观察：
   ```bash
   curl -s http://127.0.0.1:7210/health | python3 -c "import json,sys; d=json.load(sys.stdin); [print(s, v['persons'], v['alerts'], v['last_boxes'][:1]) for s,v in d['docks'].items()]"
   ```
   预期：人员进入后 `persons≥1`、`last_boxes` 出现人框、约 1 秒内 `alerts+1`。
4. 驾驶舱查看：**告警 10s 内出现在驾驶舱告警列表**，类型「机场人员入侵」，含证据图。

### 步骤 4：告警冷却验证
- 人员持续在场时，默认 `cooldown=60s` 冷却期内不重复告警；人员离开再进入，重新触发。
- 查看告警节奏：
  ```bash
  journalctl -u dock-guard --no-pager -n 20 | grep "\[alert"
  ```

### 步骤 5：ROI 区域过滤验证（如需局部布防）
1. 编辑 `/opt/jsc/dock-guard/config.json`，给目标 dock 加 `roi`（归一化多边形，如只监控机库门口）：
   ```json
   "roi": [[0.2, 0.3], [0.8, 0.3], [0.8, 0.9], [0.2, 0.9]]
   ```
2. `curl -X PUT http://127.0.0.1:7210/config -d @config.json`（热重载）或 `systemctl restart dock-guard`
3. 人员站 ROI 外 → `persons=0`；站 ROI 内 → 正常告警。
4. 验证完毕恢复 `roi: []`（全画面）。

### 步骤 6：夜间提阈验证（夜间场景）
- 夜间（bright < `nightBright=25`）自动切换 `nightConf=0.45`（更严苛阈值，降低暗光误报）。
- 验证：夜间人员进入画面，`is_night=true` 且告警正常；`journalctl` 中 `night=True`。

---

## 三、验证点对照表

| # | 验证点 | 通过标准 | 离线预演结论 |
|---|--------|----------|--------------|
| 1 | 拉流 | 4 路 `stream_ok=true` | ✅（实测 4/4） |
| 2 | 亮度判夜 | bright 与光照吻合，<25 判夜 | ✅（暗图 16.0 → is_night=True） |
| 3 | 人员检出 | 走场 `persons≥1` | ✅（暗图检出 4 人，最高 conf 0.878） |
| 4 | 连续确认 | 在场 ≥3 帧才告警 | ✅（单测 6 项） |
| 5 | 告警上报 | 驾驶舱 10s 内预警 + 证据图 | ✅（reported=True + /api/evidence/...） |
| 6 | 冷却去重 | 60s 冷却期内不重复 | ✅（场景 B 实测 6 告警节奏） |
| 7 | ROI 过滤 | 区域外不告警 | ✅（场景 A：ROI 局部 0 告警 vs 全画面 4 人） |
| 8 | 夜间提阈 | 夜间自动切 0.45 | ✅（场景 C：night=True + 告警） |
| 9 | 起飞跳帧 | 无人机在仓/起飞 60s 内整帧跳过 | ✅（单测 6 项） |
| 10 | 断流保护 | 流断开 8s 超时 → 重连，不卡死 | ✅（v0.2.2 线程超时包装） |

---

## 四、常见问题排查

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| `stream_ok=false` | 机场未推流 / 流断开 | `verify.sh` 第 2 节看 ZLM 是否在线；等任务时段或查 dji 推流链路 |
| 服务反复重启 | 配置 JSON 错误 | `journalctl -u dock-guard -n 50` 看报错；`python3 -m json.tool config.json` 校验 |
| 人员进入不告警 | frames 确认不足 / ROI 外 / 尺寸过滤 | 查 `persons` 与 `last_boxes`；调 `frames=1` 临时验证 |
| 告警过多（夜间误报） | nightConf 太低 | 提高 `nightConf`（如 0.55）；验证 `is_night` 判定是否准确 |
| 拉流卡死不重连 | 旧版本无超时保护 | 确认 `version=0.2.2`；升级后自动恢复 |
| 驾驶舱未收到告警 | 后端异常 / apiBase 错 | `curl -s http://127.0.0.1:7210/health` 看 `alerts` 计数是否增长；`journalctl -u jsc-backend` 查 /api/straw-alert |

---

## 五、回滚

- 配置回滚：`cp /opt/jsc/dock-guard/config.json.bak_scenec /opt/jsc/dock-guard/config.json && systemctl restart dock-guard`
- 代码回滚：`cp /opt/jsc/dock-guard/dock_guard.py.bak_timeout /opt/jsc/dock-guard/dock_guard.py && systemctl restart dock-guard`
- 停用单路布防：config.json 中对应 dock `"enabled": false` + 热重载

---

## 六、关键参数说明（config.json 每路 dock）

| 字段 | 默认 | 说明 |
|------|------|------|
| `conf` | 0.35 | 白天检出阈值 |
| `nightConf` | 0.45 | 夜间检出阈值（bright < nightBright 时生效） |
| `nightBright` | 25 | 亮度判夜阈值（灰度均值） |
| `frames` | 3 | 连续确认帧数 |
| `cooldown` | 60 | 告警冷却秒数 |
| `minHeight/maxHeight` | 0.02/0.60 | 人框高度占比过滤 |
| `roi` | []（全画面） | 归一化多边形 [[x,y],...]，人框中心点在多边形内才告警 |
| `hours` | 0-24 | 布防时段（支持 `22-6` 跨天） |
| `interval` | 1.0 | 检测间隔秒数 |
