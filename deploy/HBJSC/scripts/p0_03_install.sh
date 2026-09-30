#!/bin/bash
# p0_03_install.sh —— 把驾驶舱装到 /data/HBJSC（方案 A）
#   backend = 7/9 底座(node_modules + data/jsc.db + config.json) + 9月代码叠加 + 补依赖
#   frontend = 本机用 git 源码构建的 dist
#   nginx    = 7/9 站点配置，路径改到 /data/HBJSC
set -e
R=/data/HBJSC
D=/tmp/deploy_A

echo "########## 0. 安全闸 ##########"
if [ -e "$R/backend/index.js" ] || [ -n "$(ls -A "$R/backend" 2>/dev/null)" ]; then
  B="$R/backend.bak.$(date +%Y%m%d_%H%M%S)"
  echo "  ⚠️ backend 已有内容 → 备份到 $B"
  mv "$R/backend" "$B"
  mkdir -p "$R/backend"
fi
echo "  ✅ 目标目录就绪"

echo
echo "########## 1. 建服务运行账号 jsc（沿用原机设计，不用 root 跑业务）##########"
if ! id jsc >/dev/null 2>&1; then
  useradd -r -m -d /data/HBJSC -s /usr/sbin/nologin jsc
  echo "  ✅ 已建用户 jsc"
else
  echo "  ℹ️ 用户 jsc 已存在"
fi

echo
echo "########## 2. 解 7/9 底座（node_modules + data/jsc.db + config.json）##########"
tar -xzf "$D/backend_base.tgz" -C "$R"
echo "  文件数: $(find "$R/backend" -type f | wc -l) ｜ 体积: $(du -sh "$R/backend" | cut -f1)"
echo "  jsc.db: $(ls -la "$R/backend/data/jsc.db" | awk '{printf "%.1f MB", $5/1024/1024}')"
echo "  config.json zlmHost: $(python3 -c "import json;print(json.load(open('$R/backend/data/config.json'))['zlm']['zlmHost'])" 2>/dev/null)"

echo
echo "########## 3. 叠加 9 月后端代码（保持 data/ 用 7/9 的）##########"
tar -xzf "$D/backend_code2.tgz" -C "$R/backend" --strip-components=1
tar -xzf "$D/backend_code.tgz"  -C "$R/backend" --strip-components=1
echo "  ✅ 代码已叠加"
echo -n "  校验 config.json 仍是 7/9 的（zlmHost 应为 172.16.8.12）: "
python3 -c "import json;print(json.load(open('$R/backend/data/config.json'))['zlm']['zlmHost'])"
echo -n "  校验 index.js 是 9 月版（应含 straw-engine 引用）: "
grep -c "STRAW_ENGINE_URL" "$R/backend/index.js" | sed 's/^/出现 /;s/$/ 次/'

echo
echo "########## 4. 补依赖（9月版新增 nodemailer）##########"
cd "$R/backend"
export PATH=/data/HBJSC/tools/node/bin:$PATH
npm install --omit=dev --no-audit --no-fund 2>&1 | tail -5
echo -n "  nodemailer: "; [ -d node_modules/nodemailer ] && echo "✅" || echo "❌ 缺失"

echo
echo "########## 5. 部署前端产物 ##########"
rm -rf "$R/frontend" && mkdir -p "$R/frontend"
tar -xzf "$D/frontend_dist.tgz" -C "$R/frontend"
echo "  index.html: $(ls -la "$R/frontend/index.html" | awk '{print $5}') 字节"
echo "  assets: $(ls "$R/frontend/assets" | wc -l) 个"
echo -n "  base 是不是 /jsc/ : "; grep -o 'src="[^"]*"' "$R/frontend/index.html" | head -2 | tr '\n' ' '; echo

echo
echo "########## 6. 权限 ##########"
chown -R jsc:jsc "$R/backend" "$R/logs" 2>/dev/null || true
chmod -R a+rX "$R/frontend" "$R"
echo "  ✅ /data/HBJSC 归属: $(stat -c '%U:%G' "$R")"

