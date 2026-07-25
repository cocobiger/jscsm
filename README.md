# 万州区生态环境局智能AI大数据控制台

多协议视频监控驾驶舱，支持 HTTP-FLV、WebRTC、RTSP、HLS、ONVIF、GB28181 协议。

## 环境要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | 18+ | 前端构建 + 后端服务 |
| pnpm | 8+ | 前端包管理 (`npm i -g pnpm`) |
| ffmpeg | 任意版本 | RTSP 转 FLV 流转发（可选） |

## 快速启动

### 1. 启动前端

```bash
# 项目根目录
pnpm install
pnpm dev
# 访问 http://localhost:5173
```

### 2. 启动后端（可选，流转发 + 设备管理）

```bash
cd server
npm install
npm start
# 服务运行在 http://localhost:7070
```

前端通过 `/api` 代理自动转发到后端，无需额外配置。

## 项目架构

```
项目根目录/
├── src/
│   ├── app/
│   │   ├── App.tsx                    # 根组件，驾驶舱 / 管理后台路由
│   │   ├── context/
│   │   │   └── DashboardContext.tsx   # 全局状态（视频流、MQTT、告警）
│   │   └── components/
│   │       ├── TopBar.tsx             # 顶部标题栏（时间/AQI/管理入口）
│   │       ├── LeftPanel.tsx          # 左侧：大气/水质/设备状态
│   │       ├── CenterPanel.tsx        # 中间：地图视图 + 三态切换
│   │       ├── RightPanel.tsx         # 右侧：告警 + 视频轮巡 + 统计
│   │       ├── VideoCarousel.tsx      # 多分组视频缩略图轮播
│   │       ├── VideoPlayerModal.tsx   # 视频播放弹窗（FLV/WebRTC/多宫格）
│   │       └── admin/
│   │           ├── AdminPanel.tsx     # 管理后台外壳
│   │           ├── VideoStreamPage.tsx # 视频流增删改（含 GB28181 配置）
│   │           ├── MqttPage.tsx       # MQTT Broker 配置
│   │           ├── AlertFormatPage.tsx # 告警 JSON 字段映射
│   │           └── OverviewPage.tsx   # 系统总览 / 数据日志
├── server/
│   ├── index.js      # Express 后端（端口 7070）
│   ├── package.json
│   └── streams.json  # 持久化流配置（自动生成）
└── vite.config.ts    # /api → localhost:7070 代理
```

## 视频协议接入说明

### HTTP-FLV（推荐）
在管理后台"视频流管理"中添加 `.flv` 结尾的地址，播放器自动识别并使用 mpegts.js 播放：
```
http://192.168.1.100:8080/live/camera1.flv
```

### WebRTC / WHEP
填写 `webrtc://` 或 `whep://` 开头的地址，播放器使用 RTCPeerConnection 低延迟播放：
```
webrtc://192.168.1.100:1985/live/camera1
```

