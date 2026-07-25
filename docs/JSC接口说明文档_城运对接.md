# 驾驶舱系统（JSC）接口说明文档 · 城运中心对接

本文档为驾驶舱系统（JSC）与城运中心（全景影像视频平台 / 三级城运中心）对接的完整 API 参考，与已部署后端代码严格一致。所有响应体统一为 {"code":int,"message":str,"data":{...}}。

## 一、通用约定

- 协议：HTTP + JSON（application/json）。

- 时区：所有时间字段为上海时（Asia/Shanghai），格式 YYYY-MM-DD HH:MM:SS。

- 鉴权：入站与回调接口使用 chengyunGuard（来源 IP 白名单 CHENGYUN_ALLOW_IPS + 可选令牌 X-Callback-Token）。

- 统一响应结构：{"code":<int>,"message":<str>,"data":{...}}。

## 二、术语

- push_id：驾驶舱 smart_push_history 记录 ID，作为城运回调的关联键。

- eventId：城运平台事件 ID，作为驾驶舱 warnings 的幂等键（warning.id）。

## 三、入站接口（城运 → 驾驶舱）

### 3.1 POST /client/handle_event

方法/路径：POST /client/handle_event（经 nginx /client/ 转发至后端 7170）。鉴权：chengyunGuard（IP 白名单 + 可选 X-Callback-Token）。

请求参数：

| 字段 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- |
| eventId | 是 | string | 事件ID（规则 sjzl-摄像头id-毫秒时间戳）；作为 warning.id 幂等键，重复推送不重复落库 |
| eventTime | 是 | string | 事件时间（上海本地时，如 2024-09-15 07:14:25；无时区标记，落库补 +08:00） |
| cameraId | 是 | string | 摄像头ID → 关联 iot_channels 通道与通道名 |
| eventType | 是 | int | 枚举 1~17 → aiType（映射见下文） |
| subType | 否 | string | 子类型 |
| confirm | 否 | int | 1 已审核 / 0 未审核 → 决定告警级别（未审核=1，已审核=2） |
| eventImgSmall | 否 | string | 小图网络地址 → picUrl（经 /api/iot-image 代理预览） |
| eventImgBig | 否 | string | 大图网络地址（优先于 small） |
| longitude | 否 | number | 经度；落库口径：经度 = longitude |
| latitude | 否 | number | 纬度；落库口径：纬度 = latitude（已与城运确认） |
| districtName | 否 | string | 区县 → location |
| townName | 否 | string | 乡镇/街道 → location |
| address | 否 | string | 详细地址 → location |
| elevation | 否 | number | 云台上下角度 |
| azimuth | 否 | number | 云台水平角度 |
| absoluteZoom | 否 | number | 放大倍数 |
| processEventId | 否 | string | 流程事件标识 |
| processEventStatus | 否 | int | 流程事件状态：0 未识别 / 1 识别到（可用于流程结束判断） |
| watermarkImage | 否 | string | 水印图地址 |
| count | 否 | int | 识别物数量 |
| total | 否 | int | 总数 |
| presetPosNum | 否 | string | 预置点编号 |
| presetPosName | 否 | string | 预置点名称 |
| distance | 否 | number | 预估距离 |

落库说明：以 eventId 为 warning.id 做幂等 upsert（INSERT OR REPLACE），重复推送不重复落库、保留首见时间与既有处置状态；source=chengyun-platform；经纬度口径 经度=longitude / 纬度=latitude；confirm=1 则 level=2，否则 level=1。

响应：

- 成功：200 {"code":200,"message":"请求已成功","data":{}}

- 缺 eventId：400 {"code":400,"message":"缺少 eventId","data":{}}

- 非白名单 IP：403 {"code":403,"message":"来源 IP 不在白名单","data":{}}

- 令牌不符：401 {"code":401,"message":"令牌无效","data":{}}

### 3.2 POST /client/handle_event_other

方法/路径：POST /client/handle_event_other；鉴权同 3.1。

请求参数：eventIds（事件ID，可逗号分隔）、fileUrl（录像文件地址）、cameraId。

响应：200 {"code":200,"message":"请求已成功","data":{"updated":N}}（N 为成功关联的事件数）。行为：将 fileUrl 关联到对应 warning（按 eventIds 匹配），作为结案报告证据区视频证据。

## 四、出站接口（驾驶舱 → 城运 → 驾驶舱）

### 4.1 驾驶舱 → 城运 推送（城运侧接收）

- 触发：POST /api/smart-push/events 按 smart_push_rules 匹配 → 调用预案 api_url 推送；推送成功关联事件置 pushed、历史置 pushed。

- 推送报文模板变量（注入 body_template）：标准变量 event_type / location / lat / lon / level / value / standard / description / time / trigger_count / event_ids + 关联变量 push_id（本次 smart_push_history 记录 ID）+ callback_url（可选，配置 SMART_PUSH_CALLBACK_URL 时注入）。

- 回执关联头：推送 HTTP 响应携带响应头 X-Push-Id: <push_id>，城运中心用于回调时关联本次推送。

### 4.2 POST /api/smart-push/callback（处置反馈回调 · 核心闭环）

方法/路径：POST /api/smart-push/callback；鉴权：复用 chengyunGuard（IP 白名单 + 可选 X-Callback-Token）。

- 关联键（三选一，优先级从高到低）：请求头 X-Push-Id > 报文体 push_id > 报文体 event_id；三者皆缺返回 400。

