#!/bin/bash
BASE="http://172.16.8.11:6881"
PBASE="${BASE}/prod-api"

# Re-login
LOGIN=$(curl -s --connect-timeout 5 -X POST "${PBASE}/login" \
  -H "Content-Type: application/json" \
  -H "isToken: false" \
  -d '{"username":"iot-video","password":"video@123"}')
TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null)

echo "=== Get Swagger v2 API docs ==="
curl -s --connect-timeout 10 "${PBASE}/v2/api-docs" | python3 -c "
import sys, json
d = json.load(sys.stdin)
paths = d.get('paths', {})
print(f'Total endpoints: {len(paths)}')
print()
# Find anything related to analysis/record/sip/video/image
for path in sorted(paths.keys()):
    plower = path.lower()
    if any(k in plower for k in ['record', 'anal', 'sip', 'image', 'capture', 'detect', 'ai', 'smart', 'result', 'snapshot']):
        methods = list(paths[path].keys())
        print(f'  {path} => {methods}')
print()
# Also show ALL /iot/* paths
print('=== All /iot/* endpoints ===')
for path in sorted(paths.keys()):
    if path.startswith('/iot/'):
        methods = list(paths[path].keys())
        summary = ''
        for m in methods:
            s = paths[path][m].get('summary','')
            if s: summary = f' ({s})'
        print(f'  {m.upper():4} {path}{summary}')
" 2>&1
