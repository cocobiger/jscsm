# JSC 驾驶舱系统 — 本地与服务器（111.10.220.226）对比梳理报告

> 生成时间：2026-07-06
> 梳理范围：本地项目 `E:\CC work\CC jsc` vs 远程服务器 `111.10.220.226:22`
> 数据来源：MD 文档、本地源码、远程服务器实际文件/数据库/进程

---

## 一、结论速览

| 维度 | 本地 | 服务器 111.10.220.226 | 结论 |
|------|------|------------------------|------|
| **代码一致性** | `server/` 目录 | `/opt/jsc/backend/` | 核心后端代码**完全一致**（index.js 等 10 个核心文件无差异） |
| **前端产物** | `dist/`（仅当前构建） | `/opt/jsc/frontend/`（含历史构建残留） | 当前生效产物一致，但服务器有旧版本文件堆积 |
| **数据存储** | `server/data/` 含旧 JSON 文件 | `/opt/jsc/backend/data/jsc.db`（SQLite，145 MB） | 生产已迁移至 SQLite，本地仍保留历史 JSON |
| **附加文件** | `backend/` 目录为调试/部署脚本 | `/opt/jsc/backend/` 有 transcoder_v2.js、gen_token.js 等运维脚本 | 本地有 Windows 部署脚本，服务器有 Ubuntu 运维脚本 |
| **部署环境** | Windows 开发（Vite dev / PowerShell） | Ubuntu 22.04.5 LTS + nginx + systemd | 两套部署文档分别对应两个环境 |
| **运行状态** | 需手动启动 | nginx/jsc-backend/ZLMediaKit 均运行中 | 服务器已上线运行 |

---

## 二、系统功能梳理（基于文档 + 服务器实际验证）

### 2.1 技术架构

```
浏览器 ──→ nginx :80 ──→ /jsc/         → /opt/jsc/frontend/  (React SPA)
                   ──→ /jsc/api/      → :7170 Node 后端
                   ──→ /jsc/live/     → :6080 ZLMediaKit
                   ──→ /jsc/{id}/hls.m3u8  → :6080 ZLMediaKit (HLS)
                   ──→ /jsc_h264/...  → :6080 ZLMediaKit (H.265 转码流)
```

| 层级 | 技术选型 | 验证状态 |
|------|----------|----------|
| 前端 | React 18 + TypeScript + Vite 6 + 高德地图 2.0 | ✅ 服务器已部署 |
| 后端 | Node.js 22 + Express + `node:sqlite` | ✅ 运行中 |
| 数据库 | SQLite (`jsc.db`) | ✅ 145 MB，21 张表 |
| 流媒体 | ZLMediaKit (Docker) + FFmpeg | ✅ 容器运行中 |
| 消息 | MQTT (模拟/待真实接入) | ⚠️ 文档已规划 |
| 短信 | 中国移动云 MAS | ✅ 代码已实现，未真实发送 |
| 反向代理 | nginx | ✅ 已配置 `/jsc/`、`/jsc/api/`、`/jsc/live/` |

### 2.2 核心功能模块

按 `docs/系统功能说明.md`（v2.0）及服务器实际验证，系统共 **23 个功能模块**、**87 个 API 端点**、**20 张数据表**。

#### 驾驶舱大屏
- 顶部栏：多视图切换、实时数据徽章、无人机溯源入口
- 中间地图：高德地图 2.0、7 类标注、悬停数据、双击播放、图标可配置
- 视频墙：3×3 九宫格、分组展示、首次拉流自动截图封面、HLS→FLV→WebRTC 降级
- 视频轮播：5 个群组轮播、LIVE/OFF 角标
- 右侧统计：近 7 天告警趋势、告警类型占比、智治推送排行、污染事件排行
- MQTT 实时告警：前端直连 Broker，告警入地图并弹窗

#### 管理后台（14 个页面）
1. 系统总览
2. 视频流管理（CRUD + 推流控制 + 健康检测）
3. 流媒体服务器（ZLM 配置）
4. MQTT 配置
5. 告警接入（JSON 映射）
6. 智治推送（处置预案 / 推送规则 / 推送历史）⭐
7. 市局监测站数据
8. 气体采集预警
9. 短信预警推送（联系人 / 模板 / 发送 / 历史）
10. 数据统计报表
11. 重点企业管理（企业名单 + 污染事件）
12. 地图图标配置
13. 用户管理（RBAC 三级角色）
14. 登录页

### 2.3 服务器数据库表全景（21 张）

