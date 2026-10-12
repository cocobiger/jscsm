# wechat-bridge 部署收尾清单(等用户回话后执行)

> ## ⚠️ 时效警告(2026-10-12)
> 本文件下半部分写于 **2026-08-30**，其中 `/opt/jsc/**` 路径**已全部失效** ——
> 原生产机 9/29 被整体重装，**新安装根 = `/data/HBJSC/`**；桥机 IP 也由
> `172.16.8.15` 改为 **`172.16.8.16`**。以本文档**末尾「2026-10-12 重建」一节**为准。

## 状态快照(2026-08-30 22:58)
- ✅ RDP 常驻 PID 2924325 已运行 1h+, 147MB
- ✅ wechat-bridge 服务运行中, 监听 0.0.0.0:18888
- ✅ /health 200 (9ms), POST /send 200 (协议兼容)
- ✅ wxauto4 已加载, 等待微信客户端
- ⚠️ 等待用户在 VM 上手动装微信 4.0.5 + 扫码登录

## 三件套脚本(本目录)
- `list_groups.ps1` - 微信登录后运行, 列出所有群名到 `C:\wxbridge\wx_groups.txt`
- `switch_webhook.js` - 改 `area_responsibility.webhook` 从企微切到 wechat-bridge
- `rollback_webhook.js` - 一键回切(从 `area_responsibility_20260830_backup` 备份表还原)
- `group_mapping.template.json` - 批量切换的群名映射模板

## 用户回来后的执行步骤

### 第 1 步: 用户在 Windows VM 手动操作(无法自动化)
1. 装微信 PC 4.0.5, **关自动更新**(4.1.12+ 让所有 wxauto 失效)
2. 扫码登录(建议小号, 避免主号被封)
3. 把 18 个目标群(对应 18 条 area_responsibility)都加进来
4. 确认所有目标群出现在微信"最近会话"

### 第 2 步: 在 VM 跑 list_groups.ps1 拿到群名清单
通过 RDP 自动化 (或 VM 控制台手动):
```powershell
powershell -ExecutionPolicy Bypass -File C:\wxbridge\deploy\list_groups.ps1
```
输出会同时回传到 `\\tsclient\WX\wx_groups.txt`

### 第 3 步: 我根据群名清单填 group_mapping.json
对照 area_responsibility(18 条镇/街道) 与 wx_groups.txt, 把群名填到 mapping 数组

### 第 4 步: 预览切换
```bash
ssh root@111.10.220.226 "cd /opt/jsc/backend && node /opt/jsc/backend/deploy/switch_webhook.js --preview --batch /path/to/group_mapping.json"
```

### 第 5 步: 真正切换
```bash
ssh root@111.10.220.226 "cd /opt/jsc/backend && node /opt/jsc/backend/deploy/switch_webhook.js --batch /path/to/group_mapping.json"
```

### 第 6 步: 端到端验证
- 模拟一条新告警(让 v6 模型检出真烟)
- 看 wechat-bridge 的 server_err.log 是否出现"已发送到群 XXX"
- 看 area_responsibility_20260830_backup 表的 webhook 字段仍保留原值(回滚用)

## 回滚(任何时候)
```bash
ssh root@111.10.220.226 "cd /opt/jsc/backend && node /opt/jsc/backend/deploy/rollback_webhook.js"
# 预览; 加 --execute 真正执行
```

## 部署文件落地位置

