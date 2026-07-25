#!/usr/bin/env python3
"""
transcoder_v2 部署脚本
在 index.js 上做 3 处精准替换，将硬编码白名单升级为自动探测模式
"""
import re, os, shutil

INDEX_JS = '/opt/jsc/backend/index.js'
BACKUP = '/opt/jsc/backend/index.js.bak_v1'

# 备份
shutil.copy2(INDEX_JS, BACKUP)
print('[1/4] 已备份原文件 ->', BACKUP)

with open(INDEX_JS, 'r', encoding='utf-8') as f:
    content = f.read()

mod_count = 0

# ===== 修改 1：替换 require 路径 =====
old1 = "require('./transcoder')"
new1 = "require('./transcoder_v2')"
if old1 in content:
    content = content.replace(old1, new1)
    print('[2/4] 已替换 require 路径: transcoder -> transcoder_v2')
    mod_count += 1
else:
    print('[2/4] WARN: 未找到 require("./transcoder")')

# ===== 修改 2：stream/start handler 加入智能探测 =====
# 定位: const rewritten = transcoder.rewriteStreamUrl(id, url)
# 替换为自动探测逻辑
old2 = """    // H.265 透明转码：白名单内的流已由 transcoder worker 转码为 H.264 并推到 jsc_h264 app，
    // 直接拿 jsc_h264 副本的播放 URL（流已在 ZLM 中，零成本），不重复 addStreamProxy
    const rewritten = transcoder.rewriteStreamUrl(id, url)
    if (rewritten.needTranscode) {
      const directUrls = transcoder.buildDirectPlayUrls(id)
      if (directUrls) {
        log.info('H.265 透明转码: ' + id + ' -> ' + rewritten.transcodeId + ' (走 jsc_h264 副本)')
        return res.json({ ok: true, engine: 'zlm-transcoded', transcoded: true, transcodeId: rewritten.transcodeId, flvUrl: directUrls.flv, ...directUrls })
      }
    }
    try {
      const urls = await zlm.addStreamProxy(id, rewritten.url)"""

new2 = """    // v2 动态转码：已注册的流直接走 jsc_h264 副本
    if (transcoder.needTranscode(id)) {
      const directUrls = transcoder.buildDirectPlayUrls(id)
      if (directUrls) {
        log.info('H.265 透明转码 (已注册): ' + id)
        return res.json({ ok: true, engine: 'zlm-transcoded', flvUrl: directUrls.flv, ...directUrls })
      }
    }
    // 未注册 → 自动探测编码 + 智能注册（替代硬编码白名单）
    let autoRegistered = false
    try {
      const result = await transcoder.smartAdd(id, url)
      if (result.needTranscode) {
        autoRegistered = true
        const directUrls = transcoder.buildDirectPlayUrls(id)
        if (directUrls) {
          log.info('H.265 透明转码 (自动探测注册): ' + id + ' codec=' + result.codec + ' probe=' + result.probeTimeMs + 'ms')
          return res.json({ ok: true, engine: 'zlm-transcoded', autoDetected: true, probeTimeMs: result.probeTimeMs, flvUrl: directUrls.flv, ...directUrls })
        }
      }
    } catch (e) {
      log.warn('智能探测失败，走普通拉流: ' + id + ' ' + e.message)
    }
    // 兜底：普通 ZLM 拉流代理（H.264 或探测失败）
    try {
      const rewritten = transcoder.rewriteStreamUrl(id, url)
      const urls = await zlm.addStreamProxy(id, rewritten.url)"""

if old2 in content:
    content = content.replace(old2, new2)
    print('[3/4] 已替换 stream/start handler: 加入自动探测 + 动态注册')
    mod_count += 1
else:
    print('[3/4] WARN: 未匹配 stream/start handler 代码块')
    # 找一下实际代码
    idx = content.find('const rewritten = transcoder.rewriteStreamUrl')
    if idx > 0:
        print('  实际位置:', idx, '\n  周围:\n', content[max(0,idx-100):idx+200])

# ===== 修改 3：简化启动代码 =====
old3_start = '  transcoder.init({ log, zlm, dataDir: DATA_DIR })\n  const h265Sources = ['
idx3 = content.find(old3_start)
if idx3 > 0:
    # 找到 h265Sources 定义的结束位置（']' 后跟换行和 transcoder.startAll）
    end_marker = '  ]\n  transcoder.startAll(h265Sources)'
    idx_end = content.find(end_marker, idx3)
    if idx_end > 0:
        # 替换整个块
        new3 = """  transcoder.init({ log, zlm, dataDir: DATA_DIR })
  // v2: 从 transcoder.json 自动恢复所有已注册的 H.265 转码流（无需硬编码 h265Sources）
  transcoder.startAll().catch(e => log.error('transcoder 启动失败: ' + e.message))"""
        content = content[:idx3] + new3 + content[idx_end + len(end_marker):]
        print('[4/4] 已替换 h265Sources 硬编码为动态恢复')
        mod_count += 1
    else:
        print('[4/4] WARN: 找到 h265Sources 起始但未找到结束')
else:
    # 尝试备用模式
    print('[4/4] WARN: 未找到 h265Sources 硬编码块')

with open(INDEX_JS, 'w', encoding='utf-8') as f:
    f.write(content)

print(f'\n=== 完成: {mod_count}/3 处修改 ===')
if mod_count == 3:
    print('✅ 所有修改成功，可以重启服务')
else:
    print(f'⚠️  部分修改未匹配，请检查')
