# REF · jsc 驾驶舱「重新部署」流程（安装根 /data/HBJSC）

> **何时读**：需要在新机（或重建后的同机）把驾驶舱重新装起来时，**从上到下照做即可**。
> **一句话目标**：在一台只有 1T 系统盘 + 5T 数据盘的空 Ubuntu 上，把 nginx + 驾驶舱前端 + jsc-backend + ZLM（+ straw-engine）装到 `/data/HBJSC` 并跑通。
> 来源：2026-09-30 实战（原机被整体重装后从备份重建），全程实测。
>
> 📁 **配套部署件（耐久位置，已收进仓库）**：`deploy/HBJSC/`
> —— `scripts/`（8 个分阶段脚本 + 端到端验收 + geojson 工具）、`straw-engine/`（重写版 main.py/detector.py/config.json）、`README.md`（目录说明 + 执行方式 + 三条铁律）。
> `tmp/` 下的同名文件是**工作副本**；以 `deploy/HBJSC/` 为准。

---

## 0. 适用场景与前提

- 目标机：Ubuntu 22.04.x，能出网（**apt HTTP 可用即可**；`github.com:443` 时通时不通，见坑 §7.6）
- 手上有：① 本机仓库 `E:\CC work\CC jsc`；② 全量备份 `jsc-full.tar.gz`（含 `jsc.db` + nginx/systemd/ZLM 配置）；③ Git 远端 `git@github-jsc:cocobiger/jscsm.git`
- **不要**在没有备份的情况下动手；**不要**把大数据写系统盘（见 §2）

---

## 1. 访问方式（必须先掌握，否则连不上会误判"机器没了"）

```bash
# 主机：111.10.220.226 = 内网 172.16.8.12 ｜ SSH 端口是 22233（不是 22！）
ssh -p 22233 root@111.10.220.226
```

### 🔴 本机（Windows/Git Bash）下 `sshpass` 不可用 —— 用 SSH_ASKPASS
症状：服务器持续回 `Permission denied (publickey,password)`，**极像密码错**（其实是拿不到 pty、密码没发出去）。
```bash
# 1) 密码写在脚本文件里（避免 shell 引号/反引号被提前展开）
cat > /c/Users/Administrator/AppData/Local/Temp/jsc_askpass.sh <<'EOF'
#!/bin/sh
printf 'THE_PASSWORD'
EOF
chmod +x /c/Users/Administrator/AppData/Local/Temp/jsc_askpass.sh
# 2) 三个环境变量缺一不可
export SSH_ASKPASS=/c/Users/Administrator/AppData/Local/Temp/jsc_askpass.sh
export SSH_ASKPASS_REQUIRE=force
export DISPLAY=:0
# 3) 关公钥、只走密码
ssh -o BatchMode=no -o PubkeyAuthentication=no -o PreferredAuthentications=password \
    -o NumberOfPasswordPrompts=1 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -p 22233 root@111.10.220.226 "hostname"
```
`scp` 用同一组环境变量（`-P 22233`）。

### 🔴 跑脚本的铁律（踩过两次）
1. **Write 工具落盘是 CRLF** → `ssh "bash -s" <脚本` 里的**内层 heredoc 结束标记 `PY\r ≠ PY`**，
   bash 会把后面整段吞成一个命令（报错形如 `bash: line 48: V/python - <<'PY' ... No such file`，连 `$` 都丢了）。
2. **正解**：本地 `tr -d '\r' < x.sh > x_lf.sh` → `scp x_lf.sh host:/tmp/` → `ssh host "bash /tmp/x_lf.sh"`
   （**不靠 stdin**）；或另写一份 LF 副本再执行。
3. 复杂脚本**只**走「本地写文件 → scp → 执行」，**绝不**在 ssh 双引号里嵌 `$(...)` / 反引号（会被**本地**先展开）。

---

## 2. 目标布局（为什么是 /data/HBJSC）

判据：**装到"空间最充裕的那个盘"**，而不是照搬 `/opt`。

| 盘 | 容量 | 用途 |
|---|---|---|
| `/` （sda3 LVM） | 1T | 只放依赖软链与系统文件 |
| **`/data` （sdb1）** | **5.0T** | **安装根 `/data/HBJSC` + 大容量数据** |

```
/data/HBJSC/
├── frontend/      # 驾驶舱前端构建产物（nginx 站点根）
├── backend/       # jsc-backend（Node）
│   ├── data/      # jsc.db（业务库）+ config.json + iotcloud.env
│   └── logs/
├── zlm/           # ZLMediaKit 二进制 + config/config.ini
├── straw-engine/  # 秸秆引擎（app/ config/ venv/ evidence→/data/video/evidence）
├── dji-openapi/  dock-guard/   # B 阶段预留
├── tools/         # node22/ 等运行时
├── scripts/  backups/  logs/
├── README_LAYOUT.md
└── （/video 软链 → /data/video ；数据区 xunlian/ shujuji/ evidence/）
```

🔴 **必须建 `/video → /data/video` 软链**，否则程序按老路径写大数据会**写满 1T 系统盘**。
验证隔离是否成功：
```bash
dd if=/dev/zero of=/video/_chk.bin bs=1M count=64 status=none
df --output=source /video/_chk.bin   # 应是 /dev/sdb1
df --output=source /                 # 应是 /dev/mapper/ubuntu--vg-lv--0
rm -f /video/_chk.bin
```

---

## 3. 素材清单（重建靠什么）——开工前先确认这四项

| 资产 | 位置 | 内容 |
|---|---|---|
| **全量备份** | `.workbuddy/backups/pre-major-20260709-025453/jsc-full.tar.gz`（98MB/4543 条目，带 sha256） | `opt/jsc/backend`（代码 + node_modules + **`jsc.db` 168MB** + wal + `iotcloud.env`）、`opt/jsc/frontend`、`opt/jsc/dji-bridge`、`opt/zlm/config.ini`、`etc/nginx`（含 `sites-enabled/uav-sites`、`conf.d/skymonitor.conf`）、`etc/systemd/system/jsc-backend.service`、`zlmediakit-docker-inspect.json` |
| **Git 仓库** | `git@github-jsc:cocobiger/jscsm.git` | `src/`（前端，150 文件）、`server/`（**9 月版后端**，28 文件）、`infra/dji-openapi`、`infra/dock-guard`、`scripts/`；**本机另有约 177 个未提交改动** |
| **补丁脚本**（重写丢失服务的唯一依据） | `tmp/patch_main_skymask.py`、`.workbuddy/tmp/patch_engine_landing.py`、`tmp/detector_new.py`、`tmp/patch_engine_grace.py` | 逐字保留原码锚点与函数体 → 见 §6 |
| **部署脚本**（本机 `tmp/`） | `p0_01_skeleton.sh` … `p0_07_finalize.sh`、`e2e_test_engine.sh` | 分阶段可复跑 |

