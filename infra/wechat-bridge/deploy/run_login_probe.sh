#!/bin/bash
# run_login_probe.sh —— 在 226 上跑一次「微信登录态」探针并打印对照结论（T1）
#
# 用法：bash run_login_probe.sh
# 说明：探针（wx_login_probe.py）会跑在 VM 的**交互式会话**里（与桥同条件），
#       把候选信号采集到 C:\wxbridge\deploy\wx_login_probe.json。
#       未登录态 / 已登录态各跑一次，对比即得判据定标结论。
#
# 已采集的"未登录态"基线（2026-10-12 23:29）：
#   auto_detect_db_dir() = null  ⇒ 连微信 DB 目录都不存在
#   WeChatDB()           = RuntimeError: 未找到微信数据库目录
#   windows              = Qt51514QWindowIcon '微信' 296x388  （唯一窗口 = 登录窗）
#   guia_import          = OK
# ⇒ 若"已登录态"能构造出 WeChatDB() 且窗口尺寸 != 296x388，则两个信号互相印证。
set -a
. /root/.wxbridge.env
set +a
H="${RDP_VM_IP:-172.16.8.16}"
U="${RDP_USER:-KCW5ngfxteFx}"
SMB="//${H}/C\$"

run() {
  /usr/local/bin/wmiexec.py -share 'C$' "${U}:${RDP_PASS}@${H}" "$1" 2>&1 \
    | grep -v 'Impacket v\|SMBv3.0 dialect\|Decoding error\|map the result\|and then execute wmiexec'
}

# 与上一次结果比对用的指纹
OLD_MD5=""
if [ -s /tmp/_probe_new ]; then OLD_MD5=$(md5sum /tmp/_probe_new | awk '{print $1}'); fi

rm -f /tmp/_probe_new
run 'schtasks /Run /TN WxLoginProbe'

for i in $(seq 1 30); do
  sleep 5
  smbclient "$SMB" -U "${U}%${RDP_PASS}" -c "cd wxbridge\\deploy; get wx_login_probe.json /tmp/_probe_new" >/dev/null 2>&1
  if [ -s /tmp/_probe_new ]; then
    NEW=$(md5sum /tmp/_probe_new | awk '{print $1}')
    if [ "$NEW" != "$OLD_MD5" ] && grep -aq '"finished_at"' /tmp/_probe_new; then
      echo "（+$((i*5))s 取到新结果）"
      break
    fi
  fi
done

if [ ! -s /tmp/_probe_new ]; then
  echo "!! 没取到结果，看控制台："
  run 'type C:\wxbridge\deploy\wx_login_probe_console.txt'
  exit 1
fi

python3 - <<'PY'
import json
d = json.load(open('/tmp/_probe_new', encoding='utf-8'))
sig = d["signals"]
print("时段:", d.get("started_at"), "->", d.get("finished_at"))
print()
print("【窗口几何】")
for w in d.get("windows", []):
    print("   cls=%r title=%r size=%s  is_login_size=%s" % (w["cls"], w["title"], w["size"], w["is_login_size"]))
if not d.get("windows"):
    print("   （没有任何 Qt/微信 窗口 —— 微信可能没起来）")
print()
print("【候选信号】")
for k, v in sig.items():
    if k == "windows":
        continue
    if v.get("ok"):
        print("  [OK  %6dms] %-16s %s" % (v["ms"], k, json.dumps(v["value"], ensure_ascii=False)[:260]))
    else:
        print("  [ERR %6dms] %-16s %s" % (v["ms"], k, v.get("error", "")[:260]))
print()
print("【判据自检】")
ad = (sig.get("account_dirs") or {}).get("value") or {}
ctor = sig.get("db_ctor") or {}
sess = (sig.get("sessions") or {}).get("value") or {}
grp = (sig.get("groups") or {}).get("value") or {}
win = d.get("windows") or []
login_win = bool(win) and all(w.get("is_login_size") for w in win)
print("  auto_detect_db_dir 非空 ......... %s" % bool(ad.get("db_dir")))
print("  WeChatDB() 构造成功 ............ %s" % bool(ctor.get("ok")))
print("  会话数 / 群数 .................. %s / %s" % (sess.get("count"), grp.get("count")))
print("  存在非登录尺寸的微信窗口 ....... %s" % any(not w.get("is_login_size") for w in win))
print("  ⇒ 综合判定：%s" % ("已登录" if (ctor.get("ok") or any(not w.get("is_login_size") for w in win)) and not login_win else "未登录/待确认"))
PY
