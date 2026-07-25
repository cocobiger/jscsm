#!/bin/bash
BASE="http://172.16.8.11:6881/prod-api"

# Re-login
LOGIN=$(curl -s --connect-timeout 5 -X POST "$BASE/login" \
  -H "Content-Type: application/json" \
  -H "isToken: false" \
  -d '{"username":"iot-video","password":"video@123"}')
TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null)

echo "=== Massive broad scan of all likely endpoint names ==="
for name in \
  analysisRecord analysisrecord analysis_record AnalysisRecord \
  sipRecord siprecord sip_record SipRecord \
  channelRecord channelrecord channel_record ChannelRecord \
  videoRecord videorecord video_record VideoRecord \
  aiRecord airecord ai_record AiRecord \
  detectResult detectresult detect_result DetectResult \
  alarmRecord alarmrecord alarm_record AlarmRecord \
  captureRecord capturerecord capture_record CaptureRecord \
  snapshot Snapshot snap Shot \
  recognition Recognition detect Detect \
  imageRecord imagerecord image_record ImageRecord; do

  # Try /iot/{name}/list and /{name}/list
  for prefix in "/iot/" "/"; do
    path="${prefix}${name}/list"
    RESP=$(curl -s --connect-timeout 1 "${BASE}${path}?pageNum=1&pageSize=1" -H "Authorization: Bearer ${TOKEN}" 2>/dev/null)
    if echo "$RESP" | grep -q '"total"'; then
      TOTAL=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('total',0))" 2>/dev/null)
      echo "*** FOUND total=$TOTAL: $path ***"
      if [ "$TOTAL" -gt 0 ]; then
        echo "${RESP:0:500}"
      fi
      echo ""
    fi
  done
done

echo "Scan complete."