---

## 4. 分阶段流程（P0 → P4，每步都有门禁）

### P0 · 环境就绪（约 7 人时）
```bash
# ① 骨架 + /video 软链 + 磁盘隔离校验
bash p0_01_skeleton.sh            # 安全闸：/data 可用 <1T 中止；目标目录非空则先改名备份
# ② 依赖：nginx / ffmpeg / python3-pip + **Node 22**（装到 /data/HBJSC/tools/node22，只把 bin 软链进 /usr/local/bin）
bash p0_02_deps.sh
```
**门禁**：`nginx -t` 通过；`node -v` ≥ 16；`df` 显示 `/video` 落 `sdb1`。

> 🔴 **Node 必须 22+**：后端 `store-db.js` 用 `require('node:sqlite')`（Node **22.5+** 内置）。
> **apt 只有 nodejs 12.22.9** ⇒ 一律用 nodejs.org 官方 tarball。
> 装完立刻验证：`node -e "require('node:sqlite')"`。

### P1 · 后端 + 数据库（约 10 人时）
```bash
bash p0_03_install.sh     # 解 7/9 底座 + 叠加 9 月代码 + 建 jsc 用户 + 装 nginx 站点 + 写 systemd
bash p0_04_fix.sh         # 若 p0_03 的 Node/代码叠加出问题，用它修（叠加 + npm install + ExecStart 指 node22）
```

🔴 **配对策略（最容易搞错）**：**9 月版后端代码 + 7/9 数据库**。
- 7/9 库只有 `coll_*` 旧表；9 月版多 14 张表且**都用 `CREATE TABLE IF NOT EXISTS`** ⇒ 启动时自动补建缺表、基础表沿用 7/9。
- 反之（7 月代码 + 9 月前端）会**大量 404**。
- **务必保留 7/9 备份里的 `backend/data/config.json`**（`zlmHost=172.16.8.12` + 正确 secret）；
  仓库里的 `server/data/config.json` 是**开发机配置**（`192.168.0.106`），**不要**覆盖过去。

还原 SQLite 前先 checkpoint 并清点数据（把"拿到了什么"变成可核对数字）：
```bash
python3 - <<'PY'
import sqlite3
c=sqlite3.connect('/data/HBJSC/backend/data/jsc.db')
c.execute('PRAGMA wal_checkpoint(TRUNCATE)')
for (t,) in c.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
    print(t, c.execute('SELECT COUNT(*) FROM "%s"'%t).fetchone()[0])
PY
```
**门禁**：`systemctl start jsc-backend` → `is-active`；日志出现"数据库: …/jsc.db"；`/api/map-points` 返回 200。

### P2 · 前端（本机构建 → 上传）
```bash
# 本机（不要用 7/9 的旧产物，要用当前源码重建）
node node_modules/typescript/bin/tsc --noEmit     # 必须零错误
node node_modules/vite/bin/vite.js build          # 产物在 dist/（base=/jsc/）
tar -czf frontend_dist.tgz -C dist .
scp frontend_dist.tgz root@111.10.220.226:/tmp/
# 服务器：解到 /data/HBJSC/frontend/
```
**门禁**：`index.html` **磁盘 md5 == HTTP md5**；首页引用资源**逐个 200**；`dist/assets` 全量 200。

### P3 · nginx + ZLMediaKit（约 8 人时）
nginx：
- `sites-available/uav-sites`（`:80`）+ `conf.d/skymonitor.conf`（`:81`）
- 🔴 **`/jsc/` 的 `alias` 必须改到 `/data/HBJSC/frontend/`**（原为 `/opt/jsc/frontend/`）
- 备份文件放 `sites-backup/`，**别放 `sites-enabled/`**（`include sites-enabled/*` 会误加载 `.bak*`）
- 注意 `:81` 是 skymonitor vhost；**本机 `127.0.0.1:81/jsc/` 恒 404 是正常的**，正确入口是 `127.0.0.1:80/jsc/`

ZLM（**源码编译裸部署**，照 `outputs/ZLM非Docker部署评估.html`）：
```bash
apt-get install -y cmake build-essential libssl-dev libsdl2-dev \
  libavcodec-dev libavutil-dev libavformat-dev libswscale-dev libopus-dev
git clone --depth 1 https://github.com/ZLMediaKit/ZLMediaKit /tmp/ZLMediaKit
cd /tmp/ZLMediaKit && git submodule update --init --recursive
mkdir build && cd build && cmake -DCMAKE_BUILD_TYPE=Release .. && make -j$(nproc)
# ⚠️ 产物在 release/linux/Release/（取决于 CMAKE_BUILD_TYPE），不是 Debug/
cp -r /tmp/ZLMediaKit/release/linux/Release/* /data/HBJSC/zlm/
bash p0_06_zlm_cfg.sh     # 生成并精确修补配置（见下）
```
**ZLM 配置三条硬要求**：
1. **端口**：`[http] port=6080`、`[rtsp] port=5540`、`[rtmp] port=1936`、`[http] sslport=4443`（⚠️ SSL 是 **`[http] sslport`**，不是 `[https] port`；RTP 区间键名是 **`port_range`**）
2. **secret** 用 `data/config.json` 里那个（`035c73f7-…`）
3. 🔴 **hook 非 200 会拒绝推流/播放** ⇒ **只配确实存在的 hook**（`on_publish=http://127.0.0.1:7170/api/zlm/publish-check`），**其余一律置空**
   > 基线建议用 ZLM release 自带的官方完整默认配置再改（比让程序现生成安全 —— 不会短暂抢 80 端口）
   > ⚠️ 老备份里的 `/opt/zlm/config.ini` 可能是 **docker 时代的默认模板（80/554/1935/8080）**，不是生产配置

**门禁**：`getServerConfig?secret=…` 返回 200；`ss -lntp` 恰好监听 6080/5540/1936/4443（**且不占 443**）。

### P4 · straw-engine（方案 B 第一步，已完成）
```bash
bash p0_05_zlm.sh / #（ZLM 编译，见 P3）
# 引擎：把本机 tmp/straw_engine/{app,config} 上传到 /data/HBJSC/straw-engine/
#   app/main.py（819 行，重建版）+ app/detector.py（= tmp/detector_new.py，优化版）
#   venv: pip install numpy opencv-python-headless onnxruntime fastapi uvicorn[standard] requests
#   （先 apt install python3-venv，否则 python3 -m venv 会失败）
#   systemd: straw-engine.service → venv/bin/python -m uvicorn main:app --port 7200
bash e2e_test_engine.sh     # 端到端验收（桩模型 + 合成视频，测完自动还原并清场）
```
🔴 **必挂 ASGI lifespan**：systemd 用 `python -m uvicorn main:app` **只 import 模块**，`if __name__ == '__main__'` 块**不执行**
⇒ worker / OSD 轮询 / 流 watcher 必须挂在 `app.router.lifespan_context`。
（症状：服务 active、端口在听，但**一个 worker 都没有**。）

