#!/bin/bash
f=/tmp/iot_app.js

echo "=== Find all API url: patterns near analysisRecord ==="
grep -oP '.{0,120}analysisRecord.{0,30}' "$f" | head -10
echo "===END==="
echo ""

echo "=== Find all function calls with URL params ==="
grep -oP '\{url:"[^"]*record[^"]*"' "$f"
echo ""
grep -oP '\{url:"[^"]*anal[^"]*"' "$f"
echo ""

echo "=== Find all prod-api paths ==="
grep -oP '"\/prod-api[^"]*"' "$f" | sort | uniq | head -40