请求参数：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| disposal_status | 是 | 处置状态：processing（受理中）/ closed（已结案）；其他取值默认按 processing 处理 |
| disposal_result | 否 | 处置结论 / 结果文本 |
| disposal_operator | 否 | 处置人 / 责任单位 |
| disposal_time | 否 | 处置完成时间（建议上海时字符串） |
| (兼容别名) | 否 | status / result / remark / operator / disposalResult / disposalOperator / disposalTime，字段名可由 callback_field_mapping 适配 |

响应：

- 成功：200 {"code":200,"message":"请求已成功","data":{"status":"<processing|closed>"}}

- 推送记录不存在：404 {"code":404,"message":"推送记录不存在","data":{}}

- 令牌不符：401；非白名单 IP：403；缺 push_id：400。

状态机（smart_push_events）：收到 processing → 关联事件置 processing（可回退）；收到 closed → 关联事件置 closed（不可逆，不得回退为 processing）+ 推送历史写回处置结论（disposal_result / disposal_operator / callback_time=反馈时间），标记待结案。

### 4.3 POST /api/smart-push/history/:id/close（人工一键结案）

方法/路径：POST /api/smart-push/history/:id/close；鉴权：会话鉴权（Bearer），操作人取当前登录用户。

- 响应：成功 {"ok":true,"status":"closed"}；记录不存在 {"ok":false,"error":"推送记录不存在"}（HTTP 404）。

- 行为：历史置 closed + 关联事件置 closed + 写回处置人 / 结案时间（disposal_result 默认"驾驶舱人工结案"）。

### 4.4 GET /api/smart-push/history

查询推送历史。参数：status（pushed / processing / closed / timeout 特殊：内存过滤 is_timeout=1）、event_type（按事件类型）、limit（默认 100）。返回记录含 is_timeout 字段（status=pushed 且 24h 内无回调为 1）。

## 五、数据模型与枚举

### 5.1 平台 eventType → 驾驶舱 aiType 映射

| 平台 eventType | 含义 | 驾驶舱 aiType |
| --- | --- | --- |
| 1 | 工程车作业 | 工程车作业 |
| 2 | 工程车数量 | 工程车数量 |
| 3 | 烟尘 | 烟尘 |
| 4 | 工地裸露地未覆盖 | 堆头未覆盖（已确认对应） |
| 5 | 生物质燃烧 | 生物质燃烧 |
| 6 | 烟囱烟雾 | 烟囱烟雾 |
| 7 | 扬尘 | 扬尘 |
| 8 | 人员入侵 | 人员入侵 |
| 9 | 卡车脏车 | 卡车脏车 |
| 10 | 脏车 | 脏车 |
| 11 | 车辆遗撒 | 车辆遗撒 |
| 12 | 建渣未覆盖 | 建渣未覆盖 |
| 16 | 车辆冒装 | 车辆冒装 |
| 17 | 工业烟羽 | 工业烟羽 |

### 5.2 事件状态机

| 状态 | 含义 | 触发方 |
| --- | --- | --- |
| pending | 预警产生，待处理 | 系统 |
| pushed | 已推送城运中心，等待政务受理 | 驾驶舱推送成功 |
| processing | 政务系统已受理、处置中 | 城运回调 |
| closed | 政务处置完成，事件待结案 | 城运回调 |
| handled | 本地手动处置完成（未推送城运的事件） | 值守人员 |

### 5.3 经纬度落库口径（已确认）

- 经度 = 平台 longitude 字段；纬度 = 平台 latitude 字段。

## 六、错误码

| HTTP | code | message | 含义 / 处理 |
| --- | --- | --- | --- |
| 200 | 200 | 请求已成功 | 成功；data 含业务字段 |
| 400 | 400 | 缺少 push_id / 缺少 eventId | 缺少必填关联键；请携带 X-Push-Id 头或报文体 push_id |
| 401 | 401 | 令牌无效 | 配置了令牌但 X-Callback-Token 不符；请核对令牌 |
| 403 | 403 | 来源 IP 不在白名单 | 调用方 IP 未在 CHENGYUN_ALLOW_IPS；联系驾驶舱侧加白 |
| 404 | 404 | 推送记录不存在 | push_id 在驾驶舱无对应推送记录；确认 push_id 正确 |
| 500 | 500 | 处理失败 | 服务端异常；查看驾驶舱日志 |

## 七、部署配置（环境变量，经 systemd EnvironmentFile 注入）

配置位于 /opt/jsc/backend/iotcloud.env，改完 systemctl restart jsc-backend 生效。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| CHENGYUN_ALLOW_IPS | 127.0.0.1 | 入站/回调允许的客户端 IP 白名单（逗号分隔）；生产须设为城运平台出口 IP 与驾驶舱自身 IP |
| CHENGYUN_CALLBACK_TOKEN | （空） | 可选。若设置，入站/回调须带 X-Callback-Token 头且相等，否则 401；当前不强制（令牌预留） |
| CHENGYUN_IMG_HOSTS | 10.120.49.14 | 城运平台图片/短视频域名白名单，供 /api/iot-image 代理放行 |
| SMART_PUSH_CALLBACK_URL | （空） | 可选。驾驶舱对外回调地址，注入推送报文 callback_url 变量，便于城运回传 |

## 八、变更记录

- V1.0（2026-07-11）：初版接口说明，含入站事件/短视频、出站推送与处置反馈回调闭环、人工结案、查询、枚举映射、错误码与部署配置。