**门禁**：`/health`、`/metrics`、`/debug/snapshot` 全 200；端到端能出 `frame_age_s` 刷新 + `alerts` + `last_report_ok=true` + 取证图落盘 + 后端入库。

---

## 5. 一键复跑脚本（耐久位置 `deploy/HBJSC/scripts/`）

> 执行方式：`tr -d '\r' < x.sh > x_lf.sh && scp -P 22233 x_lf.sh root@111.10.220.226:/tmp/ && ssh -p 22233 root@111.10.220.226 "bash /tmp/x_lf.sh"`

| 脚本 | 作用 |
|---|---|
| `p0_01_skeleton.sh` | 建 `/data/HBJSC` + `/video` 软链 + 磁盘隔离校验 + 落 `README_LAYOUT.md` |
| `p0_02_deps.sh` | nginx/ffmpeg/pip + **Node 22 官方 tarball** + 版本门禁 |
| `p0_03_install.sh` | 解 7/9 底座 → 叠加 9 月代码 → 建 `jsc` 用户 → 装 nginx 站点 → 写 systemd |
| `p0_04_fix.sh` | 修 Node 版本 / 代码叠加 / npm 补依赖 |
| `p0_05_zlm.sh` | ZLM 源码编译 + 部署 |
| `p0_06_zlm_cfg.sh` | ZLM 配置精确修补（端口/secret/hook）+ 冲突预检 + 启动 |
| `p0_07_finalize.sh` | ZLM 端口修正 + **逐文件 md5 门禁** + 落 `INSTALL_MANIFEST` |
| `e2e_test_engine.sh` | straw-engine 全链路端到端验收（含自动清场） |
| `build_wanzhou_towns.py` | 镇街边界 geojson 生成/校验（见 §8） |
| `fix_warnings_final.sh` | `/api/warnings` 保留期放宽（含回滚脚本生成） |

`deploy/HBJSC/straw-engine/` 另存：`app/main.py`（819 行重建版）、`app/detector.py`、`config/config.json`。

---

## 6. 「从补丁脚本反推重写丢失的服务」

**本次最值钱的一招**：服务源码没进 Git、也没本地副本（看起来只能重写 750 行），
但**当时的补丁脚本逐字保留了原码的锚点与函数体**。

```bash
# 1) 补丁/迁移脚本（含"原文→替换"配对，等于原码切片）—— 最值钱
find . -iname '*patch*' -o -iname '*migrate*' | grep -v node_modules
# 2) 同族的 .bak_* 前后版本
# 3) 用"独有字符串"全盘搜，确认到底还有没有别处副本
# 4) 文档/记忆里的**接口契约**（端点、字段、阈值）—— 最好的验收标准
```
本次拿到的东西：
- `tmp/patch_main_skymask.py` → `_apply_sky_mask` **全文** + `_worker(stream_cfg, model_path, input_size, evidence_dir, format='yolo', use_gpu=True)` **完整签名** + state 键集 + `/health` 字段
- `.workbuddy/tmp/patch_engine_landing.py` → `_TAKEOFF_WINDOW` / `_osd_poller` / `_internal_secret` / `_landing_suppress_reason` **全文**
- `tmp/detector_new.py` → `app/detector.py` 1:1 还原

**重写三原则**：① 签名**逐字照抄**（便于日后与真版本对账）；② 每个"按契约猜的"地方标 **`【重建】`** 并写明依据；③ 用**可观测契约**验收（端点字段、阈值、跑真实链路）。

**没有真模型/真数据怎么验**：用**桩模型 + 合成输入**（本次做法，全程可回滚）
```bash
# 桩 ONNX：只输出 1 个固定框（YOLO 导出格式 [1,4+C,N]，值是输入画布绝对像素，分数已 sigmoid）
# 合成视频：ffmpeg -f lavfi -i testsrc=size=1280x720:rate=10 -t 40 out.mp4
# 备份真配置 → 切测试配置 → 重启 → 逐项看 → **还原真配置并重启** → **按独有标识清场**
```

---

## 7. 必踩的坑（九条，全部实测）

1. **22 端口不开是正常的** —— 这台机一直用非标端口（曾 `22333`，现 `22233`）。不要据此判"机器没了"，先去仓库找文档确认。
2. **公网 IP 上看到的是「端口映射表」不是「主机监听列表」** —— 一个公网 IP 后面是网关 + 多台内网机，某端口关闭只能推"映射被删/后端没起"。
3. **本机 `sshpass` 失效 → 用 SSH_ASKPASS**（见 §1），否则会误判密码错。
4. **CRLF 让内层 heredoc 静默失效**（见 §1），脚本一律 `tr -d '\r'` + 文件方式执行。
5. **`--strip-components=N` 只对"带目录前缀"的 tar 有效** —— 若打包是 `cd server && tar czf x.tgz *.js`（无前缀），解包时会把**文件名也剥掉**，
   **一个文件都不落地且 tar 退出码为 0**（`set -e` 拦不住）。⇒ 打包后在仓库根，且**打包后必须 `tar -tzf` 回看结构**。
6. **`cp … || true` 会吞掉关键失败** —— 本次 CMake 产物在 `Release/` 而我写了 `Debug/`，`|| true` 让脚本"成功"跑完，
   但 `ExecStart` 指向的可执行文件不存在 → systemd `status=203/EXEC`。**关键拷贝不要 `|| true`，拷完必须验存在。**
7. **`python -m uvicorn main:app` 只 import 模块** → `__main__` 块不执行，worker 必须挂 ASGI lifespan（见 §4 P4）。
8. **npm 在 pnpm 结构的 node_modules 上会崩**（`Cannot read properties of null (reading 'matches')`）
   ⇒ 补单个包用「临时目录 `npm i` 再 `cp -r`」绕开。
9. **`find` 不跟 symlink** —— `evidence` 是 `→ /data/video/evidence` 的软链，`find <软链>` 会返回 0 条（**不是没落盘**）；
   要查实体路径。同理 `du -sh` 软链显示 0 也不是故障。

---

## 8. 已知缺口与恢复指引

