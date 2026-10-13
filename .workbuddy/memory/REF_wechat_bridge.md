# REF · 微信桥（Windows VM）运维细则

> 从 MEMORY.md 拆出（MEMORY 注入超限）。**改动前必读本文件全文。** 拆出日期 2026-09-29。
>
> 🔴 **2026-10-12：桥机 IP 由 `172.16.8.15` 改为 `172.16.8.16`**（RDP 证书 CN 仍是
> `DESKTOP-PAQ2NAV` ⇒ **同一台 VM 换址**，非换机）。**同时实测发现 Windows 侧运行时已全丢
> （`C:\wxbridge\` ❌、`C:\Python311\` ❌、`:18888` 不通）⇒ 整条链路需重建。**
> 凭据：本地账户 `KCW5ngfxteFx`（密码见服务器 `/root/.wxbridge.env`，600，**不入仓库**）。
> 评估与方案：`docs/微信桥迁移重建_评估与方案_20261012.html`

## 🔌 桥的端点（2026-10-13 P1 后）
| 端点 | 性质 | 说明 |
|---|---|---|
| `POST /send?group=` | 写 | 企微 webhook 协议兼容；worker 子进程发送 |
| `GET /ping` | **纯内存** | 毫秒级存活探针，绝不触碰微信 |
| `GET /health` | **纯内存** | 存活/卡死探针。⚠️ 其中 `driver/sessions/wechat_version` **不可用于判断登录**（见下） |
| `GET /status` | 纯内存 | 人工排查用完整 STATE |
| `POST /reset-stuck` | — | 清 stuck 标记 |
| **`GET /login-state`** | **重** | 主动探测登录态（窗口 + 驱动 + DB）。成功结果缓存 `LOGIN_TTL_OK=30s`、失败 `LOGIN_TTL_FAIL=15s`；`?force=1` 穿透。返回 `logged_in/via(driver\|window)/driver/self/wechat_version/sessions_count/groups_count/login_window/main_window/windows[]/error` |
| **`GET /sessions`** | **重** | `groups`（**全部**群，来自 `chat_room` 表）+ `contacts`（最近会话里的个人）。缓存 60s；`?q=` 过滤、`?force=1` 穿透 |

- **探测并发**：`_PROBE_LOCK` 串行化；抢锁超时 8s 就返回上次结果并标 `probing=true`，避免轮询堆积。
- **纪律**：`/health` 必须保持"纯内存、绝不触碰微信"（否则 wxauto 一卡它就跟着卡，外部就分不清"进程死了"还是"业务卡住"）⇒ 重活一律放 `/login-state`、`/sessions`。

### 🔴🔴 重复监听事故面（2026-10-13 实测发现，必读）
**Windows 默认允许两个进程同时 bind 同一个端口**（Flask/Werkzeug 开了 SO_REUSEADDR）。
实测 18888 上**同时有 2 个 python.exe 在听**：
```
PID 2936  python.exe  Services     Session 0   ← 18:47 由 WMI 直启遗留（旧代码）
PID 8164  python.exe  RDP-Tcp#106  Session 2   ← schtasks /Run 起来的（新代码）
```
- **Session 0 的桥看不到微信窗口** ⇒ 发送必然失败（`_count_visible_top_level_windows` 就是为诊断这个而写的）。
- 所以 `netstat | findstr :18888` 拿到的**第一个 PID 不一定是应答的那个** ⇒
  **重启桥必须把所有监听 18888 的 PID 全部杀掉**，确认端口释放后再 `schtasks /Run /TN WeChatBridge`（`/IT` ⇒ Session 2）。
- 收官检查：**必须只有 1 个实例，且在 Session 2**（`tasklist /FI "IMAGENAME eq python.exe" /FO CSV /NH` + `uptime_s` 应为几十秒）。
- ⚠️ 本机**没有** `WxBridgeSelfHeal` 任务（老 8/15 机上有，重建后没补）⇒ **桥挂了目前无人自动拉起**。

## 🔑 登录判据（2026-10-13 **重写**，前一版是错的，别再踩）
**❌ 不能用 `/health` 的 `driver`/`sessions`/`wechat_version`**：那是 `_refresh_cache()` 填的，
全文件仅 1 处调用（发送成功路径）⇒ 没推送过时永远是 null。
**❌ 更不能用「能不能读 DB + 有会话/群数据」**：微信在别处登录被**顶下线后，磁盘 DB 仍可解密**
（`DRIVER`/`DRIVER_NAME` 是模块级永久缓存，`WeChatDB` 的密钥还缓存到 `workdir/keys.json`），
session/chat_room 依旧 100/106 行 ⇒ **这个证据会永远为真**（2026-10-13 实际故障，用户报"不实时"）。
**❌ 不能按窗口标题挑**：被顶下线时那个「提示」弹窗标题居然是 `Weixin`（复用主窗口标题）。
**❌ 不能按"登录窗是否存在"判**：登录窗在已登录时也可能残留。

✅ **正确判据 = 窗口尺寸 + "有没有主窗"**（`wechat_bot_server.py` 的 `_probe_login_state_uncached`）：
| 观测量 | 含义 | 处置 |
|---|---|---|
| 有**主窗**（宽≥700 且 高≥500，实测 **896x648**） | 已登录 | `logged_in=true` |
| 只见**小窗**（宽≤420 且 高≤460） | 未登录（**硬否决**，不看 DB 证据） | `logged_in=false` + `reset_driver()` |
| 完全看不到微信窗口 | 无法从 UI 判（可能最小化到托盘） | 才退回 DB 证据 |
实测到的三种"小窗"：登录窗 `296x388`（标题`微信`）｜被顶下线提示弹窗 `330x314`（标题`Weixin`）｜
自动更新窗 `548x380`（标题`weixin update`，**落在尺寸死区**，需单独识别 `updating`）。

其它要点：
- **`reset_driver()` 必须存在**：不清掉 `DRIVER`/`DRIVER_NAME`/STATE 缓存，"已登录"就永远不会降级。
- **更新中不要动手**：`updating` 且**没有登录窗**时 → 守护不取码、不重启（重启会打断升级）。
  升级完成后 update 窗会残留一会儿，此时登录窗已出来 ⇒ 必须照常取码，否则一直卡在"更新中"。
  残留进程是独立的 **`WeixinUpdate.exe`**，可直接 `taskkill`。
- 守护已改为**以桥 `/login-state` 为主**、本机窗口尺寸交叉确认；心跳 **60s**，且**不再周期性抢微信前台**。
- 前端轮询：**未登录 5s / 已登录也是 5s**（原 30s 是"不实时"的一半原因）。

## 📷 二维码保活（`wx-qr-keepalive.service` @226）
每 60s 前置微信窗口 + 只截「登录窗口内二维码区」（窗口内偏移 `(80,85)` 尺寸 `135x135`）
→ `/data/HBJSC/wxb_qr/latest.png`；**PNG ≥ 2500B 才认**（真码 ~4–7KB，截到浏览器 0.3–1.2KB）。
兜底重启：画面连续 **6 分钟**未变，或窗口连续 **5 轮**找不到 ⇒ `taskkill Weixin.exe` + `WxLaunchQr`；
三重护栏：冷却 5min / ≤6 次每小时 / 已登录即停。
- 取码：`bash infra/wechat-bridge/deploy/fetch_qr.sh --fresh`（**交给真人扫时必须加 `--fresh`**，
  因为 `latest.png` 码龄最长可达 ~3–4 分钟 = 微信自身换码周期）。
- ⚠️ **权限**：`/data/HBJSC/wxb_qr` 必须 `2770 root:jsc`、文件 `640` ——
  后端 `jsc-backend.service` 跑 `User=jsc`，要读 `latest.png`。**别写死 0700/0600**。
  且**不能直接 `cp -f` 覆盖**已存在文件（原地截断会保留 `root:root` 属组）⇒ 必须**先删再拷**再 chmod/chown。

### ⚠️ 微信 4.1.13.65 起：登录窗默认是「账号卡片」，不是二维码
登录窗显示**头像 + 昵称 + 「登录」按钮 + 「切换账号」**，**必须点「切换账号」才出二维码**。
- ⇒ **只重启客户端已经不够**：重启后回到账号卡片页。`wx_qr_reset.sh` 已改成
  **杀客户端 + 拉起 + 写 `click_preset.txt` + 跑 `WxClick` 任务 + 等新码**。
- **二维码判据必须加"暗像素占比"**：账号卡片的头像是高熵图案，PNG 体积 3297B **骗过了**
  原来的"≥2500B"下限。实测真码 `0.473~0.478`、账号卡片 `0.036` ⇒ 判据取 **0.30~0.62**
  （226 已装 `python3-pil`；无 PIL 时退回只看体积）。
- **受控点击能力** `wx_click.py`（任务 `WxClick`）：只认预设名（`switch_account`/`login`/`acknowledge`），
  坐标按窗口 rect 相对比例算，**只注入鼠标、绝不注入键盘**；预设名经
  `C://wxbridge//deploy//click_preset.txt` 传递、读完即删。

