# JSC 长期记忆（万州秸秆焚烧 / 驾驶舱）

> **本文件是索引，不是手册。** 只放「每次会话都必须知道」的铁律与指针；**细节全在 REF 里**。
> ⚠️ 2026-10-03 已压回注入限额以下。**新增内容请写进对应 REF 或当日日志 `YYYY-MM-DD.md`，不要再往这里堆**——超限会被截断，等于记忆丢失。
> 📦 **2026-10-13 起：`MEMORY.md` 与 `REF_*.md` 随仓库走**（`.gitignore` 开了例外），换电脑 clone 即有；
> 当日日志 `YYYY-MM-DD.md` 仍只在本地。**换机器/换人的第一入口 = `docs/微信推送域_交接指南_20261013.md`。**

## 📁 REF 索引（要细节先读这里，别凭记忆推断）
| 主题 | 文件 | 何时必读 |
|---|---|---|
| **🔰 微信推送域交接指南（换机器/换人第一入口）** | `docs/微信推送域_交接指南_20261013.md` | **换电脑、换人接手、或要动微信推送时，先读它**（含拓扑/契约/铁律/坑/回滚/落地清单） |
| **驾驶舱重新部署全流程** | `REF_驾驶舱重新部署流程.md`（§0–18） | **要重建/部署 → 直接照它做**；含访问方式、布局、P0–P4 分阶段命令、门禁、坑、回滚、司空 apikey、geojson、驱动、训练环境、ollama、预筛台 |
| 数据 / 标注治理 | `REF_annotation_protocol.md` | 做标注/复核工具、整理训练集之前 |
| 秸秆引擎运行时契约 | `REF_straw_engine.md` | 改引擎之前 |
| 「远方轻烟」迭代基线 | `REF_smoke_far_iteration.md` | 讨论小目标/召回之前 |
| 驾驶舱 KPI / 前端门禁 | `REF_cockpit_kpi.md` | 改 KPI、改前端契约、改地图主题之前 |
| 司空2 / ZLM / 8.11 | `REF_sikong_infra.md` | 改视频链路、司空对接之前 |
| **推送域（两条链路/三道闸/城运）** | `REF_push_domain.md` | 改推送、责任映射、城运贯通、口径之前；**含"本机仓库落后生产"的风险记录** |
| 微信桥（Win10 VM） | `REF_wechat_bridge.md` | 动微信推送之前 |
| 沙箱/工具链坑 | `REF_sandbox_pitfalls.md` | **动手前必读**（多数是"静默失败"） |
| **历史日志蒸馏（2026-06 ~ 09）** | `REF_历史蒸馏_2026-06_07.md` ｜ `REF_历史蒸馏_2026-08.md` ｜ `REF_历史蒸馏_2026-09上旬.md` | 查更早的**契约 / 坑 / 已否决**（原 47 个日志已蒸馏并归档到 `backups/memory_logs_archive_20261003.tar.gz`） |

## 🚨 铁律（最高优先级）
1. **标注铁律（用户定调）**：工具内置防污染；**宁多标不进脏数据**；拿不准→「不确定/暂缓」；可疑样本隔离默认不入集；
   新标注页照抄 **7 道闸**；正负增量同批匹配。→ `REF_annotation_protocol.md`
2. **同机备份等于没备** ⇒ 关键产物必须有**离开该主机/该 ESXi** 的副本。
3. **"关键源码只在服务器上"是隐形单点** ⇒ 服务器上写的服务，**源码必须回落本机仓库**。
4. **大数据/模型/数据集只写 `/data`**（`/video` 是软链）；**禁系统盘 `/`**、禁 ESXi 快照；回滚用文件级备份。
5. **给人看的界面禁止直出视频流 URL**（27 路里 22 路含明文 RTSP 凭据）→ 必须走 `maskStreamUrl()`。

