# REF · 推送域全景（两条链路 / 三道闸 / 5 个新模块）

> 建立 2026-10-12（对账时发现）。**依据：生产文件头注释 + 路由 grep + jsc.db 实测；未逐行读实现。**
> ⚠️ 本文件描述的 5 个模块**当时只存在于生产服务器**（见 §6），本机仓库没有副本。

## 一、两条推送链路（最容易混淆的地方）

| | **链路 A · 秸秆** | **链路 B · IoT 视频分析** |
|---|---|---|
| 触发源 | `straw-engine`（自研模型检测） | `IoTCloud`（172.16.8.11）外部平台 |
| 入口 | `POST /api/straw-alert` → `index.js:1708` `setImmediate(strawWorkflow)` | `iot-fetcher.js` → `warnings`（`warning_type='iot-video-analysis'`） |
| 关键闸 | **复检闸门** `straw_review_gate`（pre/off） | **研判闸门** `judgeWarning()` → `judge_status`（admitted/blocked） |
| 末端 | **责任映射 → 企业微信群 / 微信桥**（`area_responsibility.webhook`） | **智治推送（城运平台）** + `cyzx.js` 三级城运贯通 |
| 推送痕迹字段 | **`data_json.wechatPush`**（即链路 A 独有） | 无此字段，走 `smart_push_history` / `cyzx_report_log` |

🔴 **判据铁律**：`warnings.data_json` 里**没有 `wechatPush` 不代表推送失败** —— 那多半是链路 B 的告警。
两条链路**唯一交汇点是 `warnings` 表**。

## 二、三道闸 + 口径统一台（`push-caliber.js` 要解决的问题）

| # | 闸 / 表 | 作用 | 粒度 |
|---|---|---|---|
| ① | `push_rules` | 进不进**驾驶舱前台** | 逐通道（窗口/阈值/min_confidence） |
| ② | `smart_push_rules` | 发不发**城运平台** | 类型级（窗口/触发次数） |
| ③ | `alert_filter_rules` | 列表**显不显示** | 类型级（min_confidence） |
| ★ | **`push_caliber`**（统一口径表，唯一真源） | 把口径**显式下发**到 ①②③ | 逐 aiType×通道 |

- 三处口径**原本互不一致** ⇒ 本模块建统一表后**显式下发**（不是运行期改写读取路径，避免"界面显示 A、实际跑 B"）。
- 下发流程：`dry-run` 预览差异 → 确认 → 批量 UPDATE；**下发前整行快照进 `push_caliber_apply_log`，可一键回滚**。
- ⚠️ ②③ 是类型级（无点位维度）⇒ 同一 aiType 下各点位口径不一致时**下发会拒绝并列出冲突**（这正是"统一"要解决的），除非显式 `force`。

## 三、5 个模块（2026-10-10 ~ 10-12 新增，本机原无）

| 模块 | 定位 | 关键路由 | 关键表 |
|---|---|---|---|
| **`cyzx.js`** (98KB) | **三级城运中心贯通**：AI 事件贯通到城运事件中心；**双口径双路径**——聚合类走研判准入，**逐条类走独立扫描触发点**（低位点一天 1~2 条，攒不到阈值 ⇒ 会被静默 blocked ⇒ 永久漏推） | `/api/cyzx/{config,test-connect,event-type-map,areas,…}` | `cyzx_eventtype_map`/`cyzx_area_code`/`cyzx_org_code`/`cyzx_report_log`/`cyzx_task_order`/`cyzx_disposal`/`cyzx_event_update`/`cyzx_copy_notice`/`cyzx_gate_cache`（共 9 张） |
| **`push-caliber.js`** (18KB) | **推送口径统一台** | `/api/push-caliber{,/bulk,/dry-run,/apply,/log,/health}` | `push_caliber` / `push_caliber_apply_log` |
| **`stack-exempt.js`** (21KB) | **堆头未覆盖·点位豁免名单**（用户裁定：**靠近江边的作业区不受"防尘网未覆盖>40%即违规"约束**；作业区是**点位属性**而非逐帧判断） | `/api/stack-exempt{,/candidates,/bulk,/dry-run,/source}` ＋ `/api/internal/stack-exempt`（PUBLIC_PATHS，路由内校验 `X-Admin-Token`） | `stack_exempt_points`；来源 `kv_config.stack_exempt_source` |
| **`smartpush-health.js`** (15KB) | **智治推送自检/监控/干跑**（此前平台/预案/规则/订阅四表引用关系**全靠人工记忆**，配错只打一条 `log.warn`，界面看不出） | `/api/smart-push/{health,dry-run,failures}` | 只读（**不写任何既有表**，无定时器 ⇒ 不会成为新故障源） |
| **`precap-config.js`** (10KB) | **视频缓存（B′ 回看）后台配置**——代理 11 机 `alarm_processor:7002`，让驾驶舱直接调回看档位/锚点延迟/通道/写入器参数，不必登 11 机改 systemd | `/api/precap-config/{status,apply,rollback,history}` | 不落本地表（真源在 11 机 `/soft/data/plate-precap/precap_config.json`） |

