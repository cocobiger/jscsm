#!/bin/bash
# wx_qr_reset.sh —— 强制重置微信登录二维码（跑在 226 上）
#
# 何时用：要把二维码交给**人**去扫的时候。守护的 latest.png 码龄最长可达 ~3-4 分钟
# （= 微信自身的换码周期），直接交付可能"还没扫就过期"。
# 本脚本杀掉微信客户端并重新拉起 ⇒ 必然得到一张全新二维码，再等守护把它抓成 latest.png。
#
# 用法：bash wx_qr_reset.sh [最长等待秒数，默认 180]
set -a
. /root/.wxbridge.env
set +a
H="${RDP_VM_IP:-172.16.8.16}"
U="${RDP_USER:-KCW5ngfxteFx}"
QRDIR=/data/HBJSC/wxb_qr
MAXWAIT=${1:-180}

run() {
  /usr/local/bin/wmiexec.py -share 'C$' "${U}:${RDP_PASS}@${H}" "$1" 2>&1 \
    | grep -v 'Impacket v\|SMBv3.0 dialect\|Decoding error\|map the result\|and then execute wmiexec'
}

cur_md5() {
  python3 -c "
import json
try: print(json.load(open('$QRDIR/latest.json'))['md5'])
except Exception: print('')
" 2>/dev/null
}

OLD=$(cur_md5)
[ -n "$OLD" ] && echo "重置前 md5 = $OLD" || echo "重置前拿不到 latest.json（可能还没抓过）"

echo "→ taskkill Weixin.exe"
run 'taskkill /F /IM Weixin.exe' >/dev/null
sleep 5
echo "→ WxLaunchQr 重新拉起"
run 'schtasks /Run /TN WxLaunchQr' >/dev/null

t=0
while [ "$t" -lt "$MAXWAIT" ]; do
  sleep 5
  t=$((t + 5))
  NEW=$(cur_md5)
  if [ -n "$NEW" ] && [ "$NEW" != "$OLD" ]; then
    echo "✅ 新码已就绪 md5 = $NEW （用时 ${t}s）"
    exit 0
  fi
  [ $((t % 30)) -eq 0 ] && echo "   ...等待守护抓到新码（${t}s / ${MAXWAIT}s）"
done

echo "!! ${MAXWAIT}s 内没等到新码 —— 检查守护日志：tail -20 /var/log/wx_qr_keepalive.log"
exit 1
