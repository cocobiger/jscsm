#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""修复：zlm-watcher mirrorToOurZlm 的 enable_hls=0 → 1
根因：addStreamProxy 显式 enable_hls=0 关掉 HLS，导致 sikong_ 流 hls.m3u8 404
（straw_bbox 是 ffmpeg 推流默认生成 HLS 不受影响，sikong_ proxy 拉流被关掉 HLS）
修复：enable_hls=1 让 sikong_ 流也生成 HLS（弹窗才能播原流 30fps）
"""
p = '/opt/jsc/dji-openapi/lib/zlm-watcher.js'
s = open(p, encoding='utf-8').read()

old = "`&url=${encodeURIComponent(srcUrl)}&retry_count=0&enable_hls=0&enable_mp4=0`"
new = "`&url=${encodeURIComponent(srcUrl)}&retry_count=0&enable_hls=1&enable_mp4=0`"

assert old in s, '未找到 enable_hls=0 行'
s = s.replace(old, new, 1)
open(p, 'w', encoding='utf-8').write(s)
print('zlm-watcher enable_hls 0→1 已改')