## 📮 微信桥（Windows VM `DESKTOP-PAQ2NAV`，**当前 IP 172.16.8.16**）
- **拓扑**：226/8.12 跑 `Xvfb :99` + `xfreerdp /v:172.16.8.15 +auto-reconnect`；VM 内 `C:\Python311\python.exe C:\wxbridge\wechat_bot_server.py`（Flask+**wxauto4**，:18888）。
  **强依赖「RDP 会话保持 + 微信窗口可见/前台」**（必须交互式桌面会话，**不可** Session 0）。VM 3389/135/139/445 开，**22 无 sshd**。
- **调用**：`POST /send?group=<群名>`，body `{msgtype:'markdown',markdown:{content}}`；成功 `errcode===0`，或 `errcode=-1` 且 `errmsg` 含 `verify/target=`（已知误报，实际已发）。
  💡 **wxauto「发送后不返回」是常态，消息通常已发出**。
- **🎯 SMB 直连（445 开）**：凭据在 226 `/opt/jsc/rdp_keep.sh`（用户 `KCW5ngfxteFx`、密码在该脚本 `PWD=`）→ **直接读写其文件系统**。**SMB 写入也要 md5 校验**。🔴 别依赖 `\\tsclient\WX`（会话重建后失效）。
- **⚠️ SMB 不能执行命令 → 标准姿势「SMB 传 .ps1 + RDP 只注入一行 `-File` + 输出写文件 + SMB 读回」**。注入序列 `super+r`→`ctrl+a`→`ctrl+v` 粘路径→`Return`；脚本末行写哨兵，Linux 侧轮询。
- **🔴 催命规律**：**第 1 条发送必成功，第 2 条必崩**。伴生 `未找到微信渲染子窗口，回退用主窗口矩形定位坐标` ⟹ **微信 4.1.13.12 UI 变更→wxauto 拿不到渲染窗口句柄**。规避（待决）：发完一条即主动退出，由 selfheal 拉起。
- **🔴 `-WindowStyle` 铁律：必须 `Normal`**。`Hidden` 在 RDP 会话里绑定脆弱，**1~2 分钟内被硬杀**；⚠️ 给 restart 脚本加 stdout/stderr 重定向也等同 Hidden。规范脚本 `/opt/jsc/restart_wxbridge.sh`。
- **🔑 `/health` 曾是「假健康检查」**（调微信 UI）→ 已改**纯内存**（新增 `/ping`/`/status`/`/reset-stuck`，`/send` 加 30s 子线程超时 + stuck 标记）。脚本本来就 `threaded=True`。
- **⚠️ 熔断不可「拒绝请求」**：v1 stuck 时 503 拒绝 → **起飞通知重试 5 次全被拒、彻底丢失**。v2 改为 **stuck 仅观测、照常发送**。
- **🛡️ 自愈三层**：① Windows 计划任务 `WxBridgeSelfHeal` 每 2 min 跑 `selfheal.ps1`（查 `/ping`，**不通才**清理+启 bot，**必须 `-WindowStyle Normal`**，日志 `selfheal.log`）。
  ② Linux systemd timer 每 3 min（`wxbridge_watchdog.sh`）**已改「只检测+记录」(`NEED_MANUAL`)**，启用注入需 `WXBRIDGE_ALLOW_INJECT=1`；⚠️ 代价：桥进程消失时**没人救**→通知全丢。③ 闭环：Win 重启→无人登录→桥不在→看门狗重建 RDP(=登录)→触发层 1。
