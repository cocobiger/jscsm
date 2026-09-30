#!/bin/bash
# p0_05_zlm.sh —— 源码编译裸部署 ZLMediaKit 到 /data/HBJSC/zlm（照原方案，非 Docker）
set -e
R=/data/HBJSC/zlm
echo "########## 1. 编译依赖 ##########"
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq cmake build-essential libssl-dev libsdl2-dev \
  libavcodec-dev libavutil-dev libavformat-dev libswscale-dev libopus-dev 2>&1 | tail -3
echo "  cmake: $(cmake --version | head -1)"

echo
echo "########## 2. 拉源码（含子模块）##########"
# 🔴 实测：本机 github.com:443 时通时不通（2026-09-30 实测 curl 返回 000）
#    若拉不动，改用：① gitee 镜像 https://gitee.com/xia-chu/ZLMediaKit  ② 离线 tar 预置到 /tmp/ZLMediaKit
rm -rf /tmp/ZLMediaKit
git clone --depth 1 https://github.com/ZLMediaKit/ZLMediaKit /tmp/ZLMediaKit 2>&1 | tail -3 \
  || git clone --depth 1 https://gitee.com/xia-chu/ZLMediaKit /tmp/ZLMediaKit 2>&1 | tail -3
[ -d /tmp/ZLMediaKit/.git ] || { echo "  ❌ 源码拉取失败（github/gitee 均不可达），请离线预置到 /tmp/ZLMediaKit"; exit 1; }
cd /tmp/ZLMediaKit
git submodule update --init --recursive 2>&1 | tail -5
echo "  ✅ 源码就绪 $(du -sh /tmp/ZLMediaKit | cut -f1)"

echo
echo "########## 3. 编译（-j96，预计 5~10 分钟）##########"
mkdir -p build && cd build
cmake -DCMAKE_BUILD_TYPE=Release .. > /tmp/zlm_cmake.log 2>&1 || { echo "❌ cmake 失败"; tail -25 /tmp/zlm_cmake.log; exit 1; }
echo "  cmake 完成，开始 make..."
make -j$(nproc) > /tmp/zlm_make.log 2>&1 || { echo "❌ make 失败"; tail -40 /tmp/zlm_make.log; exit 1; }
echo "  ✅ 编译完成"

echo
echo "########## 4. 部署到 $R ##########"
mkdir -p "$R/config"
# 🔴 实测纠正：cmake -DCMAKE_BUILD_TYPE=Release ⇒ 产物在 release/linux/Release/（不是 Debug/）
#    踩过：写了 Debug/ 又用 `|| true` 吞错 ⇒ 一个文件都没拷、tar/脚本退出码仍为 0、
#    ExecStart 指向不存在的可执行 ⇒ systemd 203/EXEC。这里自动探测 + 拷完验存在（不用 || true）。
ZLM_BIN=""
for d in /tmp/ZLMediaKit/release/linux/Release /tmp/ZLMediaKit/release/linux/Debug; do
  [ -d "$d" ] && ZLM_BIN="$d" && break
done
[ -n "$ZLM_BIN" ] || { echo "  ❌ 未找到 ZLM 产物目录（release/linux/{Release,Debug}）"; exit 1; }
cp -r "$ZLM_BIN"/* "$R/"
ls -la "$R" | head -12
[ -x "$R/MediaServer" ] || { echo "  ❌ MediaServer 未拷到，中止"; exit 1; }
echo "  ✅ MediaServer 可执行: $(stat -c%s "$R/MediaServer") 字节（来源 $ZLM_BIN）"

echo
echo "########## 5. 落地配置（占位；真正生效的是 p0_06 用 release 官方默认重写后的）##########"
# ⚠️ 注意：/tmp/deploy_A/config.ini 是 docker 时代的默认模板（80/554/1935/8080，仅 654B），不是生产配置。
#    这里只先落个占位；紧接着 p0_06 会用 release 自带的官方完整默认重写并精确打补丁（6080/5540/1936/4443）。
if [ -f /tmp/deploy_A/config.ini ]; then
  cp /tmp/deploy_A/config.ini "$R/config/config.ini"
  sed -i 's#http://172\.17\.0\.1:7170#http://127.0.0.1:7170#g' "$R/config/config.ini"
  echo "  ✅ 已落占位配置（将以 p0_06 为准）"
else
  echo "  ⚠️ 未收到 config.ini，用模板"
  cp "$R/config/config.ini" "$R/config/config.ini.bak" 2>/dev/null || true
fi
echo "  --- 关键项 ---"
grep -nE "^(http|rtsp|rtmp|https|rtp)\.port|^\[hook\]|on_publish|on_play|secret" "$R/config/config.ini" 2>/dev/null | head -20

echo
echo "########## 6. systemd 单元 ##########"
cat > /etc/systemd/system/zlmediakit-jsc.service <<EOF
[Unit]
Description=JSC ZLMediaKit (native, no-docker) · 安装于 $R
After=network.target

[Service]
WorkingDirectory=$R
ExecStart=$R/MediaServer -c $R/config/config.ini -l 1
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now zlmediakit-jsc 2>&1 | tail -2
sleep 6

echo
echo "########## 7. 验收 ##########"
echo "  服务: $(systemctl is-active zlmediakit-jsc)"
echo "  --- 监听端口 ---"
ss -lntp 2>/dev/null | grep -E ':(6080|5540|1936|4443)\b' | awk '{print "    "$4}' | sort -u
echo "  --- ZLM API（本机带 secret）---"
SEC=$(grep -oP '(?<=^secret=).*' "$R/config/config.ini" 2>/dev/null | head -1)
printf '    getServerConfig → HTTP %s\n' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:6080/index/api/getServerConfig?secret=$SEC")"
echo "  --- 最近日志 ---"
journalctl -u zlmediakit-jsc -n 12 --no-pager | sed 's/^/    /'
echo
echo "P0_05_ZLM_DONE"