## 四、共同范式（新模块模板，建议固化）
1. **纯新增、最小侵入**：自建表 + 自管配置 + 自注册路由；`index.js` 只加 1 行 `require`
   🔴 **`require` 必须放在 `adminOnly` 定义之后** —— 它是 `const`，提前引用触发 **TDZ ReferenceError 崩进程**
2. **不动研判闸门**：`judgeWarning` / `isGateExemptWarning` / `queryWarningsAggregated` **一律不碰**
   （改它们会同时改变**前台实时告警量**与 SSOT 口径）
3. **真源在 DB**（`kv_config` / 自建表），env 只作首次初始化 ⇒ 后台填完即生效、**无需重启**
4. **时间一律上海时 UTC+8**（`getUTC*` + 8h），**禁用 `toLocaleString` / 本地时区**
5. **内网端点**：`PUBLIC_PATHS` 放行 session 鉴权，路由内自校验 `X-Admin-Token`（复用 `ALARM_ADMIN_TOKEN`）
6. **高危动作**走 `dry-run` → 确认 → 批量应用 + **快照可回滚**
7. **出站禁止兜底**：映射未命中 = **不上报**（错码值进政府系统且事件单难以撤回）

## 五、落地状态快照（2026-10-12 实测）
| 模块 | 实测 | 判定 |
|---|---|---|
| 城运 | `cyzx_eventtype_map` **28 行**；其余 8 张 **0 行** | 映射已配 ✅／**从未真实上报**（`report_log` 0） |
| 口径统一台 | `push_caliber` 0 行；`apply_log` **1 条**（10-12 02:59 admin，含「堆头未覆盖」各通道 pushRules 快照） | 下发机制**已真跑过一次** |
| 堆头豁免 | `stack_exempt_points` **0 行**；来源=`push_rule` | 待录名单 |
| 智治自检 | `smart_push_events` 1 / `history` **0** / `subscriptions` **未创建** | 基本没跑 |
| 责任映射（链路 A） | `area_responsibility` **0 行** | 🔴 模型上线前必须补 52 行 |
| 研判闸门（链路 B） | 近 7 天 `admitted` **730** / `blocked` **44** | ✅ 在真跑 |
| 告警总量 | `warnings` **1841**（近 7 天 +774，≈110/天，全 `iot-video-analysis`） | ✅ 持续产生；库共 **51 表** |
| 秸秆 | `straw_detections` **0**；含「秸秆」告警**仅 1 条**（`streamId=e2e-test-stream` 测试） | 链路 A **无真实数据** |

## 六、🔴 本机仓库落后生产（资产风险，必读）
对账（2026-10-12，本机 HEAD `6ae4bc6` **工作区干净**）：
- **本机完全没有**：上述 5 个模块（共约 172 KB）
- **同名但生产更新**：`index.js` 194,497 → **237,719**（+43KB）｜`store-db.js` 188,263 → **206,521**（+18KB）｜
  `iot-fetcher.js` 60,948 → 74,765｜`monitor.js` 9,348 → 24,334｜另 9 个小幅
- **前端 `src/` 停在 2026-09-26**，生产前端构建于 **2026-10-12 12:13**；新功能关键词在本机 `src/` **全部 0 命中**
- 全盘搜 `cyzx.js` / `push-caliber.js` ⇒ **只存在于生产服务器**（其它本地副本 0/3、10-05 后零改动）

⇒ **重演 9/29 事故的"关键源码只在服务器上是隐形单点"**（当时代价：`straw-engine/main.py` 750 行重写）。
**必须做一次源码回落**（后端 5 新 + 13 改；前端 src），并建立**定期自动对账**。
