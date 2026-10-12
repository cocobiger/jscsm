#!/bin/bash
# rdp_keep.sh —— 保持到微信桥 VM 的 RDP 常驻会话（wxauto 系列**必须**有交互式桌面）
# 迁移后：VM IP = 172.16.8.16（原 8.15）；凭据从 /root/.wxbridge.env 读（600，不入仓库）
# 用法：/usr/local/bin/rdp_keep.sh  （由 rdp-healer.timer 每分钟幂等调用）
set -u
export DISPLAY=:99
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

ENVF=/root/.wxbridge.env
[ -f "$ENVF" ] || { echo "缺少 $ENVF"; exit 1; }
# shellcheck disable=SC1090
. "$ENVF"                       # 提供 RDP_VM_IP / RDP_USER / RDP_PASS

VM_IP="${RDP_VM_IP:-172.16.8.16}"
RDP_USER="${RDP_USER:-KCW5ngfxteFx}"
RDP_PASS="${RDP_PASS:?RDP_PASS 未配置}"
SHARE_DIR="${RDP_SHARE:-/tmp/wxbridge_share}"
TS="$(date '+%Y-%m-%d %H:%M:%S')"

mkdir -p "$SHARE_DIR"; chmod 777 "$SHARE_DIR"

# 1) Xvfb
if [ ! -S /tmp/.X11-unix/X99 ]; then
  (Xvfb :99 -screen 0 1440x900x24 > /tmp/xvfb.log 2>&1 &)
  sleep 2
  echo "[$TS] Xvfb :99 已启动"
fi

# 2) 已有到该 VM 的 xfreerdp 就不再起
if pgrep -f "xfreerdp.*${VM_IP}" >/dev/null 2>&1; then
  echo "[$TS] xfreerdp → ${VM_IP} 已在运行，跳过"
  exit 0
fi
pkill -9 -f "xfreerdp.*${VM_IP}" 2>/dev/null || true
sleep 1

# 3) 起常驻 RDP（+auto-reconnect 断线自恢复；/drive 供文件互传）
nohup xfreerdp /v:"${VM_IP}" "/u:.\\${RDP_USER}" "/p:${RDP_PASS}" \
  /size:1440x900 /cert:ignore +clipboard +auto-reconnect \
  /drive:WX,"${SHARE_DIR}" \
  > /tmp/rdp_keep.log 2>&1 &
sleep 25

echo "[$TS] RDP 已发起 → ${VM_IP}；窗口列表："
xdotool search --onlyvisible --name '.*' 2>/dev/null | while read -r w; do
  echo "  WIN $w: $(xdotool getwindowname "$w" 2>/dev/null)"
done | head -12
echo "[$TS] 进程："
ps -ef | grep -E "xfreerdp.*${VM_IP}" | grep -v grep | sed 's/^/  /'
exit 0
