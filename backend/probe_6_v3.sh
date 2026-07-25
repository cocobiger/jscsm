#!/bin/bash
streams=(
  "苏商码头  rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=2&subtype=0"
  "九龙沙场  rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=4&subtype=0"
  "龙泗路    rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=5&subtype=0"
  "彼迪      rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=6&subtype=0"
  "万源玻璃  rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=7&subtype=0"
  "华歌      rtsp://berfenrir:xxxxxxxx@172.16.8.51:554/cam/realmonitor?channel=1&subtype=1"
)
for s in "${streams[@]}"; do
  name=$(echo "$s" | awk '{print $1}')
  url=$(echo "$s" | sed 's/^[^ ]* //')
  echo "=== $name ==="
  out=$(timeout 10 ffmpeg -rtsp_transport tcp -i "$url" -t 2 -f null - 2>&1)
  echo "$out" | grep -E "Stream #0:0|Stream #0:1|h264|h265|hevc|Video:|Input |Error|401|Unauthorized|Error opening|RTSP " | head -6
  echo ""
done
