import sys
path = '/opt/jsc/backend/index.js'
with open(path, 'r', encoding='utf-8') as f:
    src = f.read()
old = (
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
    "      if (rewritten.needTranscode) urls.transcoded = true\n"
    "      return res.json({ ok: true, engine: 'zlm', flvUrl: urls.flv, ...urls })\n"
    "    } catch (e) {\n"
    "      log.warn(`ZLM 拉流失败 [${id}]: ${e.message}，降级 ffmpeg`)\n"
    "      // 落到下面 ffmpeg 降级\n"
    "    }\n"
    "  }\n"
)
new = (
    "  // 优先用 ZLMediaKit 拉流代理（已配置 secret 时）\n"
    "  if (zlm.getConfig().configured) {\n"
    "    // H.265 透明转码：白名单内的流已由 transcoder worker 转码为 H.264 并推到 jsc_h264 app，\n"
    "    // 直接拿 jsc_h264 副本的播放 URL（流已在 ZLM 中，零成本），不重复 addStreamProxy\n"
    "    const rewritten = transcoder.rewriteStreamUrl(id, url)\n"
    "    if (rewritten.needTranscode) {\n"
    "      const directUrls = transcoder.buildDirectPlayUrls(id)\n"
    "      if (directUrls) {\n"
    "        log.info('H.265 透明转码: ' + id + ' -> ' + rewritten.transcodeId + ' (走 jsc_h264 副本)')\n"
    "        return res.json({ ok: true, engine: 'zlm-transcoded', transcoded: true, transcodeId: rewritten.transcodeId, flvUrl: directUrls.flv, ...directUrls })\n"
    "      }\n"
    "    }\n"
    "    try {\n"
    "      const urls = await zlm.addStreamProxy(id, rewritten.url)\n"
    "      log.info('ZLM 拉流代理已建立 [' + id + ']')\n"
    "      if (rewritten.needTranscode) urls.transcoded = true\n"
    "      return res.json({ ok: true, engine: 'zlm', flvUrl: urls.flv, ...urls })\n"
    "    } catch (e) {\n"
    "      log.warn(`ZLM 拉流失败 [${id}]: ${e.message}，降级 ffmpeg`)\n"
    "      // 落到下面 ffmpeg 降级\n"
    "    }\n"
    "  }\n"
)
if old in src:
    src = src.replace(old, new, 1)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(src)
    print('OK')
else:
    print('NOT FOUND')
    sys.exit(1)
