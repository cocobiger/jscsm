#!/bin/bash
# 探测6个RTSP流的编码格式
streams=(
  "苏商码头 ch2  rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=2&subtype=0"
  "九龙沙场 ch4  rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=4&subtype=0"
  "龙泗路 ch5    rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=5&subtype=0"
  "彼迪 ch6      rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=6&subtype=0"
  "万源玻璃 ch7  rtsp://berfenrir:xxxxxxxx@172.16.8.50:554/cam/realmonitor?channel=7&subtype=0"
  "华歌 ch1      rtsp://berfenrir:xxxxxxxx@172.16.8.51:554/cam/realmonitor?channel=1&subtype=1"
)
for s in "${streams[@]}"; do
  name=$(echo "$s" | awk '{print $1}')
  url=$(echo "$s" | sed 's/^[^ ]* [^ ]* //')
  echo "=== $name ==="
  timeout 6 ffmpeg -rtsp_transport tcp -i "$url" -t 2 -f null - 2>&1 | grep -E 'Stream #0:0|Stream #0:1|Video:|Input' | head -4
  echo ""
done