- **🔴 绝不用 xdotool 注入执行命令**（真实事故）：焦点错位时**整段命令被打进微信输入框并回车发出**。⇒ 执行只走「SMB 传文件 + 计划任务/人工」，**绝不模拟按键敲命令**（`super+r` 只用于粘**文件路径**）。
- **🔴 计划任务坑**：🚨 **直接 SMB 覆盖 `C:\Windows\System32\Tasks\<任务>` XML，服务【不会】重载** → 任务照旧不跑。
  🚨 **真病根 = `Interactive` + 指定的账户当前没登录**（`UserId=Administrator`+`Interactive`+`Highest`，而实际登录用户是 `KCW5ngfxteFx`）→ 三者锁死，任务一次都起不来，却 `State=Ready`、`LastTaskResult=267011`（`0x41303` 只是"还没跑过"的常规初值，**不是错误码**）。
  **正解**：`schtasks /Create` **不带 `/RU /RL /IT`**，再用 `Set-ScheduledTask` 补 `DisallowStartIfOnBatteries=false`/`StopIfGoingOnBatteries=false`/`StartWhenAvailable=true`。
  ⚠️ `-RepetitionDuration 3650天` 实测不触发 → 宁可省略（空=无限）。**自愈脚本必须加「心跳行」**（健康时也写），否则"没跑"与"跑了但一直健康"无法区分。