| 缺口 | 影响 | 怎么补 |
|---|---|---|
| **烟雾模型**（`stage9_1920`/`stage3_0909`） | 引擎空管线（照常抽帧，不出框） | 训练产出后把 onnx 放到 `/data/video/shujuji/datasets/v5_smoke_v5/{stage9_1920,stage3_0909}/weights/`（目录已建）**即自动生效，无需改配置** |
| **NVIDIA 驱动** | ~~onnxruntime 只有 CPU provider~~ | ✅ **2026-10-01 已装**：`nvidia-driver-580`（预签名模块，Secure Boot 保持开启，**免重启热切换**）。见 §14 |
| **`wanzhou_towns.geojson`** | ~~镇街反查不可用；且每次 straw 上报刷 ENOENT~~ | ✅ **2026-09-30 已解决**：用《乡镇街道分界.geojson》生成并部署（见 §13）|
| **dji-openapi / dock-guard / chengyun-mock / flight-monitor** | 未装 | dji-openapi 依赖司空2 网段 `172.28.0.0/24`（当前不通） |
| **业务数据停留在 2026-07-09** | 之后约 2.5 个月无副本 | 继续排查其它来源（同事导出 / 微信桥 VM / 邮件附件） |

---

## 9. 现状快照（2026-09-30 12:00 实测）

| 服务 | 端口 | active | enabled |
|---|---|---|---|
| `nginx` | 80 / 81 | ✅ | ✅ |
| `jsc-backend` | 7170 | ✅ | ✅ |
| `zlmediakit-jsc` | 6080 / 5540 / 1936 / 4443 | ✅ | ✅ |
| `straw-engine` | 7200 | ✅ | ✅ |

- 访问：`http://111.10.220.226:81/jsc/` → **200**；登录 `/api/auth/login`（**不是 `/api/login`**）`admin/admin123`
- 磁盘：`/` 用 17G/1004G ｜ `/data` 用 3.1G/5.0T
- Node：`/data/HBJSC/tools/node22/bin/node` → **v22.23.3**
- nginx：`alias /data/HBJSC/frontend/;`

---

## 10. 回滚与备份纪律

- **🔴 同机备份等于没备**（本次事故的核心教训：ESXi 无快照、`BackUp/` 为空、7TiB 数据盘零外部副本）
  ⇒ 重建完成后**必须**把「代码 + 配置 + 清单」打 tar **拉回本机**：`backups/HBJSC_install/`
- **🔴 "关键源码只在服务器上"是隐形单点**（straw-engine `main.py` 从未回落本机 → 要重写 750 行）
  ⇒ 今后任何在服务器上写的服务，**源码必须回落本机仓库**
- 改配置前先 `cp` 原版；每阶段结束打一个快照 tar
- 保留期/参数类改动一律**留可执行回滚脚本**（如 `/data/HBJSC/backups/rollback_algo_retention.sh`）
- 服务器侧标识性清单：`/data/HBJSC/backups/INSTALL_MANIFEST_*.md`

---

## 11. 逐条核对后的修正（2026-09-30 实测回归）

> 用户指令：**「照这份 runbook 执行一次重建、逐条核对脚本与现状是否一致」**。
> 做法：对在跑的新机做 **4 轮只读审计 + 实跑 `p0_01`**，把脚本/文档与实测现状逐条比对，偏差已就地修正（详见 `deploy/HBJSC/README.md` 的校正表）。

### 11.1 审计结论（现状全绿）
- 四服务 `nginx`/`jsc-backend`/`zlmediakit-jsc`/`straw-engine` 全 active+enabled；端口 80/81/7170/7200/6080/5540/1936/4443（**无 443**）
- **48 项门禁全部通过**（`p0_01`~`p0_07` + e2e + fix_warnings）
- `/jsc/` → 200；`index.html` 磁盘 md5 == HTTP md5；`/video → /data/video` 隔离实测落 `sdb1`
- **数据库 39 张表**（不是 22）：7/9 底座 22 表 + 9 月代码 `CREATE TABLE IF NOT EXISTS` 自动补 17 张（含 `straw_samples`/`straw_detections`/`straw_neg_reviews`/`ai_types`/`area_boundary` 等）—— 印证「9 月代码 + 7/9 库」策略正确

### 11.2 已修正的脚本/文档偏差（会误导下一次重建的）
1. **`p0_02` 装错 Node 版本**（最严重）：原装 **Node 20 → `tools/node`**，而系统要 **Node 22 → `tools/node22`**；
   `tools/node22` 实为**人工补装**（脚本从未创建）⇒ 照脚本跑会让后端 `require('node:sqlite')` 直接崩。**已改为 22 + 门禁 >=22 + 实测 `node:sqlite`**。
2. `p0_03` 的 `ExecStart` 指向 `tools/node`（v20）→ 改为 `tools/node22`；装 nginx 站点前**先备份**。
3. `p0_04` 的 `npm install` 在 **pnpm 结构**上必崩 → 改为「临时目录 `npm i` 再 `cp -r` 回填」。
4. `p0_05` 用了 **`Release/` 写成了 `Debug/`** 且 `|| true` 吞错 → 自动探测 + 拷完验存在；
   `git clone github`（实测 **000 不通**）→ 增加 **gitee 兜底**。
5. `p0_06` 写了两处**非标准键**（`[https] port` / `[rtp] rtpPortRange`，ZLM 均忽略）→ 改为 **`[http] sslport`** / **`[rtp] port_range`**。
6. `e2e` 的 `find "$R/evidence"`（软链不跟，恒 0）→ `find -L`。
7. `p0_03` 验收把 `/api/health` 期望 200（实际 **401=需鉴权属正常**）→ 改用 `/api/map-points`。

### 11.3 新增的两条铁律
- **🔴 nodemailer 时序铁律**：后端若在 `nodemailer` 就位**之前**启动，`monitor.js` 在模块加载时 `require` 失败并缓存 `null` ⇒ 进程内邮件告警**长期失效**（本次实测：后端 02:55:59 启动、nodemailer 02:57:33 才装，日志一直报「nodemailer 未安装」）。**补依赖后必须 restart 后端**（已修）。
- **🔴 复跑前置是易失的**：`p0_03`/`p0_04` 依赖 `/tmp/deploy_A/`（7 个 payload，含 39MB）——它在 **`/tmp`（易失）**，重启即失。**「分阶段可复跑」只在 `/tmp/deploy_A` 存活期内成立**；换机重跑前必须重新 stage（从 7/9 备份 + 仓库重建这 7 个文件）。

