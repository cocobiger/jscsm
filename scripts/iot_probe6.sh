#!/bin/bash
BASE="http://172.16.8.11:6881/prod-api"

# Re-login
LOGIN=$(curl -s --connect-timeout 5 -X POST "$BASE/login" \
  -H "Content-Type: application/json" \
  -H "isToken: false" \
  -d '{"username":"iot-video","password":"video@123"}')
TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null)

# Try many more path variations based on i18n key: sip.analysisRecord
echo "=== Comprehensive path scan ==="
for path in \
  "/iot/sip/analysisrecord" \
  "/iot/sip/analysisrecord/list" \
  "/sip/analysisrecord" \
  "/sip/analysisrecord/list" \
  "/iot/sipAnalysisRecord" \
  "/iot/sipAnalysisRecord/list" \
  "/sipAnalysisRecord" \
  "/sipAnalysisRecord/list" \
  "/iot/sip/analysis-record" \
  "/iot/sip/analysis-record/list" \
  "/iot/channel/analysisRecord" \
  "/iot/channel/analysisRecord/list" \
  "/video/sip/analysisRecord" \
  "/iot/video/sip/analysisRecord" \
  "/iot/device/analysisRecord"; do
  RESP=$(curl -s --connect-timeout 2 "${BASE}${path}?pageNum=1&pageSize=2" -H "Authorization: Bearer ${TOKEN}")
  if echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('status')==404 else 1)" 2>/dev/null; then
    : # skip 404
  else
    echo "HIT: $path"
    echo "     ${RESP:0:250}"
    echo ""
  fi
done

echo "Done scanning."
