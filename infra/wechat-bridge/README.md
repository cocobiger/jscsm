# 普通微信群推送桥接服务（方案 B）

## 一、解决什么问题

秸秆告警的微信群推送，官方只支持「**企业微信群机器人**」（webhook）。
但对接单位（街道办等）用的是**普通微信群**（个人微信建的群），没有官方推送接口。

本方案在**一台常驻 Windows 机器**上部署一个桥接服务：用 wxauto 操作本机微信 PC
客户端，把 jsc 后端发来的告警消息，转发到指定的普通微信群。

**核心优势：jsc 后端代码零改动**——只需把街道的 webhook 填成
`http://<Windows机IP>:18888/send?group=<群名>`，格式与企微完全兼容。

## 二、架构

```
Linux 服务器 111.10.220.226（告警产生）
  └─ strawWorkflow → fetch(webhook)          ← webhook 指向 Windows 机
       │  {msgtype:"news"|"markdown"}          （企微格式，零改动）
       ▼
Windows 常驻机 :18888（本服务）
  ├─ wechat_bot_server.py → 解析 → 下载卡片图 → wxauto → 发送
  └─ 微信 PC 客户端（小号常驻登录）
```

消息流：
- 有告警卡片图 → 发 `news` → 桥接服务下载图片（picurl）→ 先发图片，再发文字
- 无卡片图 → 发 `markdown` → 桥接服务转纯文本 → 发文字

## 三、部署步骤

### 1. 准备 Windows 常驻机

- 建议用 **ESXi 上的 Windows VM**（172.16.8.24 宿主）或一台 7x24 开机的 Windows
- 确认 Linux 服务器能访问它：在 111.10.220.226 上执行
  `curl -s http://<Windows机IP>:18888/health`（服务启动后可测）

### 2. 安装 Python 依赖

```
pip install -r requirements.txt
```

### 3. 准备微信（关键！）

**⚠️ 微信版本矩阵（2026-08 实测）**：wxauto 靠操作微信窗口控件（UIAutomation）发消息，
微信 4.1.12+ 改用了 Qt 自绘渲染，控件树完全不暴露，任何 wxauto 系库都失效。所以：

| 微信 PC 版本 | 可用的自动化库 | 说明 |
|---|---|---|
| **3.9.x** | `wxauto`（原版，已停更但可用） | 最稳，但要找 3.9 安装包 |
| **4.0.5** | `wxauto4`（`pip install wxauto4`） | 唯一支持微信 4.0 的库，**仅限 4.0.5** |
| 4.1.12+ | ❌ 无 | 无法自动化，桥接服务失效 |

步骤：

1. 安装**微信 PC 客户端 4.0.5 或 3.9.x**（建议 4.0.5 + `wxauto4`，下载时展开 GitHub 对应 Release 的 Assets 找 exe；建议用小号，避免打扰主号）
2. **关闭微信自动更新**（设置 → 通用设置 → 取消"自动更新"）——微信一旦升级到 4.1.12+，桥接服务立即失效，这是本方案最大的运维风险
3. 登录小号，**先手动把目标群在「最近会话」里打开过一次**（wxauto 只能操作会话列表里已有的群）
4. 微信窗口保持打开、不要最小化到托盘隐藏（部分版本最小化会导致 UIA 无法操作）

### 4. 启动服务

```
python wechat_bot_server.py --port 18888
```

> 若控制台日志中文显示乱码，先执行 `set PYTHONIOENCODING=utf-8` 再启动
> （代码已内置 UTF-8 日志，此步仅为 Windows 控制台显示优化，非必需）。

### 5. Windows 防火墙放行

入站规则放行 **TCP 18888**（局域网内网可访问即可，不建议映射公网）。

### 6. 开机自启 + 崩溃自愈（NSSM 服务）

**已落地（2026-08-31，Windows VM 172.16.8.15）**：用 NSSM 把服务注册为
`WeChatBridge`，开机自启 + 进程崩溃 5 秒自动重启 + 日志轮转：

```powershell
# install_nssm_service.ps1 已实现以下等效命令
nssm install WeChatBridge "C:\Python311\python.exe" "C:\wxbridge\wechat_bot_server.py"
nssm set WeChatBridge AppDirectory "C:\wxbridge"
nssm set WeChatBridge AppStdout  "C:\wxbridge\service_stdout.log"
nssm set WeChatBridge AppStderr  "C:\wxbridge\service_stderr.log"
nssm set WeChatBridge AppRotateFiles 1
nssm set WeChatBridge AppRotateBytes 10485760   # 10MB 轮转
nssm set WeChatBridge ExitAction Restart        # 崩溃自动重启
nssm set WeChatBridge RestartDelay 5000         # 5 秒后重启
nssm start WeChatBridge
```

配套：`C:\wxbridge\nssm.exe`；微信客户端通过「启动文件夹快捷方式
WeChatBridge.lnk」随 VM 登录自动拉起（快捷方式指向
`C:\Program Files\Tencent\Weixin\Weixin.exe`）。

**自愈验证结果（verify_nssm_only.ps1，杀进程实测）**：

