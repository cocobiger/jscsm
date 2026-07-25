#!/bin/bash
BASE="http://172.16.8.11:6881"
TOKEN="eyJhbGciOiJIUzUxMiJ9.eyJsb2dpbl91c2VyX2tleSI6ImY3MDFlYTEwLTJmZjMtNDdkYy04ODk5LWIwNDA4ODk1MGQwYyJ9.noSJFcJ2SqWarPVXQ0S6iJBtUeGqlLdIR6ehyDA3GnUQjSMvGAUM_DqrbgcJDNYSKvo7P-gUtyH6dU8Gl1dnJg"

# Try common REST patterns for the analysis record API
echo "=== Trying common REST patterns ==="
for path in \
  "/prod-api/iot/sip/analysisRecord/list" \
  "/prod-api/iot/sip/analysis-records" \
  "/prod-api/iot/sip/analysisRecords" \
  "/prod-api/iot/sip/channelAnalysisRecord" \
  "/prod-api/iot/sip/analysis/record" \
  "/prod-api/iot/video/analysisRecord" \
  "/prod-api/iot/video/analysis-record" \
  "/prod-api/analysisRecord" \
  "/prod-api/iot/analysisRecord"; do
  code=$(curl -s --connect-timeout 3 -o /dev/null -w "%{http_code}" "$path" -H "Authorization: Bearer $TOKEN")
  echo "$code $path"
done
