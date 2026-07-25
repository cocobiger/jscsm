#!/bin/bash
BASE="http://172.16.8.11:6881/prod-api"

# Re-login
LOGIN=$(curl -s --connect-timeout 5 -X POST "$BASE/login" \
  -H "Content-Type: application/json" \
  -H "isToken: false" \
  -d '{"username":"iot-video","password":"video@123"}')
TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null)

# Try paths from screenshot URL pattern + more variations
echo "=== More path patterns ==="
for path in \
  "/video/analysisRecord" \
  "/sip/analysisRecord" \
  "/iot/sip/record" \
  "/iot/video/record" \
  "/iot/channelAnalysisRecord" \
  "/iot/analysis/record/list" \
  "/sip/record" \
  "/channel/analysisRecord"; do
  RESP=$(curl -s --connect-timeout 3 "${BASE}${path}?pageNum=1&pageSize=2&deviceId=5001010000310000001&channelSpid=56331706881318000004" -H "Authorization: Bearer ${TOKEN}")
  SHORT="${RESP:0:120}"
  if echo "$SHORT" | grep -q '"status":404'; then
    echo "404 $path"
  else
    echo "OK  $path => $SHORT"
  fi
done

echo ""
echo "=== Find all static JS files on server ==="
curl -s --connect-timeout 5 "http://172.16.8.11:6881/static/js/" | grep -oP 'href="[^"]+\.js"' | head -30
