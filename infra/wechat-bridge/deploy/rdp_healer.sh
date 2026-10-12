#!/bin/bash
# rdp_healer.sh —— 每分钟幂等巡检：xfreerdp 掉了就重启（systemd timer 调用）
set -u
export DISPLAY=:99
ENVF=/root/.wxbridge.env
[ -f "$ENVF" ] || exit 0
# shellcheck disable=SC1090
. "$ENVF"
VM_IP="${RDP_VM_IP:-172.16.8.16}"
TS="$(date '+%Y-%m-%d %H:%M:%S')"

if pgrep -f "xfreerdp.*${VM_IP}" >/dev/null 2>&1; then
  echo "[$TS] xfreerdp alive → $VM_IP"
  exit 0
fi
echo "[$TS] xfreerdp DEAD → 重启"
exec /usr/local/bin/rdp_keep.sh
