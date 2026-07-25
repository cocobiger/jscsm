#!/bin/bash
BASE="http://172.16.8.11:6881"
f=/tmp/iot_app.js

echo "=== Extract all chunk file references ==="
python3 -c "
import re
with open('$f', 'r') as f:
    content = f.read()
# Find all chunk filenames like chunk-xxxxxxx.js
chunks = set(re.findall(r'chunk-[a-f0-9]+\.js', content))
for c in sorted(chunks):
    print(c)
"

echo ""
echo "=== Download each chunk and search for 'record' URLs ==="
for chunk in $(python3 -c "
import re
with open('/tmp/iot_app.js','r') as f:
    content = f.read()
chunks = set(re.findall(r'chunk-[a-f0-9]+\.js', content))
for c in sorted(chunks): print(c)
"); do
  curl -s --connect-timeout 3 "${BASE}/static/js/${chunk}" -o "/tmp/chunk_${chunk}" 2>/dev/null
  SIZE=$(wc -c < "/tmp/chunk_${chunk}")
  if [ "$SIZE" -gt 35000 ]; then
    echo "--- $chunk ($SIZE bytes) ---"
    grep -oP 'url:"[^"]*"' "/tmp/chunk_${chunk}" | head -5
    grep -oP '"[^"]*(?:record|Record|anal)[^"]*"' "/tmp/chunk_${chunk}" | head -10
  fi
done