| 角色 | 路径 |
|---|---|
| 服务代码 (Windows VM) | `C:\wxbridge\wechat_bot_server.py` |
| 服务依赖 | `C:\Python311\` (完整 Python 3.11.9) |
| 微信列表脚本 | `C:\wxbridge\deploy\list_groups.ps1` |
| 服务日志 | `C:\wxbridge\server_err.log` / `server_out.log` |
| 后端切换脚本 | `/opt/jsc/backend/deploy/switch_webhook.js` |
| 后端回滚脚本 | `/opt/jsc/backend/deploy/rollback_webhook.js` |
| 备份表 (auto) | `area_responsibility_20260830_backup` |

## 已知遗留
- 防火墙已 Set-NetFirewallProfile -All -Enabled False(开发 VM 接受)
  - 若用户希望加固: 改回 Enable, 只留 wechat-bridge-18888-in / wechat-bridge-py-in / wechat-bridge-py-out 三条规则
- 微信 4.1.12+ 自动升级会破 wxauto4 → 必须用户在微信设置里关掉"自动更新"
- v6 模型仅在 straw-engine 灰度环境运行(50% 流量), 真告警量级待观察

---

# 2026-10-12 重建（以本节为准）

## 拓扑
```
226 (Linux 跳板, 111.10.220.226)
 ├─ Xvfb :99  1440x900
 ├─ xfreerdp /v:172.16.8.16 +auto-reconnect      ← 保活 RDP 会话（rdp-healer.timer 每分钟）
 └─ wx-qr-keepalive.service                      ← 二维码保活守护（本文件）
        │  WMI over SMB（135/445，wmiexec.py，无 GUI、无按键注入）
        ▼