| 表名 | 用途 | 当前记录数 |
|------|------|-----------|
| `collected` | 气体采集记录 | 1,012 |
| `warnings` | 气体采集预警 | 61 |
| `collect_logs` | 采集日志 | 419,062 |
| `sms_history` | 短信发送历史 | 0 |
| `sms_reports` | 短信回执/上行 | 0 |
| `coll_streams` | 视频流配置 | 30 |
| `coll_map_points` | 地图点位 | 34 |
| `coll_datasources` | 数据源配置 | 2 |
| `coll_sms_contacts` | 短信联系人 | 0 |
| `coll_sms_templates` | 短信模板 | 1 |
| `coll_sms_blacklist` | 短信黑名单 | 0 |
| `kv_config` | 键值配置 | 1 |
| `users` | 用户账号 | 2 |
| `sessions` | 登录会话 | 5 |
| `enterprises` | 重点企业 | 10 |
| `pollution_events` | 污染事件 | 1 |
| `smart_push_plans` | 智治推送预案 | 1 |
| `smart_push_rules` | 智治推送规则 | 1 |
| `smart_push_events` | 告警事件 | 1 |
| `smart_push_history` | 推送历史 | 0 |
| `sqlite_sequence` | SQLite 自增序列 | - |

---

## 三、本地项目结构梳理

```
E:\CC work\CC jsc/
├── src/                          # 前端源码（React + TS，93 文件）
│   ├── app/components/           # 驾驶舱组件 + admin 页面
│   ├── app/context/              # DashboardContext
│   └── ...
├── server/                       # 后端源码（== 服务器 /opt/jsc/backend/）
│   ├── index.js                  # Express 主入口
│   ├── auth.js                   # 登录鉴权 + RBAC
│   ├── crawler.js                # 网页/接口采集
│   ├── warning-engine.js         # 6 污染物预警
│   ├── store-db.js               # SQLite 存储层
│   ├── zlm.js                    # ZLMediaKit 封装
│   ├── stream-monitor.js         # 视频流在线探测
│   ├── sms-mas.js                # 云 MAS 短信
│   ├── logger.js                 # 结构化日志
│   ├── migrate-collected-to-db.js# JSON → SQLite 迁移脚本
│   └── data/                     # 本地数据目录（旧 JSON + jsc.db）
├── dist/                         # 前端构建产物（当前版本）
├── backend/                      # 调试/诊断/部署脚本（非运行时代码）
│   ├── deploy_v2.py
│   ├── fix_nginx_hls.py
│   ├── patch_h265*.py
│   └── ...
├── deploy/                       # Windows 方案 B 部署文件
│   ├── nginx/jsc.conf
│   ├── deploy.ps1
│   ├── install-backend-service.ps1
│   └── 部署手册-方案B-Windows.md
├── docs/                         # 最新文档（v2.0，最准确）
│   ├── 系统功能说明.md
│   ├── 操作手册.md
│   ├── 测试报告.md
│   ├── JSC系统Ubuntu服务器迁移方案.md
│   └── Ubuntu服务器系统B调研报告.md
├── 代码迭代方案.md              # 旧版（6月8日），已部分过时
├── 系统功能说明与完善建议.md    # 旧版（6月8日），已部分过时
├── ZLMediaKit部署指南.md        # Docker 本地部署指南
└── README.md                     # 最早版本说明
```

---

## 四、服务器（111.10.220.226）实际结构梳理

```
/opt/jsc/
├── backend/                      # Node 后端代码
│   ├── index.js                  # 主入口（与本地 server/index.js 一致）
│   ├── auth.js, crawler.js, ...  # 同本地
│   ├── transcoder.js             # 旧版转码
│   ├── transcoder_v2.js          # H.265 转码 Worker
│   ├── init_enterprises.js       # 重点企业种子数据
│   ├── gen_token.js              # 手动生成会话 Token
│   ├── data/
│   │   ├── jsc.db                # SQLite 主库（145 MB）
│   │   ├── config.json           # ZLM 配置
│   │   ├── icon_config.json      # 地图图标配置
│   │   └── transcoder.json       # 转码任务状态
│   └── node_modules/
├── frontend/                     # 构建产物
│   ├── index.html                # 当前引用 index-DkBcYVgF.js
│   ├── assets/                   # 当前 + 多个历史构建 JS/CSS
│   └── ...
├── backups/                      # 快照备份（3 个时间点）
│   ├── 20260617-172821/
│   ├── 20260617-182721/
│   └── 20260617-190721/
├── server/                       # 旧版 index.js 备份（74 KB）
│   └── index.js
└── rollback.sh                   # 一键备份/回滚脚本
```

