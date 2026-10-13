# REF · 驾驶舱 KPI 口径 / 前端环境 / 类型门禁

> 从 MEMORY.md 下沉（2026-10-03 整理）。**改 KPI、改前端契约、改地图/主题之前必读。**

## ✅ 已解决：生产前端真源已入库（2026-10-13）
**用户提供了真源压缩包** `E://AI xm\CC jsc\1shu\jsc-frontend-prod-src_20261013.tar.gz`
（来源机器 `F://AI CODE\CC jsc\CC jsc` 的**工作树**，非 GitHub 仓库）。
**已合并进本仓库 `src/` 并正式上线**（commit `440730e`）。⇒ 本仓 `src/` **现在就是生产前端真源**。

**独立复核方式（别只信来源方的话）**：把真源原样构建，与线上逐项比对 ——
主包字节数相同（3,153,094）、CSS sha256 逐字节相同、`index.html`/`vite.config.ts`/`tsconfig.json`/
`postcss.config.mjs`/`package.json` 与本仓完全一致（依赖 diff 为空）⇒ 真源成立。
**CSS/vendor 哈希为什么能对得上**：配置文件一致 ⇒ 构建输入一致。

**合并时踩到并记住的点**：
- 真源的 `StrawMonitorPage.tsx` 与本仓 P3 前版本**逐字节相同** ⇒ 补丁可直接 `patch` 应用；
- 真源的 `api-types.ts` 更新（多 607 行），我方新增章节是**纯追加** ⇒ 附到尾部即可；
- `AlertFilterPage.tsx` 在真源里已"退休"为 `AlertFilterPage.tsx.retired_20261012`
  ⇒ 本仓原文件被删除（这是对的，不是误删）；
- 真源自带的 `*.bak_*` / `*.retired_*` 也一并入库了（它们是**唯一副本**，宁可留噪声也别丢文件）。

### ⚠️ 仍然保留的门禁（每次前端发布前照做）
1. 用 `grep -ao '.\{70\}<关键词>.\{70\}'` 对**线上 bundle** 与本机构建做特征对照；
2. 差集里若出现"线上有、本机没有"的**页面级文案** ⇒ **停手**，先确认基线是否落后（2026-10-13 靠这道门禁拦下了一次大范围回退）。

### 🔍 追查「生产前端源码到底在哪」的记录（2026-10-13，未果，留给下次）
**服务器侧已排除**：全盘（`/data` `/opt` `/root` `/srv` `/home`）搜
`vite.config.*` / 含 `precap-config` 的 `.tsx` / `StrawMonitorPage.tsx` / 含 `城运码值` 的 `.tsx`
⇒ **0 命中**。`/data/QITIJSC/frontend` 也是构建产物不是源码。⇒ **前端不在服务器上构建**。

**已收集的旁证（下次接着查用）**：
- 线上 `index.html` 引用的 vendor 包是 `vendor-charts-CuEu9485.js` / `vendor-map-D9u4wHj1.js`，
  **与本仓库构建出的 `-DEfPxlrS` / `-DCIffZry` 不同** ⇒ 依赖版本那套不一样；
  但 **CSS 哈希 `index-CkFkXljX.css` 与本仓库构建完全一致** ⇒ 样式层同源。
- `/data/HBJSC/frontend/index.html` 属主是 **`197108:197121` = MSYS/Git-Bash 的 Windows 用户映射**，
  而本仓库/serv 端产物多为 `root:root` ⇒ **最后一次前端部署是从某台 Windows 机器经 SMB/SCP 推的**。
- 无 `.map`（sourcemap 被关掉了 ⇒ 拿不到原始文件路径）。
- `/root/_fe_rollback_20261004_235315.sh`、`_fe_rollback_final_20261005_001454.sh`
  —— **有人（10/4–10/5）在服务器上手写前端回滚脚本**，脚本里手动 `cp index.html + assets/*.js`
  并比对 sha256 ⇒ 说明部署流程是「Windows 上构建 → 传产物 → 服务器上 cp」，
  **那个写脚本的人手上就有源码树**。
- `/data/HBJSC/frontend_bak_2026101{0,1}_*` 备份目录名 = `precap` / `stacktweak` / `aligfix` / `platedim`
  ⇒ 与线上多出来的功能一一对应，可用来定位是哪些次部署带进来的。
- `/root/.bash_history` 只有别的项目痕迹（`ka-stream-server.jar`、`Dist/Configs/`），无 JSC 前端构建命令。