VM DESKTOP-PAQ2NAV (172.16.8.16, 交互式会话 rdp-tcp#106 / Session 2)
 ├─ Weixin.exe  C:/Program Files\Tencent\Weixin\Weixin.exe （4.1.13.12）
 ├─ C:/wxbridge/wechat_bot_server.py  → :18888   （Flask + wechatauto-replica）
 └─ 计划任务：WeChatBridge(自启) / StartWeixin / BringWxFront / WxFront / WxLaunchQr
```

## 安装（幂等，在本机 Git Bash）
```bash
# 1) 准备 LF 版本（Write 落盘是 CRLF，.cmd 保留 CRLF，其余必须剥）
cd infra/wechat-bridge/deploy
for f in wx_qr_keepalive.py wx-qr-keepalive.service install_wx_qr_keepalive.sh wx_front.py; do
  tr -d '\r' < "$f" > "/tmp/wxb_install/$f"; done
cp run_wx_launch.cmd /tmp/wxb_install/
# 2) 上传 + 执行
scp -P 22233 /tmp/wxb_install/* root@111.10.220.226:/tmp/wxb_install/
ssh -p 22233 root@111.10.220.226 "bash /tmp/wxb_install/install_wx_qr_keepalive.sh"
```

## 取二维码（随时）
```bash
bash infra/wechat-bridge/deploy/fetch_qr.sh            # → tmp/wxb_shots/qr_live_only.png
```
> 坑：ssh 端口是 `-p`，**scp 端口是大写 `-P`**；写成小写会把 `22233` 当源文件报 "Not a directory"。

## 落地位置
| 角色 | 路径 |
|---|---|
| 守护脚本 | `/data/HBJSC/scripts/wx_qr_keepalive.py` |
| 二维码产物 | `/data/HBJSC/wxb_qr/{latest.png,win.png,latest.json,state.json}`（目录 700 / 文件 600）|
| 守护日志 | `/var/log/wx_qr_keepalive.log` |
| 窗口前置脚本 | `C:/wxbridge/deploy/wx_front.py`（+ `run_wx_front.cmd`）|
| 拉起微信脚本 | `C:/wxbridge/deploy/run_wx_launch.cmd`（+ 任务 `WxLaunchQr`）|
| 桥服务 | `C:/wxbridge/wechat_bot_server.py` → `:18888` |

## 二维码保活机制（为什么这么设计）
- **主手段**：每 60s 把微信窗口前置 + 截一张 → `latest.png`。微信自身会定期更换二维码，
  所以只要保证「码龄 ≤ 60s」，用户任何时刻取到的码都远在 2–5 分钟有效期之内。
- **兜底重置**：仅当「画面连续 6 分钟完全没变」（= 自刷新卡死）时，才 `taskkill Weixin.exe`
  + `WxLaunchQr` 重新拉起。三重护栏：冷却 5 分钟 / 每小时 ≤ 6 次 / 已登录即停。
  ⚠️ **不做定时重启**：微信对频繁登录二维码请求有风控嫌疑，且重启会打断"已扫码待手机确认"的窗口期。
- **已登录即静默**：判据原文（**2026-10-12 已更正，别再按旧版做**）——
  ~~`/health` 的 `driver`/`sessions`/`wechat_version` 非 null~~
  🔴 **那三项只在"某次推送成功之后"才被填**（`_refresh_cache()` 全文件仅 1 处调用：`wechat_bot_server.py:803`），
  且 `get_self_info()` 永远返回 dict ⇒ **不能用来判断登录**。
  ✅ **现用判据 = 微信窗口几何**（实测基线：未登录时唯一窗口 = 登录窗 `296x388`）：
  | 观测 | 含义 | 处置 |
  |---|---|---|
  | `found=0` | 微信没起来 / 崩了（**≠ 已登录**） | 连续 5 轮找不到 ⇒ 重启客户端拉起 |
  | `found=1` 且尺寸 `296x388` | 登录界面（未登录） | 继续保活取码 |
  | `found=1` 且尺寸 ≠ `296x388` | 已登录（主界面） | 静默 + 每 300s 心跳确认 |

## 登录态探针（T1 定标，可复用）
```bash
ssh -p 22233 root@111.10.220.226 "bash /data/HBJSC/scripts/run_login_probe.sh"
```
跑在 VM 的**交互式会话**（与桥同条件），采集 `auto_detect_db_dir()` / `WeChatDB()` /
`get_self_info()` / `get_sessions()` / `get_groups()` / 窗口几何，并给出"未登录 vs 已登录"对照。
**已记录的未登录态基线**：`auto_detect_db_dir()=null`、`WeChatDB()` 抛
`RuntimeError: 未找到微信数据库目录`、唯一窗口 `296x388`。

## 目录权限（P0 T3，必须保持）
```
/data/HBJSC/wxb_qr/        drwxrws---  root jsc   2770（setgid）
  latest.png/latest.json   -rw-r-----  root jsc   640
```
后端 `jsc-backend.service` 以 `User=jsc` 运行，要读 `latest.png` 给前端展示；jsc 还要能在该目录
**创建 `reset.request`**（P2 的"手动刷新二维码"就靠它）。
⚠️ 两个坑：① 守护脚本里**别写死 0700/0600**；② 发布文件**不能直接 `cp -f` 覆盖**——
cp 是原地截断会保留 `root:root` 属组，640 也只给到 root 组 ⇒ 必须**先删再拷**再 `chmod/chown`。

## 实测踩坑（都已修）
1. **`SetForegroundWindow` 会静默失败**（Windows 前台锁）→ 此时按窗口 rect 去 scrot 会截到
   压在上面的 Chrome（静默错图）。修法：`wx_front.py` 用 `AttachThreadInput` 抢输入队列 + 重试 6 次，
   并输出机器可读的 `VERDICT fronted=1 hwnd=… fg=… rect=…`；守护**必须**确认 `fronted=1 且 fg==hwnd` 才截图。
   → 否则会出现「截到 Chrome → 画面永不变化 → 误判冻结 → 反复重启」的死循环。
2. `wx_front_out.txt` 同时列出了屏幕**其他**窗口的 rect ⇒ 解析必须**只认 `VERDICT` 行**，
   直接对整个文件 findall 会把 Progman 的全屏 rect 当微信窗口。
3. `wx_front.py` 每次启动**先落一次盘**（此时还没有 VERDICT）⇒ Linux 侧若在本次未结束时来读，
   会正确地"读不到→重试"，而不是误用上一次的陈旧判定。
4. `/health` 的 `wechat_version`/`driver`/`sessions` 全 null = 驱动从未初始化（未登录）。
5. **计划任务是异步的 ⇒ 会读到上一次残留的判定**：`schtasks /Run` 后新进程要几秒才起来，
   若这时去读 `wx_front_out.txt`，读到的是**上一次**的 `VERDICT`（写着 fronted=1）
   ⇒ "以为抢到前台了、其实没有" ⇒ 截到压在上面的浏览器。
   正解：**触发前先 `del` 掉输出文件，再轮询直到 VERDICT 出现**（确定性，不依赖时序）。
6. **判据要落在像素内容上**：窗口 rect 一直是对的，错的是"那个位置当前显示谁"。
   零依赖做法 = **只截二维码子区域**（登录窗口 296x388，二维码区偏移 (80,85) 尺寸 135x135），
   以 **PNG 体积 ≥ 2500B** 验真伪（实测：真码 ~4.1–6.9KB，截到浏览器 0.3–1.2KB）。
   ⚠️ 别用整窗 PNG 体积：好图 ~16.1KB vs 错图 ~15.6KB，只差 3%，太窄。

## P1 新增端点（2026-10-13）
| 端点 | 说明 |
|---|---|
| `GET /login-state` | 主动探测登录态。成功缓存 30s / 失败 15s；`?force=1` 穿透。返回 `logged_in / via(driver\|window) / driver / self / wechat_version / sessions_count / groups_count / login_window / main_window / windows[] / error` |
| `GET /sessions` | `groups`（**全部**群，来自 `chat_room` 表）+ `contacts`（最近会话里的个人）。缓存 60s；`?q=` 过滤 |
> 纪律：`/health` 保持"纯内存、绝不触碰微信"，**重活一律放这两个新端点**。

### 🔴 重启桥的正确姿势（踩过坑）
```bash
# ① 把所有监听 18888 的 PID 全部杀掉 —— Windows 允许两个进程同时 bind 同一端口，
#    实测同时存在 Session 0（WMI 直启的遗留，看不到微信窗口）与 Session 2（正确）两个实例
for P in $(netstat -ano | findstr LISTENING | findstr :18888 | grep -oE '[0-9]+$' | sort -u); do
  taskkill /F /PID $P
done
# ② 确认端口已释放（/ping 不再 200），再拉起
schtasks /Run /TN WeChatBridge          # /IT ⇒ Session 2（必须）
# ③ 收官检查：只能有 1 个实例且在 Session 2，且 /ping 的 uptime_s 是几十秒
tasklist /FI "IMAGENAME eq python.exe" /FO CSV /NH
curl -s http://172.16.8.16:18888/ping
```
⚠️ 解析 PID 时注意 `wmiexec` 输出**首行是空行** ⇒ `head -1` 会拿到空行、`awk '{print $NF}'` 得到空串。
用 `grep -oE '[0-9]+$'` 取行尾数字更稳（本仓库踩过这个）。
⚠️ 本机**没有** `WxBridgeSelfHeal` 任务 ⇒ 桥挂了无人自动拉起。

## P2 后端模块 `/api/wechat/*`（2026-10-13）
模块：`server/wechat-login.js`；在 `index.js` 里 1 行 `require` 注册（**必须在 `adminOnly` 定义之后**）。

| 端点 | 作用 |
|---|---|
| `GET /api/wechat/status` | 在线状态 + 二维码码龄 + 是否正在重置 + 全局默认对象 |
| `GET /api/wechat/qr` | 二维码 PNG（`no-store`；已登录时 409；未登录才给） |
| `POST /api/wechat/qr/refresh` | 落 `reset.request` → **202 异步**；120s 内重复点返回 `alreadyPending` |
| `GET /api/wechat/targets` | 可推送会话（群/个人，服务端已拼好 `webhook`）；支持 `?q=` |
| `POST /api/wechat/test-send` | 向指定会话发测试消息（复用 `sendWechatPush` 含重试与误报识别） |
| `GET/PUT /api/wechat/default-target` | 全局默认推送对象（`kv_config.wechat_default_target`）|

- **全部 adminOnly**（二维码=登录令牌）；**绝不可**加进 `PUBLIC_PATHS`/`PREFIX_PATHS`。无 token 实测 **401**。
- **刷新链路是"标志文件"**：后端只写 `wxb_qr/reset.request`，真正的重置由 `wx-qr-keepalive` 执行
  ⇒ **重置权只归守护一家**，无 `taskkill` 竞态；后端（`User=jsc`）也不需要 root/SSH 凭据。
  该文件能写，靠的是 `wxb_qr` 目录的 **setgid + 组写权限（2770 root:jsc）**。
- ⚠️ `PUT /default-target` 目前**只提供配置读写**；让推送链路回落到它要改 `strawWorkflow`（P3 的 T16）。
- 实测（2026-10-13）：6 个端点全通过；F4 从点击到出新码 **52 秒**。

## 桥看门狗（自愈）· 2026-10-13
重建后**没有** `WxBridgeSelfHeal` 任务（老 8/15 机上有）⇒ 桥挂了无人拉起，告警静默全丢。现补：
```
/usr/local/bin/wxbridge_watchdog.sh          （每分钟由 timer 触发）
/etc/systemd/system/wxbridge-watchdog.service
/etc/systemd/system/wxbridge-watchdog.timer  OnBootSec=120 OnUnitActiveSec=60
/var/log/wxbridge_watchdog.log               （含**心跳行**，健康时也写）
/var/lib/wxbridge_watchdog.state             （每小时重启计数，上限 6 次）
```
逻辑：`/ping` 连续 3 次不通 → **把所有监听 18888 的 PID 全杀**（收敛重复实例）→ 等端口释放
→ `schtasks /Run /TN WeChatBridge`（`/IT` ⇒ 交互式会话）→ 恢复后**核对「桥 session == 微信 session」**
（不相等 ⇒ 桥看不到微信窗口、发送必败，日志打 `RECOVERED_WARN`）。
- 判据用 `/ping` 而非 `/health`：`/ping` 是毫秒级、绝不触碰微信的纯存活探针。
- **为什么放 226 而不是 Windows 计划任务**：拉起桥的正解是 `schtasks /Run /TN WeChatBridge`（`/IT`），
  若在 Windows 侧再建一个任务去拉起，任务自身若落在 Session 0，拉起来的桥也在 Session 0 → 看不到微信窗口。
- ⚠️ **日志时间戳必须每行现算**：曾写成脚本启动时算一次的变量，结果一次自愈的十几行日志带同一个
  时间戳，完全看不出哪一步花了多久。
- 实测：杀掉桥 → `ALERT` → **25 秒**恢复到「实例数=1，bridge session=2，weixin session=2 ✅」。

## 责任映射表 `area_responsibility`（2026-10-13 重建）
原表随 2026-09-29 重装丢失，**本地无任何含该表的副本**（7/9 整机备份里连表都没建）。
现按 **2026-09-24 那次经用户认可的同一规则**重建 52 行：
- `town` 取自 `area_boundary`（52 个，含新 geojson 补上的**高梁镇**）—— 反查真源，必须一一对应
- `unit` 后缀推导：`X街道`→`X街道办事处`／`X镇`→`X镇人民政府`／`X乡`→`X乡人民政府`
- `district='万州区'`、`community=''`、**`person`/`phone` 留空**（用户 9/24 明确：推送按街道定对象，不细分责任人）
- `webhook` 沿用历史目标 `军哥`，IP 换成新桥 `172.16.8.16` ⚠️ **属占位**，登录后应在页面上按实际群/人重选
- 种子文件（可复现）：`deploy/HBJSC/data/area_responsibility_seed_20261013.json`
- 备份（含回滚 SQL）：`/data/HBJSC/backups/area_resp_backup_<ts>.json`
- 实测：导入 52 行；`unit`/`webhook` 无空值；**边界↔责任 52/52 全覆盖、无多余**；
  反查回归 **52/52 命中**；真实告警坐标 `(108.4319,30.7555)` → 百安坝街道 → 百安坝街道办事处 ✅

## 交付二维码给真人扫
```bash
bash infra/wechat-bridge/deploy/fetch_qr.sh --fresh      # 先强制重置换全新码再取
```
`latest.png` 码龄最长可达 ~3–4 分钟（= 微信自身换码周期），**直接交付可能"还没扫就过期"**，
所以要交给真人时加 `--fresh`（实测 20s 内出新码）。
`--fresh` 背后是 `/data/HBJSC/scripts/wx_qr_reset.sh`：taskkill → `WxLaunchQr` → 轮询新 md5。

---

# 2026-10-13 补充：登录态判据修正（用户报"被别处登录后不实时显示退出"）

## 故障与根因
微信在别处登录被顶下线后，页面仍显示"已登录"。根因链：
1. 桥的登录判据原为「能读 DB + 有会话/群数据」⇒ 但**掉线后磁盘 DB 仍可解密**
   （`DRIVER`/`DRIVER_NAME` 是模块级永久缓存，`WeChatDB` 密钥还缓存到 `workdir/keys.json`），
   于是 session/chat_room 仍有 100/106 行 ⇒ **驱动证据永远为真**。
2. 前端"已登录时 30s 才轮询一次"，也不够快。

## 修复（三处）
1. **桥以「窗口 UI」为权威**：只要能看到微信窗口，就按**有没有主窗**判：
   - 有主窗（实测 896x648）⇒ 已登录
   - 只有小窗 ⇒ **未登录**（硬否决，不看 DB 证据），并 `reset_driver()` 清掉陈旧缓存
   - 完全看不到窗口 ⇒ 才退回 DB 证据（可能是最小化到托盘）
   尺寸判据：小窗 `宽≤420 且 高≤460`；主窗 `宽≥700 且 高≥500`。
   ⚠️ **不能按标题挑**：被顶下线时的「提示」弹窗标题居然是 `Weixin`（复用了主窗口标题）。
   ⚠️ **不能按"登录窗是否存在"判**：登录窗在已登录时也可能残留。
2. **识别"正在自动更新"**：`weixin update` 窗口（548x380）落在尺寸死区。此时**不取码、不重启**
   （重启会打断升级）。但**若登录窗已出现**则照常取码 —— 升级完成后 update 窗会残留一会儿，
   不能因此停摆。残留的 `WeixinUpdate.exe` 可直接 `taskkill`。
3. **守护**改为以桥 `/login-state` 为主判据 + 本机窗口尺寸交叉确认；心跳 300s→**60s** 且
   **不再周期性抢微信前台**（只问桥，很便宜）。前端轮询已登录时 30s→**5s**。

## 另一处必改：二维码判据不能只看体积
微信 4.1.13.65 起，登录窗默认显示**「上次登录的账号卡片」**（头像+昵称+「登录」按钮），
**必须点「切换账号」才会出二维码**。头像让该区域 PNG 达 3.3KB，**骗过了原来的"≥2500B"下限**。
实测对比：
| 区域 | PNG 体积 | 暗像素占比(<110) |
|---|---|---|
| 真二维码 | 4155–8935 B | **0.473 ~ 0.478** |
| 账号卡片（头像） | 3297 B | **0.036** |
⇒ 判据加一条 **暗像素占比必须落在 0.30~0.62**（用 PIL 解码；226 已装 `python3-pil`）。
无 PIL 时退回只看体积（并会在日志里说明）。

## 新增能力：受控单次鼠标点击 `wx_click.py`
用途：点「切换账号」把二维码调出来。**安全边界**（改动前必读）：
- **只认预设名**（`switch_account` / `login` / `acknowledge`），坐标按窗口 rect **相对比例**算；
- **只注入鼠标事件，绝不注入键盘** —— 历史事故（xdotool 把命令敲进微信输入框）来自键盘注入；
- 三重校验：目标必须是**可见小窗** + 必须成功置前台且 `GetForegroundWindow()` 等于它 + 点完光标归位；
- 预设名经 `C:/wxbridge/deploy/click_preset.txt` 传递（绕开 `schtasks /TR` 引号地狱），**读完即删**。
```
printf 'switch_account' > /tmp/click_preset.txt
scp ... 到 C:/wxbridge/deploy/click_preset.txt
wmiexec ... 'schtasks /Run /TN WxClick'
```
⇒ `wx_qr_reset.sh` 已同步改造：**杀客户端 + 拉起 + 点「切换账号」+ 等新码**
（只重启不点击，现在只会回到账号卡片页）。

## 实测（2026-10-13 03:22）
```
wx_click: 点「切换账号」于 (660,574) window=296x388 置前台 OK
守护: 二维码判据通过：6787B 暗占比=0.478   ← 真二维码
```
