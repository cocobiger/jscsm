# IoTCloud 视频分析对接 · 使用说明

> 适用对象：万州区生态环境局驾驶舱（JSC）运维人员、后台管理员
> 关联服务器：`172.16.8.11`（IoTCloud 物联视频平台，端口 6881=API / 6882=抓拍图）、`111.10.220.226`（JSC 后端，端口 7170 / 对外 81）
> 文档版本：2026-07-09

---

## 1. 这是什么

JSC 驾驶舱通过后端定时拉取 **IoTCloud 物联视频平台（172.16.8.11）** 上 NVR 设备的 AI 视频分析记录（堆头未覆盖、裸土、人员入侵、车辆违停、烟火等），写入驾驶舱告警管道，并做到：

- **后台存档**：按通道分类归档所有 AI 分析记录，可筛选、搜索、导出 CSV。
- **地图联动**：将 IoTCloud 通道与驾驶舱视频流（`coll_streams`）做 1:1 映射，通道产生 AI 推送时，对应摄像头图标在地图红闪告警（30 分钟内有效）。

---

## 2. 架构与数据流（简图）

```
IoTCloud 172.16.8.11:6881/prod-api
   │  (Bearer JWT, 每 30s 轮询)
   ▼
JSC 后端 iot-fetcher.js
   │  ├─ /sip/channel/list         → 远程通道（后台"通道接入"用）
   │  └─ /sip/analyse/record/list  → AI 分析记录
   │         │  transformToWarning()
   ▼
JSC SQLite (jsc.db → warnings 表, 类型 iot-video-analysis)
   │  ├─ /api/iot-analysis/archive  (存档, 公开读)
   │  ├─ /api/iot-analysis/status   (告警状态, 公开读)
   │  └─ /api/iot-image             (图片代理, 公开读)
   ▼
JSC 前端（驾驶舱地图 + 后台"AI分析存档"栏目）
```

图片地址说明：IoTCloud 返回的图片 URL 指向 `111.10.220.226:5001/images/detect/...` 或 `172.16.8.11:6882/profile/snap/...`，前端统一通过 `/api/iot-image?url=<编码后地址>` 代理访问（解决跨域 + 内网可达性问题）。

---

## 3. 前置条件（运维必读）

| 项目 | 说明 |
|------|------|
| 网络 | JSC 后端服务器需能直连 `172.16.8.11:6881`（局域网/专线）。**不走公网代理**。 |
| IoTCloud 账号 | 凭据已**外置为环境变量**（`IOT_CLOUD_BASE_URL` / `IOT_CLOUD_USERNAME` / `IOT_CLOUD_PASSWORD`），由 systemd 经 `/opt/jsc/backend/iotcloud.env`（chmod 600）注入，**源码不再含明文**。 |
| 端口 | 后端 7170（容器内），对外访问走 81 反代；图片代理用 6881/6882。 |
| 鉴权 | JSC 后台登录为 `Bearer` 会话令牌（非 cookie）。管理员账号才能操作"通道接入"。 |

> ⚠️ 若 IoTCloud 密码变更，**只需编辑服务器上的 `/opt/jsc/backend/iotcloud.env` 改 `IOT_CLOUD_PASSWORD`，然后 `systemctl restart jsc-backend`**；无需改动源码。

---

## 4. 后台操作指南

### 4.1 登录
驾驶舱右上角「管理」→ 输入管理员账号密码（当前为 `admin / admin123`）→ 进入后台左侧栏「AI分析存档」。

### 4.2 子标签一：存档记录（所有角色可见）
- **通道概览卡片**：按通道展示记录数、最近时间、坐标；红色圆点=当前告警中。
- **筛选/搜索**：可按通道、AI 类型下拉筛选，或输入关键词（通道名/类型/设备）。
- **导出 CSV**：导出当前筛选结果（含通道、类型、置信度、等级、时间、坐标、图片地址），带 UTF-8 BOM，Excel 直接打开中文不乱码。
- **模拟触发**（仅管理员）：向选中通道注入一条"当前时间"的 AI 记录，使驾驶舱对应摄像头红闪 30 分钟（用于演示/联调）。
- **定位**：点击通道卡片筛选后，可在地图定位（需配合驾驶舱"AI分析存档"按钮）。

### 4.3 子标签二：通道接入（仅管理员）
两栏布局：

**左栏 · 远程通道（IoTCloud NVR 设备通道）**
- 列出 IoTCloud 的全部 NVR 通道（探测当前共 9 个），带抓拍缩略图。
- 「已接入」标签表示该通道已在本地 `iot_channels` 表中。
- 点「＋ 接入」：把该远程通道写入本地表（若通道名与某视频流同名，自动推荐映射）。

**右栏 · 已接入通道与映射**
- 下拉选择要绑定的**驾驶舱视频流**（同名通道自动标「✓推荐」，被占用的标「已被XX占用」）。
- 「启用中 / 已停用」：启用才会进入轮询与告警；停用=草稿态（有记录不亮灯）。
- 「移除」：软删除（保留数据，可重新接入）。

**关键语义**
| 状态 | 行为 |
|------|------|
| 已接入 + 已映射 + 启用 | 轮询入档，且 AI 推送时驾驶舱对应摄像头红闪 |
| 已接入 + 未映射 | 仍入档为存档，但**不联动摄像头**（草稿态） |
| 已停用 | 停止轮询，不告警 |

