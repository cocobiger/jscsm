# Ubuntu 服务器系统 B 调研报告

> 调研时间：2026-06-16 00:30 (GMT+8)
> 目标服务器：`111.10.220.226` (内网 `172.16.8.12`)
> SSH 端口：22333（已自定义非默认 22）

---

## 一、服务器基础信息

| 项目 | 值 |
|------|-----|
| 公网 IP | `111.10.220.226` |
| 内网 IP | `172.16.8.12` |
| Hostname | `userver` |
| 操作系统 | **Ubuntu 22.04.5 LTS** (Jammy Jellyfish) |
| 内核 | `5.15.0-181-generic` |
| 启动时长 | 7 天 8 小时 |
| CPU | **96 核** |
| 内存 | **220 GiB**（已用 1.1 GiB，可用 217 GiB） |
| 磁盘 | 1.5 TB（已用 16 GB / 1%） |
| Swap | 8 GB |
| Docker | ❌ **未安装**（`docker: command not found`） |
| systemd | ✅ 运行中 |
| 防火墙 | iptables 全 ACCEPT（依赖云厂商安全组） |

---

## 二、监听端口（核心资产）

```
80      nginx（公网可访问）
22333   sshd（自定义端口，公网可访问）
53      systemd-resolve（仅 lo）
```

**仅 2 个对外服务**：nginx 和 sshd。

### 进程列表
- nginx：1 个 master + 96 个 worker（`worker_processes auto`，匹配 96 核）
- sshd：当前会话
- systemd：pid 1
- 没有其他业务进程

---

## 三、nginx 配置分析

### 3.1 主配置 `/etc/nginx/nginx.conf`
```nginx
user www-data;
worker_processes auto;          # 匹配 96 核
events { worker_connections 768; }
http {
    sendfile on;
    tcp_nopush on;
    gzip on;
    ssl_protocols TLSv1 TLSv1.1 TLSv1.2 TLSv1.3;
    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;   # 仅引用 uav-sites
}
```

### 3.2 站点 `/etc/nginx/sites-enabled/uav-sites`
```nginx
server {
    listen 80;
    server_name _;
    absolute_redirect off;

    location = /admin  { return 302 /admin/; }
    location = /dajiang { return 302 /dajiang/; }

    location /admin/ {
        alias /var/www/admin/;
        index index.html;
        try_files $uri $uri/ /admin/index.html;
    }

    location /dajiang/ {
        alias /var/www/dajiang/;
        index index.html;
        try_files $uri $uri/ /dajiang/index.html;
    }
}
```

**结论：纯静态托管，无后端反向代理、无 API 网关。**

### 3.3 加载模块
- `50-mod-http-geoip2`
- `50-mod-http-image-filter`
- `50-mod-http-xslt-filter`
- `50-mod-mail`、`50-mod-stream`
- `70-mod-stream-geoip2`

### 3.4 访问测试
| URL | 本机 (127.0.0.1) | 公网 (111.10.220.226) |
|------|----------------|-------------------|
| `/` | HTTP 200, 612 字节（默认欢迎页）| 访问被拦截 |
| `/admin/` | HTTP 200 | 未测 |
| `/dajiang/` | HTTP 200 | 未测 |

> 公网访问 `111.10.220.226:80` 出现 `HTTP 000`（连接失败），但 nginx access log 显示来自公网 IP（93.123.72.183、204.76.203.206 等）的请求都有记录 → **说明 nginx 在监听 80，但 ISP/云厂商可能在更高层拦截了 80 端口入站（合规要求）**。
> 错误日志显示这些公网请求实际走的是 `:81`（`host: "111.10.220.226:81"`），说明可能存在 NAT 80→81 映射。

---

## 四、站点应用（系统 B = "大气快检"）

### 4.1 应用清单
| 目录 | 名称 | 角色 |
|------|------|------|
| `/var/www/admin/` | 后台管理 | 完整 SPA（含 echarts、路由：login/dashboard/data/plan/inspection/rule/log/role/user 等 60+ 文件） |
| `/var/www/dajiang/` | 实时可视化 | 单页大屏（1.04 MB JS，371 KB CSS） |

### 4.2 文件特征
- `admin`：构建产物含 hash 文件名，体积大（ECharts 1.1 MB），功能复杂
- `dajiang`：单一 `index-B_IgQVa3.js` + `index-BngW8kym.css`，是单页大屏
- 都是 **Vite 打包后的 dist 静态资源**（含 `index-XXX.js` hash 命名、`<script type="module">`）
- 构建时间：`2026-05-25`（同一批次发布）

### 4.3 缺失证据
- ❌ **没有找到后端代码**（无 `package.json`、无 `node_modules`、无 Python/Go/Java 后端）
- ❌ **没有数据库**（无 MySQL/PostgreSQL/Redis/SQLite）
- ❌ **没有 systemd 服务**（除 sshd、nginx、vmtoolsd、cloud-init 外无业务服务）
- ❌ **没有 Docker 容器**
- ❌ **没有 /api 反向代理**

### 4.4 推断结论
系统 B 是**纯前端静态站点**，无独立后端进程。前端应用所调用的 API 应该都跑在**别的服务器上**（比如客户已有的 API 集群、IoT 平台、或第三方 SaaS）。

