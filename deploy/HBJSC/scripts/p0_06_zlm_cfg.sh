#!/bin/bash
# p0_06_zlm_cfg.sh —— 生成并精确修补 ZLM 生产配置，然后启动
# 关键：ZLM 的 hook 非 200 会【拒绝推流/播放】→ 必须只留 on_publish 指向本机后端，其余清空
set -e
R=/data/HBJSC/zlm
CFG="$R/config/config.ini"

echo "########## 1. 基线配置：优先用 release 自带的官方完整默认（43KB）##########"
mkdir -p "$R/config" "$R/www"
[ -f "$R/config/config.ini" ] && mv "$R/config/config.ini" "$R/config/config.ini.tpl_7jul.bak"
if [ -f "$R/config.ini" ] && [ "$(stat -c%s "$R/config.ini")" -gt 10000 ]; then
  cp "$R/config.ini" "$CFG"
  echo "  ✅ 用 release 自带官方默认配置 ($(stat -c%s "$CFG") 字节) —— 不必让程序现生成，避免抢 80 端口"
else
  echo "  ℹ️ 无官方默认，让 MediaServer 现生成（仅 3 秒，会短暂占 80）"
  timeout 3 "$R/MediaServer" -c "$CFG" -l 0 >/tmp/zlm_gen.log 2>&1 || true
  sleep 1
fi
if [ ! -f "$CFG" ]; then echo "  ❌ 未得到 $CFG"; exit 1; fi
echo "  基线 $(stat -c%s "$CFG") 字节"

echo
echo "########## 2. 精确修补（按 section 改，改完逐项回读）##########"
python3 - "$CFG" "$R" <<'PY'
import sys, io, re
cfg_path, R = sys.argv[1], sys.argv[2]
txt = io.open(cfg_path, encoding='utf-8').read()

WANT = {
    'api':   {'secret': '035c73f7-bb6b-4889-a715-d9eb2d192abc', 'apiDebug': '0'},
    # 🔴 实测校正：ZLM 的 SSL http 端口键名是 [http] sslport（不是 [https] port；[https] 段会被忽略）
    'http':  {'port': '6080', 'sslport': '4443', 'rootPath': f'{R}/www', 'ssl': '0'},
    'rtsp':  {'port': '5540'},
    'rtmp':  {'port': '1936'},
    'websocket': {'port': '6081'},          # 避开 skymonitor 的 8080（实测 ZLM 未在此起独立监听，无害）
    'hls':   {'segDur': '2', 'segNum': '5', 'segRetain': '5', 'fastRegister': '1',
              'fileBufSize': '65536', 'broadcastRecordTs': '0'},
    'general': {'enableHls': '1', 'enableMP4': '0', 'enableFmp4': '1',
                'enable_audio': '1', 'flowThreshold': '1024', 'maxStreamWaitMS': '15000'},
    'ffmpeg': {'bin': '/usr/bin/ffmpeg'},
    # 🔴 实测校正：RTP 区间键名是 [rtp] port_range（不是 rtpPortRange，后者会被忽略）
    'rtp':   {'port_range': '40000-40500'},   # 避开司空 30000-30500
    'hook':  {'on_publish': 'http://127.0.0.1:7170/api/zlm/publish-check',
              'enable': '1',
              # 这些留空：ZLM 收到非 200 会拒绝播放/推流，本机后端没有对应路由，宁可全放行
              'on_play': '', 'on_flow_report': '', 'on_http_access': '', 'on_rtsp_realm': '',
              'on_rtsp_auth': '', 'on_stream_changed': '', 'on_stream_none_reader': '',
              'on_stream_not_found': '', 'on_server_started': '', 'on_server_keepalive': '',
              'on_record_mp4': '', 'on_record_ts': '', 'on_shell_login': '',
              'on_stream_not_found_ffmpeg': ''},
}

lines = txt.split('\n')
cur = None
out = []
seen = {}
for ln in lines:
    m = re.match(r'^\s*\[([^\]]+)\]\s*$', ln)
    if m:
        cur = m.group(1).strip()
        out.append(ln)
        continue
    m2 = re.match(r'^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*)=(.*)$', ln)
    if m2 and cur and cur in WANT and m2.group(2) in WANT[cur]:
        key = m2.group(2)
        val = WANT[cur][key]
        out.append(f'{key}={val}')
        seen[(cur, key)] = True
        continue
    out.append(ln)

# 补齐 WANT 里但原配置中不存在的键
text = '\n'.join(out)
missing = []
for sec, kv in WANT.items():
    for k, v in kv.items():
        if (sec, k) not in seen:
            missing.append((sec, k, v))
if missing:
    lines2 = text.split('\n')
    out2, cur = [], None
    added_sec = set()
    for ln in lines2:
        m = re.match(r'^\s*\[([^\]]+)\]\s*$', ln)
        if m:
            cur = m.group(1).strip()
            out2.append(ln)
            for (s, k, v) in missing:
                if s == cur and s not in added_sec:
                    out2.append(f'{k}={v}')
            added_sec.add(cur)
            continue
        out2.append(ln)
    text = '\n'.join(out2)
    # 对配置里完全没有的 section，追加到文件末
    exist_secs = set(re.findall(r'^\s*\[([^\]]+)\]', text, re.M))
    tail = []
    for s in {x[0] for x in missing}:
        if s not in exist_secs:
            tail.append(f'\n[{s}]')
            for (ss, k, v) in missing:
                if ss == s:
                    tail.append(f'{k}={v}')
    if tail:
        text += '\n' + '\n'.join(tail) + '\n'

io.open(cfg_path, 'w', encoding='utf-8', newline='\n').write(text)
print('  已写入')
PY

echo
echo "  --- 逐项回读门禁 ---"
chk(){ printf '    %-28s ' "$1"; v=$(awk -v s="[$2]" -v k="$3" '
  $0==s{f=1;next} /^\[/{f=0} f&&$0~"^"k"="{sub("^"k"=","");print;exit}' "$CFG"); echo "${v:-（空）}"; }
chk "api.secret"        api secret
chk "http.port"         http port
chk "http.sslport"      http sslport
chk "rtsp.port"         rtsp port
chk "rtmp.port"         rtmp port
chk "websocket.port"    websocket port
chk "rtp.port_range"    rtp port_range
chk "hls.segDur"        hls segDur
chk "hls.fastRegister"  hls fastRegister
chk "hook.on_publish"   hook on_publish
chk "hook.on_play"      hook on_play

echo
echo "########## 3. 冲突预检：ZLM 要占的端口是否被占 ##########"
for p in 6080 5540 1936 4443 6081; do
  if ss -lnt 2>/dev/null | grep -q ":$p "; then echo "  ⚠️ $p 已被占用：$(ss -lntp 2>/dev/null | grep ":$p " | head -1)"; else echo "  ✅ $p 空闲"; fi
done

echo
echo "########## 4. 启动 ##########"
systemctl restart zlmediakit-jsc
sleep 6
echo "  服务: $(systemctl is-active zlmediakit-jsc)"
echo "  --- 监听 ---"; ss -lntp 2>/dev/null | grep -E ':(6080|5540|1936|4443|6081)\b' | awk '{print "    "$4}' | sort -u
echo "  --- API 门禁 ---"
printf '    getServerConfig → HTTP %s\n' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 'http://127.0.0.1:6080/index/api/getServerConfig?secret=035c73f7-bb6b-4889-a715-d9eb2d192abc')"
echo "  --- 日志 ---"; journalctl -u zlmediakit-jsc -n 10 --no-pager | sed 's/^/    /'
echo
echo "P0_06_ZLM_CFG_DONE"
