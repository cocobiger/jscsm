# JSC 驾驶舱系统 → Ubuntu 服务器迁移方案

> 目标服务器：`111.10.220.226:22333`（SSH 端口已改为 22333，非标准 22）  
> 迁移原则：**零影响大气快检项目**，端口/目录/服务完全隔离  
> 生成时间：2026-06-16

---

## 一、JSC 系统架构全景

### 1.1 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 前端 | React 18 + Vite 6 + TypeScript | 93 个源文件，MUI v7 + Recharts |
| 后端 | Express 4 + Node.js 22+ | CommonJS，端口 7170 |
| 数据库 | SQLite（`node:sqlite` 内置模块） | `jsc.db`，无外部数据库依赖 |
| 流媒体 | ZLMediaKit | RTSP → FLV/WebRTC 转发 |
| 短信 | 云 MAS | 重庆市万州区生态环境局 |
| 物联网 | MQTT（模拟模式） | 需真实 Broker 接入 |

### 1.2 目录结构（本机）

```
CC jsc/
├── src/                    # 前端源码（93 个文件）
│   ├── app/App.tsx         # 主路由
│   ├── app/components/     # 大屏组件 + AdminPanel
│   └── main.tsx            # 入口
├── server/                 # 后端 Express
│   ├── index.js            # 主服务（鉴权/API/角色矩阵）
│   ├── zlm.js              # ZLMediaKit REST API 封装
│   ├── sms-mas.js          # 云MAS 短信平台
│   ├── store-db.js         # SQLite 存储层（node:sqlite）
│   ├── stream-monitor.js   # 流媒体监控
│   ├── warning-engine.js   # 预警引擎
│   ├── crawler.js          # 网页采集
│   ├── auth.js             # 登录鉴权（会话存 jsc.db）
│   └── data/               # 数据目录（⚠️ 迁移核心）
│       ├── config.json     # API Key + ZLM 配置
│       ├── jsc.db          # SQLite（用户/采集数据）
│       ├── streams.json    # 视频流定义（17 条）
│       ├── map_points.json # 地图点位（21 个）
│       ├── warnings.json   # 预警记录
│       ├── datasources.json# 数据源配置
│       └── sms_*.json      # 短信相关
├── package.json            # 前端依赖（Vue 风格，实际是 React）
├── vite.config.ts          # Vite 配置（dev proxy → :7170）
└── dist/                   # `pnpm build` 输出（部署用）
```

### 1.3 依赖特点（迁移友好）

- ✅ **无原生 npm 依赖**：后端仅 `express/cors/uuid/cheerio`，纯 JS
- ✅ **SQLite 内置**：Node 22 的 `node:sqlite`，无需额外安装
- ✅ **数据文件自包含**：`server/data/` 整体拷贝即完成数据迁移
- ⚠️ **ZLMediaKit 除外**：需要单独部署（Docker 或编译安装）

---

## 二、Ubuntu 服务器现状（系统 B：大气快检）

| 项目 | 详情 |
|------|------|
| OS | Ubuntu 22.04.5 LTS |
| CPU | 96 核 |
| 内存 | 220 GB（空闲 99%） |
| 磁盘 | 1.5 TB（占用 < 1%） |
| Web 服务 | nginx 1.24.0，端口 80 |
| 现有项目 | `/var/www/admin/`（后台）+ `/var/www/dajiang/`（大屏） |
| nginx 配置 | `/etc/nginx/sites-available/uav-sites` |
| ffmpeg | ✅ 已安装（`/opt/ffmpeg/ffmpeg`） |
| Docker | ❌ 未安装 |
| Node.js | ❌ 未安装 |

### 2.1 现有 nginx 路由

```
http://111.10.220.226/          → /var/www/html/ (默认页)
http://111.10.220.226/admin/    → /var/www/admin/ (后台管理 SPA)
http://111.10.220.226/dajiang/  → /var/www/dajiang/ (实时可视化大屏)
```

---

## 三、迁移方案设计

### 3.1 隔离策略

| 维度 | 大气快检（系统 B） | JSC 驾驶舱（新） |
|------|-------------------|-----------------|
| nginx 站点 | `/admin/`、`/dajiang/` | `/jsc/` (前端) + `/jsc/api/` (代理) |
| 后端端口 | 无（纯静态） | `7170` |
| 流媒体端口 | 无 | `6080` (HTTP API)、`5540` (RTSP)、`1936` (RTMP) |
| 部署目录 | `/var/www/` | `/opt/jsc/` |
| 数据目录 | 无 | `/data/jsc/` |
| 系统用户 | root（不推荐） | `jsc`（新建专用用户） |
| SQLite | 无 | `/data/jsc/jsc.db` |
| systemd 服务 | 无 | `jsc-backend.service` |