### 11.4 已知无害项
- `[websocket] port=6081` 配置了但 ZLM **未起独立监听**（本系统走 FLV/HLS，不影响）
- 配置里 `[https] port=4443` 与 `[http] sslport=4443` 并存（前者被忽略；生效的是后者）
- `straw-engine.service` 用 `User=root`（jsc-backend 用 `User=jsc`）——权限不一致，非功能性
- 邮件仍发不出 = **SMTP 授权码未配置**（环境无凭据，非缺陷）

---

## 12. 司空 2 重新部署后「快速接上」（apikey 可配置字段）

> 用户定调（2026-09-30）：**先让仓库与生产两端一致；司空重装后拿到新 apikey 要能迅速连上**。

### 12.1 已落地的机制（真凭据不进 git）
司空私有版每次重装会给**全新凭据**：OpenAPI user token（即"司空给的 apikey"）、登录用户 `tenantId/id/userType`、
webhook `appId/signatureSecret`、`encryptionSecret`、司空 ZLM `secret/tokenSecret`。
以前是手填 `infra/dji-openapi/config.json` 的 8 处 `REPLACE_WITH_*` —— 慢、易漏、且会把真凭据带进仓库。

现在改成**环境变量覆盖**：
| 文件 | 作用 |
|---|---|
| `infra/dji-openapi/config.cjs` | 加载 `config.json` 后，用 `SIKONG_*` 环境变量覆盖（**用 `.cjs`**，与 `package.json` 的 `type` 无关） |
| `infra/dji-openapi/config.json` | 模板/默认值，**永远不含真凭据** |
| `/data/HBJSC/dji-openapi/dji-openapi.env` | 真凭据（systemd EnvironmentFile，权限 600；`*.env` 已被 .gitignore） |
| `deploy/HBJSC/scripts/set-sikong-key.sh` | **一键注入**：写 env + `systemctl restart dji-openapi` |
| `deploy/HBJSC/scripts/dji-openapi.service` | systemd 单元，`EnvironmentFile=-/data/HBJSC/dji-openapi/dji-openapi.env` |

### 12.2 司空重装后怎么用（三步）
```bash
# ① 拿到司空给的新 apikey 后（脚本已放在 /data/HBJSC/scripts/）
bash /data/HBJSC/scripts/set-sikong-key.sh <新apikey> [TENANT_ID] [USER_ID] [APP_ID] [SIGNATURE_SECRET]
#    只给第一个参数也行；其余可后续补
# ② 看日志确认哪些被覆盖 / 哪些仍缺
journalctl -u dji-openapi -n 20 | grep '\[config\]'
# ③ 验链路
curl -s http://127.0.0.1:17810/health
```

### 12.3 关键环境变量
`SIKONG_API_KEY`(★apikey)｜`SIKONG_BASE_URL`｜`SIKONG_WS_URL`｜`SIKONG_LOGIN_USER_ID`｜`SIKONG_LOGIN_USER_TYPE`｜
`SIKONG_LOGIN_TENANT_ID`｜`SIKONG_APP_ID`｜`SIKONG_SIGNATURE_SECRET`｜`SIKONG_ENCRYPTION_SECRET`｜
`SIKONG_ZLM_HTTP`｜`SIKONG_ZLM_RTMP`｜`SIKONG_ZLM_SECRET`｜`SIKONG_ZLM_TOKEN_SECRET`
（兼容别名 `DJI_OPENAPI_TOKEN` → `SIKONG_API_KEY`）

### 12.4 又一条铁律（本地 vs 服务器差异的来源之一）
**仓库根 `package.json` 是 `"type": "module"`** ⇒ 本仓库里所有 `infra/**/*.js`（以及 `server/*.js`）
在本机都会被 Node 当 **ESM**，`module.exports` **不生效**（`require()` 返回 `{}`），
但**服务器上各自目录有自己的 CJS 环境**，所以线上正常。
⇒ 本地要跑 CJS 代码：**用 `.cjs` 后缀**（或在该目录放 `{"type":"commonjs"}` 的 package.json）。

---

## 13. 万州区乡镇街道边界数据（`wanzhou_towns.geojson`）—— 2026-09-30 已接入

**用途**：告警坐标 → 乡镇/街道归属（Point-in-Polygon 离线反查）→ 决定推给哪个街道办。
**放置**：`/data/HBJSC/backend/data/wanzhou_towns.geojson`（仓库副本 `data/wanzhou_towns.geojson`）。
**优先级**：`process.env.WANZHOU_TOWNS_GEOJSON` 可指向别处；否则用 `backend/data/` 下那个。
**初始化**：后端启动时若 `area_boundary` 表为空 → 从该文件 seed → 注入内存索引（支持后台热更新）。

### 13.1 数据源的特殊结构（重要，别踩）
《乡镇街道分界.geojson》（15 MB，`crs: EPSG:4490`）**不是**常规格式：
- **52 个 Point**（前 52 个 feature）= `properties.name` 是**中文乡镇街道名**
- **52 个 Polygon**（后 52 个）= `properties.name` 是**编号** `5001011210000000NN`
- 两者**无显式外键**，靠 **Point-in-Polygon 配对**（实测 52/52 完美 1:1）

> ⚠️ 直接把这个文件丢给后端**会失败**：`index.js` 的 seed 用 `coordinates[0]` 当环，Point 会让
> `ring` 变成数字 → 迭代抛错 → 整段「行政边界初始化失败」。（已加防呆：只接受 Polygon/MultiPolygon）

### 13.2 再生成（一条命令）
```bash
cd deploy/HBJSC/scripts
python3 build_wanzhou_towns.py --from-file "乡镇街道分界.geojson" \
    --names-from-points --simplify-tol 0.0001 --out wanzhou_towns.geojson
# 部署
cp wanzhou_towns.geojson /data/HBJSC/backend/data/ && systemctl restart jsc-backend
```
- `--names-from-points`：丢 Point + 用点在多边形内把中文名补到面上（面原编号挪到 `division_code` 保留来源）
- `--simplify-tol 0.0001`（≈11 m）：Douglas-Peucker 简化，**顶点 301446→26829、面积偏差 ≤0.119%、1.5 MB**
- 工具已修正 `WZ_BBOX` 东边界 `108.70→108.95`（原值过紧会把东部乡镇误判为"邻区数据"）

