# 方案 B 生产部署手册（Windows Server）

> 万州区生态环境局智能 AI 大数据驾驶舱
> 架构：**Nginx 托管前端静态 + 反代 /api → NSSM 守护的 Node 后端(:7170)**

---

## 0. 部署架构

```
            浏览器
              │  http(s)://服务器IP
              ▼
        ┌───────────────┐
        │  Nginx :80/443 │
        │   ├ /     → 静态托管  C:\jsc\dist  (前端构建产物)
        │   └ /api  → 反代 127.0.0.1:7170
        └───────────────┘
              │
              ▼
   ┌────────────────────────────┐
   │ Node 后端 :7170 (NSSM 服务) │  数据 → C:\jsc\server\data\jsc.db (SQLite)
   └────────────────────────────┘

   旁路（不经 Nginx）：
     浏览器 ──WS──> MQTT Broker(:8083)        传感器数据
     浏览器 ──FLV─> ZLMediaKit                视频流播放
```

> MQTT 与视频流由浏览器直连对应服务，Nginx 只管前端与 `/api`。

---

## 1. 目录规划（建议）

| 路径 | 用途 |
| --- | --- |
| `C:\jsc\` | 项目根（前端源码 + `server\` 后端） |
| `C:\jsc\dist\` | Nginx 托管的前端构建产物（由 deploy.ps1 发布） |
| `C:\jsc\server\data\` | 后端数据目录（`jsc.db` + config.json，**核心，务必备份**） |
| `C:\jsc\nginx\` | Nginx 安装目录 |
| `C:\jsc\tools\nssm.exe` | NSSM 可执行 |
| `C:\jsc\logs\` | 后端服务日志 |
| `C:\jsc\releases\` | 前端历史发布备份（自动，留最近 5 份） |
| `D:\backup\jsc\` | 数据定期备份输出 |

把整个项目放到 `C:\jsc\`。若用别的路径，需同步修改各脚本顶部变量与 `nginx\jsc.conf` 中的 `root`。

---

## 2. 前置软件

| 软件 | 版本 | 安装 |
| --- | --- | --- |
| Node.js | ≥18（推荐 22） | 官网安装包，勾选"加入 PATH" |
| pnpm | ≥9 | `npm i -g pnpm` |
| Git | 任意 | **必装**，依赖里有从 GitHub 拉取的包 |
| Nginx for Windows | 稳定版 | nginx.org 下载，解压到 `C:\jsc\nginx` |
| NSSM | 2.24+ | https://nssm.cc/download ，把 `nssm.exe` 放 `C:\jsc\tools\` |

---

## 3. 首次部署步骤

### 3.1 装依赖

```powershell
cd C:\jsc
pnpm install            # 前端依赖
cd server
npm install             # 后端依赖
cd ..
```

### 3.2 检查配置

- **`.env`**（前端高德 Key）：确认 `VITE_AMAP_KEY` / `VITE_AMAP_SECURITY`。换账号则改新 Key（构建时会编译进产物，改完要重新 build）。
- 后端 `server\data\config.json` 存 ZLM / 短信网关配置（无则首启自动生成空壳）。
- 后端数据库 `server\data\jsc.db` 首启自动创建并种子默认数据 + 默认管理员账号。

### 3.3 注册并启动后端服务

```powershell
# 管理员 PowerShell
cd C:\jsc\deploy
.\install-backend-service.ps1
```

首次启动后端会在日志（`C:\jsc\logs\backend-out.log`）打印**默认管理员账号**：

```
用户名: admin
密码:   admin123   （首次登录强制改密）
```

后续登录、新建用户、分配角色都在前端「用户管理」里完成，**不再需要 API Key**。

### 3.4 配置 Nginx

1. 把 `deploy\nginx\jsc.conf` 复制到 `C:\jsc\nginx\conf\`。
2. 编辑 `C:\jsc\nginx\conf\nginx.conf`，在 `http { }` 块内加一行：
   ```
   include  jsc.conf;
   ```
3. 确认 `jsc.conf` 里 `root C:/jsc/dist;` 与实际发布目录一致（**用正斜杠**）。
4. 如平台短信回调出口 IP 有变，改 `jsc.conf` 顶部 `geo $sms_callback_allowed` 白名单。

### 3.5 构建并发布前端

```powershell
cd C:\jsc
.\deploy\deploy.ps1
```

脚本会：构建 → 备份旧版 → 发布到 `C:\jsc\dist` → 测试并 reload Nginx。

### 3.6 验证

```powershell
# 后端健康检查（各数据文件条数）
Invoke-RestMethod -Uri "http://localhost:7170/api/health"
Invoke-RestMethod -Uri "http://localhost:7170/api/health/files"

# 经 Nginx 走一遍（前端 + 反代）
Invoke-RestMethod -Uri "http://localhost/api/health"
```

浏览器访问 `http://<服务器内网IP>/`，进入**登录页**用 `admin/admin123` 登录（首登强制改密），确认视频流、地图、采集数据正常。

---

## 4. 日常运维

### 发布新版本（改了前端代码后）
```powershell
cd C:\jsc
git pull          # 或手动更新源码
.\deploy\deploy.ps1
```

