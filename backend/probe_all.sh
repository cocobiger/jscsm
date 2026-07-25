#!/bin/bash
# Probe all jsc app streams for encoding
for sid in sqs45b3 sk91qjp s2xqr8g s9gt5zu smjmr1g sqs45b4 sapsegv s2xqr8f snh9lsu; do
    out=$(timeout 6 ffmpeg -i "http://172.17.0.2/jsc/$sid/hls.m3u8" -t 3 -f null - 2>&1 | grep -oE 'Video: [a-z0-9]+' | head -1)
    out2=$(timeout 6 ffmpeg -i "http://172.17.0.2/jsc/$sid/hls.m3u8" -t 3 -f null - 2>&1 | grep -oE '[0-9]+x[0-9]+' | head -1)
    echo "$sid : $out  ${out2}"
done
