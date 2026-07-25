#!/bin/bash
BASE="http://172.16.8.11:6881/prod-api"

# Re-login
LOGIN=$(curl -s --connect-timeout 5 -X POST "$BASE/login" \
  -H "Content-Type: application/json" \
  -H "isToken: false" \
  -d '{"username":"iot-video","password":"video@123"}')
TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null)

# Search app.js for dynamic URL construction near "record"
echo "=== Search for dynamic URL patterns ==="
python3 -c "
import re
with open('/tmp/iot_app.js', 'r', errors='ignore') as f:
    content = f.read()

# Find patterns like url: variable + 'something' or url: \`template\`
patterns = re.findall(r'.{0,100}(?:record|Record).{0,100}', content)
for p in patterns[:20]:
    if 'url' in p.lower() or 'api' in p.lower() or '/prod' in p or 'get\|post' in p.lower():
        print(p)
        print('---')
"

echo ""
echo "=== Try RuoYi-style CRUD generator paths ==="
for path in \
  "/iot/sip/analysisrecord" \
  "/iot/sip/analysisrecords" \
  "/iot/sipAnalysisRecord/list" \
  "/iot/sipAnalysisRecord" \
  "/sip/analysisrecord/list" \
  "/sipAnalysisRecord/list"; do
  RESP=$(curl -s --connect-timeout 3 "${BASE}${path}?pageNum=1&pageSize=2" -H "Authorization: Bearer ${TOKEN}")
  if ! echo "$RESP" | grep -q '"status":404'; then
    echo "FOUND: $path => ${RESP:0:200}"
  fi
done

echo ""
echo "=== List all JS chunks ==="
curl -s "http://172.16.8.11:6881/" | grep -oP 'src="[^"]+\.js"' | sort -u
