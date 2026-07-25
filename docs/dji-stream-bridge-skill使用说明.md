# dji-stream-bridge Skill 使用说明

## 一、Skill 概述

| 项目 | 内容 |
|------|------|
| **名称** | `dji-stream-bridge` |
| **级别** | User-level（跨项目生效，所有项目可用） |
| **安装位置** | `~/.workbuddy/skills/dji-stream-bridge/` |
| **文件结构** | SKILL.md + references/（3个参考文档） |
| **用途** | 大疆司空 FlightHub 分享页视频直播流接入驾驶舱/大屏系统 |

## 二、触发方式

### 自动触发（推荐）

WorkBuddy 会在以下场景**自动加载**此 Skill：

| 场景 | 示例用户输入 |
|------|-------------|
| **接入新视频流** | "把大疆无人机视频流接入驾驶舱"、"新增一个 DJI 机场摄像头" |
| **排查推流异常** | "DJI 推流失败"、"无人机视频画面黑屏"、"HLS 404" |
| **修改流配置** | "把这个机场流改成无人机画面"、"DJI 流换一个设备" |
| **提及大疆/司空/DJI** | "大疆司空的直播怎么接入"、"FlightHub 分享页的视频" |
| **提及 dji_bridge** | "dji_bridge.py 配置"、"bridge 进程异常" |

### 关键触发词

以下关键词会高概率触发此 Skill：

```
大疆、无人机、司空、FlightHub、fh.dji.com、DJI WebRTC
dji_bridge、dji-bridge、Dock Camera、Matrice 4TD
机场视频、无人机直播、视频流接入
推流异常、Already publishing、HLS 404
ZLMediaKit、RTMP 推流
```

### 手动触发

在对话中输入：
```
/dji-stream-bridge
```
或明确说：
```
加载 dji-stream-bridge skill
```

## 三、Skill 包含的知识

### SKILL.md（核心流程）

| 章节 | 内容 |
|------|------|
| 架构概览 | FlightHub → Playwright+Xvfb → ffmpeg → RTMP → ZLM → nginx → hls.js 全链路 |
| 两种接入模式 | ① 顶层设备(Dock Camera) ② 嵌套子相机(Matrice 4TD/辅助影像) |
| streamId 派生 | 嵌套模式：`deriveStreamId(shareUrl + '#' + parentName + '|' + airportName)`；顶层设备：`deriveStreamId(shareUrl + '#' + airportName)`；前后端一致算法 |
| 完整接入步骤 | 确认分享页 → 写数据库 → 重启后端 → 验证（4步） |
| dji_bridge.py 参数表 | 10个关键命令行参数说明 |
| 三大必修复 | 部署前必须确认的3个代码修复 |
| 故障速查表 | 6种常见错误 → 根因 → 修复 |
| nginx 配置要求 | 端口80+81各需5个location块 |
| 修改已有流配置 | 改配置 → sid变化 → 重启 → 刷新的完整流程 |

### references/（参考文档，按需加载）

| 文件 | 内容 | 何时加载 |
|------|------|---------|
| `dji_bridge_fixes.md` | 三大必修复项的详细代码对比和验证方法 | 修改 dji_bridge.py 或排查全屏/点击问题时 |
| `troubleshooting.md` | 6种故障的排查工具+修复步骤 | 排查推流异常时 |
| `database_config.md` | coll_streams 表结构+后端逻辑+ZLM配置 | 数据库操作或理解后端机制时 |

## 四、典型使用场景

### 场景 1：接入新的机场摄像头

```
用户：把大疆司空分享页 https://fh.dji.com/share/live/XXX 上的
      "机场5-XX" 视频流接入驾驶舱

→ Skill 自动加载，提供：
  1. 确认设备名称（顶层设备，无 parentName）
  2. 写入 coll_streams 的 SQL 模板
  3. 重启后端命令
  4. 验证命令（HLS + 截帧）
```

### 场景 2：接入无人机子相机

```
用户：把 "M4TD | 4TD-XX" 下面的 "Matrice 4TD" 子相机接入

→ Skill 自动加载，提供：
  1. 确认父子设备名称
  2. djiWebRTCConfig 模板（含 parentName）
  3. 嵌套模式注意事项（展开等待8s + Strategy D）
  4. 验证截帧标题是否正确
```

### 场景 3：排查推流异常

```
用户：DJI 视频流报 "Already publishing" 错误

→ Skill 自动加载，提供：
  1. 根因：pidfile 名不匹配导致重复启动
  2. 排查命令（检查进程 + pidfile）
  3. 修复步骤（杀进程 + 修正 pidfile 名）
```

### 场景 4：排查画面问题

```
用户：无人机画面全黑 / 标题显示错误设备

→ Skill 自动加载，提供：
  1. RTMP 截帧验证命令
  2. Xvfb 截图命令
  3. 三大必修复项检查清单
```

## 五、Skill 不适用的场景

| 场景 | 应该用什么 |
|------|-----------|
| IoTCloud 视频分析 | `iot-fetcher.js` 相关代码，非此 Skill |
| RTSP/ONVIF 摄像头接入 | 前端 needsTranscode + ZLM addStreamProxy |
| H.265 转码问题 | transcoder_v2.js + jsc_h264 app |
| 通用 nginx 配置 | 直接查 uav-sites / skymonitor.conf |

## 六、维护说明

### 更新 Skill

当发现新的故障模式或修复方法时，更新对应文件：

```bash
# 编辑核心流程
编辑 ~/.workbuddy/skills/dji-stream-bridge/SKILL.md

# 添加新的故障排查条目
编辑 ~/.workbuddy/skills/dji-stream-bridge/references/troubleshooting.md

# 添加新的代码修复
编辑 ~/.workbuddy/skills/dji-stream-bridge/references/dji_bridge_fixes.md
```

### 重新打包

```bash
python ~/.workbuddy/plugins/marketplaces/cb_teams_marketplace/plugins/skill-creator/scripts/package_skill.py \
  ~/.workbuddy/skills/dji-stream-bridge
```

### 验证 Skill 已安装

```bash
ls ~/.workbuddy/skills/dji-stream-bridge/
# 应看到 SKILL.md + references/
```

## 七、关联资源

| 资源 | 位置 |
|------|------|
| dji_bridge.py 源码 | `deploy/dji_bridge.py` |
| Node 管理层 | `server/dji-bridge.js` |
| 后端路由 | `server/index.js`（/api/dji-bridge/start, /api/stream/start） |
| 前端播放器 | `src/app/components/VideoPlayerModal.tsx`（deriveStreamId） |
| 服务器运行时 | `/opt/jsc/dji-bridge/dji_bridge.py` |
| 已有 DJI 流接入 Skill | `~/.workbuddy/skills/dji-stream-bridge/` |
| 项目记忆 | `.workbuddy/memory/MEMORY.md`（DJI 相关条目） |