### 3.2 访问地址规划

```
大屏页面：http://111.10.220.226/jsc/           → 静态文件（nginx 直出）
管理后台：http://111.10.220.226/jsc/admin       → 同一 SPA，路由区分
后端 API：http://111.10.220.226/jsc/api/...    → nginx 代理 → :7170
视频流：http://111.10.220.226:6080/...         → ZLMediaKit 直连（或 nginx 代理）
```

> 注：`/jsc/` 前缀通过 `vite.config.ts` 的 `base` 配置，构建时注入。

---

## 四、执行步骤

### Step 1：服务器环境准备

```bash
# SSH 登录（端口 22333）
ssh -p 22333 root@111.10.220.226

# 1. 新建专用用户
adduser jsc
usermod -aG sudo jsc

# 2. 安装 Node.js 22（使用 nvm）
su - jsc
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 22
node --version   # 应显示 v22.x.x

# 3. 安装 pnpm
npm install -g pnpm

# 4. 创建目录结构
sudo mkdir -p /opt/jsc
sudo mkdir -p /data/jsc
sudo chown -R jsc:jsc /opt/jsc /data/jsc

# 5. 安装 ZLMediaKit（二选一）
```

#### ZLMediaKit 安装选项

**选项 A：Docker 方式（推荐）**

```bash
# 安装 Docker
sudo apt update && sudo apt install -y docker.io
sudo systemctl enable docker && sudo systemctl start docker
sudo usermod -aG docker jsc

# 启动 ZLMediaKit
docker run -d \
  --name zlmediakit-jsc \
  --restart unless-stopped \
  -p 6080:8080 \
  -p 5540:5540 \
  -p 5540:5540/udp \
  -p 1936:1935 \
  -p 10000-10003:10000-10003 \
  -p 30000-30500:30000-30500/udp \
  -e TZ=Asia/Shanghai \
  zlmediakit/zlmediakit:master
```

**选项 B：编译安装（无 Docker 时）**

```bash
sudo apt install -y build-essential cmake git
git clone --depth 1 https://github.com/ZLMediaKit/ZLMediaKit.git
cd ZLMediaKit
git submodule update --init
mkdir build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
make -j$(nproc)
# 编译产物在 release/ 目录
```

---

### Step 2：构建前端（本机操作）

```bash
# 在本机（Windows）上
cd "E:\CC work\CC jsc"

# 修改 vite.config.ts，设置 base 路径
# export default defineConfig({
#   base: '/jsc/',   // ← 新增
#   ...
# })

# 安装依赖 + 构建
pnpm install
pnpm build

# 构建产物在 dist/ 目录
# 验证：dist/index.html 的静态资源路径应以 /jsc/ 开头
```

---

### Step 3：上传文件到服务器

```bash
# 在本机 PowerShell 执行（需要 WinSCP 或 scp）
# 1. 上传前端构建产物
scp -P 22333 -r dist/* jsc@111.10.220.226:/opt/jsc/frontend/

# 2. 上传后端代码
scp -P 22333 -r server/* jsc@111.10.220.226:/opt/jsc/backend/

# 3. 上传数据文件（⚠️ 包含敏感配置）
scp -P 22333 -r server/data/* jsc@111.10.220.226:/data/jsc/

# 4. 在服务器上安装后端依赖
ssh -p 22333 jsc@111.10.220.226
cd /opt/jsc/backend
npm install --production
```

---

### Step 4：配置 nginx（不影响现有站点）

在 `/etc/nginx/sites-available/uav-sites` 末尾追加：

```nginx
# ===== JSC 驾驶舱系统 =====
location /jsc/ {
    alias /opt/jsc/frontend/;
    try_files $uri $uri/ /jsc/index.html;
    
    # 缓存策略
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
        expires 7d;
        add_header Cache-Control "public, immutable";
    }
}

# JSC 后端 API 代理
location /jsc/api/ {
    proxy_pass http://127.0.0.1:7170/api/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    
    # WebSocket 支持（如需要）
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}

# ZLMediaKit 代理（可选，统一域名访问）
location /jsc/media/ {
    proxy_pass http://127.0.0.1:6080/;
    proxy_set_header Host $host;
}
```

应用配置：

