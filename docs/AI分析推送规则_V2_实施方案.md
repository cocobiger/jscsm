# AI 分析推送规则 V2 实施方案

> 需求来源：用户要求把 AI 类型从「前端写死 7 枚举」升级为「后台可增删改主数据」，
> 并在通道映射上挂 AI 类型（多选）；推送规则改为「以 AI 类型为主线 + 保留通道维度」配时间窗/阈值。
> 本方案基于已上线的 V1（push_rules + queryWarningsAggregated + 告警列表聚合渲染）。

## 一、已收敛的设计决策（grilling 5 分支）

| # | 分支 | 结论 |
|---|------|------|
| Q1 | 规则是否保留通道维度 | **语义 B：保留通道维度**（规则 = 通道 + AI类型 + 时间窗 + 阈值） |
| Q2 | 一条规则如何对应 AI 类型 | **选项 A：一条规则 = 1 通道(可空=全部) + 多个 AI类型 + 1 时间窗 + 1 阈值**（多类型共用一套参数） |
| Q3 | AI 类型匹配键 | **选项 A：用名字字符串作匹配键**（现有规则/历史告警零迁移） |
| Q4 | 通道映射对聚合的作用 | **选项 A：纯元数据/UI 过滤，不约束聚合**（杜绝漏警） |
| Q5 | 删除 AI 类型的级联 | **选项 A：保护式删除**（被启用规则/未处理告警引用时禁止删；否则级联剥离引用，历史告警保留） |

**关键语义澄清（Q2）**：多类型只是「减少规则条数」，聚合仍按 `(通道, 单AI类型)` 各自独立分组计数。
即一条规则覆盖 `{堆头未覆盖, 道路扬尘}` 时，这两类各自独立判断是否达阈值折叠，不混算。
这与 V1 原始需求（龙泗路 24h 内 20+ 条堆头未覆盖只推 1 条）完全一致。

## 二、数据模型变更

### 1. 新增 `ai_types` 主数据表
```sql
CREATE TABLE IF NOT EXISTS ai_types (
  name TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
```
- 用 name 作主键（Q3 选项 A）。
- 种子化：首次 init 若表空，插入现有 7 个类型（顺序即现有枚举顺序）。
- 7 个类型：堆头未覆盖 / 道路扬尘 / 秸秆燃烧 / 违规排污 / 固废与危废违规倾倒 / 固废运输违规 / 侵占岸线与水面漂浮物。

### 2. `iot_channels` 加列
```sql
ALTER TABLE iot_channels ADD COLUMN ai_types TEXT NOT NULL DEFAULT '[]';
```
- 存 JSON 数组（如 `["堆头未覆盖","道路扬尘"]`）。
- 仅元数据（Q4 选项 A），不参与聚合判断。

### 3. `push_rules` 改多类型
- 新增列 `ai_types TEXT NOT NULL DEFAULT '[]'`（JSON 数组）。
- 保留旧 `ai_type` 列做兼容，**新代码只读写 `ai_types`**。
- 迁移：init 时把已有行的 `ai_type` 单值包成数组写入 `ai_types`（如 `ai_type='堆头未覆盖'` → `ai_types='["堆头未覆盖"]'`），避免老规则失效。
- 校验：创建/更新时 `aiTypes` 至少 1 个。

## 三、后端改动（server/store-db.js + server/index.js）

### Phase 1 — AI 类型主数据
store-db.js 新增：
- `listAiTypes()` → `SELECT name, sort_order FROM ai_types ORDER BY sort_order, name`
- `createAiType(name)` → 去重、非空校验；`INSERT`
- `deleteAiType(name)` → **保护式**：
  1. 扫启用规则：`SELECT 1 FROM push_rules WHERE enabled=1 AND ai_types LIKE '%"name"%'`（或解析后 includes）
  2. 扫未处理告警：`SELECT 1 FROM warnings WHERE status!='handled' AND json_extract(data_json,'$.aiType')='name' AND json_extract(data_json,'$.source')='iotcloud'`
  3. 任一命中 → 返回 `{ok:false, reason:'rule'|'warning'}`，**不删**
  4. 否则：从相关规则 `ai_types` 数组剔除该 name（UPDATE）、从各通道 `ai_types` 剔除、`DELETE FROM ai_types WHERE name=?`

