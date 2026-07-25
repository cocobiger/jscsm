#!/bin/bash
BASE="http://172.16.8.11:6881"
PBASE="${BASE}/prod-api"

# Re-login
LOGIN=$(curl -s --connect-timeout 5 -X POST "${PBASE}/login" \
  -H "Content-Type: application/json" \
  -H "isToken: false" \
  -d '{"username":"iot-video","password":"video@123"}')
TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null)

echo "=== Check for Swagger/API docs ==="
for path in \
  "/swagger-ui.html" "/swagger-ui/" "/swagger-resources" "/v2/api-docs" \
  "/v3/api-docs" "/doc.html" "/swagger-ui/index.html" \
  "/prod-api/swagger-ui.html" "/prod-api/v2/api-docs" \
  "/prod-api/v3/api-docs"; do
  CODE=$(curl -s --connect-timeout 2 -o /dev/null -w "%{http_code}" "${BASE}${path}")
  echo "$CODE $path"
done

echo ""
echo "=== Try Spring Actuator ==="
for path in \
  "/actuator" "/actuator/mappings" "/actuator/env" \
  "/prod-api/actuator" "/prod-api/actuator/mappings"; do
  CODE=$(curl -s --connect-timeout 2 -o /dev/null -w "%{http_code}" "${BASE}${path}")
  [ "$CODE" != "404" ] && echo "$CODE $path"
done

echo ""
echo "=== Direct JS grep for all string literals containing / ==="
# Search for any path-like strings in app.js that contain 'record' or 'anal'
python3 << 'PYEOF'
import re, json

with open('/tmp/iot_app.js', 'r', errors='ignore') as f:
    content = f.read()

# Find all quoted strings that look like URL paths (start with /)
paths = re.findall(r'"(/[^"]{3,60})"', content)
# Filter for interesting ones
interesting = []
for p in paths:
    plower = p.lower()
    if any(k in plower for k in ['record', 'anal', 'sip', 'video', 'image', 'capture', 'detect', 'alarm', 'event', 'ai', 'smart', 'result']):
        interesting.append(p)

print(f"Found {len(interesting)} interesting path strings:")
for p in sorted(set(interesting)):
    print(f"  {p}")
PYEOF
