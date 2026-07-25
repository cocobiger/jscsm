#!/bin/bash
BASE="http://172.16.8.11:6881/prod-api"

# Re-login
LOGIN=$(curl -s --connect-timeout 5 -X POST "$BASE/login" \
  -H "Content-Type: application/json" \
  -H "isToken: false" \
  -d '{"username":"iot-video","password":"video@123"}')
TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null)

echo "=== Found base: /iot/device/analysisRecord ==="
echo "Trying CRUD variations..."

for method_path in \
  "GET:/iot/device/analysisRecord/list?pageNum=1&pageSize=5" \
  "GET:/iot/device/analysisRecord?pageNum=1&pageSize=5" \
  "GET:/iot/device/analysisRecords?pageNum=1&pageSize=5" \
  "POST:/iot/device/analysisRecord/list" \
  "POST:/iot/device/analysisRecord/query" \
  "GET:/iot/device/analysisRecord/queryList?pageNum=1&pageSize=5" \
  "GET:/iot/device/channelAnalysisRecord/list?pageNum=1&pageSize=5" \
  "GET:/iot/device/analysisRecord/page?pageNum=1&pageSize=5"; do

  METHOD="${method_path%%:*}"
  PATH_URL="${method_path#*:}"

  RESP=$(curl -s --connect-timeout 3 -X "$METHOD" "${BASE}${PATH_URL}" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json")

  STATUS=$(echo "$RESP" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print(d.get('status', d.get('code', '?')))
except: print('?')
" 2>/dev/null)

  if [ "$STATUS" != "404" ] && [ "$STATUS" != "?" ]; then
    echo "$METHOD $PATH_URL => status=$STATUS"
    echo "  ${RESP:0:300}"
    echo ""
  fi
done

echo ""
echo "=== Also try with device+channel params ==="
curl -s --connect-timeout 3 "${BASE}/iot/device/analysisRecord/list?pageNum=1&pageSize=3&deviceId=5001010000310000001&channelSpid=56331706881318000004" \
  -H "Authorization: Bearer ${TOKEN}" | python3 -m json.tool 2>/dev/null | head -40
