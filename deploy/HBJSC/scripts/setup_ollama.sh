#!/bin/bash
# setup_ollama.sh —— 部署 ollama + Qwen2.5-VL 7B（用于自动标注「离线预筛 + 难负挖掘」）
#
# 用途定位（重要，别用错）
#   ❌ 不做：VLM 直接出框、用文字提示驱动 YOLO —— 已论证技术错位/精度不足
#   ✅ 只做：离线预筛（挑"可能有烟"的候选帧交给人工框）+ 难负挖掘（模型报了但 VLM 判无烟 → hard negative）
#
# 装到数据盘（/data），模型也放 /data/video/ollama/models；只监听 127.0.0.1，不对外暴露。
#
# 🔴 踩过的坑（务必保留这些措施）
#   1. 二进制资产名已从 `ollama-linux-amd64.tgz` 改为 **`.tar.zst`**，且下载 URL **必须带 `?version=`**
#      （不带直接 404）；解压需要 **zstd**（Ubuntu 自带 /usr/bin/zstd）。
#   2. systemd 默认**不设 `$HOME`**，ollama 会报 `Error: $HOME is not defined` 并以
#      `activating (auto-restart)` 疯狂重启（restart 计数能到几十）⇒ 单元里必须 `Environment=HOME=/root`。
#
# 用法：setsid nohup bash setup_ollama.sh < /dev/null > /tmp/setup_ollama.log 2>&1 &
set -e
BASE=/data/HBJSC/ollama
MODELS=/data/video/ollama/models
VER="${OLLAMA_VER:-0.35.0}"

echo "########## 1. 依赖 ##########"
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq zstd curl
which zstd

echo
echo "########## 2. 下载 release（约 1.43 GB）##########"
mkdir -p "$BASE" "$MODELS"
# 官方镜像（带 ?version= 才不是 404）；GitHub 直链作备选
URL1="https://ollama.com/download/ollama-linux-amd64.tar.zst?version=${VER}"
URL2="https://github.com/ollama/ollama/releases/download/v${VER}/ollama-linux-amd64.tar.zst"
curl -fL --retry 3 --retry-delay 5 -o /tmp/ollama.tar.zst "$URL1" \
  || curl -fL --retry 3 --retry-delay 5 -o /tmp/ollama.tar.zst "$URL2"
ls -la /tmp/ollama.tar.zst

echo
echo "########## 3. 解压到 $BASE ##########"
rm -rf "$BASE"/* 2>/dev/null || true
tar --zstd -xf /tmp/ollama.tar.zst -C "$BASE" 2>/dev/null || zstd -dc /tmp/ollama.tar.zst | tar -x -C "$BASE"
rm -f /tmp/ollama.tar.zst
[ -x "$BASE/bin/ollama" ] || { echo "❌ 未找到 $BASE/bin/ollama"; exit 1; }
"$BASE/bin/ollama" --version
echo "  CUDA 库: $(ls "$BASE/lib/ollama/" 2>/dev/null | grep -E 'cuda' | tr '\n' ' ')"

echo
echo "########## 4. systemd（🔴 必须设 HOME）##########"
cat > /etc/systemd/system/ollama.service <<'EOF'
[Unit]
Description=Ollama (JSC VLM 预筛用 · 装于 /data/HBJSC/ollama)
After=network.target

[Service]
# 🔴 systemd 不设 HOME，ollama 会报 "Error: $HOME is not defined" 并无限重启
Environment=HOME=/root
Environment=OLLAMA_MODELS=/data/video/ollama/models
Environment=OLLAMA_HOST=127.0.0.1:11434
# 空闲 5 分钟卸载模型，把 ~8.6 GB 显存让回给 straw-engine
Environment=OLLAMA_KEEP_ALIVE=5m
Environment=OLLAMA_NUM_PARALLEL=1
ExecStart=/data/HBJSC/ollama/bin/ollama serve
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now ollama
sleep 8
echo "  状态: $(systemctl is-active ollama)"
curl -s --max-time 8 http://127.0.0.1:11434/api/version

echo
echo "########## 5. 拉取 Qwen2.5-VL 7B（约 6 GB）##########"
"$BASE/bin/ollama" pull qwen2.5vl:7b
"$BASE/bin/ollama" list

echo
echo "########## 6. 验收：必须看到 100% GPU ##########"
"$BASE/bin/ollama" ps
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv
echo "  模型目录: $(du -sh $MODELS 2>/dev/null | cut -f1)"
echo "SETUP_OLLAMA_DONE"
