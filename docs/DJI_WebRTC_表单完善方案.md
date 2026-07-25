# 大疆司空 WebRTC 接入参数 — 评估与安全完善方案

## 一、现状评估

### 1.1 当前表单字段（VideoStreamPage.tsx → DJIWebRTCForm）

| 字段 | 标签 | 必填 | 说明 |
|------|------|------|------|
| shareUrl | 分享页 URL | ✓ | 大疆司空分享页链接 |
| airportName | 机场名称 | ✓ | "页面左侧边栏显示的机场名称" |
| airportIndex | 机场索引 | ✗ | "左侧边栏第几个按钮（0 开始）" |
| bitrate | 推流码率 | ✗ | 默认 1500 kbps |
| width / height | 窗口宽高 | ✗ | 默认 960×540 |
| keepAlive | 持续保持浏览器推流 | ✗ | 默认 true |

### 1.2 核心问题

#### 问题 1：`parentName` 在 UI 中完全缺失 ⚠️ 严重

- `DJIWebRTCConfig` 类型定义中**没有 `parentName` 字段**
- 但后端 `djiStreamId()`、`dji-bridge.js` 的 `startSession()`、前端 `VideoPlayerModal.tsx` 的 sid 计算都**已经在使用 `parentName`**
- 实际数据库中的两条 DJI 流记录已经手动写入了 `parentName`（如 `"M4TD | 4TD-三峡科技大学"`）
- **后果**：管理员在后台编辑这两条流时，`parentName` 会被表单的 `EMPTY_DJI_WEBRTC` 覆盖为 `undefined`，导致 streamId 变化、推流失败

#### 问题 2：字段语义与实际页面结构不匹配

当前标签和提示：
- `airportName` → 标签"机场名称"，提示"页面左侧边栏显示的机场名称"

实际大疆司空页面有两种设备结构：
- **顶层设备模式**：`airportName` = 边栏设备名（如 `"Dock 3 | 机场3-三峡科技大学"`）→ 直接点击开播
- **嵌套子相机模式**：`parentName` = 父设备名（如 `"M4TD | 4TD-三峡科技大学"`），`airportName` = 子相机名（如 `"Matrice 4TD"`）→ 先展开父设备再点击子相机

表单没有区分这两种模式，用户无法知道 `airportName` 到底该填什么。

#### 问题 3：`airportIndex` 定义模糊且有风险

- 索引点击依赖页面布局稳定性，大疆页面改版会导致索引错位
- 嵌套模式下索引指向不明（是父设备索引还是子相机索引？）
- 实际使用中从未通过索引成功接入过，应降级为高级选项

#### 问题 4：技术参数干扰配置

`width`/`height`/`bitrate` 对非技术用户是噪音。实际默认值（1280×720, 2000kbps）适用于所有现有场景，不需要每次配置时都看到。

#### 问题 5：无 streamId 可见性

派生 streamId 是 ZLM 流名、pidfile 命名、nginx 路由的核心标识，但用户完全看不到它。排障时无法快速定位是哪路流出了问题。

#### 问题 6：无配置校验和预览

保存前无法验证：
- 分享页 URL 是否可达
- 填写的设备名是否与页面实际文字匹配
- 是否存在同名子相机冲突

---

## 二、安全完善方案

### 2.1 设计原则

1. **向后兼容**：不改变已有数据库记录的存储格式，`parentName` 作为可选字段加入类型定义
2. **模式引导**：通过"接入模式"选择器让用户明确当前是顶层设备还是嵌套子相机
3. **默认安全**：技术参数折叠到高级设置，默认值不变
4. **可观测性**：显示派生 streamId 供排障
5. **不动播放链路**：只改管理后台表单，不修改 VideoPlayerModal / VideoWall / MapView 等播放组件

### 2.2 具体改动

#### 改动 1：类型定义扩展（DashboardContext.tsx）

```typescript
export interface DJIWebRTCConfig {
  shareUrl: string
  airportName: string
  parentName?: string        // ← 新增：嵌套子相机模式的父设备名称
  airportIndex?: number
  keepAlive?: boolean
  width?: number
  height?: number
  bitrate?: number
}
```

#### 改动 2：表单重构（VideoStreamPage.tsx → DJIWebRTCForm）

**新增"接入模式"选择器**：
- `顶层设备`（默认）：填写 shareUrl + airportName（设备名称）
- `嵌套子相机`：填写 shareUrl + parentName（父设备名称）+ airportName（子相机名称）

**字段标签修正**：
| 模式 | 字段 | 标签 | 提示 |
|------|------|------|------|
| 顶层 | airportName | 设备名称 * | 页面左侧边栏显示的设备名称，如 "Dock 3 \| 机场3-三峡科技大学" |
| 嵌套 | parentName | 父设备名称 * | 可展开的设备组名称，如 "M4TD \| 4TD-三峡科技大学" |
| 嵌套 | airportName | 子相机名称 * | 展开后的子相机名称，如 "Matrice 4TD"、"辅助影像" |

**高级设置折叠区**：
- 推流码率（默认 2000 kbps）
- 窗口宽高（默认 1280×720）
- 机场索引（标注"一般无需填写，仅当名称匹配失败时使用"）
- keepAlive 开关

**streamId 预览**：
- 根据 shareUrl + parentName + airportName 实时计算并显示派生 streamId
- 标注"此 ID 用于 ZLM 流命名，修改参数会导致地址变化"

#### 改动 3：EMPTY_DJI_WEBRTC 默认值调整

```typescript
const EMPTY_DJI_WEBRTC: DJIWebRTCConfig = {
  shareUrl: '', airportName: '', parentName: undefined,
  keepAlive: true, width: 1280, height: 720, bitrate: 2000,
}
```

（width/height/bitrate 默认值从 960/540/1500 调整为实际使用的 1280/720/2000）

### 2.3 安全保障

| 风险 | 保障措施 |
|------|----------|
| 编辑已有 DJI 流时丢失 parentName | 表单初始化时从 `s.djiWebRTCConfig` 完整读取（含 parentName） |
| 模式切换导致字段丢失 | 切换模式时保留已填写的共享字段（shareUrl） |
| 向后兼容旧记录 | parentName 为 undefined 时走顶层设备逻辑，与现有代码一致 |
| 播放链路不受影响 | 不修改 VideoPlayerModal / dji-bridge.js / index.js 中的任何逻辑 |
| 默认值变更不影响已有流 | 已有流从数据库读取完整配置，不受 EMPTY_DJI_WEBRTC 影响 |

### 2.4 不改动的部分

- `VideoPlayerModal.tsx` 的 sid 计算逻辑 — 已经支持 parentName，无需改动
- `server/index.js` 的 `djiStreamId()` — 已经支持 parentName，无需改动
- `server/dji-bridge.js` 的 `startSession()` — 已经透传 parentName，无需改动
- `dji_bridge.py` — 不改动
- 数据库中已有记录 — 不改动

---

## 三、实施清单

1. ✅ `DashboardContext.tsx`：DJIWebRTCConfig 添加 `parentName?: string`
2. ✅ `VideoStreamPage.tsx`：
   - EMPTY_DJI_WEBRTC 添加 parentName + 调整默认值
   - DJIWebRTCForm 重构：接入模式选择器 + 条件字段 + 高级折叠 + streamId 预览
   - handleEdit 确保完整读取 djiWebRTCConfig（含 parentName）
3. ✅ 本地构建验证无 TypeScript 错误
4. ⏳ 部署到服务器（用户确认后）
