# 模拟城运中心 (Mock City-Ops Center)

依据《全景影像视频平台接口规范 V1.0》实现的**城运中心模拟系统**，用于真实模拟 JSC「智治推送」把聚合告警事件推送到城运中心、再由城运中心**回执（受理中 / 结案）**走完闭环的全过程。零依赖（纯 Node `http`），独立运行，不修改 JSC 数据库。

## 访问地址
- UI（外部）：`http://111.10.220.226:81/chengyun-mock/`
- 服务（服务器内）：`http://127.0.0.1:8088/`
- 系统服务：`systemctl status chengyun-mock`（日志 `/opt/jsc/chengyun-mock/data/server.log`）

## 实现的接口（与文档一致）
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/client/handle_event` | 接收摄像头识别事件推送（文档字段），响应 `{code:200,message:"请求已成功",data:{}}` |
| POST | `/client/handle_event_other` | 接收事件短视频（eventIds + fileUrl），关联到对应事件 |

> 同时兼容 JSC `executePush` 注入的 `X-Push-Id` 响应头与报文体 `push_id` / `callback_url`。

## UI 功能
- 事件卡片列表：缩略图、eventType 中文标签、时间、相机、地址、审核、回执状态；支持按 类型/回执状态/关键词 筛选。
- 详情弹窗：全部文档字段、原始 JSON、图片（小/大/水印）、关联短视频、回执历史、回执表单。
- 回执：对单条事件点「受理中(processing)」/「结案(closed)」，POST 到 JSC 的 `/api/smart-push/callback`（带 `X-Push-Id` 头）。
- 回执设置：JSC 回调基础地址（默认 `http://127.0.0.1:7170`）、`X-Callback-Token`（可选）、自动回执模式（收到即回执 / 延迟结案）。
- 发送样例事件：无需 JSC 即可演示 UI 与回执流程（样例 push_id 为伪造，回执会提示“无 push_id”属正常）。

## 接入 JSC 智治推送（手动建平台）
在 JSC 后台「智治推送 → 目标平台」新增一个平台：
- `api_url` = `http://127.0.0.1:8088/client/handle_event`
- `api_method` = POST
- `api_headers` = `{"Content-Type":"application/json"}`
- `auth_mode` = none
- `event_types` = ALL（或指定类型）
- `body_template`（文档字段格式，含 JSC 变量）：
```json
{
  "eventId": "jsc-{push_id}",
  "eventTime": "{time}",
  "cameraId": "{event_ids}",
  "eventType": 7,
  "subType": 7,
  "elevation": "", "azimuth": "", "absoluteZoom": "",
  "confirm": 1,
  "districtId": 500101000, "districtName": "万州区",
  "townId": 500101005, "townName": "龙都街道",
  "latitude": "{lat}", "longitude": "{lon}",
  "eventImgSmall": "{image_url}", "eventImgBig": "{image_url}",
  "address": "[{location}]截止于[{time}]{description}",
  "push_id": "{push_id}",
  "callback_url": "{callback_url}"
}
```
- 副接口（可选）：`api_url_other` = `http://127.0.0.1:8088/client/handle_event_other`，`body_template_other` = `{"cameraId":"{event_ids}","eventIds":"jsc-{push_id}","fileUrl":"{image_url}"}`

配置后触发任意一条识别告警（或「AI 分析存档 → 模拟走完结案流程」），本系统 UI 会实时收到该事件，点击回执即可在 JSC「推送历史」看到状态变为 受理中 / 已结案。

## 回执为什么能命中 JSC 白名单
JSC 回调接口 `/api/smart-push/callback` 复用 `chengyunGuard`：IP 白名单（`CHENGYUN_ALLOW_IPS`，未设置时默认含 `127.0.0.1`）+ 可选令牌 `X-Callback-Token`。模拟城运中心与 JSC 同机，回执走 loopback `http://127.0.0.1:7170`，源 IP = 127.0.0.1，默认即通过校验。若 JSC 设了 `CHENGYUN_CALLBACK_TOKEN`，在「回执设置」里填相同值即可。

## 运维
- 启动 / 停止 / 重启：`systemctl start|stop|restart chengyun-mock`
- 查看日志：`tail -f /opt/jsc/chengyun-mock/data/server.log`
- 重置数据：`curl -X DELETE http://127.0.0.1:8088/api/events`
- 改端口：改 `chengyun-mock.service` 的 `Environment=PORT=` 与 nginx `skymonitor.conf` 的 `proxy_pass`，然后 `nginx -s reload` + `systemctl restart chengyun-mock`
