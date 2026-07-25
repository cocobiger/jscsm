#!/bin/bash
BASE="http://172.16.8.11:6881/prod-api"

# Re-login
LOGIN=$(curl -s --connect-timeout 5 -X POST "$BASE/login" \
  -H "Content-Type: application/json" \
  -H "isToken: false" \
  -d '{"username":"iot-video","password":"video@123"}')
TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null)

echo "=== Broad scan under /iot/ ==="
for path in \
  "/iot/sip" \
  "/iot/sip/" \
  "/iot/video" \
  "/iot/video/" \
  "/iot/channel" \
  "/iot/channel/" \
  "/iot/analysis" \
  "/iot/analysis/" \
  "/iot/record" \
  "/iot/record/" \
  "/iot/device/list" \
  "/iot/device/?pageNum=1" \
  "/iot/alarm" \
  "/iot/alarm/" \
  "/iot/event" \
  "/iot/event/"; do

  RESP=$(curl -s --connect-timeout 2 "${BASE}${path}" -H "Authorization: Bearer ${TOKEN}")
  STATUS=$(echo "$RESP" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    s=d.get('status',d.get('code','?'))
    print(s)
except: print('?')
" 2>/dev/null)

  if [ "$STATUS" != "404" ] && [ "$STATUS" != "?" ]; then
    echo "$STATUS $path => ${RESP:0:200}"
    echo ""
  fi
done

echo ""
echo "=== Try /sip/* paths (no /iot prefix) ==="
for path in \
  "/sip/analysisRecord" \
  "/sip/analysisRecord/list" \
  "/sip/analysisrecord" \
  "/sip/analysisrecord/list"; do
  RESP=$(curl -s --connect-timeout 2 "${BASE}${path}?pageNum=1&pageSize=2" -H "Authorization: Bearer ${TOKEN}")
  STATUS=$(echo "$RESP" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    s=d.get('status',d.get('code','?'))
    print(s)
except: print('?')
" 2>/dev/null)
  if [ "$STATUS" != "404" ] && [ "$STATUS" != "?" ]; then
    echo "$STATUS $path => ${RESP:0:200}"
  fi
done