---

## 五、辅助工具与文件

### 5.1 `/opt/`
```
/opt/ffmpeg/                    # 静态编译 ffmpeg + ffprobe（sansaoye 用户拥有，2024-08-23）
/opt/ffmpeg/ffmpeg              # 76 MB 主程序
/opt/ffmpeg/ffprobe             # 76 MB 探测工具
/opt/ffmpeg/qt-faststart        # MP4 元数据优化
/opt/ffmpeg/model/              # AI 模型目录
/opt/scripts/record_stream.sh   # 视频流录像脚本
/opt/scripts/test_stream.sh     # 拉流测试脚本
/opt/ffmpeg-release-amd64-static.tar.xz  # 安装包备份（39 MB）
```

### 5.2 `/opt/scripts/record_stream.sh`（录像脚本）
- 入参：`<流名称> <流URL> <录制秒数>`
- 默认时长 300s
- 输出：`/data/recordings/${NAME}/${NAME}_YYYYmmdd_HHMMSS.mp4`
- 自动清理 30 天前的录像
- 记录日志到 `/data/recordings/${NAME}/record.log` 和 `ffmpeg.log`

### 5.3 `/data/`
- 仅 `/data/recordings/`（空目录，未启动过录像）

### 5.4 系统用户
- `root`
- `sansaoye`（曾安装 ffmpeg 的用户）
- `www-data`（nginx worker 运行用户）
- `sshd`

---

## 六、SSH 安全配置

```
Port 22333                    # 已修改非默认端口 ✅
PermitRootLogin yes           # ⚠️ 允许 root 远程登录
PubkeyAuthentication yes      # ✅ 启用公钥认证
PasswordAuthentication yes    # 隐式允许（未显式禁用）
X11Forwarding yes
KbdInteractiveAuthentication no
```

---

## 七、安全 / 风险提示

### ⚠️ 关键问题

1. **公网 80 端口疑似被运营商/云厂商封禁**
   - 错误日志显示所有公网请求实际打到 `:81`
   - 用户从公网访问 `http://111.10.220.226/` 返回 HTTP 000（连接失败）
   - **可能需要走 HTTPS（443）或改其他端口**

2. **PermitRootLogin yes + 弱密码风险**
   - 当前用的是用户提供的明文密码登录
   - **建议改用公私钥认证，并禁用密码登录**

3. **大量公网扫描请求**
   - access log 中大量 `GET /SDK/webLanguage`、`GET /wiki` 等扫描痕迹
   - 来自全球数十个 IP
   - **建议加 fail2ban + 限制敏感路径**

4. **没有 HSTS / HTTPS**
   - 纯 HTTP 80，前端无 HTTPS 加密
   - 系统 B 的登录/管理页面在公网是明文传输

5. **没有 fail2ban、没有 ufw、没有云厂商安全组审计痕迹**
   - 全部依赖云厂商安全组（iptables 是空的）

---

## 八、可供 JSC 系统迁移的资源

| 资源 | 现状 | 是否可用 |
|------|------|----------|
| 80 端口 | 被 nginx 占用 | ❌ 需换端口 |
| 22333 端口 | sshd | ✅ 保留 |
| 磁盘 1.4 TB | 充足 | ✅ 充裕 |
| 内存 220 GB | 几乎全空闲 | ✅ 充裕 |
| 96 核 CPU | 空闲 | ✅ 充裕 |
| ffmpeg 静态包 | `/opt/ffmpeg/ffmpeg` | ✅ 可直接复用 |
| `/data/` | 已规划录像目录 | ✅ 可借用作 JSC 数据目录 |
| nginx | 单站点简单配置 | ✅ 加 vhost 即可共用 |

### 建议的 JSC 系统隔离方案

| 项目 | 端口/路径 |
|------|----------|
| JSC 前端 Vite 静态站 | `:7080/admin/` + `:7080/dajiang/`，改为 `:8080/jsc/` vhost |
| JSC 后端 Node | `:7170` |
| ZLMediaKit | `:6080`（HTTP API）、`:554`（RTSP）、`:1935`（RTMP）、`:8000`（GB28181） |
| 数据库（如果引入） | `:3307`（MySQL/MariaDB） |
| EMQX MQTT | `:1883`（MQTT）、`:18083`（管理） |
| 部署目录 | `/opt/jsc/`，数据 `/data/jsc/` |
| 运行用户 | 新建 `jsc` 非 root 用户 |

---

## 九、总结

**系统 B 是一个"轻量化大气快检前端展示平台"**：
- 单 nginx 静态托管
- 两个 SPA：`/admin/`（管理端）+ `/dajiang/`（实时大屏）
- 无后端、无数据库、无中间件
- 配套 ffmpeg 录像脚本

**资源极度充裕**（96 核 / 220 GB / 1.4 TB），完全可以**直接在同机部署 JSC 系统**，重点是：
1. 与现有 nginx 站点**端口隔离 + 路径隔离**
2. 必要时**反向代理整合**到 80/443
3. **安全加固**：HTTPS、fail2ban、公网白名单