echo
echo "########## 7. nginx 站点（路径指向 /data/HBJSC/frontend）##########"
mkdir -p /var/www/admin /var/www/dajiang                        # 别的站，空占位避免噪音
mkdir -p /opt/skymonitor/frontend/dist                          # 气体快检站，本次未恢复，占位
SED=/etc/nginx/sites-available
mkdir -p "$SED" /etc/nginx/sites-enabled
# 🔴 复跑保护：站点已存在先备份（否则原地覆盖后无回退）
if [ -f "$SED/uav-sites" ]; then
  mkdir -p /etc/nginx/sites-backup
  cp -a "$SED/uav-sites" "/etc/nginx/sites-backup/uav-sites.$(date +%Y%m%d_%H%M%S)"
  echo "  ℹ️ 已备份原 uav-sites → /etc/nginx/sites-backup/"
fi
cp "$D/uav-sites" "$SED/uav-sites"
# 关键改动：前端根目录
sed -i 's#alias /opt/jsc/frontend/;#alias /data/HBJSC/frontend/;#' "$SED/uav-sites"
echo -n "  核对 /jsc/ 的 alias: "; grep -m1 "alias /data/HBJSC/frontend/" "$SED/uav-sites" || { echo "❌ 改写失败"; exit 1; }
ln -sfn "$SED/uav-sites" /etc/nginx/sites-enabled/uav-sites
# 备份放独立目录，避免 include sites-enabled/* 误加载 .bak*
mkdir -p /etc/nginx/sites-backup
[ -e /etc/nginx/sites-enabled/default ] && rm -f /etc/nginx/sites-enabled/default
cp "$D/skymonitor.conf" /etc/nginx/conf.d/skymonitor.conf
echo "  ✅ 站点已装"
echo -n "  nginx -t: "; nginx -t 2>&1 | tail -1

echo
echo "########## 8. systemd 单元 ##########"
cat > /etc/systemd/system/jsc-backend.service <<'EOF'
[Unit]
Description=JSC Backend Service (驾驶舱后端 · 安装于 /data/HBJSC)
After=network.target

[Service]
Environment=TZ=Asia/Shanghai
Environment=NODE_ENV=production
# B 阶段（秸秆引擎 / 机场守护）相关路径，一并指向 /data/HBJSC
Environment=PUBLIC_HOST=111.10.220.226
Environment=STRAW_ENGINE_URL=http://127.0.0.1:7200
Environment=STRAW_ENGINE_CONFIG=/data/HBJSC/straw-engine/config/config.json
Environment=STRAW_EVIDENCE_ROOT=/data/video/evidence
Environment=DOCK_GUARD_URL=http://127.0.0.1:7210
EnvironmentFile=/data/HBJSC/backend/iotcloud.env
Type=simple
User=jsc
WorkingDirectory=/data/HBJSC/backend
ExecStart=/data/HBJSC/tools/node22/bin/node index.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
echo "  ✅ 单元已写（ExecStart=/data/HBJSC/tools/node22/bin/node index.js）"

echo
echo "########## 9. 启动 ##########"
# 大容量数据目录（B 阶段 evidence 会写这里）
mkdir -p /data/video/evidence /data/video/xunlian /data/video/shujuji
systemctl restart nginx
systemctl enable --now jsc-backend 2>&1 | tail -2
sleep 5
echo "--- 服务状态 ---"
for s in nginx jsc-backend; do printf '  %-14s ' "$s"; systemctl is-active $s; done
echo "--- 监听端口 ---"
ss -lntp 2>/dev/null | grep -E ':(80|81|7170|6080)\b' | sed 's/^/  /' || echo "  (无匹配)"

echo
echo "########## 10. 首轮验收 ##########"
# ⚠️ 实测校正：/api/health 需鉴权，返回 401 属正常（不是故障）；用公开接口 /api/map-points 验 200
printf '  本机 :80/jsc/            → HTTP %s（期望 200）\n' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1/jsc/)"
printf '  本机 :80/jsc/api/health  → HTTP %s（401=需鉴权，正常）\n' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1/jsc/api/health)"
printf '  本机 :7170/api/map-points→ HTTP %s（期望 200）\n' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:7170/api/map-points)"
echo "  --- 后端最近日志 ---"
journalctl -u jsc-backend -n 12 --no-pager 2>/dev/null | sed 's/^/    /'
echo
echo "P0_03_INSTALL_DONE"