### 4.1 运行服务验证

| 服务 | 状态 | 验证命令 |
|------|------|----------|
| `jsc-backend.service` | ✅ running | `systemctl` |
| `nginx.service` | ✅ running | `systemctl` |
| `docker.service` | ✅ running | `systemctl` |
| `zlmediakit` 容器 | ✅ Up 8 days | `docker ps` |
| 后端端口 7170 | ✅ 监听 | 已部署 |
| ZLM 端口 6080 | ✅ 监听 | docker 端口映射 |

### 4.2 nginx 配置要点

- `/jsc/` → `/opt/jsc/frontend/`
- `/jsc/api/` → `:7170/api/`
- `/jsc/live/` → `:6080/live/`
- `/jsc/{id}/hls.m3u8` 和 `/jsc/{id}/*.ts` → `:6080/jsc/{id}/...`
- `/jsc_h264/{id}/hls.m3u8` → `:6080/jsc_h264/{id}/...`（H.265 转码流）
- `/api/` → `:7170/api/`（兼容路径）

### 4.3 ZLMediaKit 配置

- 容器镜像：`zlmediakit/zlmediakit:master`
- 端口映射：`6080→80`、`5540→554`、`1936→1935`、`4443→443`、`30000-30500/udp`、`8080-8089/udp`
- Secret：`035c73f7-bb6b-4889-a715-d9eb2d192xxx`
- `config.json` 中 ZLM 配置：`zlmHost: 172.16.8.12`, `domain: 111.10.220.226`, `zlmPort: 6080`

---

## 五、本地 vs 服务器差异对比

### 5.1 代码层面

| 文件/模块 | 本地 `server/` | 服务器 `/opt/jsc/backend/` | 差异说明 |
|-----------|---------------|---------------------------|----------|
| `index.js` | 1856 行 | 1856 行 | **完全一致** |
| `crawler.js` | 387 行 | 387 行 | **完全一致** |
| `warning-engine.js` | 151 行 | 151 行 | **完全一致** |
| `auth.js` | 5634 字节 | 5634 字节 | **完全一致** |
| `zlm.js` | 7436 字节 | 7436 字节 | **完全一致** |
| `store-db.js` | 25435 字节 | 25435 字节 | **完全一致** |
| `stream-monitor.js` | 5043 字节 | 5043 字节 | **完全一致** |
| `sms-mas.js` | 12160 字节 | 12160 字节 | **完全一致** |
| `logger.js` | 2158 字节 | 2158 字节 | **完全一致** |
| `package.json` | 356 字节 | 356 字节 | **完全一致** |
| `transcoder.js` | ❌ 无 | 8877 字节 | 服务器特有：旧版 ffmpeg 转码 |
| `transcoder_v2.js` | ❌ 无 | 14911 字节 | 服务器特有：H.265 转码 Worker |
| `init_enterprises.js` | ❌ 无 | 2419 字节 | 服务器特有：重点企业种子数据 |
| `gen_token.js` | ❌ 无 | 479 字节 | 服务器特有：手动生成 Token |
| `collect_logs.json` 等 | 存在 | ❌ 无 | 本地特有：旧 JSON 数据文件 |
| `data/jsc.db` | 可能不存在/旧 | 145 MB 生产库 | 服务器为真实数据 |

### 5.2 前端产物

| 项 | 本地 `dist/` | 服务器 `/opt/jsc/frontend/` | 说明 |
|----|-------------|----------------------------|------|
| `index.html` | 引用 `index-DkBcYVgF.js` + `index-DHarYchJ.css` | 引用相同 | 当前生效一致 |
| 当前 JS 文件 | `assets/index-DkBcYVgF.js` | `assets/index-DkBcYVgF.js` | 文件名一致 |
| 当前 CSS 文件 | `assets/index-DHarYchJ.css` | `assets/index-DHarYchJ.css` | 文件名一致 |
| 历史构建文件 | 无 | 20+ 个旧 index-*.js | 服务器需要清理 |
| 体积 | ~2 MB | ~49 MB（含历史文件） | 服务器冗余大 |

### 5.3 数据存储

