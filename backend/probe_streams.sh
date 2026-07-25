#!/bin/bash
# Probe encoding of all jsc app streams
for sid in sqs45b3 sk91qjp s2xqr8g s9gt5zu smjmr1g sqs45b4 sapsegv s2xqr8f snh9lsu; do
    echo -n "jsc/$sid: "
    timeout 6 ffmpeg -i "http://172.17.0.2/jsc/$sid/hls.m3u8" -t 3 -f null - 2>&1 | grep -oE 'Video: [a-z0-9]+' | head -1
done
