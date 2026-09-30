#!/bin/bash
# p0_01_skeleton.sh —— 在空间最充裕的盘上建 /data/HBJSC 安装根 + /video 软链
# 目的：① 驾驶舱安装在 HBJSC 下；② 大数据走 /data（5T），绝不落 1T 系统盘
set -e

ROOT=/data/HBJSC
VID=/data/video

echo "########## 0. 前置校验：确认目标盘是空间最充裕的 ##########"
echo "--- 当前磁盘 ---"
df -hT | grep -vE 'tmpfs|udev|overlay' | sed 's/^/  /'
echo "--- sdb1 挂载点 ---"
findmnt -no SOURCE,TARGET,SIZE,AVAIL /data 2>/dev/null | sed 's/^/  /' || echo "  ⚠️ /data 未挂载！"

# 安全闸：必须确认 /data 是独立大盘，且可用空间 > 1T
AVAIL=$(df -B1 --output=avail /data 2>/dev/null | tail -1 | tr -d ' ')
if [ -z "$AVAIL" ] || [ "$AVAIL" -lt 1000000000000 ]; then
  echo "  ❌ /data 可用空间不足 1T（实测 ${AVAIL:-?} 字节）→ 中止，请人工确认挂载"
  exit 1
fi
echo "  ✅ /data 可用 $(awk -v a=$AVAIL 'BEGIN{printf "%.2f TB", a/1024/1024/1024/1024}') ，满足要求"

# 安全闸：HBJSC 若已存在且非空，不覆盖
if [ -d "$ROOT" ] && [ -n "$(ls -A "$ROOT" 2>/dev/null)" ]; then
  echo "  ⚠️ $ROOT 已存在且非空，本次只补建缺失子目录，不动已有内容"
fi

echo
echo "########## 1. 建安装根目录 ##########"
mkdir -p "$ROOT"/{frontend,backend/data,backend/logs,zlm,scripts,backups,logs}
mkdir -p "$ROOT"/{straw-engine,dji-openapi,dock-guard}      # B 阶段预留
echo "  ✅ $ROOT 结构："
find "$ROOT" -maxdepth 2 -type d | sort | sed 's|^|    |'

echo
echo "########## 2. 建大容量数据区 /data/video 并做 /video 软链 ##########"
mkdir -p "$VID"/{xunlian,shujuji,evidence,minio}
if [ -e /video ] && [ ! -L /video ]; then
  echo "  ⚠️ /video 已存在且不是软链，先备份改名"
  mv /video /video.bak.$(date +%Y%m%d_%H%M%S)
fi
ln -sfn "$VID" /video
echo "  ✅ /video -> $(readlink -f /video)"
ls -ld /video | sed 's/^/    /'

echo
echo "########## 3. 权限（nginx 需要读 frontend）##########"
chmod 755 "$ROOT" "$VID"
chmod -R 755 "$ROOT"/frontend "$VID" 2>/dev/null || true
# 若已装 nginx，让 www-data 能读
if id www-data >/dev/null 2>&1; then
  chmod 755 "$ROOT" "$ROOT"/frontend
  echo "  ✅ 已放开 www-data 读取路径权限（755）"
fi

echo
echo "########## 4. 关键校验：写大数据会落到 /data 而不是系统盘 ##########"
echo "  写入测试文件到 /video/ 并看落在哪个盘："
dd if=/dev/zero of=/video/_diskcheck.bin bs=1M count=64 status=none
echo -n "    /video 实际设备: "; df --output=source /video/_diskcheck.bin | tail -1
echo -n "    /      设备: "; df --output=source / | tail -1
rm -f /video/_diskcheck.bin
echo "  ✅ 若两者不同 = 隔离成功"

echo
echo "########## 5. 落一份布局说明（给下一位接手的人）##########"
cat > "$ROOT/README_LAYOUT.md" <<'EOF'
# HBJSC 安装根 · 目录布局

> 本目录是「万州秸秆焚烧监控 jsc 驾驶舱」的**安装根**。
> 之所以不放在 `/opt/jsc`，是因为本机系统盘 `/` 只有 1T，而 `sdb1`（挂载在 `/data`）有 **5T**。

## 目录职责

| 路径 | 用途 | 备注 |
|---|---|---|
| `frontend/` | 驾驶舱前端**构建产物**（nginx 站点根） | nginx `alias /data/HBJSC/frontend/` |
| `backend/` | jsc-backend（Node 服务，:7170） | 入口 `backend/index.js` |
| `backend/data/` | **jsc.db**（SQLite 业务库） | 关键数据，务必定期外备 |
| `zlm/` | ZLMediaKit 二进制 + `config.ini` | 裸部署（非 Docker） |
| `straw-engine/` | 秸秆 AI 引擎（Python FastAPI，:7200） | **B 阶段**使用，当前为空 |
| `dji-openapi/` | 司空2 OpenAPI 桥（:17810） | **B 阶段**，依赖 172.28 网段可达 |
| `dock-guard/` | 机场守护（:7210） | **B 阶段** |
| `scripts/` | 运维脚本 | |
| `backups/` | 配置与代码备份 | |
| `logs/` | 统一日志出口 | |

## 大容量数据区

| 路径 | 用途 |
|---|---|
| `/data/video/` | 大容量数据总区（**软链自 `/video`**） |
| `/data/video/xunlian/` | 训练资产（数据集标签、evidence 等） |
| `/data/video/shujuji/` | 数据集 |
| `/data/video/evidence/` | 检测取证帧 |
| `/data/video/minio/` | 对象存储数据（如需） |

⚠️ **任何超过 1GB 的数据只准写 `/data`（含 `/video`），严禁写系统盘 `/`。**

## 服务清单（目标态）

| 服务 | 端口 | systemd 单元 |
|---|---|---|
| nginx | 80 / 81 | `nginx` |
| jsc-backend | 7170 | `jsc-backend` |
| ZLMediaKit | 6080 / 5540 / 1936 | `zlmediakit-jsc` |
| （B 阶段）straw-engine | 7200 | `straw-engine` |
| （B 阶段）dji-openapi | 17810 | `dji-openapi` |
EOF
echo "  ✅ 已写 $ROOT/README_LAYOUT.md"

echo
echo "########## 6. 汇总 ##########"
df -hT /data / | sed 's/^/  /'
echo
echo "P0_01_SKELETON_DONE"