### 13.3 坐标系判定（结论：WGS84/CGCS2000，**不做转换**）
三方证据一致：① 文件声明 `EPSG:4490`（CGCS2000≈WGS84，差 <1 m）；② 后端要求 WGS84
（`index.js`：告警坐标即 **WGS-84（OSD GPS）**，`reverseGeocode(lon,lat)` **直接用原值**）；③ 工具默认 WGS84。
**旁证（本次实测）**：`coll_map_points`(GCJ) − `collected`(政府API) = `(+0.004359, −0.002155)`，
与标准 GCJ 偏移 `(+0.004591, −0.002265)` 吻合到 ~20 m ⇒ 政府 API 是 WGS84、手工点录是 GCJ-02；
而文件的「周家坝」标注点与政府 API 点仅差 **141 m**（若文件是 GCJ-02 应为 ~500 m）⇒ 文件是 **WGS84**。
⚠️ 残留不确定性：`准确定性判据是"点在边界内距 > 偏移量"` —— 本次测试点内距 347~994 m > 偏移 441 m，
故 4/4 在两种 CRS 下都命中。**最终以地图目视为准**（底图=天地图 WGS-84，若整体偏 ~500 m 一眼可见）。
> ✅ **2026-09-30 人工目视确认：边界与万州区实际乡镇界线完全吻合** ⇒ **CRS = WGS84/CGCS2000 定案，无需转换**。
> （至此 §13 全链路闭环：数据接入 → 反查可用 → 告警可归属街道办。）

### 13.4 验收
```bash
TOK=$(curl -s -X POST -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' \
      http://127.0.0.1:7170/api/auth/login | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
curl -s -H "Authorization: Bearer $TOK" 'http://127.0.0.1:7170/api/straw/reverse-geocode?lng=108.372259&lat=30.840445'
# → {"ok":true,"town":{"name":"周家坝街道","divisionCode":"500101121000000005"}}
```
实测：4 个已知点位 4/4 命中（周家坝/百安坝/熊家/九池），界外点（重庆解放碑）返回 `null`；
`area_boundary` 表 52 行；启动日志「已加载 52 个乡镇/街道」；**ENOENT 归零**。

### 13.5 `division_code` 说明
保留下的是**源系统的 18 位编号**（`500101121` + `0000000` + `01..52`），**不是 GB/T 2260 的 9 位区划代码**。
`area_responsibility` 以 **town 名称**为键，故不影响归属；如需真区划代码需另行补。

---

## 14. RTX 3090 驱动安装（Secure Boot 开启前提下的正解）—— 2026-10-01 完成

**背景**：服务器是 **PCI 直通的 VM**，裸 3090 可见但无驱动；**Secure Boot 已启用（UEFI）**。

### 14.1 核心认知：看「内核模块由谁提供」，不是看驱动大版本号
| 包 | 模块来源 | 签名 | Secure Boot 开启时 |
|---|---|---|---|
| `linux-modules-nvidia-<ver>-…` | Canonical **预编译并签名** | ✅ `signer: Canonical Ltd. Kernel Module Signing` | **能加载** |
| `nvidia-dkms-<ver>` | 本机**现场编译** | ❌ 无 | **加载失败** |

**一条命令判断**（`ubuntu-drivers list` 会标出来）：
```
nvidia-driver-580     (kernel modules provided by linux-modules-nvidia-580-generic)  ← ✅ 预签名
nvidia-driver-545     (kernel modules provided by nvidia-dkms-545)                  ← ❌ 只有 DKMS
```
⚠️ 别被名字骗：`linux-modules-nvidia-545-generic` 的 Candidate 是 `5.15.0-157.167`（**旧内核 157** 的包），
与当前内核 `5.15.0-194-generic` **不匹配**。**要认后缀里的内核 ABI**。

### 14.2 实际执行（**免重启、零停机**，实测）
```bash
# 前置：确认重启后能连回来（ssh enabled）+ 四大服务 enabled + 备份状态
# 安装（这一步同时把预签名模块装好；本机实测【未拉入 dkms】）
apt-get install -y linux-modules-nvidia-580-generic nvidia-driver-580
# 核验「生效模块」确实是签名的那个（关键）
modinfo -F filename nvidia      # → /lib/modules/<abi>/kernel/nvidia-580/nvidia.ko   ← 预签名位置
modinfo nvidia | grep -iE 'sig_id|signer|vermagic'
#   sig_id: PKCS#7
#   signer: Canonical Ltd. Kernel Module Signing
#   vermagic: 5.15.0-194-generic
# 免重启热切换（nouveau 引用计数=0 时可安全 rmmod）
rmmod nouveau && modprobe nvidia && nvidia-smi
```
**结果**：`Driver 580.178.04 / CUDA 13.0`，RTX 3090 24576 MiB，compute_cap **8.6**；四服务全程 active、接口全 200。

### 14.3 为什么免重启也行，以及「重启后会不会失效」
- `nouveau` 当时**引用计数 = 0** ⇒ `rmmod` 安全，`modprobe nvidia` 直接接管，无需重启
- 重启存活性已核验：黑名单在 **`/usr/lib/modprobe.d/nvidia-graphics-drivers.conf`**
  （⚠️ **Ubuntu 22.04 放 `/usr/lib/modprobe.d/`，不是 `/etc/modprobe.d/`** —— 只搜前者会误判"未黑名单"）
  内容含 `blacklist nouveau` / `alias nouveau off`；且 **initramfs 内 nouveau 条目 = 0、nvidia 条目 = 5** ⇒ 重启后 nvidia 正常加载

### 14.4 备份 / 回滚
- 备份：`/data/HBJSC/backups/nvidia_pre_20261001_001604/`（dpkg-selections / lspci / lsmod / modprobe.d / grub / systemd-units）
- 回滚：`apt purge -y 'nvidia-*' 'linux-modules-nvidia-*' 'linux-objects-nvidia-*' 'linux-signatures-nvidia-*' && rmmod nvidia_uvm nvidia_drm nvidia_modeset nvidia && update-initramfs -u`
  （回到 CPU 推理，全链路仍可跑通）

### 14.5 顺带装的 GUI 包（headless 用不上，无害）
`nvidia-settings` / `nvidia-prime` / `xserver-xorg-video-nvidia-580` / `screen-resolution-extra`
（`nvidia-driver-580` 的依赖带进来的；机器没跑 X，留着不影响）

### 14.6 引擎启用 GPU 推理（T4）—— ✅ 2026-10-01 完成
**做法**：`onnxruntime`（CPU）→ **`onnxruntime-gpu==1.23.2`** + pip 的 CUDA 运行库轮子
（`nvidia-cuda-runtime-cu12` / `cublas` / `cudnn 9.x` / `cufft` / `curand` / `cuda-nvrtc`），
**不需要装 apt 的 CUDA Toolkit**（驱动 580 向下兼容 CUDA 12 运行时）。

🔴 **关键坑：ORT 的 `libonnxruntime_providers_cuda.so` 没有 RUNPATH**，所以即使 pip 装了 `nvidia/cublas/lib/libcublasLt.so.12`，
运行时仍会报 `libcublasLt.so.12: cannot open shared object file` → **静默回退 CPU**
（症状极具迷惑性：`get_available_providers()` **会列出** `CUDAExecutionProvider`，但 `InferenceSession` 实际用的是 CPU）。

