#!/bin/bash
BASE="http://172.16.8.11:6881/prod-api"

# Re-login for fresh token
LOGIN=$(curl -s --connect-timeout 5 -X POST "$BASE/login" \
  -H "Content-Type: application/json" \
  -H "isToken: false" \
  -d '{"username":"iot-video","password":"video@123"}')
TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null)
echo "TOKEN_OK: $([ -n "$TOKEN" ] && echo YES || echo NO)"

# Try common REST patterns - just output raw response head
echo ""
for path in \
  "/iot/sip/analysisRecord/list" \
  "/iot/sip/analysis-records" \
  "/iot/sip/analysisRecords" \
  "/iot/sip/channelAnalysisRecord" \
  "/iot/video/analysisRecord" \
  "/analysisRecord" \
  "/iot/analysisRecord"; do
  RESP=$(curl -s --connect-timeout 3 "${BASE}${path}?pageNum=1&pageSize=2" -H "Authorization: Bearer ${TOKEN}")
  echo "--- $path ---"
  echo "${RESP:0:200}"
  echo ""
done