index.js 路由（adminOnly）：
- `GET /api/ai-types` → listAiTypes
- `POST /api/ai-types` → createAiType（body.name 必填）
- `DELETE /api/ai-types/:name` → deleteAiType（返回 200 或 409+reason）

### Phase 2 — 通道映射 AI 类型
store-db.js：
- `listIotChannels` / `getIotChannel` 返回时解析 `ai_types` 为数组（camelCase `aiTypes`）
- `updateIotChannelAiTypes(channelSipId, aiTypes[])` → `UPDATE iot_channels SET ai_types=? WHERE channel_sip_id=?`
index.js：
- `GET /api/iot-channels` 输出已含 `aiTypes`
- `PATCH /api/iot-channels/:id/ai-types`（adminOnly）→ updateIotChannelAiTypes

### Phase 3 — push_rules 多类型
store-db.js：
- `queryWarningsAggregated`：规则匹配 `rl.aiType === ai` → `rl.aiTypes.includes(ai)`（数组包含）；其余分组/折叠逻辑不变（仍按 `channel|aiType` 分组）
- `createPushRule` / `updatePushRule`：入参 `aiTypes: string[]`，存 JSON；映射回 `aiTypes`
- `listPushRules` / `getPushRule`：返回 `aiTypes`（数组）
- 迁移：init 末尾对 `ai_types IS NULL OR ai_types=''` 的行执行 `ai_types = json([ai_type])`

## 四、前端改动

### Phase 4 — 类型与 API
- `DashboardContext.tsx`：`AI_ANALYSIS_TYPES` 改为**动态获取**（移除写死导出，或保留为登录前 fallback）；`PushRule.aiType` → `PushRule.aiTypes: string[]`；`AggregateWarning` 不变（仍单 aiType）。
- 新增 API 封装：`getAiTypes()/createAiType(name)/deleteAiType(name)`、`patchChannelAiTypes(id, arr)`。

### Phase 5 — AI 类型管理 UI（PushRulePanel 内）
- 「推送规则」标签内增加「AI 类型管理」区：列表(name+排序) + 新增输入框 + 删除按钮。
- 删除走保护式：后端返回 409 时提示「仍有启用规则/未处理告警引用，无法删除，请先解绑」。
- 规则表单：`ai_type` 单选下拉 → `aiTypes` **多选下拉**，选项来自 `/api/ai-types`（可在此直接「新增类型」）。

### Phase 6 — 通道映射多选（IotChannelManage）
- 每行增加「AI 类型」多选（选项来自 `/api/ai-types`），保存调 `PATCH /api/iot-channels/:id/ai-types`。
- 仅元数据，不约束聚合（Q4）。

### Phase 7 — 告警列表（AlertHistoryModal）
- **基本不动**：`AggregateWarning.aiType` 仍是单值、聚合仍按单类型分组，渲染逻辑天然兼容。
- 仅需确认 aiType 展示用的是动态字符串（已是），无需改。

## 五、构建 / 部署 / 验证（Phase 8）
1. 本地 `npx vite build` → 确认无类型错误。
2. `scp dist/*` → `/opt/jsc/frontend/`。
3. 重启 `jsc-backend`（表结构变更 + 代码变更需重启加载）。
4. 验证脚本（复用 V1 思路）：
   - 确认 `ai_types` 已种子 7 个；`push_rules` 老行已迁移 `ai_types`。
   - 新建规则「龙泗路 + {堆头未覆盖,道路扬尘} + 24h + 阈值3」。
   - 注入该通道两类各 3+ 条 → 应各自折叠成 2 个聚合行（每类独立）。
   - 标记处理后两行均消失；原始 warnings 存档保留。
   - 删类型时若规则仍引用 → 返回 409 被拒；解绑后再删成功。
5. 清理测试数据。

## 六、影响与风险小结
- **零数据迁移**：现有规则/历史告警用名字匹配，不受影响（Q3）。
- **表结构**：`ai_types` 新建、`iot_channels`/`push_rules` 加列（SQLite ADD COLUMN 安全）。
- **前端去写死**：`AI_ANALYSIS_TYPES` 改动态，未登录/离线时列表可能空 → 保留 7 个作 initial fallback。
- **保护式删除**：避免规则漂成空规则或漏警（Q5）。
- **回滚**：`jsc-rollback` 覆盖前端/后端/SQLite，但表结构变更不可逆 → 重大改动前补 tarball 快照。
