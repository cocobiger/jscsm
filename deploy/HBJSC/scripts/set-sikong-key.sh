#!/bin/bash
# set-sikong-key.sh —— 司空2 重新部署后，用新的 apikey 一键接上 dji-openapi
#
# 背景：司空私有版每次重装会给出一套新凭据（OpenAPI user token / 登录用户 / webhook 密钥）。
#       本脚本把凭据写进 systemd EnvironmentFile，仓库里的 config.json 永远只留占位符
#       （遵循红线：真实凭据不进 git）。
#
# 用法：
#   bash set-sikong-key.sh <SIKONG_API_KEY> [TENANT_ID] [USER_ID] [APP_ID] [SIGNATURE_SECRET]
# 例：
#   bash set-sikong-key.sh 1a2b3c4d5e6f...  1435364026368000  1435364026458112  myAppKey  myHmacSecret
#
# 只给第一个参数也行（最常见的"司空就给了个 apikey"场景）；其余可后续再补。
set -e
APP=/data/HBJSC/dji-openapi
ENVF=$APP/dji-openapi.env
KEY="$1"

if [ -z "$KEY" ]; then
  echo "用法: $0 <SIKONG_API_KEY> [TENANT_ID] [USER_ID] [APP_ID] [SIGNATURE_SECRET]"
  exit 1
fi

mkdir -p "$APP"
[ -f "$ENVF" ] && cp -a "$ENVF" "$ENVF.bak_$(date +%Y%m%d_%H%M%S)"
touch "$ENVF"

setkv() {
  local k="$1" v="$2"
  [ -n "$v" ] || return 0
  if grep -q "^$k=" "$ENVF"; then sed -i "s|^$k=.*|$k=$v|" "$ENVF"; else echo "$k=$v" >> "$ENVF"; fi
}
setkv SIKONG_API_KEY          "$1"
setkv SIKONG_LOGIN_TENANT_ID  "$2"
setkv SIKONG_LOGIN_USER_ID    "$3"
setkv SIKONG_APP_ID           "$4"
setkv SIKONG_SIGNATURE_SECRET "$5"
chmod 600 "$ENVF"

echo "✅ 已写入 $ENVF（键名如下，值已隐藏）："
sed -E 's/=.*/=<hidden>/' "$ENVF" | sed 's/^/    /'

echo
echo "--- 重启 dji-openapi ---"
systemctl daemon-reload
if systemctl list-unit-files 2>/dev/null | grep -q '^dji-openapi.service'; then
  systemctl restart dji-openapi
  sleep 4
  echo "  状态: $(systemctl is-active dji-openapi)"
  echo "  /health: $(curl -s --max-time 8 http://127.0.0.1:17810/health | head -c 400)"
  echo "  最近日志："
  journalctl -u dji-openapi -n 8 --no-pager | tail -8 | sed 's/^/    /'
else
  echo "  ⚠️ 未发现 dji-openapi.service（服务尚未安装）——凭据已就位，装好后启动即生效"
fi
echo
echo "SET_SIKONG_KEY_DONE"
