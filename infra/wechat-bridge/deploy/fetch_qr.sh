#!/bin/bash
# fetch_qr.sh —— 从 226 取回「最新的微信登录二维码」并裁切放大（在本机 Git Bash 下运行）
#
# 背景：微信登录二维码有效期约 2–5 分钟。用户拿到的若是几分钟前的截图，扫的时候早失效了。
# 226 上有 wx-qr-keepalive.service 每 60s 把最新二维码落到
#   /data/HBJSC/wxb_qr/latest.png （目录 700 / 文件 600）
# 本脚本拉回该图、按二维码 bbox 裁切并 6× 放大，产出可直接扫的图。
#
# 用法：  bash infra/wechat-bridge/deploy/fetch_qr.sh [输出目录]
# 依赖：  SSH_ASKPASS（本机无 sshpass，见 REF_sandbox_pitfalls）、Python + Pillow
set -e

HOST=${WXB_SSH_HOST:-111.10.220.226}
PORT=${WXB_SSH_PORT:-22233}
ASKPASS=${WXB_ASKPASS:-/c/Users/Administrator/AppData/Local/Temp/jsc_askpass.sh}
PY=${WXB_PY:-C:/Users/Administrator/.workbuddy/binaries/python/envs/default/Scripts/python.exe}
OUTDIR=${1:-tmp/wxb_shots}
REMOTE_QR=/data/HBJSC/wxb_qr

[ -f "$ASKPASS" ] || { echo "!! 找不到 askpass 脚本：$ASKPASS（用 WXB_ASKPASS 指定）"; exit 1; }
export SSH_ASKPASS="$ASKPASS" SSH_ASKPASS_REQUIRE=force DISPLAY=:0
# ⚠️ 端口参数大小写不同：ssh 用 -p，scp 用 -P（少见的坑，写错会把端口号当成源文件）
SSHOPT="-o PubkeyAuthentication=no -o PreferredAuthentications=password -o StrictHostKeyChecking=no"
SSHOPTP="-p $PORT $SSHOPT"
SCPOPT="-P $PORT $SSHOPT"

mkdir -p "$OUTDIR"

echo "[1/3] 取 latest.png + latest.json + 守护日志尾部"
scp $SCPOPT "root@$HOST:$REMOTE_QR/latest.png" "$OUTDIR/qr_live.png" >/dev/null
ssh $SSHOPTP "root@$HOST" "cat $REMOTE_QR/latest.json; echo; tail -3 /var/log/wx_qr_keepalive.log" > "$OUTDIR/qr_live.meta.txt"

echo "[2/3] 裁切 + 6x 放大"
"$PY" - "$OUTDIR" <<'PYEOF'
import sys, json, time
from PIL import Image

out = sys.argv[1]
im = Image.open(out + "/qr_live.png").convert("L")
W, H = im.size

# 二维码在登录窗口里水平居中、垂直约 39% 处；按比例框定搜索带，
# 左右各留 12% 安全边避开窗口外的背景像素（否则暗像素包围盒会被背景文字带偏）
XL, XR = int(W * 0.12), int(W * 0.88)
y0, y1 = int(H * 0.16), int(H * 0.60)
band = im.crop((XL, y0, XR, y1))
px = band.load()
xs, ys = [], []
for yy in range(band.height):
    for xx in range(band.width):
        if px[xx, yy] < 110:
            xs.append(xx); ys.append(yy)
if not xs:
    print("!! 未在窗口内找到二维码像素，可能当前不是登录界面（已登录？）")
    sys.exit(2)

x0, x1 = XL + min(xs), XL + max(xs)
yy0, yy1 = y0 + min(ys), y0 + max(ys)
w, h = x1 - x0, yy1 - yy0
print("   qr bbox = (%d,%d)-(%d,%d)  %dx%d" % (x0, yy0, x1, yy1, w, h))
if abs(w - h) > 20:
    print("   ⚠️ 二维码区域不是方形，判据可能失效，请人工看图确认")

M = 8
qr = im.crop((max(0, x0 - M), max(0, yy0 - M), min(W, x1 + M), min(H, yy1 + M)))
big = qr.resize((qr.width * 6, qr.height * 6), Image.LANCZOS).convert("RGB")
big.save(out + "/qr_live_only.png")
big.save(out + "/qr_latest.png")
print("   已保存 %s/qr_live_only.png (%dx%d)" % (out, big.width, big.height))
PYEOF

echo "[3/3] 元信息"
cat "$OUTDIR/qr_live.meta.txt" 2>/dev/null | head -5
echo
echo "👉 可扫码图：$OUTDIR/qr_live_only.png"
echo "   （二维码约 2–5 分钟过期；守护每 60s 换一张新的，随时重跑本脚本即可拿最新）"