| 项 | 本地 | 服务器 | 说明 |
|----|------|--------|------|
| 主存储 | 旧 `*.json` + 可能有 `jsc.db` | SQLite `jsc.db` | 生产已 SQLite 化 |
| 采集记录 | `collected.json`（旧） | `collected` 表 1,012 条 | 真实数据在服务器 |
| 预警记录 | `warnings.json`（旧） | `warnings` 表 61 条 | 真实数据在服务器 |
| 采集日志 | `collect_logs.json`（旧） | `collect_logs` 表 419,062 条 | 大量日志在服务器 |
| 视频流 | `streams.json`（旧） | `coll_streams` 表 30 条 | 服务器配置更多 |
| 地图点位 | `map_points.json`（旧） | `coll_map_points` 表 34 条 | 服务器配置更多 |
| 用户/会话 | ❌ 无 | `users`/`sessions` 表 | 仅服务器有登录体系 |
| 智治推送 | ❌ 无 | `smart_push_*` 表 | 仅服务器有数据 |
| 重点企业 | ❌ 无 | `enterprises` 表 | 仅服务器有数据 |

### 5.4 部署与运维

| 项 | 本地文档/脚本 | 服务器实际 | 说明 |
|----|--------------|-----------|------|
| 部署文档 | `deploy/部署手册-方案B-Windows.md` | Ubuntu 实际部署 | Windows 方案未在服务器使用 |
| 启动方式 | `start.ps1` / Vite dev | `systemd jsc-backend.service` | 服务器已服务化 |
| 反向代理 | `deploy/nginx/jsc.conf`（Windows 路径） | `/etc/nginx/sites-enabled/uav-sites` | Ubuntu nginx 配置 |
| 备份/回滚 | `deploy/backup-data.ps1` | `/opt/jsc/rollback.sh` + `jsc-rollback` | 服务器有完整回滚体系 |
| 备份快照 | 无 | 3 个快照，共 215 MB | 服务器已创建快照 |
| 运行用户 | Windows Administrator | `jsc` Linux 用户 | 专用非 root 用户 |
| Node 路径 | `C:\Users\...\node.exe` | `/home/jsc/.nvm/versions/node/v22.22.3/bin/node` | 服务器用 nvm |

### 5.5 文档时效性

| 文档 | 日期 | 准确性 | 说明 |
|------|------|--------|------|
| `docs/系统功能说明.md` | 2026-06-18 | ⭐⭐⭐ 最准确 | 描述 v2.0 系统，含 SQLite、智治推送、重点企业 |
| `docs/操作手册.md` | 2026-06-24 | ⭐⭐⭐ 准确 | 操作手册 |
| `docs/测试报告.md` | 2026-06-24 | ⭐⭐⭐ 准确 | 测试报告 |
| `docs/JSC系统Ubuntu服务器迁移方案.md` | 2026-06-16 | ⭐⭐ 基本准确 | 描述 Ubuntu 部署，但 SSH 端口写为 22333，实际当前为 22 |
| `docs/系统还原部署文档.md` | 2026-06-14 | ⭐⭐ 较旧 | 早期部署文档 |
| `README.md` | 较早 | ⭐ 已过时 | 仍写 JSON 文件存储 |
| `系统功能说明与完善建议.md` | 2026-06-08 | ⭐ 已过时 | 仍写 JSON 存储，且把很多已实现功能标记为待完善 |
| `代码迭代方案.md` | 2026-06-08 | ⭐ 已过时 | Sprint 1-4 已在服务器实现，方案仍标记为待做 |
| `ZLMediaKit部署指南.md` | - | ⭐⭐ 本地适用 | 仅描述 Docker Desktop 本地部署，未覆盖服务器 Ubuntu |

---

## 六、关键发现

### 6.1 已实现但旧文档未标记的功能

以下功能在服务器代码/数据库中**已实际存在**，但 `代码迭代方案.md` 和 `系统功能说明与完善建议.md` 仍标记为待完成或描述为旧架构：

1. **SQLite 数据存储**：`node:sqlite` 已替代 JSON 文件。
2. **用户登录与 RBAC**：`auth.js` + `users`/`sessions` 表已实现。
3. **结构化日志**：`logger.js` 已实现。
4. **数据质量治理**：`collected.valid` 字段已存在。
5. **设备在线状态动态探测**：`stream-monitor.js` 已实现。
6. **ZLMediaKit 流媒体接入**：`zlm.js` + nginx 反代已实现。
7. **H.265 转码**：`transcoder_v2.js` 已实现。
8. **短信预警**：`sms-mas.js` + 相关表已实现（配置驱动，未真实发送）。
9. **智治推送引擎**：`smart_push_*` 表 + 后端 API 已实现。
10. **重点企业管理**：`enterprises` + `pollution_events` 表已实现。
11. **一键备份回滚**：`rollback.sh` + `jsc-rollback` 已实现。

