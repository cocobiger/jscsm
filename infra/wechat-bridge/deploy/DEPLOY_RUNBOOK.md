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
- **已登录即静默**：判据是 `/health` 的 `driver` / `sessions` / `wechat_version` **非 null**。
  ⚠️ `/health` 的 `wx:"connected"` 是**内存态假健康**，不能用来判断登录！

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

## 交付二维码给真人扫
```bash
bash infra/wechat-bridge/deploy/fetch_qr.sh --fresh      # 先强制重置换全新码再取
```
`latest.png` 码龄最长可达 ~3–4 分钟（= 微信自身换码周期），**直接交付可能"还没扫就过期"**，
所以要交给真人时加 `--fresh`（实测 20s 内出新码）。
`--fresh` 背后是 `/data/HBJSC/scripts/wx_qr_reset.sh`：taskkill → `WxLaunchQr` → 轮询新 md5。