### 回滚前端到上一版
```powershell
.\deploy\deploy.ps1 -Rollback
```

### 后端服务管理
```powershell
C:\jsc\tools\nssm.exe restart JscBackend
C:\jsc\tools\nssm.exe stop    JscBackend
C:\jsc\tools\nssm.exe status  JscBackend
# 卸载服务
cd C:\jsc\deploy; .\install-backend-service.ps1 -Uninstall
```
后端代码更新后需 `nssm restart JscBackend` 生效。

### 后端日志
```powershell
Get-Content C:\jsc\logs\backend-out.log -Tail 100 -Wait
Get-Content C:\jsc\logs\backend-err.log -Tail 100
```

### 数据备份（建议每日任务计划）
```powershell
.\deploy\backup-data.ps1
# 注册每日 02:00 自动备份（备份整个 data\ 目录，含 jsc.db + config.json）：
schtasks /create /tn "JscDataBackup" /tr "powershell -ExecutionPolicy Bypass -File C:\jsc\deploy\backup-data.ps1" /sc daily /st 02:00 /ru SYSTEM
```

> 核心数据现已统一在 `server\data\jsc.db`（SQLite）。`backup-data.ps1` 备份整个 `data\` 目录，已覆盖 jsc.db。
> 备份/还原数据库时，建议先停后端服务（`nssm stop JscBackend`）再复制 jsc.db，避免热拷贝不一致。

### 单文件损坏恢复（后端自带）
```powershell
# 业务数据已在 SQLite，无需逐文件恢复；此接口现仅对仍为 JSON 的 sms_history/sms_reports 有效
Invoke-RestMethod -Uri "http://localhost:7170/api/health/restore" -Method Post `
  -ContentType "application/json" -Body '{"file":"sms_history","ver":1}'
```

---

## 5. 防火墙与端口

| 端口 | 用途 | 对外开放 |
| --- | --- | --- |
| 80 / 443 | Nginx（用户访问入口） | 是 |
| 7170 | Node 后端 | **否**（仅本机，由 Nginx 反代）|
| 8083 | MQTT Broker WS | 客户端可达即可 |
| ZLM 相关 | 视频流 | 客户端可达即可 |

建议用 Windows 防火墙**只放行 80/443**，关闭 7170 的外部访问——虽然后端现已全接口登录鉴权，但不直接暴露内部端口仍是好习惯。

---

## 6. 外部依赖对接（换网络/换机后必查）

| 项目 | 检查点 | 在哪改 |
| --- | --- | --- |
| ZLMediaKit | 地址/端口是否可达 | 管理后台「视频流管理」或 `POST /api/zlm/config` |
| MQTT Broker | broker 地址、WS 端口连通 | 管理后台「MQTT 配置」 |
| 云 MAS 短信 | **服务器公网/出口 IP 加入平台白名单**；回调 IP 写入 `jsc.conf` | MAS 平台 + `jsc.conf` |
| 高德地图 | 需互联网；换 Key 改 `.env` 后重新 build | `.env` |
| 摄像头 / 采集源 | 新网络下流地址、采集源是否可达 | 管理后台对应配置页 |

---

## 7. 安全要点

- 后端鉴权（`auth.js`）采用**用户名密码登录 + 三级角色**，**所有接口都需登录**（短信平台回调除外）：
  - 角色：管理员（全权限+用户管理）/ 值守员（处理预警、发短信、触发采集）/ 访客（只读+看视频）；
  - 会话 token 存数据库，默认 7 天有效；密码用 scrypt 加盐哈希存储。
  - 首启默认管理员 `admin/admin123`，**务必首次登录后立即改密**。
- 短信回调 `/api/sms/report`、`/api/sms/upstream` 不参与登录鉴权，已在 `jsc.conf` 做来源 IP 白名单。
- 防火墙不暴露 7170；有条件时为 Nginx 启用 HTTPS（`jsc.conf` 末尾有模板）。
- `server\data\jsc.db` 含**用户账号与密码哈希**、`config.json` 含 ZLM secret/短信密钥，**纳入备份且妥善保管**，不要进版本库。

---

## 8. 文件清单（deploy\）

| 文件 | 作用 |
| --- | --- |
| `nginx\jsc.conf` | Nginx 生产配置（静态托管 + /api 反代 + 回调白名单 + gzip + SPA fallback） |
| `install-backend-service.ps1` | 用 NSSM 注册后端为 Windows 服务（自启 + 崩溃重启 + 日志） |
| `deploy.ps1` | 前端构建 + 发布 + reload，支持 `-BuildOnly` / `-Rollback` |
| `backup-data.ps1` | 数据目录打包备份，保留最近 N 份 |
| `register-backup-task.ps1` | 注册每日自动备份的 Windows 计划任务 |
| `..\server\migrate-collected-to-db.js` | 一次性迁移：把旧 JSON 数据导入 SQLite（换机/升级时跑一次） |
| `部署手册-方案B-Windows.md` | 本文档 |
| `启动方法与路径速查.md` | 启动方法与路径速查 |
