#!/bin/bash
f=/tmp/iot_app.js

echo "=== Search analysisRecord related URL paths ==="
grep -oP '.{0,80}analysisRecord.{0,80}' "$f" | grep -iP '(url|path|api|get|post|put)' | head -20
echo ""

echo "=== All /prod-api style URLs with sip ==="
grep -oP '"[^"]*sip[^"]*"' "$f" | head -30
echo ""

echo "=== Find Vue component route for analysisRecord ==="
grep -oP '.{0,60}analysisRecord.{0,60}' "$f" | head -15
