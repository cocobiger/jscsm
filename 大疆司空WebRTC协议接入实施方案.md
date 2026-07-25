# 大疆司空 WebRTC 协议接入实施方案

## 一、需求目标

在「视频流管理 → 添加视频流」的协议下拉框中，新增 **"大疆司空 WebRTC"** 协议类型。

用户填写：
- 大疆司空分享页 URL（如 `https://fh.dji.com/share/live/LCP4WpyZk4M`）
- 机场名称（页面左侧边栏按钮文字）
- 可选：机场索引、窗口大小、推流码率

后端自动启动浏览器适配器，打开分享页并点击指定机场，把 WebRTC 视频流转推给 ZLMediaKit，最终输出本系统可播放的 HLS/FLV 地址。

---

## 二、前端改造（已完成）

### 2.1 类型扩展

文件：`src/app/context/DashboardContext.tsx`

新增 `DJIWebRTCConfig` 接口，并把 `VideoStream.protocol` 扩展为包含 `'dji_webrtc'`。

```ts
export interface DJIWebRTCConfig {
  shareUrl: string      // 大疆司空 share/live/ 分享页完整 URL
  airportName: string   // 机场名称（用于点击左侧边栏按钮）
  airportIndex?: number // 机场在左侧边栏中的索引（从0开始），可选
  keepAlive?: boolean   // 是否持续保持浏览器推流（默认 true）
  width?: number        // 浏览器窗口宽度（默认 960）
  height?: number       // 浏览器窗口高度（默认 540）
  bitrate?: number      // 推流码率 kbps（默认 1500）
}

export interface VideoStream {
  // ...
  protocol: 'rtsp' | 'hls' | 'webrtc' | 'onvif' | 'gb28281' | 'dji_webrtc'
  gb28181Config?: GB28181Config
  djiWebRTCConfig?: DJIWebRTCConfig
}
```

### 2.2 添加视频流表单

文件：`src/app/components/admin/VideoStreamPage.tsx`

- `PROTOCOLS` 数组增加 `'dji_webrtc'`，`PROTOCOL_LABELS` 增加 `"大疆司空WebRTC"`
- 新增 `DJIWebRTCForm` 组件，包含：
  - 分享页 URL（必填）
  - 机场名称（必填）
  - 机场索引、推流码率、窗口宽高（可选）
  - 持续保持浏览器推流开关
- 保存校验：选择 DJI WebRTC 时，必填 `shareUrl + airportName`，`url` 字段留空
- 列表行展示：机场名称 + 分享页 URL

### 2.3 播放组件改造

文件：`src/app/components/VideoPlayerModal.tsx`

- `needsTranscode()` 增加 `protocol === 'dji_webrtc'`
- `SinglePlayer` 增加可选 `djiConfig` 属性
- 播放 DJI WebRTC 时，调用 `/api/stream/start` 并带上 `protocol: 'dji_webrtc'` 和 `djiConfig`
- 后端返回 HLS/FLV 地址后直接播放

已同步修改 `VideoCarousel.tsx`、`MapView.tsx`、`VideoWall.tsx`，把 `djiWebRTCConfig` 透传给播放器。

---

## 三、后端改造

### 3.1 新增 dji-bridge 适配器脚本

部署路径：`/opt/jsc/dji-bridge/dji_bridge.py`

职责：
1. 启动 Xvfb 虚拟桌面（如未提供 DISPLAY）
2. 启动 ffmpeg x11grab，把屏幕画面编码为 H.264 并推 RTMP 到 ZLMediaKit
3. 用 Playwright 启动 Chromium，打开大疆司空分享页
4. 等待页面加载后，点击左侧边栏指定机场按钮
5. 保持浏览器运行，持续推流
6. 收到 SIGTERM 后，按顺序关闭浏览器、ffmpeg、Xvfb

核心流程：

```
启动 Xvfb :99
启动 ffmpeg x11grab → libx264 → rtmp://172.17.0.2:1935/jsc/{streamId}
启动 Chromium (headless=false, DISPLAY=:99)
打开 shareUrl
等待左侧机场列表渲染
点击 airportName / airportIndex 对应按钮
循环等待，直到进程被终止
```

命令行示例：

```bash
/opt/jsc/dji-bridge/venv/bin/python3 /opt/jsc/dji-bridge/dji_bridge.py \
  --share-url "https://fh.dji.com/share/live/LCP4WpyZk4M" \
  --airport-name "机场 1" \
  --stream-id "dji_A_airport1" \
  --width 960 --height 540 --bitrate 1500
```

### 3.2 新增后端管理模块

文件：`/opt/jsc/backend/dji-bridge.js`（与本地 `server/dji-bridge.js` 同步）

对外接口：

```js
// 启动一路 DJI WebRTC 转码
async function startSession(id, djiConfig) -> { ok, hls, flv, wsFlv, rtmp, rts }

// 停止一路
async function stopSession(id) -> { ok }

// 查询状态
function getStatus() -> { sessions: [...] }
```

内部状态管理：
- `sessions` Map：维护 `streamId -> { proc, ffmpegPid, display, startTime, lastHealth, djiConfig }`
- 启动时写入 pidfile：`/opt/jsc/dji-bridge/sessions/{streamId}.json`
- 定时健康检查：检测 ffmpeg 是否仍在推流、浏览器是否存活
- 崩溃自动重启：ffmpeg/浏览器退出时，按指数退避重试

### 3.3 新增 REST API

在 `server/index.js` 或 `backend/index.js` 中添加：