### RTSP（通过转发服务）
1. 在后端配置 [ZLMediaKit](https://github.com/ZLMediaKit/ZLMediaKit) 或 [SRS](https://github.com/ossrs/srs)
2. 将 RTSP 推流到 ZLMediaKit，它会自动输出 HTTP-FLV
3. 在前端填写 ZLMediaKit 输出的 FLV 地址

### ONVIF 设备发现
调用后端 API：
```bash
POST http://localhost:7070/api/onvif/scan
{ "subnet": "192.168.1" }
```

### GB28181 国标接入
在管理后台"视频流管理"中选择 GB28181 协议，填写：
- SIP 服务器地址 / 端口 / 国标编码
- 设备国标编码 / 通道编码
- 用户名 / 密码 / 传输协议

推荐配合 [WVP-PRO](https://github.com/648540858/wvp-GB28181-pro) 完成 SIP 信令接入，其输出的 FLV/WS-FLV 地址可直接填入本系统播放。

## 后端 API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/health | 健康检查 |
| GET | /api/streams | 获取所有流配置 |
| POST | /api/streams | 添加流 |
| PATCH | /api/streams/:id | 修改流 |
| DELETE | /api/streams/:id | 删除流 |
| GET | /api/map-points | 获取地图点位（可加 ?type=air/water/alert/uav/watermon） |
| POST | /api/map-points | 添加地图点位 |
| PATCH | /api/map-points/:id | 修改地图点位 |
| DELETE | /api/map-points/:id | 删除地图点位 |
| POST | /api/stream/start | 启动 RTSP→FLV 转发（需 ffmpeg） |
| DELETE | /api/stream/stop/:id | 停止转发 |
| GET | /api/stream/status | 当前转发状态 |
| POST | /api/onvif/scan | 扫描 ONVIF 设备 |
| GET | /api/onvif/devices | 获取已发现设备 |
| POST | /api/onvif/stream-url | 获取 ONVIF 设备的 RTSP 地址 |
| POST | /api/gb28181/invite | GB28181 邀请播放（需 SIP 平台配合） |
| GET | /api/datasources | 获取气体采集数据源列表 |
| POST | /api/datasources | 新增数据源 |
| PATCH | /api/datasources/:id | 修改数据源 |
| DELETE | /api/datasources/:id | 删除数据源 |
| POST | /api/datasources/:id/test | 测试数据源连通性 |
| POST | /api/collect/run/:id | 手动触发采集（网页爬取） |
| GET | /api/collected | 查看采集数据 |
| GET | /api/warnings | 查看预警记录 |
| GET | /api/collect-logs | 查看采集日志 |
| GET | /api/warning-rules | 获取预警规则阈值表 |

## 气体采集预警模块

市监测站气体采集预警模块，覆盖数据采集、预警判断、采集日志全流程。在管理后台「气体采集预警」页操作。

### 数据采集
- 支持 html_crawl（网页爬取）、http、mqtt、mysql、tcp 五种数据源类型
- 网页爬取使用 cheerio 解析官方空气质量发布页表格，自动标准化为统一结构
- 配置驱动：目标 URL、点位过滤、采集周期、超时均可在后台配置
- 异常处理：超时重试 2 次（间隔 3s）、连续失败熔断（10 分钟暂停）、解析失败告警、部分点位缺失不中断
- 数据校验：非空、时间格式、时间合理性（拒未来/超24h）、AQI 范围 0-500、点位+时间去重

### 预警规则（6 种污染物）
| 污染物 | 不预警 | 5小时增长预警 | 跨阈值预警 | 固定值 |
|--------|--------|---------------|------------|--------|
| PM2.5 | ≤30 | 30<v≤60 且5h增长≥40% | 跨 75/115/150 | 无 |
| PM10 | ≤45 | 45<v≤120 且5h增长≥40% | 跨 150/250/350 | 无 |
| SO₂ | <20 | 无 | 无 | 无 |
| NO₂ | ≤30 | >30 且5h增长≥40% | 无 | 无 |
| O₃ | ≤160 | 无 | 跨 160 | 无 |
| CO | ≤1 | 无 | 无 | >1 |

5小时增长预警以「当前+前4小时」窗口最低值为基准；跨阈值要求前一小时在阈值下、当前跨到阈值上。

### 短信推送
短信联系人、模版、云 MAS 接口配置为后续阶段，当前为配置驱动占位（接口已预留，未真实调用平台）。

### 数据存储
采用 JSON 文件存储（纯 JS，无需数据库）：datasources.json、collected.json、warnings.json、collect_logs.json，首次启动自动生成。

## 数据接入（MQTT）

1. 进入管理后台 → MQTT 配置
2. 填写 Broker 地址（`ws://ip:8083/mqtt`）、用户名密码
3. 添加订阅 Topic，选择数据类型（大气质量 / 水质 / 告警 / 设备状态）
4. 点击"连接" → 数据自动渲染到驾驶舱

## 故障排查

**pnpm install 失败**：确认 Node.js ≥ 18，执行 `npm i -g pnpm`

**HTTP-FLV 在 HTTPS 下不播放**：浏览器拦截混合内容，改用 HTTPS 流地址或在 HTTP 环境下运行

**ffmpeg 转发失败**：确认 `ffmpeg -version` 可用；推荐使用 ZLMediaKit 代替手动 ffmpeg 进程

**ONVIF 扫描无结果**：摄像头和服务器需在同一子网；防火墙放通 3702/UDP（WS-Discovery）
