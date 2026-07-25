#!/bin/bash
BASE="http://172.16.8.11:6881"
TOKEN="eyJhbGciOiJIUzUxMiJ9.eyJsb2dpbl91c2VyX2tleSI6ImY3MDFlYTEwLTJmZjMtNDdkYy04ODk5LWIwNDA4ODk1MGQwYyJ9.noSJFcJ2SqWarPVXQ0S6iJBtUeGqlLdIR6ehyDA3GnUQjSMvGAUM_DqrbgcJDNYSKvo7P-gUtyH6dU8Gl1dnJg"

echo "=== Download analysisRecord chunk ==="
curl -s --connect-timeout 5 "$BASE/static/js/chunk-322f7d0e.js" -o /tmp/iot_chunk.js
wc -c /tmp/iot_chunk.js

echo ""
echo "=== Find API URLs in chunk ==="
grep -oP 'url:"[^"]+"' /tmp/iot_chunk.js | head -20
echo ""
grep -oP '"url"\s*:\s*"[^"]+"' /tmp/iot_chunk.js | head -20

echo ""
echo "=== Find all string URLs containing record/anal ==="
grep -oP '"[^"]*(record|anal|Record|Anal)[^"]*"' /tmp/iot_chunk.js | head -20