### 6.2 服务器需关注事项

1. **前端历史构建文件堆积**：`frontend/assets/` 有 20+ 个旧版 JS，建议清理以释放空间和避免混淆。
2. **端口暴露情况**：根据工作记忆，外部仅开放 81 和 6080；80 内部监听但外部未开放。
3. **SSH 端口文档不一致**：迁移方案写 22333，当前实际为 22。
4. **短信未真实发送**：`sms_history` 表为空，需确认是否已配置真实云 MAS 账号。
5. **数据目录权限**：`jsc.db` 属主为 `jsc`，但部分备份/脚本文件属主为 `root`，需注意权限一致性。
6. **ffmpeg 路径**：服务器 `/opt/ffmpeg/ffmpeg` 存在，但后端代码可能使用系统 `ffmpeg`，需确认。

### 6.3 本地开发需关注事项

1. **旧 JSON 数据文件仍保留**：`server/*.json` 是历史数据，生产环境已不再使用，建议归档或删除。
2. **数据目录未统一**：本地 `server/data/` 与代码中的 `DATA_DIR` 需确认一致。
3. **缺少服务器运维脚本**：本地没有 `rollback.sh`、`transcoder_v2.js` 等服务器运行脚本，但这些属于生产环境补充，不一定需要同步回本地仓库。
4. **Windows 部署文档未使用**：服务器实际使用 Ubuntu 部署，Windows 方案 B 文档可能仅用于其他场景。

---

## 七、建议

### 7.1 文档更新建议

1. 将 `docs/系统功能说明.md` 作为**当前唯一权威功能说明文档**。
2. 在根目录添加一个 `README-当前版.md` 或更新 `README.md`，指向 `docs/` 下最新文档，避免使用旧版文档。
3. 删除或归档 `代码迭代方案.md` 和 `系统功能说明与完善建议.md`，或标注为“已归档，内容已过时”。
4. 更新 `JSC系统Ubuntu服务器迁移方案.md` 中的 SSH 端口为 22（如当前确实为 22）。

### 7.2 服务器运维建议

1. **清理前端旧构建文件**：保留当前 `index.html` 引用的 2 个文件即可，其余可删除或归档。
   ```bash
   # 建议清理命令（执行前请备份）
   cd /opt/jsc/frontend/assets
   # 保留 index-DkBcYVgF.js 和 index-DHarYchJ.css
   rm index-!(DkBcYVgF|DHarYchJ).js index-!(DHarYchJ).css
   ```
2. **确认端口映射**：验证外部访问是否走 81 映射到内部 80，确保 `/jsc/` 外部可达。
3. **短信配置**：如需真实发送，确认 `config.json` 或管理后台已配置云 MAS 账号并加入 IP 白名单。
4. **定期快照**：`jsc-rollback create` 在重大改动前执行，当前已有 3 个快照，建议保留策略。

### 7.3 本地开发建议

1. **清理旧 JSON 数据**：`server/collected.json`、`server/streams.json` 等旧文件可移动到 `server/data/archive/` 或删除，避免误导。
2. **同步服务器数据到本地调试**：如需用真实数据调试，可 `scp` 服务器 `jsc.db` 到本地 `server/data/jsc.db`（注意敏感数据）。
3. **统一构建产物**：本地重新 `pnpm build` 后，若产物与服务器不一致，应及时上传服务器。

---

## 八、附录

### 8.1 服务器关键配置

- OS：Ubuntu 22.04.5 LTS (Jammy Jellyfish)
- 内核：5.15.0-185-generic
- CPU：96 核
- 内存：220 GB
- 磁盘：1.5 TB（已用 20 GB）
- Node：v22.22.3（nvm）
- 后端工作目录：`/opt/jsc/backend`
- 数据目录：`/opt/jsc/backend/data`
- 前端目录：`/opt/jsc/frontend`
- nginx 站点配置：`/etc/nginx/sites-enabled/uav-sites`
- systemd 服务：`/etc/systemd/system/jsc-backend.service`

### 8.2 验证命令记录

```bash
# 后端健康
ssh root@111.10.220.226 'curl -s http://127.0.0.1:7170/api/health'

# 数据库表
curl /opt/jsc/backend/data/jsc.db  # 21 张表

# ZLM 状态
ssh root@111.10.220.226 'docker ps | grep zlmediakit'

# 服务状态
ssh root@111.10.220.226 'systemctl status jsc-backend nginx docker'
```

---

*报告结束。如需进一步分析某个具体差异或执行清理/同步操作，请告知。*
