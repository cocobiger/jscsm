# AI 分析存档栏目 — 功能评估报告与修复方案

> 日期：2026-07-10  
> 状态：**根因已定位，修复已部署**

---

## 一、栏目功能点梳理

「AI 分析存档」包含三个子标签页：

### 1. 存档记录
- **功能**：展示所有 AI 视频分析推送记录（缩略图、通道、AI 类型、置信度、等级、时间、坐标）
- **数据源**：`GET /api/iot-analysis/archive`（按通道分组返回记录）+ `GET /api/iot-analysis/status`（通道在线/告警状态）
- **刷新**：每 15 秒自动轮询

### 2. 通道接入
- **功能**：管理 IoTCloud 通道接入（查看远程通道列表、接入/移除通道、映射视频流、启停通道、AI 类型多选映射）
- **数据源**：`GET /api/iot-channels`（本地通道列表）+ `GET /api/streams`（视频流列表）+ `GET /api/iot-analysis/iot-channels`（远程通道列表）
- **子组件**：`IotChannelManage.tsx`

### 3. 推送规则
- **功能**：配置降噪规则（通道 + 多 AI 类型 + 时间窗 + 阈值），以及 AI 类型主数据管理（增删）
- **数据源**：`GET /api/push-rules` + `GET /api/iot-channels`（通道下拉）+ `GET /api/ai-types`（AI 类型列表）
- **子组件**：`PushRulePanel`（内嵌于 `IotArchivePage.tsx`）

---

## 二、发现的问题

### 问题 P0（严重 · 已修复）：apiFetch 误用导致整个栏目数据加载失败

**根因**：

`IotArchivePage.tsx` 中 **7 处** 代码错误使用了 `apiFetch`：

```javascript
// ❌ 错误写法（把 apiFetch 当 authFetch 用）
apiFetch<T>('/api/...').then(r => r.ok ? r.json() : fallback)
```

**原因分析**：

| 函数 | 返回类型 | 正确用法 |
|------|----------|----------|
| `authFetch(url)` | `Promise<Response>`（原生 Response） | `.then(r => r.ok ? r.json() : fallback)` ✅ |
| `apiFetch<T>(url)` | `Promise<T>`（已解析的 JSON） | 直接使用返回值，失败时走 `.catch()` ✅ |

`apiFetch` 内部已经做了 `resp.ok` 判断和 `resp.json()` 解析，返回的就是最终数据。但在 `IotArchivePage.tsx` 中，7 处代码对 `apiFetch` 的返回值再次调用了 `r.ok`（对一个数组/对象取 `.ok` → 恒为 `undefined` → falsy），导致**始终走 fallback 分支返回空数据**。

**影响范围**：

| # | 位置 | API | 影响 |
|---|------|-----|------|
| 1 | `IotArchivePage.load()` | `/api/iot-analysis/archive` | 存档记录列表**始终为空** |
| 2 | `IotArchivePage.load()` | `/api/iot-analysis/status` | 通道状态**始终为空** |
| 3 | `PushRulePanel.loadAiTypes()` | `/api/ai-types` | AI 类型不从 API 加载（fallback 到 7 个写死枚举） |
| 4 | `PushRulePanel.load()` | `/api/push-rules` | 规则列表**始终为空** |
| 5 | `PushRulePanel.load()` | `/api/iot-channels` | **通道下拉只有「全部通道」**（根因！） |
| 6 | `PushRulePanel.load()` | `/api/ai-types` | 同 #3 |
| 7 | `PushRulePanel.refreshAiTypes()` | `/api/ai-types` | 删除 AI 类型后列表不刷新 |

> **注**：`IotChannelManage.tsx` 使用了正确的写法（`.then(d => ...)` 直接消费），因此通道接入页面功能正常。

**为何之前没发现**：
- 存档记录列表为空时，用户可能以为是"没有 AI 分析数据"
- 规则列表为空时，用户以为是"还没建过规则"
- 通道下拉为空时，用户以为是"通道还没接入"
- 直到用户尝试新建规则并发现通道下拉只有"全部通道"，才暴露问题

### 问题 P1（次要 · 已修复）：AI 类型删除 409 错误信息丢失

后端 `DELETE /api/ai-types/:name` 在类型被引用时返回 409 + `{ ok: false, reason: 'rule' }`，但缺少 `error` 字段。`apiFetch` 在 409 时抛异常，只提取 `error` 和 `code` 字段，`reason` 丢失。导致前端无法区分"被规则引用"还是"有未处理告警"。

**修复**：后端 409 响应增加 `error` 描述字段；前端 `delAiType` 改为 `catch` 异常直接显示 `e.error`。

---

## 三、修复方案（已实施）

### 3.1 前端修复（`IotArchivePage.tsx`）

7 处 `.then(r => r.ok ? r.json() : fallback)` → `.catch(() => fallback)`

```javascript
// ✅ 修复后
apiFetch<T>('/api/...').catch(() => fallback)
```

### 3.2 后端修复（`index.js`）

```javascript
// 409 响应增加 error 描述
if (!r.ok) {
  const msg = r.reason === 'rule' ? '该 AI 类型被启用的推送规则引用，无法删除'
    : r.reason === 'warning' ? '该 AI 类型存在未处理告警，无法删除' : '无法删除'
  return res.status(409).json({ ...r, error: msg })
}
```

### 3.3 数据清理

- 已删除测试规则 `name='test'`
- DB 确认有 7 个通道、7 个 AI 类型、9 条用户创建的规则

---

## 四、当前 DB 实际数据状态

### 通道（7 个）
| channel_sip_id | channel_name |
|----------------|-------------|
| 56331706881318000004 | 九龙沙场 |
| 50010100001310000001 | 红溪沟作业区 |
| 50010100001310000002 | 苏商码头 |
| 56331706881318000003 | 桐子园码头 |
| 34020000001310000005 | 龙泗路 |
| 34020000001310000006 | 厂区主道(彼迪) |
| 34020000001310000007 | 大门干道（万源玻璃） |

### AI 类型（7 个）
堆头未覆盖、道路扬尘、秸秆燃烧、违规排污、固废与危废违规倾倒、固废运输违规、侵占岸线与水面漂浮物

### 推送规则（9 条，全部 enabled）
用户测试期间创建了多条名称相近的"堆头未覆盖"规则，建议清理重复项，只保留需要的。

---

## 五、验证步骤

1. **Ctrl+F5 强制刷新** `http://111.10.220.226:81/jsc/`
2. 进入 **管理端 → AI 分析存档**
3. **存档记录**标签：应能看到 AI 分析记录列表（如有数据）
4. **通道接入**标签：应能看到 7 个已接入通道
5. **推送规则**标签：
   - 规则列表应显示 9 条已有规则
   - 点击「新增规则」→ 通道下拉应显示 7 个具体通道 + "全部通道"
   - AI 类型多选应显示 7 种类型
   - 填写后点「保存」应成功创建并刷新列表
6. AI 类型管理区的「添加」和「删除」功能正常

---

## 六、经验教训

`apiFetch`（返回 parsed JSON）和 `authFetch`（返回原生 Response）是两套不同的 API 调用模式，**不能混用** `.then(r => r.ok ? r.json() : ...)` 模式。已更新项目 MEMORY.md 记录此教训。
