#!/bin/bash
BASE="http://172.16.8.11:6881/prod-api"

echo "=== LOGIN ==="
LOGIN=$(curl -s --connect-timeout 5 -X POST "$BASE/login" \
  -H "Content-Type: application/json" \
  -H "isToken: false" \
  -d '{"username":"iot-video","password":"video@123"}')
echo "$LOGIN"
echo ""

# Extract token
TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token','') or d.get('data',{}).get('token',''))" 2>/dev/null)
echo "=== TOKEN (first 60 chars) ==="
echo "${TOKEN:0:60}"
echo ""

if [ -n "$TOKEN" ]; then
  echo "=== ANALYSIS RECORD (list) ==="
  curl -s --connect-timeout 5 "$BASE/iot/sip/analysisRecord?deviceId=5001010000310000001&channelSpid=56331706881318000004&pageNum=1&pageSize=5" \
    -H "Authorization: Bearer $TOKEN" | python3 -m json.tool 2>/dev/null | head -120
  
  echo ""
  echo "=== TRY WITHOUT PARAMS ==="
  curl -s --connect-timeout 5 "$BASE/iot/sip/analysisRecord?pageNum=1&pageSize=3" \
    -H "Authorization: Bearer $TOKEN" | python3 -m json.tool 2>/dev/null | head -80
fi