## 🔴🔴 A 级事件：原生产机被整体重装（2026-09-29，9/30 查明）
- 原 `userver`（172.16.8.12，内网=现公网 `111.10.220.226`）**被 Curtin autoinstall 重装**，hostname 改 `dajiang`；
  7TiB `/video` 盘被删；**无任何快照、全盘搜 0 命中 ⇒ 无救援可能**。
- **已丢失且无副本**：`/video` 全部数据集与模型（现网 `stage9_1920`/`stage3_0909`）、evidence、7/9 之后约 2.5 个月运行数据。
  （⚠️ `outputs/v5_smoke27.tar.gz` 实为 58 张样本图，**不是模型**。）
- ✅ **已重建（9/30–10/1）**：驾驶舱四服务 + straw-engine（`main.py` 重写 819 行）+ **RTX 3090 驱动** + 引擎 GPU 推理 +
  **训练环境** + **抽帧链路** + **VLM 预筛** + **乡镇街道边界数据**。
- 事件报告 `docs/jsc生产环境被重建_事件报告_20260930.html`｜工时 `docs/jsc新机重建方案与工时评估_20260930.html`。
- **仍阻塞**：① **司空2 网段 `172.28.0.0/24` 全超时**（dji-openapi / 无人机视频 / 遥测的最大阻塞）；
  ② **烟雾模型缺失**（引擎空管线：照常抽帧不出框）；③ 业务数据停留在 2026-07-09。

## 🌐 访问与红线（`ssh -p 22233 root@111.10.220.226`，hostname `dajiang`）
- **22 端口不开是正常的**（一直用非标端口）。**`111.10.220.226` = 内网 `172.16.8.12`**（Ubuntu 22.04.5 / 96 核 / 188 G）。
- **本机 Git Bash 下 `sshpass` 不可用**（拿不到 pty → 一直 `Permission denied`，**极像密码错**）
  ⇒ 用 **`SSH_ASKPASS`**（`askpass.sh` + `SSH_ASKPASS_REQUIRE=force DISPLAY=:0` + `-o PubkeyAuthentication=no`）；`scp` 用 `-P 22233`。
- ⚠️ **公网 IP 上看到的是「端口映射表」不是「主机监听列表」**（背后是华三网关 + 多台内网机）
  ⇒ 某端口关只能推"映射被删/后端没起"，**不能推"机器没了"**。排障见 skill `backend-service-recon`。
- **ESXi `172.16.8.24`**：SSH(22) 已关、`:443` 可用 ⇒ 只读查盘 `/folder?dcPath=ha-datacenter`；
  **钻取必须用 `/folder/<子路径>?dcPath=…&dsName=<ds>`**（`path=` 无效）。
- **迁移/重建相关**：`⭐ 安装根 = /data/HBJSC`；入口 `http://111.10.220.226:81/jsc/`；
  登录 `/api/auth/login`（**不是 `/api/login`**）`admin/admin123`；
  nginx `/jsc/` 的 alias 指向 **`/data/HBJSC/frontend/`**；**Node 必须 22+**（后端用 `require('node:sqlite')`）；
  **ZLM hook 非 200 会拒绝推流** ⇒ 只配 `on_publish=…/api/zlm/publish-check`。
- **ZLM secret = `<ZLM_API_SECRET（见服务器 /data/HBJSC/backend/data/config.json 的 zlm.zlmSecret）>`**（在 `backend/data/config.json`）。
- git `git@github-jsc:cocobiger/jscsm.git`；**禁提交** `.env` / `streams.json` / `backups/`。
  ⚠️ 本机仓库长期有大量未提交改动 ⇒ 是**独特资产**，别 `git checkout --` 一把清掉。

## 🔴 沙箱坑（只有最危险的 3 条在这里，其余见 `REF_sandbox_pitfalls.md`）
- **`sshpass` 不可用** → 用 `SSH_ASKPASS`（同"访问与红线"）。
- **Write 落盘是 CRLF** ⇒ `ssh "bash -s" <脚本` 里内层 heredoc 结束标记 `PY\r ≠ PY`，bash 把后面整段吞掉
  ⇒ **`tr -d '\r'` 剥 CR + scp 成文件后 `bash /path.sh`**；正则要写 `;\r?\n`。
