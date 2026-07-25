# AI 分析推送规则 · 解决方案

> 目标：在驾驶舱后台「AI分析存档」下新增 **AI 分析推送规则**，实现"某点位 + 某 AI 类型在 N 小时内超过 M 条 → 前端『告警信息』只推送一条聚合告警"的降噪能力。
> 状态：设计已通过 grilling 拷问（6 个分叉全部确认），本文为可实施规格。**尚未改代码。**

---

## 一、决策汇总（grilling 结论）

| # | 分叉 | 决策 | 含义 |
|---|------|------|------|
| 1 | 作用范围 | **方案 A** | 规则只影响「告警信息」列表；原始 AI 图片**照常写入 `warnings` 表**，AI分析存档一条不少 |
| 2 | 标记联动 | **方案 X** | 标记一条聚合告警 = 把该组命中的全部原始记录标记 `handled`（列表与存档状态一致） |
| 3 | 匹配维度 | **方案 P** | 规则 = `{通道, AI类型, 时间窗(h), 阈值(条)}` 四元组，全部可配；通道/AI类型支持"全部"通配；聚合分组键 = `channelSipId + aiType` |
| 3a | 通道展示 | 映射名 | 规则「通道」下拉显示 `iot_channels.channel_name`（映射名，如「龙泗路」），**存储用 `channel_sip_id`**（稳定 ID） |
| 4 | 展示形态 | **方案 S** | 聚合行 = 标题 + 计数徽章 + 等级取组内最高 + 时间取最新 + 可 drill-down 展开原始记录 |
| 5 | 时间窗 | **方案 V** | 滚动窗口：以"当前时刻"为终点往前推 N 小时，任意连续窗口内累计 ≥ 阈值即折叠 |
| 6 | AI类型来源 | **方案 Y2** | 固定枚举 7 种（见下），代码中维护白名单 |

**AI 类型固定枚举（7 种）：**
```
堆头未覆盖 / 道路扬尘 / 秸秆燃烧 / 违规排污 / 固废与危废违规倾倒 / 固废运输违规 / 侵占岸线与水面漂浮物
```

---

## 二、数据模型

### 2.1 新增表 `push_rules`

```sql
CREATE TABLE IF NOT EXISTS push_rules (
  id                TEXT PRIMARY KEY,          -- UUID
  name              TEXT NOT NULL,             -- 规则名，如「龙泗路堆头未覆盖降噪」
  channel_sip_id    TEXT,                       -- 通道ID；NULL = 全部通道（通配）
  ai_type           TEXT NOT NULL,             -- 7种枚举之一
  time_window_hours INTEGER NOT NULL DEFAULT 24,
  threshold         INTEGER NOT NULL DEFAULT 20,
  enabled           INTEGER NOT NULL DEFAULT 1, -- 1启用 0禁用
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
```

> 说明：
> - `channel_sip_id` 存 ID 而非映射名文本——映射名改了不影响规则匹配（`warnings.channelSipId` 直接 JOIN）。
> - `ai_type` 存枚举原值（与 `warnings.data_json.aiType` 精确相等）。
> - 通配：`channel_sip_id IS NULL` 表示"任意通道"；`ai_type` 暂不支持通配（按 Y2 设计为单选枚举，如需全局某类型降噪，逐通道建规则或后续扩展）。

### 2.2 现有表复用（不改结构）
- `warnings`：聚合的"原始记录"来源。`data_json` 已含 `aiType`、`channelSipId`、`level`、`source`、`picUrl`、`time` 等字段（实测确认）。
- `iot_channels`：`channel_sip_id`(PK) + `channel_name`(映射名)，用于下拉展示与标题映射名解析。

---

## 三、后端设计

### 3.1 规则 CRUD API（新增）

