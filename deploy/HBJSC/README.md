# HBJSC 部署件（驾驶舱重新部署）

配套流程文档：`.workbuddy/memory/REF_驾驶舱重新部署流程.md`（**从上到下照做即可**）

## 目录
| 路径 | 内容 |
|---|---|
| `scripts/p0_01_skeleton.sh` | 建 `/data/HBJSC` + `/video` 软链 + 磁盘隔离校验 |
| `scripts/p0_02_deps.sh` | nginx/ffmpeg/pip + **Node 22**（官方 tarball → tools/node22） |
| `scripts/p0_03_install.sh` | 解 7/9 底座 → 叠加 9 月代码 → 建 `jsc` 用户 → nginx 站点 → systemd |
| `scripts/p0_04_fix.sh` | 修 Node 版本 / 代码叠加 / npm 补依赖 |
| `scripts/p0_05_zlm.sh` | ZLMediaKit 源码编译 + 部署（裸部署，非 Docker） |
| `scripts/p0_06_zlm_cfg.sh` | ZLM 配置精确修补（端口/secret/hook）+ 冲突预检 + 启动 |
| `scripts/p0_07_finalize.sh` | ZLM 端口修正 + 逐文件 md5 门禁 + 落安装清单 |
| `scripts/e2e_test_engine.sh` | straw-engine 全链路端到端验收（桩模型+合成视频，测完自动清场） |
| `scripts/build_wanzhou_towns.py` | 镇街边界 geojson 生成/校验（需高德「Web服务」key 或原文件） |
| `scripts/fix_warnings_final.sh` | `/api/warnings` 保留期放宽（含回滚脚本生成） |
| `straw-engine/app/main.py` | **straw-engine 重写版（819 行，2026-09-30）** |
| `straw-engine/app/detector.py` | 检测封装（= 优化后版本，328→106ms） |
| `straw-engine/config/config.json` | 引擎配置（双模型 day/night、inputSize=1920、maskSky*、cfmNeed=3） |

## 执行方式（务必遵守）
```bash
tr -d '\r' < scripts/p0_01_skeleton.sh > /tmp/x_lf.sh    # ① 剥 CR（Write 落盘是 CRLF）
scp -P 22233 /tmp/x_lf.sh root@111.10.220.226:/tmp/       # ② 上传成文件
ssh -p 22233 root@111.10.220.226 "bash /tmp/x_lf.sh"      # ③ 以文件方式执行（不靠 stdin）
# 访问用 SSH_ASKPASS（本机 Git Bash 下 sshpass 不可用），见流程文档 §1
```

## 2026-09-30 实测校正记录（照 runbook 在新机上逐条核对后的修正）

对新机现状做了一次穷尽审计（4 轮只读 + 实跑 `p0_01`），把脚本/文档与**实测现状**的偏差修正如下：

| 脚本 | 修正前（错的） | 修正后（与现状一致） |
|---|---|---|
| `p0_02_deps.sh` | 装 **Node 20** → `tools/node`；门禁只查 `>=16` | 装 **Node 22** → `tools/node22`；门禁 `>=22` **+ 实测 `require('node:sqlite')`** |
| `p0_03_install.sh` | `ExecStart=…/tools/node/bin/node`（v20，起不来）；装 nginx 站点**不备份** | `ExecStart=…/tools/node22/bin/node`；覆盖前先备份到 `sites-backup/` |
| `p0_03_install.sh` | 验收打印 `/api/health` 期望 200 | 标注 **401=需鉴权属正常**，改用 `/api/map-points` 验 200 |
| `p0_04_fix.sh` | `npm install`（在 **pnpm 结构**上必崩） | 检测 `.pnpm` → 走「临时目录 `npm i` 再 `cp -r` 回填」 |
| `p0_05_zlm.sh` | `cp …/release/linux/**Debug**/*` + `\|\| true`（静默拷 0 文件） | 自动探测 **`Release/`** + **拷完验存在**（不用 `\|\| true`） |
| `p0_05_zlm.sh` | `git clone github.com`（实测 000 不通） | 增加 **gitee 镜像兜底** + 离线预置提示 |
| `p0_06_zlm_cfg.sh` | 写 `[https] port=4443`（**非标准键，被忽略**） | 写 `[http] **sslport**=4443`（正确键） |
| `p0_06_zlm_cfg.sh` | 写 `[rtp] rtpPortRange=…`（**非标准键**） | 写 `[rtp] **port_range**=40000-40500`（正确键） |
| `e2e_test_engine.sh` | `find "$R/evidence"`（软链不跟，恒 0） | `find **-L** "$(readlink -f …)"` |

**另记两条活体结论（非脚本）**：
- ⚠️ **nodemailer 时序坑**：后端若在 nodemailer 就位**之前**启动，`monitor.js` 模块加载时 `require` 失败并缓存 `null` → 进程内邮件告警长期失效。**补依赖后必须 restart 后端**。（本次已 restart 修复。）
- `[websocket] port=6081` 配置了但 ZLM **未起独立监听**（无害，本系统走 FLV/HLS）。

## 三条铁律
1. **大数据只写 `/data`（含 `/video` 软链），严禁系统盘 `/`**
2. **同机备份等于没备** —— 部署完成后把代码+配置打 tar **拉回本机**
3. **任何写在服务器上的服务，源码必须回落本机仓库**
