# ZLMediaKit 部署指南（Docker）

> 用途：作为本系统的流媒体服务器，把 RTSP / GB28181 摄像头流转换为浏览器可播放的 HTTP-FLV / WebRTC。
> 部署方式：Docker（无需编译，一键拉起）

---

## 一、前置条件

- 已安装 **Docker Desktop**（Windows）并启动
- 验证：PowerShell 执行 `docker --version`，能看到版本号即可

---

## 二、一键启动 ZLMediaKit

PowerShell 执行（单条命令）：

```powershell
docker run -d --name zlm `
  -p 1935:1935 `
  -p 8080:80 `
  -p 8443:443 `
  -p 554:554 `
  -p 10000:10000 `
  -p 10000:10000/udp `
  -p 8000:8000/udp `
  -p 30000-30100:30000-30100/udp `
  zlmediakit/zlmediakit:master
```

端口说明：

| 端口 | 用途 |
|------|------|
| 1935 | RTMP |
| 8080 | HTTP（HTTP-FLV / HLS / REST API，容器内 80 映射到主机 8080） |
| 8443 | HTTPS |
| 554 | RTSP |
| 10000 | RTC TCP |
| 8000/udp | RTC UDP |
| 30000-30100/udp | GB28181 媒体接收端口段 |

> 若 8080 被占用，改成 `-p 9090:80`，后端配置里的 zlmPort 也相应改 9090。

---

## 三、获取 API Secret（关键）

ZLMediaKit 的 REST API 需要 secret 鉴权。查看容器内配置文件里的 secret：

```powershell
docker exec zlm cat /opt/media/conf/config.ini | findstr secret
```

会看到类似：

```
secret=035c73f7-bb6b-4889-a715-d9eb2d192xxx
```

复制这串 secret，稍后填入本系统后端配置。

> 也可以自己指定 secret：在 docker run 时加 `-e MEDIA_SERVER_SECRET=你的密钥`，但用默认生成的更简单。

---

## 四、验证 ZLMediaKit 正常运行

PowerShell 执行（把 SECRET 换成上一步的值）：

```powershell
curl "http://127.0.0.1:8080/index/api/getServerConfig?secret=SECRET"
```

返回 JSON（含 code:0）说明 API 通了。

浏览器访问 `http://127.0.0.1:8080`（默认有简单页面或返回 404，都说明服务起来了）。

---

## 五、在本系统中配置 ZLMediaKit

启动本系统后端后，调用配置接口（或在管理后台填写）：

```powershell
# 把 SECRET 换成第三步的值
Invoke-RestMethod -Method POST -Uri "http://localhost:7070/api/zlm/config" `
  -Headers @{ Authorization = "Bearer 你的系统APIKey" } `
  -Body (@{ zlmHost="127.0.0.1"; zlmPort=8080; zlmSecret="SECRET" } | ConvertTo-Json) `
  -ContentType "application/json"
```

配置成功后，本系统的 RTSP / GB28181 流会自动通过 ZLMediaKit 转换为 FLV 播放。

---

## 六、测试 RTSP 拉流转换

假设有一路 RTSP 摄像头 `rtsp://admin:pwd@192.168.1.100:554/stream`：

1. 在「视频流管理」添加该流，协议选 RTSP
2. 点「启动转发」（或播放）
3. 后端调用 ZLMediaKit 的 addStreamProxy 拉流，返回 FLV 地址，前端自动播放

也可用公开测试 RTSP 源验证：
```
rtsp://rtspstream.com/pattern  （示例，实际可用源以官方为准）
```

---

## 七、常用运维命令

```powershell
docker logs zlm           # 看日志
docker restart zlm        # 重启
docker stop zlm           # 停止
docker start zlm          # 启动
docker rm -f zlm          # 删除容器（数据不持久，重建即恢复默认）
```

---

## 八、GB28181 接入（可选）

ZLMediaKit 支持 GB28181，但配置较复杂（需配置 SIP 服务器、设备注册）。
如果主要用 RTSP，可暂不配 GB28181。
若需要，建议配合 **WVP-PRO**（基于 ZLMediaKit 的国标平台，有完整 Web 管理界面）：
- GitHub: 648540858/wvp-GB28181-pro
- WVP-PRO 提供设备注册、通道管理、点播 API，本系统对接其 API 即可

---

## 故障排查

- **API 返回 401/鉴权失败**：secret 不对，重新执行第三步获取
- **8080 访问不了**：检查端口是否被占用，或容器是否启动 `docker ps`
- **RTSP 拉流失败**：确认摄像头地址在 ZLMediaKit 所在机器能访问（同网段）
- **WebRTC 黑屏**：检查 30000-30100/udp 端口段是否正确映射、防火墙是否放通
