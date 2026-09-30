#!/bin/bash
# p0_02_deps.sh —— 安装系统依赖：nginx / ffmpeg / ffprobe / python3-pip + Node 22（装到 /data/HBJSC/tools/node22）
# 为什么 Node 不走 apt：Ubuntu 22.04 只提供 nodejs 12.22.9，太老
# 为什么必须 22+：后端 store-db.js 用 require('node:sqlite')（Node 22.5+ 内置）
# ⚠️ 2026-09-30 实测校正：原版误装 Node 20 到 tools/node，导致后端 require('node:sqlite') 直接崩；
#    且 tools/node22 是人工补装的（脚本从未创建）。现已改为 22 → tools/node22，与 p0_03/p0_04/README 对齐。
export DEBIAN_FRONTEND=noninteractive
set -e

echo "########## 1. apt 更新与安装 ##########"
apt-get update -qq 2>&1 | tail -3
apt-get install -y -qq nginx ffmpeg python3-pip curl xz-utils unzip jq 2>&1 | tail -8
echo "  ✅ apt 装完"

echo
echo "########## 2. Node 22 官方 tarball（装到 /data/HBJSC/tools/node22）##########"
mkdir -p /data/HBJSC/tools/node22
cd /tmp
VER=$(curl -s --max-time 30 https://nodejs.org/dist/index.json \
      | python3 -c "import sys,json;d=json.load(sys.stdin);print(next(x['version'] for x in d if x['version'].startswith('v22.')))")
echo "  选用版本: $VER"
curl -sL --max-time 300 -o node.tar.xz "https://nodejs.org/dist/$VER/node-$VER-linux-x64.tar.xz"
ls -la node.tar.xz | sed 's/^/    /'
tar -xJf node.tar.xz -C /data/HBJSC/tools/node22 --strip-components=1
rm -f node.tar.xz
# 只把可执行文件的软链放到系统 PATH（软链本身极小，不占系统盘）
for b in node npm npx corepack; do
  [ -e "/data/HBJSC/tools/node22/bin/$b" ] && ln -sfn "/data/HBJSC/tools/node22/bin/$b" "/usr/local/bin/$b"
done
echo "  ✅ Node 已装：$(readlink -f /usr/local/bin/node)"

echo
echo "########## 3. 版本门禁 ##########"
printf '  node      : '; node -v
printf '  npm       : '; npm -v 2>/dev/null || echo "?"
printf '  nginx     : '; nginx -v 2>&1
printf '  ffmpeg    : '; ffmpeg -version 2>/dev/null | head -1
printf '  ffprobe   : '; ffprobe -version 2>/dev/null | head -1
printf '  pip3      : '; pip3 --version 2>/dev/null | head -1

echo
echo "########## 4. nginx 语法自检（此时还没改配置）##########"
nginx -t 2>&1 | sed 's/^/  /'

echo
echo "########## 5. Node 版本门禁（必须 >= 22，否则后端起不来：store-db.js 用 node:sqlite）##########"
MAJ=$(node -v | sed 's/^v//;s/\..*//')
if [ "$MAJ" -ge 22 ]; then echo "  ✅ Node $MAJ 满足要求"; else echo "  ❌ Node $MAJ 过老（后端需要 >= 22，因为 node:sqlite 22.5+ 才内置）"; exit 1; fi
# 实测门禁：node:sqlite 能 require 才算数（v20 会抛 ERR_UNKNOWN_BUILTIN_MODULE）
if node -e "require('node:sqlite')" 2>/dev/null; then echo "  ✅ node:sqlite 可用"; else echo "  ❌ node:sqlite 不可用（Node < 22.5）"; exit 1; fi

echo
echo "########## 6. 磁盘复核（依赖装在哪、占多少）##########"
du -sh /data/HBJSC/tools 2>/dev/null | sed 's/^/  /'
df -hT / /data | sed 's/^/  /'
echo
echo "P0_02_DEPS_DONE"