| 检查项 | 结果 |
|---|---|
| 杀掉所有 python 后 NSSM 是否重启 | ✅ 新进程 PID 23592（00:42:41 启动） |
| 重启后 /health 响应 | ✅ HTTP 200 |
| 服务日志 | ✅ 启动完成，监听 0.0.0.0:18888 |
| 微信客户端 | ⚠️ 被杀进程连带关闭，需重新登录（预期行为） |

> 注意：NSSM 只保证服务进程存活；微信 PC 客户端掉线仍需人工
> 重新登录（小号常驻 VM 桌面）。

### 7. jsc 管理后台配置

管理后台 →「秸秆焚烧监控」→「检测结果」→ **责任映射管理** → 编辑对应街道 → 在
`webhook` 字段填入：

```
http://<Windows机IP>:18888/send?group=万州区秸秆处置群
```

> 群名用中文即可（后端 fetch 会自动 URL 编码，服务端自动解码）。
> 群名不需要全名，填**唯一关键字**即可（如"秸秆"），服务端按关键字匹配会话。

## 四、验证

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | 浏览器/curl 访问 `http://<IP>:18888/health` | `{"ok":true,"wx":"connected","sessions":N}` |
| 2 | 后端触发一条真实告警（或模拟） | 微信群收到卡片图 + 文字，后端推送状态=成功 |
| 3 | 管理后台看该条告警推送状态 | reason="推送成功" |

手工测试（在服务器上模拟一条 markdown 推送）：
```
curl -X POST "http://<Windows机IP>:18888/send?group=秸秆" \
  -H "Content-Type: application/json" \
  -d '{"msgtype":"markdown","markdown":{"content":"**测试**\\n> 这是一条来自桥接服务的测试消息"}}'
```

## 五、常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `/health` 返回 `wx: "..."` 报错 | 微信未登录/未启动 | 登录微信小号，保持窗口打开 |
| 返回"未找到群「xx」" | 群不在最近会话列表 | 先在微信里打开该群一次，或换个更短的关键字 |
| 发送后群里收不到 | 微信窗口最小化/被遮挡 | 保持微信窗口可见，取消"最小化到托盘" |
| 微信提示登录环境异常 | 虚拟机/异地登录风控 | 小号 + 登录设备保持固定；必要时企业认证 |
| wxauto 报 API 不兼容 | 微信版本与 wxauto 不匹配 | 对照版本表升级/降级 wxauto |

## 六、风险与建议

1. **封号风险**：wxauto 属非官方自动化，违反微信用户协议，**务必用小号**，控制发送频率
2. **升级风险**：微信升级后桥接服务可能失效，禁止自动更新，升级前先备份
3. **单点依赖**：Windows 机掉线/微信掉线 = 推送中断；建议加一个 `/health` 定时探活
   （可对接 jsc 已有的服务监控，或简单的 cron + 微信/邮件告警）
4. 若后续要求更高稳定性，可评估「企业微信群」（方案 A）作为双通道备份

## 七、文件清单

```
wechat-bridge/
├── wechat_bot_server.py          # 主服务（Flask + wxauto4，协议兼容企微）
├── requirements.txt              # Python 依赖（flask / requests / wxauto4）
├── install.ps1 / install_full.ps1 / silent_install*.ps1   # 微信静默安装脚本
├── start_wechat.ps1 / show_wechat*.ps1 / bring_wechat_front.sh  # 微信拉起/前置脚本
├── install_nssm_service.ps1      # NSSM 服务注册（开机自启+崩溃自愈）
├── verify_nssm_only.ps1          # NSSM 自愈独立验证（杀 python 实测）
├── weixin_4.0.5.27.exe           # 微信 PC 4.0.5 安装包（wxauto4 唯一兼容版）
├── restart_wxbridge.ps1 / restart_wxb_v2.ps1   # 服务重启脚本
├── verify_nssm_result.txt        # 自愈验证日志（2026-08-31）
└── README.md                     # 本文档
```

## 八、部署现状（2026-08-31）

| 项 | 值 |
|---|---|
| Windows 常驻机 | 172.16.8.15（ESXi VM，RDP 通过 111.10.220.226 转发） |
| 服务名 | WeChatBridge（NSSM，AUTO_START，ExitAction=Restart） |
| 服务目录 | `C:\wxbridge\`（wechat_bot_server.py + nssm.exe + 日志） |
| Python | `C:\Python311\python.exe`（wxauto4 已装） |
| 微信客户端 | 4.0.5（已加入 VM 登录自启动） |
| 监听端口 | 18888（内网） |
| 外网探测 | `curl http://172.16.8.15:18888/health` |

### 运维备忘
- 重启服务：RDP 到 VM → `nssm restart WeChatBridge`（或 PowerShell `Restart-Service`）
- 日志：`C:\wxbridge\service_stderr.log`（10MB 轮转）
- 微信掉线处理：RDP 到 VM 重新登录微信小号，服务会自动重新连接
- 备份：`C:\wxbridge\` 整目录 + 微信安装包（weixin_4.0.5.27.exe 已存档本目录）
```