挂在管理接口下，需鉴权（复用现有 admin 鉴权中间件）：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/push-rules` | 规则列表（含通道映射名） |
| POST | `/api/push-rules` | 新增规则 |
| PATCH | `/api/push-rules/:id` | 编辑 / 启用禁用 |
| DELETE | `/api/push-rules/:id` | 删除规则 |

请求体示例（POST）：
```json
{
  "name": "龙泗路堆头未覆盖降噪",
  "channel_sip_id": "34020000001310000005",
  "ai_type": "堆头未覆盖",
  "time_window_hours": 24,
  "threshold": 20,
  "enabled": true
}
```
- `channel_sip_id` 可省略 / 传 `null` = 全部通道。
- 校验：`ai_type` 必须在 7 种枚举内；`time_window_hours` / `threshold` 为正整数。

### 3.2 聚合查询（核心改造 · `store.queryWarnings`）

`GET /api/warnings` 当前直接 `store.queryWarnings({type, limit})` 返回原始行。改造为：**在返回前，对 iotcloud AI 类 pending 记录做规则聚合**，把命中规则的组折叠成一条聚合对象。

**算法（伪码）：**
```
1. 取所有 pending + source='iotcloud' 的 warnings（原始行集合 R）
2. 取所有 enabled 的 push_rules（规则集合 RULES）
3. 按 (channelSipId, aiType) 对 R 分组 → groups
4. 对每个 group g：
   a. 计算滚动窗口内计数：g.count_in_window = g中 created_at >= now - 对应规则.time_window_hours 的记录数
      （同一组可能命中多条规则，取"能使其折叠"的规则：存在规则使 count_in_window >= 阈值）
   b. 若命中任一规则 rule：
      - 折叠为聚合对象 agg：
        {
          isAggregate: true,
          ruleId: rule.id,
          channelSipId: g.channelSipId,
          aiType: g.aiType,
          channelName: <JOIN iot_channels 取映射名>,
          count: g.count_in_window,
          maxLevel: <组内最高 level>,
          latestTime: <组内最新 created_at>,
          memberIds: [原始记录 id 列表],
          members: [原始记录摘要，供 drill-down]
        }
   c. 否则：group 内记录照常逐条加入结果
5. 返回 [聚合对象...] + [未命中组的逐条原始记录...]
```

**SQL 辅助（分组计数，规则匹配在 JS 层做，因规则动态）：**
```sql
SELECT
  json_extract(data_json,'$.channelSipId') AS channel_sip_id,
  json_extract(data_json,'$.aiType')       AS ai_type,
  COUNT(*)                                  AS cnt,
  MAX(json_extract(data_json,'$.level'))    AS max_level,
  MAX(created_at)                           AS latest_time
FROM warnings
WHERE status='pending'
  AND json_extract(data_json,'$.source')='iotcloud'
  AND created_at >= datetime('now','-24 hours')   -- 取最大窗口，JS 内按规则再裁
GROUP BY channel_sip_id, ai_type;
```
> 备注：`datetime('now')` 在服务器为 UTC，需用 `datetime('now','localtime')` 或后端按上海时区处理（项目既有约定：SQLite 时间用 localtime）。

### 3.3 标记处理改造

**单条聚合告警标记（新增接口）：**
```
POST /api/warnings/handle-group
body: { memberIds: [id1, id2, ...], handledBy?: string }
```
后端对 `memberIds` 逐条 `updateWarningStatus(id,'handled')`，返回标记条数。
- 前端点击聚合行"标记处理"时，传该聚合对象的 `memberIds`（方案 X：一组全标）。

**现有接口改动：**
- `PATCH /api/warnings/:id`：保持不变（仍处理单条原始记录）。
- `POST /api/warnings/handle-all`：保持"标记所有 pending 原始记录"——聚合是查询层的事，handle-all 本就标全部原始，聚合组自然被清除。**无需改逻辑**。

---

## 四、前端设计

### 4.1 类型定义（`DashboardContext.tsx`）
```typescript
export const AI_ANALYSIS_TYPES = [
  '堆头未覆盖','道路扬尘','秸秆燃烧','违规排污',
  '固废与危废违规倾倒','固废运输违规','侵占岸线与水面漂浮物'
] as const
export type AiAnalysisType = typeof AI_ANALYSIS_TYPES[number]

export interface PushRule {
  id: string
  name: string
  channelSipId: string | null   // null = 全部通道
  channelName?: string          // 展示用映射名
  aiType: AiAnalysisType
  timeWindowHours: number
  threshold: number
  enabled: boolean
}

