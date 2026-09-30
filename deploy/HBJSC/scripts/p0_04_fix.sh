#!/bin/bash
# p0_04_fix.sh —— 修复：① 叠加 9 月代码 ② 补依赖 ③ systemd 指向 Node22 ④ 重启验收
set -e
R=/data/HBJSC
D=/tmp/deploy_A

echo "########## 1. 叠加 9 月后端代码（这次 tar 带 server/ 前缀，strip 1 正确）##########"
cd "$R/backend"
tar -xzf "$D/backend_code2.tgz" -C "$R/backend" --strip-components=1
tar -xzf "$D/backend_code.tgz"  -C "$R/backend" --strip-components=1
echo "  9月独有文件校验："
for f in drone-events.js review.js sikong.js stack-config.js warnings-stream.js algo-threshold.js; do
  printf '    %-20s ' "$f"; [ -f "$R/backend/$f" ] && echo "✅" || echo "❌"
done
printf '  index.js STRAW_ENGINE_URL 出现次数: '; grep -c "STRAW_ENGINE_URL" index.js
printf '  index.js 大小: '; stat -c '%s 字节  （%y）' index.js

echo
echo "########## 2. 补依赖（9月版新增 nodemailer）##########"
export PATH=/data/HBJSC/tools/node22/bin:$PATH
# 🔴 实测校正：本项目 node_modules 是 pnpm 结构（.pnpm/ + 符号链），直接 npm install 会崩
#    （Cannot read properties of null (reading 'matches')）⇒ 用「临时目录 npm i 再 cp -r」回填缺失包
if [ -f node_modules/.modules.yaml ] || [ -d node_modules/.pnpm ]; then
  echo "  ℹ️ 检测到 pnpm 结构，走临时目录回填法"
  TMPN=$(mktemp -d)
  ( cd "$TMPN" && npm init -y >/dev/null 2>&1 && npm install --omit=dev --no-audit --no-fund nodemailer 2>&1 | tail -3 )
  [ -d "$TMPN/node_modules/nodemailer" ] && cp -r "$TMPN/node_modules/nodemailer" node_modules/ && echo "  ✅ nodemailer 已回填"
  rm -rf "$TMPN"
else
  npm install --omit=dev --no-audit --no-fund 2>&1 | tail -4
fi
echo -n "  nodemailer: "; [ -d node_modules/nodemailer ] && echo "✅" || echo "❌"
echo "  node_modules 顶层包数: $(ls node_modules | grep -v '^\.' | wc -l)"
# ⚠️ 时序铁律：nodemailer 必须在【后端 restart 之前】就位。否则 monitor.js 在模块加载时
#    require('nodemailer') 失败并缓存 null，进程内邮件告警长期失效（2026-09-30 实测踩过：
#    后端 02:55:59 启动、nodemailer 02:57:33 才装 ⇒ 日志一直报「nodemailer 未安装」）。
#    故本脚本：先补依赖，第 5 步再 restart。

echo
echo "########## 3. 前端产物复核 ##########"
echo "  index.html: $(stat -c%s "$R/frontend/index.html") 字节"
echo "  assets: $(ls "$R/frontend/assets" | wc -l) 个"
echo -n "  /jsc/ base: "; grep -oE '(src|href)="[^"]*"' "$R/frontend/index.html" | head -3 | tr '\n' ' '; echo

echo
echo "########## 4. systemd 改用 Node22 ##########"
sed -i 's#^ExecStart=.*#ExecStart=/data/HBJSC/tools/node22/bin/node index.js#' /etc/systemd/system/jsc-backend.service
echo -n "  新 ExecStart: "; grep '^ExecStart' /etc/systemd/system/jsc-backend.service
systemctl daemon-reload

echo
echo "########## 5. 权限与重启 ##########"
chown -R jsc:jsc "$R/backend"
chmod -R a+rX "$R/frontend"
systemctl restart jsc-backend
sleep 8
echo "  jsc-backend: $(systemctl is-active jsc-backend)"
echo "--- 最近日志 ---"
journalctl -u jsc-backend -n 18 --no-pager | sed 's/^/    /'

echo
echo "########## 6. 验收 ##########"
for u in "http://127.0.0.1/jsc/" "http://127.0.0.1/jsc/api/health" "http://127.0.0.1:7170/api/health"; do
  printf '  %-40s HTTP %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$u")"
done
echo "--- 监听 ---"
ss -lntp 2>/dev/null | grep -E ':(80|81|7170)\b' | sed 's/^/  /'
echo
echo "P0_04_FIX_DONE"