- **`python -m uvicorn main:app` 只 import 模块** ⇒ `__main__` 块不执行，后台线程必须挂 **ASGI lifespan**
  （否则"服务 active、端口在听、**0 个 worker**"）。
- 长任务**必须** `setsid nohup … &` 脱离 SSH 会话（本机 SSH 会中途断，表现为 SIGTERM+空输出），再用短命令轮询日志。

## 🖥️ 当前部署状态（截至 2026-10-01）
| 服务 | 端口 | 状态 |
|---|---|---|
| nginx | 80/81 | ✅ |
| jsc-backend | 7170 | ✅ 9 月代码 + 7/9 库（39 表） |
| zlmediakit-jsc | 6080/5540/1936/4443 | ✅ 裸部署 |
| straw-engine | 7200 | ✅ **空管线**（无模型；GPU 推理已启用） |
| ollama | 11434（仅本机） | ✅ qwen2.5vl:7b，**100% GPU**，空闲 5min 卸载让出显存 |
| dji-openapi / dock-guard | 17810 / 7210 | ❌ 未部署（等司空网段） |

**算法训练「软件就绪」清单**：✅ GPU 驱动（580 预签名）｜✅ 引擎 GPU 推理（onnxruntime-gpu）｜
✅ 训练环境（`/data/HBJSC/train-venv` = torch 2.6.0+cu124 + ultralytics 8.4.169）｜✅ 抽帧链路（`record_frames.py`，直录不依赖 MinIO）｜
✅ VLM 预筛（`prescreen.py` + 复核台）｜⏳ **数据（P4 采集，受飞行窗口约束）** → 数据集/splits → 训练 → onnx 落位

## 🧠 关键口径（一句话版）
- **引擎统计铁律**：`source='alert'` 里 **74% 是模拟器帧** ⇒ 统计必须先过滤；干净口径 `stream_id LIKE 'sikong_%' AND exclude=0`。
- **尺度缺口（头号问题）**：1041 框里 `<40px` **仅 1.7%**、p05=54px ⇒ 模型没见过小目标，**降阈值救不回**（已三次证实）。
  ⚠️ **架构补不了数据缺口** —— 先补数据。见 `docs/论文评估_MSA-DETR小目标检测_20261003.html`（结论：**P2 小目标检测层必上**，三件套不必全上）。
- **算力不紧张**：3090 单路 2s 预算余量 **≈39×** ⇒ 可上 **ROI 切片** + `interval 2s→1s` 启用**时序判别**（"轻烟 vs 碎云"的正解）。
- **VLM 只做预筛不做标注**：❌ 不出框、❌ 不用文字提示驱动 YOLO。→ `REF_annotation_protocol.md`
- **前端类型门禁**：发布前必跑 `npm run verify`；契约唯一出处 `src/app/lib/api-types.ts`。→ `REF_cockpit_kpi.md`
- **核验门禁**：引用逐个 200 + **md5 磁盘==HTTP**；**scp 前先 cp 原版**；`:81` 是网关 hairpin DNAT→8.12:80
  （本机 `127.0.0.1:81/jsc/` 恒 404，正确是 `127.0.0.1:80/jsc/`）。

## 已沉淀 skills
`ts-type-gate-diagnosis` · `backend-service-recon` · `static-html-data-rebuild` · `esxi-datastore-storage-inspection` ·
`esxi-snapshot-datastore-rescue` · `sikong-openapi-integration` · `mqtt-device-onboarding` · `port-manager` ·
`windows-vm-rdp-automation` · `frontend-degradation-acceptance` · `straw-review-page-gen` ·
`build-artifact-credential-leak-audit` · `server-rebuild-from-backup` ·
`admin-boundary-geojson-onboarding` · `nvidia-driver-secureboot-install`