```
POST /api/dji-bridge/start
  body: { id, shareUrl, airportName, airportIndex?, width?, height?, bitrate? }
  return: { ok, hls, flv, wsFlv, rtmp, rts }

POST /api/dji-bridge/stop/:id
  return: { ok }

GET  /api/dji-bridge/status
  return: { sessions: [...] }
```

### 3.4 修改 /api/stream/start

当前逻辑：优先使用 ZLMediaKit 拉流代理，失败则 ffmpeg 降级。

增加 DJI WebRTC 分支：

```js
app.post('/api/stream/start', async (req, res) => {
  const { id, url, protocol, djiConfig } = req.body

  if (protocol === 'dji_webrtc') {
    if (!djiConfig?.shareUrl || !djiConfig?.airportName) {
      return res.status(400).json({ error: '缺少 shareUrl 或 airportName' })
    }
    try {
      const urls = await djiBridge.startSession(id, djiConfig)
      return res.json({ ok: true, engine: 'dji-bridge', ...urls })
    } catch (e) {
      return res.status(500).json({ error: e.message })
    }
  }

  // 原有 RTSP/HLS 逻辑保持不变 ...
})
```

### 3.5 修改 /api/stream/stop/:id

```js
app.delete('/api/stream/stop/:id', async (req, res) => {
  const id = req.params.id
  // 原有 ZLM / ffmpeg 停止逻辑 ...
  // 新增：
  await djiBridge.stopSession(id).catch(() => {})
  res.json({ ok: true })
})
```

---

## 四、服务器依赖安装

已在 `/opt/jsc/dji-bridge` 创建 Python 虚拟环境，下一步完成：

```bash
apt-get install -y xvfb ffmpeg fonts-wqy-zenhei fonts-noto-cjk

cd /opt/jsc/dji-bridge
source venv/bin/activate
pip install playwright
python -m playwright install chromium
```

验证：

```bash
source venv/bin/activate
python -c "import playwright; print('OK')"
python -m playwright install --help | head -3
ls ~/.cache/ms-playwright/chromium-*/chrome-linux/chrome
```

---

## 五、ZLMediaKit 推流地址

推流目标：`rtmp://172.17.0.2:1935/jsc/{streamId}`

播放地址：

| 协议 | 地址 |
|------|------|
| HLS | `http://111.10.220.226:6080/jsc/{streamId}/hls.m3u8` |
| FLV | `http://111.10.220.226:6080/jsc/{streamId}.live.flv` |
| WebRTC | `http://111.10.220.226:6080/jsc/{streamId}/rtc/v1/play` |

前端统一使用相对路径 `/jsc/{streamId}/hls.m3u8`，由 nginx 反代到 `http://172.17.0.2:6080`。

nginx 已配置 `/jsc/` 和 `/jsc_h264/` 反代，无需额外改动。

---

## 六、关键风险与应对

| 风险 | 应对方案 |
|------|----------|
| 大疆页面 DOM/类名变化，机场按钮定位失败 | 同时支持 `airportName` 文本匹配和 `airportIndex` 索引匹配，并在脚本中多策略回退 |
| 页面需要登录或检测 headless | 使用非 headless Chromium + 正常 User-Agent；分享页已验证无需登录 |
| 浏览器/WebRTC 崩溃 | dji-bridge 模块内部健康检查 + 自动重启 |
| ffmpeg 推流中断 | 检测到 ffmpeg 退出后自动重拉浏览器并重推 |
| 多路同时运行资源不足 | 单路先 PoC，确认 CPU/内存后扩展到 4 路；必要时降低分辨率/码率 |
| 延迟过大 | 调低 x11grab 帧率、使用 ultrafast preset、关闭 B 帧，目标 3~8 秒 |
| 视频画质差 | 提高码率或分辨率；机场画面以监控可用为主，不建议超过 2Mbps |

---

## 七、实施步骤

1. ✅ 前端：新增协议类型、表单、播放透传
2. ✅ 服务器：完成 Playwright + Chromium 安装
3. ✅ 上传 `dji_bridge.py` 到 `/opt/jsc/dji-bridge/`
4. ✅ 创建后端 `dji-bridge.js` 管理模块
5. ✅ 修改后端 `/api/stream/start` 和 `/api/stream/stop/:id`
6. ✅ 本地构建并部署前端到 `/opt/jsc/frontend/`
7. ✅ 重启 `jsc-backend.service`
8. ⏳ 单路 PoC：添加第一个大疆司空机场视频流并播放（需要用户提供机场名称/索引）
9. ⏳ 扩展到 4 路独立视频流
10. ⏳ 配置 systemd 自启服务（可选）

---

## 八、运维命令

```bash
# 查看 dji-bridge 运行状态
systemctl status jsc-backend

# 查看 dji-bridge 会话
curl http://localhost:7170/api/dji-bridge/status

# 查看 ZLMediaKit 活跃流
curl http://111.10.220.226:6080/index/api/getMediaList?secret=035c73f7-bb6b-4889-a715-d9eb2d192xxx

# 手动停止某一路
curl -X POST http://localhost:7170/api/dji-bridge/stop/dji_A_airport1

# 查看 dji-bridge 日志
journalctl -u jsc-backend -f | grep dji-bridge
```

---

## 九、后续可优化方向

1. **MediaRecorder 注入**：不抓屏，直接通过页面内 `video.srcObject` 录制 WebRTC 流，CPU 占用更低、延迟更小。
2. **音频同步**：当前 x11grab 只抓视频，后续需要时加入音频捕获。
3. **机场自动发现**：后端打开页面后解析左侧机场列表，返回给前端选择。
4. **缩略图截图**：浏览器定期截图存为视频流缩略图。
5. **多机场合一**：如果 4 路资源吃紧，可只开 1 个浏览器抓 4 宫格画面，作为一个合流输出。
