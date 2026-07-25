#!/bin/bash
BASE="http://172.16.8.11:6881/prod-api"

# Re-login for fresh token
LOGIN=$(curl -s --connect-timeout 5 -X POST "$BASE/login" \
  -H "Content-Type: application/json" \
  -H "isToken: false" \
  -d '{"username":"iot-video","password":"video@123"}')
TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null)
echo "TOKEN: ${TOKEN:0:40}..."

# Try common REST patterns
echo ""
echo "=== Probing API paths ==="
for path in \
  "/iot/sip/analysisRecord/list" \
  "/iot/sip/analysis-records" \
  "/iot/sip/analysisRecords" \
  "/iot/sip/channelAnalysisRecord" \
  "/iot/sip/analysis/record" \
  "/iot/video/analysisRecord" \
  "/iot/video/analysis-record" \
  "/analysisRecord" \
  "/iot/analysisRecord"; do
  RESP=$(curl -s --connect-timeout 3 "$BASE$path?pageNum=1&pageSize=2" -H "Authorization: Bearer $TOKEN")
  CODE=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('code','?'))" 2>/dev/null || echo "?")
  echo "$CODE $path"
  # Show first 100 chars of non-404 responses
  if ! echo "$RESP" | grep -q '"status":404'; then
    echo "  BODY: ${RESP:0:150}"
  fi
done
