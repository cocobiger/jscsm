#!/bin/bash
f=/tmp/iot_app.js

echo "=== Find all url: with common CRUD paths ==="
grep -oP 'url:"[^"]*"' "$f" | sort | uniq | head -60
echo ""
echo "=== Find list/page patterns ==="
grep -oP 'url:"[^"]*(list|page|query|get|fetch)[^"]*"' "$f" | sort | uniq
echo ""
echo "=== Find iot/sip related urls ==="
grep -oP 'url:"[^"]*iot[^"]*"' "$f" | sort | uniq
grep -oP 'url:"[^"]*sip[^"]*"' "$f" | sort | uniq
