#!/bin/bash
# p0_07_finalize.sh —— ① 修正 ZLM 三处端口 ② 逐文件 md5 门禁 ③ 落安装清单
set -e
R=/data/HBJSC
CFG=$R/zlm/config/config.ini

echo "########## 1. ZLM 端口修正（我上一轮用的键名不对）##########"
# 真相：SSL http 端口由 [http] sslport 控制（不是 [https] port）；rtp 端口区间键名是 port_range
sed -i 's/^sslport=443$/sslport=4443/' "$CFG"            # [http] sslport → 4443（与文档一致）
sed -i 's/^port_range=30000-35000$/port_range=40000-40500/' "$CFG"   # 避开司空 30000-30500
sed -i 's/^port=8000$/port=0/' "$CFG"                    # [rtc] 关闭 webrtc（本系统用 FLV/HLS，不用 rtc）

echo "  --- 回读（按 section）---"
for kv in "http:sslport" "rtp:port_range" "rtc:port" "http:port" "rtsp:port" "rtmp:port" "https:port"; do
  s=${kv%%:*}; k=${kv##*:}
  printf '    [%s] %-12s = ' "$s" "$k"
  awk -v s="[$s]" -v k="$k" '$0==s{f=1;next} /^\[/{f=0} f&&$0~"^"k"="{sub("^"k"=","");print;exit}' "$CFG"
done
systemctl restart zlmediakit-jsc
sleep 6
echo "  服务: $(systemctl is-active zlmediakit-jsc)"
echo "  --- 实际监听（应含 6080/5540/1936/4443，且无 443）---"
ss -lntp 2>/dev/null | grep -E ':(6080|5540|1936|4443|443|6081)\b' | awk '{print "    "$4}' | sort -u
printf '  getServerConfig → HTTP %s\n' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 'http://127.0.0.1:6080/index/api/getServerConfig?secret=035c73f7-bb6b-4889-a715-d9eb2d192abc')"

echo
echo "########## 2. 前端逐文件门禁：磁盘 md5 == HTTP md5，引用逐个 200 ##########"
A=http://127.0.0.1/jsc
FAIL=0
# 2.1 首页
dm=$(md5sum "$R/frontend/index.html" | awk '{print $1}')
hm=$(curl -s "$A/index.html" | md5sum | awk '{print $1}')
[ "$dm" = "$hm" ] && echo "  ✅ index.html  md5 一致" || { echo "  ❌ index.html md5 不一致 磁盘=$dm HTTP=$hm"; FAIL=1; }

# 2.2 首页引用的每个资源
echo "  --- index.html 引用的资源 ---"
for u in $(grep -oE '(src|href)="/jsc/[^"]*"' "$R/frontend/index.html" | sed 's/.*"\(.*\)"/\1/' | sort -u); do
  f="$R/frontend/${u#/jsc/}"
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1${u}")
  if [ -f "$f" ]; then
    d=$(md5sum "$f" | awk '{print $1}'); h=$(curl -s --max-time 10 "http://127.0.0.1${u}" | md5sum | awk '{print $1}')
    [ "$d" = "$h" ] && [ "$code" = "200" ] && echo "    ✅ $code $u" || { echo "    ❌ $code $u  md5 $([ "$d" = "$h" ] && echo 一致 || echo 不一致)"; FAIL=1; }
  else
    echo "    ⚠️ $code $u（磁盘无此文件）"
  fi
done

# 2.3 全量 assets
echo "  --- dist/assets 全量（$(ls $R/frontend/assets | wc -l) 个）---"
BAD=0
for f in "$R"/frontend/assets/*; do
  n=$(basename "$f")
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$A/assets/$n")
  [ "$code" = "200" ] || { echo "    ❌ $n → $code"; BAD=$((BAD+1)); }
done
[ "$BAD" = "0" ] && echo "    ✅ 全部 200" || FAIL=1

echo
echo "########## 3. 后端 API 抽查（401=需鉴权属正常，5xx 才是问题）##########"
for u in /api/streams /api/map-points?type=air /api/enterprises /api/warnings /api/sikong/devices; do
  printf '    %-30s HTTP %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:7170$u")"
done

echo
echo "########## 4. 落安装清单（给下一位接手的人）##########"
cat > "$R/backups/INSTALL_MANIFEST_$(date +%Y%m%d_%H%M).md" <<EOF
# HBJSC 安装清单（方案 A · $(date '+%Y-%m-%d %H:%M')）

## 已安装
| 组件 | 路径 | 版本 | 服务 |
|---|---|---|---|
| 前端驾驶舱 | $R/frontend | git 源码构建（vite 6.3.5） | nginx |
| 后端 jsc-backend | $R/backend | 9月代码 + 7/9 node_modules/data | jsc-backend.service |
| 业务库 | $R/backend/data/jsc.db | 2026-07-09 快照（~163MB；7/9 底座 22 表，9 月代码启动后自动补建到 **39 表**） | — |
| ZLMediaKit | $R/zlm | 源码编译（Release） | zlmediakit-jsc.service |
| Node 运行时 | $R/tools/node22 | v22.23.2x | — |
| nginx | /etc/nginx | 1.18.0 | nginx |

## 端口
80/81 nginx ｜ 7170 jsc-backend ｜ 6080/5540/1936/4443 ZLM

## 未完成 / 已知缺口
- straw-engine（:7200）—— 方案 B，需重写 app/main.py
- dji-openapi（:17810）—— 依赖司空2 网段 172.28.0.0/24（当前不通）
- dock-guard / chengyun-mock / flight-monitor —— 方案 A 收尾项
- wanzhou_towns.geojson 缺失 → 镇街反查/告警责任单位不可用
- 视频流数据为 7/9 快照；2026-07-09 之后的运行数据无副本

## 数据盘
/video -> /data/video（软链）；任何 >1GB 数据只准写这里
EOF
echo "  ✅ 已写 $R/backups/INSTALL_MANIFEST_$(date +%Y%m%d_%H%M).md"

echo
[ "$FAIL" = "0" ] && echo "P0_07_FINALIZE_DONE  RESULT=PASS" || echo "P0_07_FINALIZE_DONE  RESULT=FAIL"
