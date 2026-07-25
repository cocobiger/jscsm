#!/bin/bash
BASE="http://172.16.8.11:6881/prod-api"

# Re-login
LOGIN=$(curl -s --connect-timeout 5 -X POST "$BASE/login" \
  -H "Content-Type: application/json" \
  -H "isToken: false" \
  -d '{"username":"iot-video","password":"video@123"}')
TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null)

echo "=== Scan /iot/sip/* endpoints ==="
for path in \
  "/iot/sip/list" \
  "/iot/sip/channel/list" \
  "/iot/sip/device/list" \
  "/iot/sip/record/list" \
  "/iot/sip/analysis/list" \
  "/iot/sip/analysisrecord/list" \
  "/iot/sip/analysisRecord/list" \
  "/iot/sip/alarm/list" \
  "/iot/sip/alert/list" \
  "/iot/sip/event/list" \
  "/iot/sip/log/list" \
  "/iot/sip/task/list" \
  "/iot/sip/result/list" \
  "/iot/sip/capture/list" \
  "/iot/sip/detect/list" \
  "/iot/sip/detection/list" \
  "/iot/sip/image/list"; do

  RESP=$(curl -s --connect-timeout 2 "${BASE}${path}?pageNum=1&pageSize=2" -H "Authorization: Bearer ${TOKEN}")
  if echo "$RESP" | grep -q '"total"'; then
    TOTAL=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('total',0))")
    echo "DATA($TOTAL) $path"
    if [ "$TOTAL" -gt 0 ]; then
      echo "  ${RESP:0:400}"
    fi
    echo ""
  fi
done

echo ""
echo "=== Also try /sip/* (no /iot prefix) ==="
for path in \
  "/sip/list" "/sip/analysisRecord/list" "/sip/record/list" \
  "/sip/alert/list" "/sip/alarm/list" "/sip/event/list"; do
  RESP=$(curl -s --connect-timeout 2 "${BASE}${path}?pageNum=1&pageSize=2" -H "Authorization: Bearer ${TOKEN}")
  if echo "$RESP" | grep -q '"total"'; then
    TOTAL=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('total',0))")
    echo "DATA($TOTAL) $path"
  fi
done
