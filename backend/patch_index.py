import sys
path = '/opt/jsc/backend/index.js'
with open(path, 'r', encoding='utf-8') as f:
    src = f.read()

old = (
    "  // 优先用 ZLMediaKit 拉流代理（已配置 secret 时）\n"
    "  if (zlm.getConfig().configured) {\n"
    "    try {\n"
    "      const urls = await zlm.addStreamProxy(id, url)\n"
    "      log.info(`ZLM 拉流代理已建立 [${id}]`)"
)

new = (
    "  // 优先用 ZLMediaKit 拉流代理（已配置 secret 时）\n"
    "  if (zlm.getConfig().configured) {\n"
    "    try {\n"
    "      // H.265 透明转码：白名单内的流由 transcoder worker 已转码为 H.264 并推入 jsc_h264 app，\n"
    "      // 此处把 addStreamProxy 的 url 重写为 ZLM 内部 RTMP（jsc_h264 副本），对调用方完全透明\n"
    "      const rewritten = transcoder.rewriteStreamUrl(id, url)\n"
    "      if (rewritten.needTranscode) {\n"
    "        log.info('H.265 透明转码: ' + id + ' -> ' + rewritten.transcodeId + ' (走 jsc_h264 副本)')\n"
    "      }\n"
    "      const urls = await zlm.addStreamProxy(id, rewritten.url)\n"
    "      log.info('ZLM 拉流代理已建立 [' + id + ']')\n"
    "      if (rewritten.needTranscode) urls.transcoded = true"
)

if old not in src:
    print('ERR: old block not found')
    sys.exit(1)
src = src.replace(old, new, 1)
with open(path, 'w', encoding='utf-8') as f:
    f.write(src)
print('OK')
