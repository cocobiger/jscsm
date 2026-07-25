#!/bin/bash
BASE="http://172.16.8.11:6881/prod-api"

# Re-login
LOGIN=$(curl -s --connect-timeout 5 -X POST "$BASE/login" \
  -H "Content-Type: application/json" \
  -H "isToken: false" \
  -d '{"username":"iot-video","password":"video@123"}')
TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null)

echo "=== Try POST /iot/event with query ==="
curl -s --connect-timeout 5 -X POST "${BASE}/iot/event" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"pageNum":1,"pageSize":5,"deviceId":"5001010000310000001","channelSpid":"56331706881318000004"}' | python3 -m json.tool 2>/dev/null | head -60

echo ""
echo "=== Scan more /iot/* list endpoints ==="
for path in \
  "/iot/sip/list" \
  "/iot/channel/list" \
  "/iot/video/list" \
  "/iot/analysis/list" \
  "/iot/alarm/list" \
  "/iot/alert/list" \
  "/iot/log/list" \
  "/iot/message/list" \
  "/iot/notice/list" \
  "/iot/task/list"; do

  RESP=$(curl -s --connect-timeout 2 "${BASE}${path}?pageNum=1&pageSize=2" -H "Authorization: Bearer ${TOKEN}")
  STATUS=$(echo "$RESP" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    s=d.get('status',d.get('code','?'))
    print(s)
except: print('?')
" 2>/dev/null)
  if [ "$STATUS" = "200" ]; then
    echo "200 $path => ${RESP:0:250}"
    echo ""
  fi
done

echo ""
echo "=== Deep scan: all paths returning 200 under /iot/ ==="
for path in $(echo '
/iot/list /iot/device/list /iot/sip/list /iot/sipChannel/list
/iot/channelList /iot/deviceChannel/list /iot/device-channel/list
/iot/record/list /iot/recordList /iot/analysisRecord/list
/iot/analysis/list /iot/analysislist /iot/aiRecord/list
/iot/detection/list /iot/detectResult/list
/iot/capture/list /iot/snapshot/list
'); do
  RESP=$(curl -s --connect-timeout 2 "${PATH:-}${BASE}${path}?pageNum=1&pageSize=1" -H "Authorization: Bearer ${TOKEN}" 2>/dev/null)
  if echo "$RESP" | grep -q '"total"'; then
    echo "DATA $path => total found!"
  fi
done
