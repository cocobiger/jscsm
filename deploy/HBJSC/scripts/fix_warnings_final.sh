#!/bin/bash
# fix_warnings_final.sh —— 定稿 /api/warnings：保留期「重建期放宽」，并留可回滚记录
#
# 已证实的诊断（受控实验）：
#   基线 默认=0 / retention=0=83
#   关掉 __gas__(5天)        → 63   （60 条 growth5h 被它归档）
#   再关掉 堆头未覆盖(2天)   → 83   （20 条 iot-video-analysis 被它归档）
#   ⇒ 真因 = 算法保留期「软归档」：库里数据是 2026-06~07 的，已超 2~7 天窗口。
#   ⇒ 不是代码 bug，也不是 alert_filter_rules（该表 0 行）。
#
# 定稿做法：**保留期功能保持 enabled（语义完整、后台可见），只把天数放宽**，并在 remark 里写清原值，
#          待新数据接入后把天数改回原值即可回滚。
set -e
B=http://127.0.0.1:7170
STAMP=$(date +%Y%m%d_%H%M%S)
BK=/data/HBJSC/backups

TOK=$(curl -s --max-time 12 -X POST -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' "$B/api/auth/login" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))")
[ -n "$TOK" ] || { echo "❌ 登录失败"; exit 1; }
H="Authorization: Bearer $TOK"

echo "########## 1. 留改动前快照（含原始天数，供回滚）##########"
curl -s --max-time 12 -H "$H" "$B/api/algo-retention" > "$BK/algo_retention_BEFORE_$STAMP.json"
python3 - "$BK/algo_retention_BEFORE_$STAMP.json" <<'PY'
import json,sys,io
d=json.load(io.open(sys.argv[1],encoding='utf-8'))
orig={it['aiType']: it['keepDays'] for it in d.get('items',[])}
print('  原始天数：', orig)
# 生成回滚脚本
lines=['#!/bin/bash','# 回滚到重建前的保留期口径（由 fix_warnings_final.sh 生成）','B=http://127.0.0.1:7170']
lines.append('TOK=$(curl -s -X POST -H "Content-Type: application/json" -d \'{"username":"admin","password":"admin123"}\' $B/api/auth/login | python3 -c "import sys,json;print(json.load(sys.stdin).get(\'token\',\'\'))")')
for k,v in orig.items():
    lines.append('curl -s -o /dev/null -X PUT -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \\')
    lines.append('  -d \'{"aiType":"%s","keepDays":%s,"enabled":true,"remark":"回滚：恢复重建前口径"}\' $B/api/algo-retention' % (k, v))
io.open('/data/HBJSC/backups/rollback_algo_retention.sh','w',encoding='utf-8',newline='\n').write('\n'.join(lines)+'\n')
import os; os.chmod('/data/HBJSC/backups/rollback_algo_retention.sh',0o755)
print('  ✅ 已生成回滚脚本 /data/HBJSC/backups/rollback_algo_retention.sh')
PY

echo
echo "########## 2. 放宽保留期（enabled 保持 true，只放宽天数）##########"
# 天数放宽到 3650 天（约 10 年）——足以覆盖当前历史；生产口径恢复时按 remark 里的原值改回
declare -A ORIG=( ["__default__"]=3 ["__gas__"]=5 ["渣土车冒装"]=7 ["堆头未覆盖"]=2 ["秸秆燃烧"]=2 ["人员入侵"]=3 )
for k in "__default__" "__gas__" "渣土车冒装" "堆头未覆盖" "秸秆燃烧" "人员入侵"; do
  body=$(python3 -c "
import json,sys
k=sys.argv[1]; o=sys.argv[2]
print(json.dumps({'aiType':k,'keepDays':3650,'enabled':True,
  'remark':'重建期放宽（2026-09-30）：原值 %s 天；新数据接入后按原值改回。原口径见 backups/algo_retention_BEFORE_*.json' % o}, ensure_ascii=False))
" "$k" "${ORIG[$k]}")
  curl -s -o /dev/null --max-time 12 -X PUT -H "$H" -H 'Content-Type: application/json' -d "$body" "$B/api/algo-retention"
  echo "    ✅ $k → 3650 天（原 ${ORIG[$k]} 天）"
done

echo
echo "########## 3. 验收 ##########"
cnt(){ curl -s --max-time 12 -H "$H" "$B/api/warnings$1" | python3 -c "
import sys,json
d=json.load(sys.stdin)
a=d if isinstance(d,list) else (d.get('data') if isinstance(d.get('data'),list) else d.get('items'))
print(len(a) if isinstance(a,list) else '-')" 2>/dev/null; }
printf '    %-30s → %s 条\n' '/api/warnings（默认）'        "$(cnt '')"
printf '    %-30s → %s 条\n' '/api/warnings?limit=10'      "$(cnt '?limit=10')"
printf '    %-30s → %s 条\n' '/api/warnings?aggregate=1'   "$(cnt '?aggregate=1')"
printf '    %-30s → %s 条\n' '/api/warnings?status=pending' "$(cnt '?status=pending')"
printf '    %-30s → %s 条\n' '/api/warnings?type=growth5h' "$(cnt '?type=growth5h')"

echo
echo "########## 4. 抽样一条，确认字段完整 ##########"
curl -s --max-time 12 -H "$H" "$B/api/warnings?limit=1" | python3 -c "
import sys,json
d=json.load(sys.stdin)
a=d if isinstance(d,list) else (d.get('data') if isinstance(d.get('data'),list) else d.get('items'))
if a:
    w=a[0]
    for k in ('id','createdAt','status','type','pointName','value','unit','warningLabel','level','source'):
        if k in w: print('    %-14s %s' % (k, str(w[k])[:70]))
else: print('    （空）')"

echo
echo "########## 5. 保留期最终状态 ##########"
curl -s --max-time 12 -H "$H" "$B/api/algo-retention" | python3 -c "
import sys,json
for it in json.load(sys.stdin).get('items',[]):
    print('    %-14s keep=%-6s enabled=%s' % (it['aiType'], it['keepDays'], it['enabled']))"

echo
echo "FIX_WARNINGS_FINAL_DONE"
