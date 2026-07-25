#!/bin/bash
BASE="http://172.16.8.11:6881/prod-api"

# Re-login
LOGIN=$(curl -s --connect-timeout 5 -X POST "${BASE}/login" \
  -H "Content-Type: application/json" \
  -H "isToken: false" \
  -d '{"username":"iot-video","password":"video@123"}')
TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null)
echo "Token: ${TOKEN:0:40}..."

echo ""
echo "=== ANALYSIS RECORD LIST ==="
curl -s --connect-timeout 10 "${BASE}/sip/analyse/record/list?pageNum=1&pageSize=5&channelSpid=56331706881318000004&deviceId=5001010000310000001" \
  -H "Authorization: Bearer ${TOKEN}" | python3 -m json.tool 2>/dev/null

echo ""
echo "=== ALL RECORDS (no filter) ==="
curl -s --connect-timeout 10 "${BASE}/sip/analyse/record/list?pageNum=1&pageSize=3" \
  -H "Authorization: Bearer ${TOKEN}" | python3 -m json.tool 2>/dev/null

echo ""
echo "=== SINGLE RECORD (first) ==="
# Get first record ID
FIRST_ID=$(curl -s --connect-timeout 10 "${BASE}/sip/analyse/record/list?pageNum=1&pageSize=1&channelSpid=56331706881318000004" \
  -H "Authorization: Bearer ${TOKEN}" | python3 -c "
import sys,json
d=json.load(sys.stdin)
rows=d.get('rows',[])
if rows:
    r=rows[0]
    print(r.get('id',r.get('recordId','?')))
    print('---FULL RECORD---')
    import json as j
    print(j.dumps(r, indent=2, ensure_ascii=False))
else:
    print('NO_RECORDS')
" 2>/dev/null)
