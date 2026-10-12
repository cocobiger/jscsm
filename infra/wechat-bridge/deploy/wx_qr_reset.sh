#!/bin/bash
# wx_qr_reset.sh —— 强制重置微信登录二维码（跑在 226 上）
#
# 何时用：要把二维码交给**人**去扫的时候。守护的 latest.png 码龄最长可达 ~3–4 分钟
# （= 微信自身的换码周期），直接交付可能"还没扫就过期"。
#
# ⚠️ 2026-10-13 重要变更：**光重启客户端已经不够了**。
#    微信 4.1.13.65 升级后，登录窗默认显示「上次登录的账号卡片」（头像 + 昵称 + 「登录」按钮），
#    直接截图会截到头像而不是二维码。重启后**必须再点一次「切换账号」**才会出现二维码。
#    ⇒ 本脚本现在 = 杀客户端 + 拉起 + 写 click_preset.txt + 跑 WxClick + 等新码。
#
# 用法：bash wx_qr_reset.sh [最长等待秒数，默认 180]
set -a
. /root/.wxbridge.env
set +a
H="${RDP_VM_IP:-172.16.8.16}"
U="${RDP_USER:-KCW5ngfxteFx}"
QRDIR=/data/HBJSC/wxb_qr
MAXWAIT=${1:-180}
SMBC="//${H}/C\$"

run() {
  timeout 40 /usr/local/bin/wmiexec.py -share 'C$' "${U}:${RDP_PASS}@${H}" "$1" 2>&1 \
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
run 'taskkill /F /IM Weixin.exe' > /dev/null
sleep 5

echo "→ WxLaunchQr 重新拉起"
run 'schtasks /Run /TN WxLaunchQr' > /dev/null
sleep 20

echo "→ 点「切换账号」把二维码调出来（4.1.13.65 起必需）"
printf 'switch_account' > /tmp/click_preset.txt
smbclient "$SMBC" -U "${U}%${RDP_PASS}" -c "cd wxbridge\\deploy; put /tmp/click_preset.txt click_preset.txt" > /dev/null 2>&1
run 'schtasks /Run /TN WxClick' > /dev/null
sleep 8

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

echo "!! ${MAXWAIT}s 内没等到新码 —— 检查："
echo "   守护日志 tail -20 /var/log/wx_qr_keepalive.log"
echo "   点击结果 type C:\\wxbridge\\deploy\\wx_click_out.txt"
echo "   （若当前是「账号卡片」而点击无效，预设坐标可能需要按新版本界面重新标定）"
exit 1