- **🔴 写给 Windows 的 `.ps1` 必须带 UTF-8 BOM**：PS 5.1 对无 BOM 按 **ANSI/GBK** 读→中文乱码吃掉引号→语法错。修法 `[System.IO.File]::WriteAllText($p,$c,(New-Object System.Text.UTF8Encoding($true)))`。本地可先验语法（同为 5.1.19041）。
- **取证（零侵入）**：`export DISPLAY=:99; scrot -o /tmp/win_now.png` → scp 看图，**不抢焦点**。
- **📣 推送规则**：推送**发到群**，**按街道定对象、不细分责任人**。来源 `area_responsibility.webhook`（按 `town`+`community` 反查，`store-db.js:findResponsibility`）；18 行统一 `group=军哥`。
  🔴 已修：原表只覆盖 16/51 镇街 → **36 区域（70%）告警静默不推送**；已补齐 **51/51**。⚠️ **仍缺「高梁镇」**（`area_boundary` 无边界）。回滚 `DELETE FROM area_responsibility WHERE remark LIKE '2026-09-24 自动补齐%'`。
- **✈️ 飞行事件推送**：`flight-monitor.service`→`/opt/jsc/flight_monitor_daemon.mjs`（由 `tmp/build_daemon.cjs` 从 v6 生成）。30s 采样；起飞/降落/FAIL 自动推；日志留 3 天；`Restart=always`；推送重试 5×22s；**引擎 FAIL 有 90s 宽限期**。
  - **📊 降落汇报**：起飞记 `takeoffAt`，降落查 `warnings` 统计**检出事件数 + 责任街道分布**。
    ⚠️ **`warnings` 只有 `id/created_at/status/warning_type/data_json`** → 必须 `json_extract(data_json,'$.streamId')`；写 `WHERE streamId=?` 会报错。
    🔴 **同一机场 streamId 两种格式**：`sikong_<无人机SN>` 与 `sikong_<机场SN>` —— 只查一种**漏约 30%**；daemon 内置 `DOCK_SN` + `IN (...)` 双匹配。
- **飞行监控** `/opt/jsc/flight_monitor6.mjs`：`setsid nohup node flight_monitor6.mjs 30 300 <outdir> &`。判据：`osd.tracked.droneInDock`（**0=在飞/1=在仓**）判阶段，只对已起飞的判"流未上线"；
  ⚠️ **跨阶段必须重置累计计数器，且重置语句要放在使用它之前**。

