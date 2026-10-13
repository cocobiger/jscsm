# REF · 司空2 / ZLM / 8.11 IoTCloud 基础设施细则

> 从 MEMORY.md 拆出（MEMORY 注入超限）。**改动前必读本文件全文。** 拆出日期 2026-09-29。

## 告警 / 视频 / 司空2
- webhook→`POST /api/drone-events/ingest`→`drone_live_events`（event_time=UTC）→SSE `/api/drone-events/stream?token=`；弹窗 v2 状态机（2 窗+3 队，30s 收起）；`/simulate` 防呆。warnings 4 源；聚合 windowHours=24/threshold 5；**聚合 key=`channelSipId||streamId`**（勿退回单 key）。
- LiveTextOverlay：`DronePopupWindow` 常显（WGS-84+GCJ-02+镇街+机场名，断流保留末位+红标）；`useOsdPolling` 2s 单例；镇街 `/api/straw/reverse-geocode`（需 Bearer）；GCJ-02 用 `wgs84ToGcj02`（万州偏 506m）。
  **✅ 2026-09-30 边界数据已恢复**：`data/wanzhou_towns.geojson` 共 **52 个乡镇街道**（11 街道+29 镇+12 乡，**含高梁镇**，
  比原生产的 51 个更全），已 seed 入 `area_boundary`、原先每次上报刷的 `[straw-workflow] ENOENT` 归零。
  ⚠️ 该 `division_code` 是**源系统 18 位编号**，不是 GB/T 2260 的 9 位区划代码。
  详见 `REF_驾驶舱重新部署流程.md` §13（含再生成命令与坐标系判定）。MiniDroneMap 滚轮缩放+±+stopPropagation。
- ZLM：HLS `segDur=2`+`fastRegister=1` 已最优，首屏由源 GOP 决定；**FLV 优先 HLS 回退**；H.265→`jsc_h264`、H.264→`jsc`；mirror `sikong_<SN>`；:6080 secret `035c73f7-bb6b-4889-a715-d9eb2d192abc`。
- 司空2 web :5443；OpenAPI `172.28.0.108:48089/v1/*`；admin `172.28.0.103:48081` 须带 **/admin-api**（login-user 头，租户 `1435364026458112`）；mysql 库 `v3_private_test`；Redis `172.28.0.81:6379`。
  三通道：zlm_to_minio 720p｜dock_media 遥控器录像 HEVC（滞后 6-9min，**仅事后取证**）｜ZLM mirror 直播（**检测抽帧源**）。
- 机场↔无人机：环保局 8UUXN7G00A0FDP/064U、三峡 8UUXN8N00A0LS7/0S4G、职教 8UUXN8P00A0LZ4/0S4J、经开区 8UUXN5500A07D1/0SJM。
- **8.11 IoTCloud 溯源（已结案）**：`6881` IotCloud(RuoYi 定制，前缀 /prod-api，凭据 226 `/opt/jsc/backend/iotcloud.env`)｜`7100` 告警 API｜`8101` 复检标注台｜`7001` plate｜`7002` Flask｜`6081` 网关。
  ⚠️ **401 假阳性**：6881 未认证时对所有路径回 200+`{code:401}`，带 token 后 404 才是真没有。采集源 `/sip/analyse/record/list`(29065)。
  **四层命名**：模型 `unsoilcover`→告警 `spill`(冒装)→标注 `spill`(真违规·载货未覆盖)→我方「堆头未覆盖」（**错名**，实为渣土车）。产出方=**EasyAIoT TASK 引擎**；本地检索命中 0 → **权重抄不到**。
  车牌已随 `analyseInfo` 返回但未消费；通道算法配置**只覆盖 4/21**；`iot-fetcher.js` 必须**按记录自身 channelSipId 查配置**。
- git `git@github-jsc:cocobiger/jscsm.git`；禁提交 .env/streams.json/backups/。

