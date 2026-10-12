#!/bin/bash
# 在 226 上安装「微信二维码保活守护」
# 用法：scp 本目录 4 个文件到 /tmp/wxb_install/ 后，bash /tmp/wxb_install/install.sh
set -e

SRC="$(cd "$(dirname "$0")" && pwd)"
INSTALL_PY=/data/HBJSC/scripts/wx_qr_keepalive.py
QRDIR=/data/HBJSC/wxb_qr
UNIT=/etc/systemd/system/wx-qr-keepalive.service

echo "=== 0) 准备 ==="
set -a
. /root/.wxbridge.env
set +a
H="${RDP_VM_IP:-172.16.8.16}"
U="${RDP_USER:-KCW5ngfxteFx}"
echo "VM=$H USER=$U"
command -v smbclient >/dev/null || { echo "!! 缺 smbclient，先 apt-get install -y smbclient"; exit 1; }

echo
echo "=== 1) 安装守护脚本 ==="
install -m 0755 "$SRC/wx_qr_keepalive.py" "$INSTALL_PY"
python3 -m py_compile "$INSTALL_PY" && echo "语法 OK"

mkdir -p "$QRDIR"
chmod 700 "$QRDIR"

echo
echo "=== 2) 投送 Windows 启动包装（SMB） ==="
smbclient "//${H}/C\$" -U "${U}%${RDP_PASS}" \
  -c "cd wxbridge\\deploy; put $SRC/run_wx_launch.cmd run_wx_launch.cmd" 2>&1 | tail -3

echo
echo "=== 3) 校验 md5（本地 vs VM） ==="
L=$(md5sum "$SRC/run_wx_launch.cmd" | awk '{print $1}')
rm -f /tmp/_cmdbk
smbclient "//${H}/C\$" -U "${U}%${RDP_PASS}" \
  -c "cd wxbridge\\deploy; get run_wx_launch.cmd /tmp/_cmdbk" >/dev/null 2>&1
R=$(md5sum /tmp/_cmdbk 2>/dev/null | awk '{print $1}')
echo "local=$L"
echo "  vm=$R"
[ -n "$R" ] && [ "$L" = "$R" ] && echo "md5 一致 ✅" || { echo "!! md5 不一致"; exit 1; }

echo
echo "=== 4) 创建 WxLaunchQr 计划任务（交互式会话启动微信） ==="
/usr/local/bin/wmiexec.py -share 'C$' "${U}:${RDP_PASS}@${H}" \
  "schtasks /Create /TN WxLaunchQr /SC ONCE /ST 00:00 /TR \"C:\\wxbridge\\deploy\\run_wx_launch.cmd\" /IT /RU ${U} /F" 2>&1 | tail -6

echo
echo "=== 5) 安装并启动 systemd 服务 ==="
install -m 0644 "$SRC/wx-qr-keepalive.service" "$UNIT"
systemctl daemon-reload
systemctl enable wx-qr-keepalive.service
systemctl restart wx-qr-keepalive.service
sleep 8
systemctl --no-pager --full status wx-qr-keepalive.service | head -14

echo
echo "=== 6) 首轮日志 ==="
sleep 20
tail -20 /var/log/wx_qr_keepalive.log 2>/dev/null || journalctl -u wx-qr-keepalive -n 20 --no-pager

echo
echo "=== 7) 产出 ==="
ls -la "$QRDIR" 2>/dev/null