```bash
sudo nginx -t          # 检查语法
sudo systemctl reload nginx
```

---

### Step 5：配置 systemd 服务

创建 `/etc/systemd/system/jsc-backend.service`：

```ini
[Unit]
Description=JSC 驾驶舱后端服务
After=network.target

[Service]
Type=simple
User=jsc
WorkingDirectory=/opt/jsc/backend
ExecStart=/home/jsc/.nvm/versions/node/v22.x.x/bin/node index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=DATA_DIR=/data/jsc

# 日志
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

启动服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable jsc-backend
sudo systemctl start jsc-backend
sudo systemctl status jsc-backend
```

---

### Step 6：数据迁移与配置更新

在服务器上编辑 `/data/jsc/config.json`：

```json
{
  "apiKey": "8b25eab6ccf6bd0bbc17b7bd22fb08a8fadfafa0d2f20c4b",
  "zlm": {
    "zlmHost": "127.0.0.1",
    "zlmPort": 6080,
    "zlmSecret": "<ZLMediaKit容器中实际的secret>",
    "scheme": "http",
    "httpsPort": 4443,
    "rtspPort": 5540,
    "rtmpPort": 1936
  }
}
```

> ⚠️ **重要**：`zlmSecret` 需要登录服务器执行 `docker logs zlmediakit-jsc | grep secret` 获取。

---

### Step 7：验证

```bash
# 1. 后端健康检查
curl http://127.0.0.1:7170/api/health

# 2. 前端访问
curl -I http://111.10.220.226/jsc/

# 3. API 代理验证
curl http://111.10.220.226/jsc/api/health

# 4. ZLMediaKit 验证
curl http://127.0.0.1:6080/index/api/getServerConfig?secret=<secret>
```

---

## 五、回滚方案

如果迁移出现问题：

```bash
# 1. 停止 JSC 后端
sudo systemctl stop jsc-backend

# 2. 移除 nginx JSC 配置块（或注释掉）
sudo nano /etc/nginx/sites-available/uav-sites

# 3. 重载 nginx
sudo systemctl reload nginx

# 4. 大气快检项目完全不受影响
curl http://111.10.220.226/admin/
curl http://111.10.220.226/dajiang/
```

---

## 六、后续优化建议

1. **HTTPS**：申请 SSL 证书（`certbot`），全站 HTTPS
2. **域名**：申请 `jsc.xxx.com` 或 `env.xxx.com` 子域名
3. **监控**：配置 `systemctl status jsc-backend` 告警
4. **备份**：每日自动备份 `/data/jsc/` 到异地
5. **Docker Compose**：将 JSC 后端 + ZLM 打包为 `docker-compose.yml`，方便管理

---

## 七、执行检查清单

- [ ] 服务器上创建 `jsc` 用户
- [ ] 安装 Node.js 22 + pnpm
- [ ] 构建前端（`pnpm build`，`base: /jsc/`）
- [ ] 上传 `dist/` → `/opt/jsc/frontend/`
- [ ] 上传 `server/` → `/opt/jsc/backend/`
- [ ] 上传 `data/` → `/data/jsc/`
- [ ] 安装后端 npm 依赖
- [ ] 部署 ZLMediaKit（Docker 或编译）
- [ ] 配置 nginx `/jsc/` 路由
- [ ] 创建 systemd 服务
- [ ] 启动后端，验证 API
- [ ] 验证前端页面
- [ ] 验证视频流代理
- [ ] 修改 `config.json` 中的 ZLM secret

---

## 附：快速部署脚本（概览）

```bash
# 服务器端一键部署（待完善）
#!/bin/bash
set -e

echo "=== JSC 系统部署脚本 ==="

# 1. 创建用户和目录
id jsc &>/dev/null || adduser --disabled-password --gecos "" jsc
mkdir -p /opt/jsc /data/jsc
chown -R jsc:jsc /opt/jsc /data/jsc

# 2. 安装 Node.js（通过 nvm）
su - jsc -c "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash && source ~/.bashrc && nvm install 22"

# 3. 安装 Docker + ZLMediaKit
apt update && apt install -y docker.io
docker run -d --name zlmediakit-jsc --restart unless-stopped \
  -p 6080:8080 -p 5540:5540 -p 1936:1935 \
  zlmediakit/zlmediakit:master

# 4. 部署后端（需要上传文件后执行）
# ...

echo "=== 部署完成 ==="
```

---

*本方案由 AI 助手生成，执行前请仔细核对每步操作。*