改动 **30 秒内** 自动生效（后端每轮热加载 `iot_channels` 表），无需重启。

---

## 5. 通道 ↔ 摄像头地理坐标触发对应

- 每个 IoTCloud 通道通过 `channel_sip_id`（20 位国标 ID）在 `iot_channels` 表中关联到 `coll_streams.id`（驾驶舱视频流）。
- 坐标来源：由关联的驾驶舱视频流经纬度驱动（而非 IoTCloud 自身的经纬度字段），以保证摄像头图标在地图上的位置与驾驶舱一致。
- 触发逻辑：后端每轮检查该通道最新一条 AI 记录的时间，若在 **30 分钟**（`alertTtlMs`）内，则 `status` 接口标记 `alerting=true`，前端地图对应摄像头图标红闪。

> 注意：IoTCloud 当前以**历史分析归档**为主，新推送到来的频率取决于现场设备。常态下若无新记录，`alerting` 为 false；可用「模拟触发」验证联动效果。

---

## 6. 数据表 `iot_channels` 字段说明

| 字段 | 含义 |
|------|------|
| `channel_sip_id` | IoTCloud 国标通道 ID（主键，20 位） |
| `channel_name` | 通道名称（如"九龙沙场""苏商码头"） |
| `device_sip_id` | 所属 NVR 设备 ID |
| `device_name` | 设备名（NVR） |
| `stream_id` | 关联的驾驶舱视频流 `coll_streams.id`，可空 |
| `enabled` | 是否启用（1/0） |
| `remark` | 备注 |
| `created_at` / `updated_at` | 时间戳（ISO） |
| `deleted_at` | 软删除时间，空=未删 |

---

## 7. 常见问题排查

**Q1：后台"通道接入"左侧远程通道为空白？**
- 先硬刷新（Ctrl+F5）清缓存，重新登录。
- 确认管理员账号（通道接入仅 admin 可见）。
- 检查 JSC 后端能否连通 `172.16.8.11:6881`（`curl` 内网探测）；IoTCloud 账号密码是否在 `/opt/jsc/backend/iotcloud.env` 中配置正确。
- 查看后端日志：`journalctl -u jsc-backend -f | grep IoT`。

**Q2：通道抓拍缩略图 / 检测图不显示？**
- 图片走 `/api/iot-image` 代理，仅允许 `111.10.220.226`、`172.16.8.11` 两个 host，且路径须含 `/images/` 或 `/profile/snap/`。
- 若 IoTCloud 图片服务器端口/路径变更，需同步调整代理白名单（`iot-fetcher.js` 的 `proxyImage`）。

**Q3：摄像头图标不红闪？**
- 确认通道已「启用 + 已映射 + 未停用」。
- 确认有**新** AI 记录（或点「模拟触发」验证）。
- 红闪仅 30 分钟有效，超时自动熄灭。

**Q4：管理员密码忘了？**
- 登录服务器执行：`node -e "require('./auth').adminSetPassword(<用户id>,'新密码',false)"`（详见运维章节）。

---

## 8. 运维命令

```bash
# 重启后端（IoT 轮询随之重启）
systemctl restart jsc-backend

# 实时查看 IoT 拉取日志
journalctl -u jsc-backend -f | grep "\[IoT\]"

# 手动触发一次拉取（调试）
curl -X POST http://127.0.0.1:7170/api/iot-fetch/now \
  -H "Authorization: Bearer <管理员token>"

# 重置管理员密码（forceChange=false 表示不强制改密）
cd /opt/jsc/backend
node -e "const a=require('./auth'); a.adminSetPassword('<id>','admin123',false); console.log('ok')"

# 验证 IoTCloud 账号可用
curl -s -X POST http://172.16.8.11:6881/prod-api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"iot-video","password":"<密码>"}'

# 查看/修改凭据（改密后需 restart）
cat /opt/jsc/backend/iotcloud.env
```

> 💡 凭据位置：服务器 `/opt/jsc/backend/iotcloud.env`（chmod 600，属主 jsc）。由 systemd 服务文件的 `EnvironmentFile=` 注入，源码 `iot-fetcher.js` 仅读 `process.env.IOT_CLOUD_*`。

---

## 9. 相关接口速查

| 方法/路径 | 鉴权 | 用途 |
|-----------|------|------|
| `GET /api/iot-analysis/archive` | 公开 | 按通道分类的 AI 历史存档 |
| `GET /api/iot-analysis/status` | 公开 | 通道实时告警状态（驱动地图红闪） |
| `GET /api/iot-image?url=` | 公开 | 图片代理（跨域 + 内网可达） |
| `GET /api/iot-analysis/iot-channels` | admin | 远程通道列表（代理 IoTCloud） |
| `GET/POST/PUT/DELETE /api/iot-channels` | admin | 本地通道 CRUD（1:1 映射） |
| `POST /api/iot-analysis/simulate` | 登录 | 模拟触发一条告警 |
| `POST /api/iot-fetch/now` | 登录 | 手动触发立即拉取 |

---

*本文档配套《IoT视频分析对接-评估报告.md》说明实现质量与优化建议。*