// 告警列表项扩展
export interface AggregateWarning {
  isAggregate: true
  ruleId: string
  channelSipId: string | null
  aiType: string
  channelName: string
  count: number
  maxLevel: number
  latestTime: string
  memberIds: string[]
}
```

### 4.2 后台规则管理 UI（`IotArchivePage.tsx` 内新增分区）
在「AI分析存档」页内新增 **「AI分析推送规则」** 卡片/标签页，包含：
- **规则列表**：表格列 = 名称 / 通道(映射名或"全部通道") / AI类型 / 时间窗(h) / 阈值(条) / 启用开关 / 操作(编辑·删除)。
- **新增/编辑表单**：
  - 通道下拉：选项 = `[{value:'',label:'全部通道'}, ...iot_channels.map(c=>({value:c.channel_sip_id, label:c.channel_name}))]`（从 `/api/iot-channels` 或现有通道接口取）。
  - AI类型下拉：选项 = `AI_ANALYSIS_TYPES`（固定枚举）。
  - 时间窗：数字输入，默认 24。
  - 阈值：数字输入，默认 20。
  - 启用：开关，默认开。
- 保存 → `POST/PATCH /api/push-rules`；删除 → `DELETE`。

### 4.3 告警列表聚合渲染（`AlertHistoryModal.tsx`）
- `load()` 拉 `/api/warnings` 后，结果可能含 `isAggregate:true` 项。
- **聚合行渲染**：
  - 标题：`{channelName} 检测到 {aiType} 频发`
  - 计数徽章：`{timeWindow}h内 {count}+ 条`（用规则时间窗，前端可随 ruleId 拉取或后端附带 `windowHours`）
  - 等级色：按 `maxLevel` 取 `LEVEL_COLORS`（与单条一致，避免 3 处重复——建议抽到共享模块）
  - 时间：显示 `latestTime`
  - "标记处理"按钮 → `POST /api/warnings/handle-group` 传 `memberIds`
- **drill-down**：点击聚合行展开，列出 `memberIds` 对应的原始记录缩略图（取 `members` 或二次拉取），每条带"已处理/未处理"状态（方案 X 联动）。
- **「全部标记处理」**：保持现有 `POST /api/warnings/handle-all`，聚合组原始记录一并被标。

---

## 五、边界与异常处理

| 场景 | 行为 |
|------|------|
| 组内计数 < 阈值 | 不折叠，逐条正常显示 |
| 规则 `enabled=0` | 不参与匹配，不折叠 |
| 同一组命中多条规则 | 命中即折叠（折叠后1条，无冲突） |
| 通道通配规则 | `channel_sip_id IS NULL` 匹配任意通道 |
| 滚动窗口旧记录滑出 | 计数下降，<阈值则该组恢复逐条（若尚未标记） |
| 标记聚合后 | 原始记录变 `handled`，查询时不再进入 pending 聚合 |
| `aiType` 精确匹配 | Y2 枚举保证写入值与规则值一致，无模糊误命中 |
| 规则删除/禁用后 | 下次查询即时生效（查询时实时计算，无缓存） |

---

## 六、实施步骤（分阶段，当前未实施）

- **Phase 1 · 数据**：`push_rules` 建表 + 迁移脚本。
- **Phase 2 · store 层**：`queryWarnings` 增加聚合分支；新增 `handleGroupWarnings(memberIds)`；新增 `crudPushRules` 系列。
- **Phase 3 · API 层**：`/api/push-rules` CRUD（鉴权）；`/api/warnings` 支持聚合返回；`/api/warnings/handle-group` 新增。
- **Phase 4 · 前端类型**：`DashboardContext.tsx` 加 `AI_ANALYSIS_TYPES` / `PushRule` / `AggregateWarning`。
- **Phase 5 · 后台 UI**：`IotArchivePage.tsx` 新增规则管理分区。
- **Phase 6 · 告警列表 UI**：`AlertHistoryModal.tsx` 聚合行渲染 + drill-down + 标记联动。
- **Phase 7 · 构建部署 + 验证**。

---

## 七、验证方案

1. 后台新建规则：通道=龙泗路(映射名) / AI类型=堆头未覆盖 / 时间窗=24 / 阈值=**3**（低阈值便于快速验证）。
2. 等待该通道堆头未覆盖累计 ≥3 条（或手动插测试数据）。
3. 前端「告警信息」应出现 **1 条**聚合告警：`龙泗路 检测到 堆头未覆盖 频发` + 徽章 `24h内 3+ 条`，点击可 drill-down 看 3 张原始图。
4. 点聚合行"标记处理" → 3 条原始变 `handled`，聚合行消失。
5. 切到「AI分析存档」→ 仍见 3 条原始图片（**验证方案 A：存档不丢**）。
6. 阈值调回 20 做生产配置。

---

## 八、实施注意

- **部署一致性**：运行后端在 `/opt/jsc/backend/index.js` + `store-db.js`；本地源码在 `server/`。改后端须**同时改本地 `server/` 并部署到 `/opt/jsc/backend/`**，否则下次从 `server/` 重新部署会覆盖（参考此前 504 修复经验）。
- **时区**：`datetime('now')` 用 `localtime` 或后端按上海时区计算窗口，避免 UTC 偏差导致窗口错位。
- **鉴权**：`/api/push-rules` 须走 admin 鉴权（与现有后台接口一致），不可暴露为 PUBLIC_PATHS。
- **`LEVEL_COLORS` 重复**：当前 `AlertPanel` / `AlertHistoryModal` / `DashboardContext` 三处各定义一份，建议抽共享模块，避免聚合行与单条行等级色不一致。
- **`location` 字段**：此前评估发现 AI 类告警点位常回退"市监测站"，属独立数据质量问题，本次规则不依赖 `location`（用 `channelSipId` 匹配），但建议另立项修复点位映射。