**正解：给 systemd 单元注入 `LD_LIBRARY_PATH`**（指向所有 `venv/lib/python3.X/site-packages/nvidia/*/lib`）：
```
Environment=LD_LIBRARY_PATH=<venv>/lib/python3.10/site-packages/nvidia/{cublas,cudnn,cuda_runtime,cufft,curand,cuda_nvrtc,nvjitlink}/lib
```
（另一条等效路：在代码里调 `onnxruntime.preload_dlls()`；本机选了改 unit，零代码改动）
单元已回落仓库：`deploy/HBJSC/scripts/straw-engine.service`

**验收（用引擎自己的 `Detector` 类 + 引擎进程的真实 env）**：
```
★ Detector.use_gpu   = True
★ Detector providers = ['CUDAExecutionProvider', 'CPUExecutionProvider']
★ predict 返回条数   = 1
```
四服务 active、`/jsc/`+`:7170/api/map-points`+`:7200/{health,metrics,debug/snapshot}`+ZLM 全 **200**；
`/health.resource.gpu` 由 `null` → `{mem_total_mb: 24576}`。

**真正的端到端 GPU 验证仍未做**：需真实模型 + 视频流（现在 `workers=0`，没有 session 就不会初始化 CUDA 上下文）。
可用 `deploy/HBJSC/scripts/e2e_test_engine.sh`（桩模型 + 合成视频，自还原）补做，注意按 `streamId LIKE '%_TEST%'` 清场。

---

## 15. 算法训练环境（`train-venv`）—— 2026-10-01 建好

**为什么独立**：ultralytics 会拉 `matplotlib/polars/opencv/…` 一堆依赖，混进生产推理的 `straw-engine` venv
有把引擎搞坏的风险 ⇒ 单独建 **`/data/HBJSC/train-venv`**。

**一键重建（幂等）**：`deploy/HBJSC/scripts/setup_train_env.sh`
**产出**：`/data/HBJSC/train-venv`（**5.5 GB**）＝ `torch 2.6.0+cu124` / `torchvision 0.21.0+cu124` /
`ultralytics 8.4.169` / `onnx 1.23.1` / `numpy 2.2.6` / `opencv-python 5.0.0.93`

### 🔴 唯一的坑：torch 必须走 CUDA 索引
`pip install torch` 默认给 **CPU 轮子**（装完 `torch.cuda.is_available()==False`，白跑一晚上）⇒ 必须
```
--index-url https://download.pytorch.org/whl/cu124
```
（cu124 索引里 cp310 最高 **torch 2.6.0+cu124**；驱动 580 向下兼容 CUDA 12 运行时）

### 两个配套设置
- `mkdir -p /root/.config/Ultralytics` —— 否则 ultralytics 报「config 目录不可写」退到 `/tmp`，**重启即失**
- `yolo settings runs_dir=/data/video/xunlian/runs datasets_dir=/data/video/shujuji/datasets`（**落到 /data，不占系统盘**）

### 验收实测（2026-10-01 01:35）
```
torch = 2.6.0+cu124 | cuda_build = 12.4 | cuda_available = True
device = NVIDIA GeForce RTX 3090 | cap = (8,6)
GPU matmul OK -> (2048,2048)
ultralytics 8.4.169 | YOLO import OK | onnx 1.23.1
```

### 顺带修掉的「过期路径」
`infra/vlm/train_v5_v5.sh` 原来指向 `/opt/jsc/straw-engine/venv/bin/yolo`（**旧址，已失效**）
⇒ 改为 `TRAIN_VENV=/data/HBJSC/train-venv`，并加「venv 不存在则提示先跑 setup_train_env.sh」的前置检查；
`gen_v5_train_v5.py` / `gen_v5_stage_splits.py` 的用法注释同步更新。

---

## 16. 抽帧链路重建（替代已失效的 MinIO 路径）—— 2026-10-01 完成

**问题**：原抽帧脚本 `infra/vlm/pull_frames_v5.py` 依赖 **MinIO 上的直播段**（`s3_get` → ffmpeg 抽帧 → 删 mp4）。
2026-09-30 生产机重建后 **MinIO 不复存在**（本地 `:9000` 与司空侧 `172.28.0.90:9000` 均不可达）⇒ **该路径跑不通**。

**新工具**：`infra/vlm/record_frames.py`（服务器上副本 `/data/HBJSC/scripts/record_frames.py`）

### 两种模式
| 模式 | 做法 | 适用 |
|---|---|---|
| **`direct`（默认，推荐）** | `ffmpeg -i <流> -t N -vf fps=1/interval out_%05d.jpg` —— **完全不落视频** | 只要帧；绕开 `-c copy` 到 TS 的 pts/dts 问题 |
| `segment` | `-c copy -f segment` 切段 → 每段一落盘就抽帧、**抽完立刻删段** | 想先录下来、稍后用不同 interval 反复抽 |

### 用法
```bash
V=/data/HBJSC/train-venv/bin/python          # 需要 opencv/PIL（去重与体检）
# 按后端 streamId 取地址（免手抄含密码的 URL）
$V /data/HBJSC/scripts/record_frames.py --id <streamId> --api http://127.0.0.1:7170 \
   --seconds 600 --interval 2 --out /data/video/shujuji/datasets/v5_live_frames --tag <名字> --dedupe --audit
# 或直接给地址 / 批量（每行 `url[,tag]`，支持 # 注释）/ 只抽已有视频（--local-video）
```

### 实测验收（2026-10-01 02:28，九龙沙场 RTSP）
```
录 30s / interval 3 → 抽到 10 帧（正好 30/3）→ 去重后留 10 → 用时 35s
[audit] 分辨率分布: {'704x576': 10}   可疑帧: 0
临时目录 /data/video/rec_tmp 体积 4.0K（空）⇒ 不囤视频 ✅
单帧 72K；输出 _selftest_000001.jpg … _000010.jpg + meta.json
```

### 🔴 两个踩过的坑（已修）
1. **`-c copy` 到 MPEG-TS 报 `first pts and dts value must be set`**（RTSP 源常见）⇒
   首选 `direct` 模式（解码抽帧，不经 copy）；segment 模式已加 `-fflags +genpts -avoid_negative_ts make_zero` 缓解。
2. **不要给 ffmpeg 传 `-rw_timeout` / `-stimeout`** —— 各版本命名不一致，**ffmpeg 4.4 直接报 `Option rw_timeout not found`** ⇒
   超时统一交给 **Python 层 `subprocess(timeout=…)`**，与 ffmpeg 版本无关。
