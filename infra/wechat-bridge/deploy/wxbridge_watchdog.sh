#!/bin/bash
# wxbridge_watchdog.sh —— 微信桥看门狗（跑在 226 上，由 wxbridge-watchdog.timer 每分钟触发）
#
# 背景：重建后**没有** WxBridgeSelfHeal 任务（老 8/15 机上有）⇒ 桥挂了无人拉起，
#       告警推送会静默全丢。本脚本补上这一层。
#
# 为什么放在 226 而不是 Windows 计划任务（与历史做法不同，是有意的）：
#   * 拉起桥的正解是 `schtasks /Run /TN WeChatBridge`，而该任务是 /IT（交互式）⇒ 必然落在
#     有桌面的 RDP 会话里。若在 Windows 侧再建一个任务去拉起，任务自身若跑在 Session 0，
#     拉起来的桥也在 Session 0 —— **看不到微信窗口，发送必失败**（这正是这次踩到的重复监听事故面）。
#   * 226 上已有同款范式（rdp-healer.timer），复用它最稳。
#
# 判据用 /ping 而不是 /health：/ping 是毫秒级、**绝不触碰微信**的纯存活探针；
# /health 会读 STATE（虽然也是内存态，但语义上不如 /ping 干净）。
#
# ⚠️ 必须写心跳行：否则"没跑"与"跑了但一直健康"无法区分（历史教训）。

set -u
ENV_FILE=/root/.wxbridge.env
[ -f "$ENV_FILE" ] || { echo "$(date '+%F %T') [FATAL] 缺少 $ENV_FILE"; exit 1; }
set -a; . "$ENV_FILE"; set +a
H="${RDP_VM_IP:-172.16.8.16}"
U="${RDP_USER:-KCW5ngfxteFx}"
PASS="${RDP_PASS:-}"
WMI=/usr/local/bin/wmiexec.py
LOG=/var/log/wxbridge_watchdog.log
STATE=/var/lib/wxbridge_watchdog.state

mkdir -p "$(dirname "$STATE")"
[ -f "$STATE" ] || echo "0 0" > "$STATE"   # "<小时窗口起点epoch> <本窗口内重启次数>"

# ⚠️ 时间戳必须**每行现算**：早先写成脚本启动时算一次的变量，结果一次自愈的十几行日志
#    全带同一个时间戳，排障时根本看不出哪一步花了多久。
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

vm() {
  "$WMI" -share 'C$' "${U}:${PASS}@${H}" "$1" 2>&1 \
    | grep -v 'Impacket v\|SMBv3.0 dialect\|Decoding error\|map the result\|and then execute wmiexec'
}

ping_ok() {
  [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://${H}:18888/ping" 2>/dev/null)" = "200" ]
}

# 18888 上所有监听的 PID（Windows 允许两个进程 bind 同一端口 ⇒ 必须全拿）
bridge_pids() {
  vm 'netstat -ano | findstr LISTENING | findstr :18888' \
    | tr -d '\r' | grep -a '18888' | grep -oE '[0-9]+$' | sort -u
}

# 某镜像名的会话号（第 4 列）
sess_of() {
  vm "tasklist /FI \"IMAGENAME eq $1\" /FO CSV /NH" | tr -d '\r' \
    | grep -a "\"$1\"" | head -1 | awk -F'","' '{print $4}' | tr -d '"'
}

hourly_budget() {
  # 打印 "本小时已重启次数"，并在跨小时时重置
  read -r WIN N < "$STATE" || { WIN=0; N=0; }
  NOW=$(date +%s)
  if [ $((NOW - WIN)) -ge 3600 ]; then echo "0 0" > "$STATE"; echo 0; else echo "${N:-0}"; fi
}
bump_budget() {
  read -r WIN N < "$STATE" || { WIN=$(date +%s); N=0; }
  NOW=$(date +%s)
  if [ $((NOW - WIN)) -ge 3600 ]; then WIN=$NOW; N=0; fi
  echo "$WIN $((N + 1))" > "$STATE"
}

MAX_PER_HOUR=6

# ── 1) 存活判定：1 次 + 2 次重试 ─────────────────────────────────────────
if ping_ok; then
  log "HEARTBEAT ok  (session: bridge=$(sess_of python.exe) weixin=$(sess_of Weixin.exe))"
  exit 0
fi
sleep 5
if ping_ok; then log "HEARTBEAT ok（首次探测抖动，已恢复）"; exit 0; fi
sleep 5
if ping_ok; then log "HEARTBEAT ok（重试后恢复）"; exit 0; fi

log "ALERT /ping 连续 3 次不通 ⇒ 判定桥已死，开始自愈"

N=$(hourly_budget)
if [ "$N" -ge "$MAX_PER_HOUR" ]; then
  log "BLOCKED 本小时已重启 $N 次（上限 $MAX_PER_HOUR），跳过本次以免抖动循环"
  exit 0
fi

# ── 2) 先收敛重复监听（所有 PID 全杀，避免"杀了第一个、应答的还是旧的"）──
PIDS=$(bridge_pids)
if [ -n "$PIDS" ]; then
  for P in $PIDS; do
    log "  kill PID $P"
    vm "taskkill /F /PID $P" >/dev/null 2>&1
  done
else
  log "  （18888 上没有监听进程 —— 是进程整个没了，而不是端口被占）"
fi

# ── 3) 等端口真正释放 ───────────────────────────────────────────────────
REL=0
for i in $(seq 1 12); do
  sleep 5
  if ! ping_ok; then REL=1; break; fi
done
[ "$REL" = "1" ] && log "  端口已释放（$((i*5))s）" || log "  ⚠️ 端口仍在应答（可能有第三个实例？继续往下走）"

# ── 4) 拉起（/IT ⇒ 交互式会话）─────────────────────────────────────────
vm 'schtasks /Run /TN WeChatBridge' >/dev/null 2>&1
UP=0
for i in $(seq 1 24); do
  sleep 5
  if ping_ok; then UP=1; log "  已恢复（+$((i*5))s）"; break; fi
done
bump_budget

if [ "$UP" != "1" ]; then
  log "FAILED 拉起后 120s 内 /ping 仍不通 ⇒ 需人工介入（RDP 上机检查）"
  exit 1
fi

# ── 5) 关键不变量：桥与微信必须在**同一个会话**（否则看不到微信窗口，发送必失败）──
SB=$(sess_of python.exe)
SW=$(sess_of Weixin.exe)
CNT=$(bridge_pids | wc -l)
if [ "$SB" = "$SW" ] && [ -n "$SB" ]; then
  log "RECOVERED 桥恢复；实例数=$CNT，bridge session=$SB，weixin session=$SW（一致 ✅）"
else
  log "RECOVERED_WARN 桥恢复但会话不一致！实例数=$CNT bridge session=${SB:-?} weixin session=${SW:-?}"
  log "              ⇒ 桥可能看不到微信窗口，发送会失败；必须人工在交互式会话里重拉"
fi
exit 0