3. **体检判据别写太严**：曾用「必须等于 4:3 或 16:9」⇒ 把 **704×576 (D1)** 这种合法摄像头尺寸误杀。
   现判据 = `宽度≥2000`（桌面截图特征，已知三个污染尺寸都命中）或 `宽高比>2.1 / <0.8`。

### 备注
- 该流是**码头摄像头**（704×576 子码流），产出属「难负/背景」样本，**不是**无人机秸秆样本；
  无人机样本仍需等司空网段恢复后的机场/无人机 RTSP/RTMP 源（同一工具直接可用）。
- `pull_frames_v5.py` 已加顶部警告，指向本工具（保留作历史参考）。

---

## 17. VLM 预筛（ollama + Qwen2.5-VL 7B）—— 2026-10-01 部署完成

**用途定位（别用错）**
- ❌ **不做**：VLM 直接出框 / 用文字提示驱动 YOLO（已论证：模型本质错位、小目标定位精度不足）
- ✅ **只做**：**离线预筛**（挑"可能有烟"的候选帧交人工整框）+ **难负挖掘**（模型报了但 VLM 判无烟 → hard negative）

**一键部署（幂等）**：`deploy/HBJSC/scripts/setup_ollama.sh`
**落位**：`/data/HBJSC/ollama`（二进制，自带 `lib/ollama/cuda_v12` + `cuda_v13`）
＋ `/data/video/ollama/models`（模型 5.6 G）；单元 `deploy/HBJSC/scripts/ollama.service`（**只监听 127.0.0.1:11434**）

### 🔴 两个坑（务必保留原文）
1. **下载地址/资产名已变**：资产从 `ollama-linux-amd64.tgz` 改为 **`.tar.zst`**，且
   **URL 必须带 `?version=`**（不带直接 404，`ollama.com/install.sh` 那套老指引已失效）；解压需 **zstd**。
   ```
   https://ollama.com/download/ollama-linux-amd64.tar.zst?version=0.35.0     # 官方镜像
   https://github.com/ollama/ollama/releases/download/v0.35.0/ollama-linux-amd64.tar.zst  # 备选
   ```
2. **systemd 默认不设 `$HOME`** ⇒ ollama 报 `Error: $HOME is not defined`，
   表现为 `activating (auto-restart)` + **重启计数飙到几十**（极易误判成"服务起不来但没日志"）
   ⇒ 单元里必须 `Environment=HOME=/root`。**这不是 ollama 的问题，是所有依赖 HOME 的服务在 systemd 下的通病。**

### 验收实测（2026-10-01 12:23）
```
ollama ps   → qwen2.5vl:7b   7.3 GB   PROCESSOR = 100% GPU
nvidia-smi  → llama-server 占 8602 MiB / 24576 MiB
首帧 82.8s（含首次加载 33.7s）｜热态 3 张: 0.12 / 0.66 / 0.64 s  ⇒ **~0.65 s/帧**
⇒ 预筛 1000 帧 ≈ 11 分钟（完全可用）
```
`OLLAMA_KEEP_ALIVE=5m`：**空闲 5 分钟卸载模型**，把 ~8.6 GB 显存让回 straw-engine（检测优先）。
五服务（nginx / jsc-backend / zlmediakit-jsc / straw-engine / ollama）全 active，`/jsc/` 与引擎 `/health` 均 200。

---

## 18. VLM 预筛脚本 + 复核台（T6）—— 2026-10-01 完成

**在流水线里的位置**
```
录制/抽帧 → 【预筛·本步】 → 人工复核准入 → 协议 v1.2 五档整框标注 → 入训练集
                ├─ VLM 判「有」     → 候选正样本（人工只需在"可能有烟"的图上整框）
                └─ VLM 判「无」     → 候选难负池（尤其"模型报了但 VLM 判无烟" = hard negative）
```

**工具**：`infra/vlm/prescreen.py`（服务器副本 `/data/HBJSC/scripts/prescreen.py`）
```bash
V=/data/HBJSC/train-venv/bin/python
$V prescreen.py run    --dir <帧目录> [--limit N] [--no-reason]   # 批量预筛；可中断，续跑自动跳过已完成
$V prescreen.py review --dir <帧目录> [--max-embed 600]            # 生成单文件复核台 HTML
$V prescreen.py summary --dir <帧目录>
$V prescreen.py one    --image x.jpg                                # 单图调试
```

**产物**（都在 `<帧目录>/_prescreen/`）
| 文件 | 内容 |
|---|---|
| `results.jsonl` | 逐帧明细（file/verdict/reason/elapsed/at）——**续跑靠它跳过已完成** |
| `pos.txt` / `neg.txt` / `uncertain.txt` | 三份清单 |
| `summary.json` | 统计（total/pos/neg/uncertain/error） |
| `review.html` | **单文件复核台**：缩略图 base64 内嵌、三态确认、localStorage 记进度、一键导出 JSON |

**复核台的定位**：只做**三态确认**（真有烟 / 没烟 / 不确定），**不画框**。
「真有烟」→ 走协议 v1.2 五档整框标注；「没烟」且模型曾报过 → 进难负池。

### 性能（实测，热态）
| 输出方式 | 耗时 |
|---|---|
| 裸回答（只答 有/无） | 0.10 s/帧 |
| schema 仅 `has_smoke` | 0.26 s/帧 |
| **schema + reason（默认）** | **0.37 s/帧** ⇒ 1000 帧 ≈ 6 分钟 |

⚠️ **冷启动另计 ~30 s**（模型被 KEEP_ALIVE 卸载后的首次调用）⇒ 请求里带 `keep_alive=30m` 让批跑期间常驻。
> 🔴 **教训**：首次实测看到 5.88 s/帧，一度以为慢 9 倍 —— 其实是**模型刚被卸载**的冷启动。
> **测吞吐必须先预热**，否则会做出错误的性能判断。

### 🔴 两个坑
1. **提示词"只输出 JSON" + 不给 schema ⇒ 模型会包 ` ```json ` 围栏**，得多一层清洗。
   ⇒ 代码里 `PROMPT_JSON`（配 schema 用）/ `PROMPT_BARE`（不配 schema 用）**必须分开写**。
2. **别按 `_` 前缀过滤帧文件** —— 抽帧产物常以 `_<tag>_` 开头（如 `_selftest_000001.jpg`），会被整批误杀。

### 实测（10 帧，码头摄像头）
`0.89 s/帧`（含首次加载）→ 全部判「无」→ 10 条难负候选；复核台 179 KB / 10 条。
（该场景本就无烟，属**难负/背景**样本；无人机正样本待司空网段恢复。）

