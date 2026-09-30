/**
 * 告警实时推送（SSE）· 2026-09-14 整改 #2.1
 *
 * 背景：驾驶舱"实时告警"原先只靠前端 10s 轮询（最坏 10s 延迟）。
 * 现后端在 insertWarning 后即广播，前端 EventSource 订阅 → 延迟 <1s；
 * 轮询降级为 60s 兜底（双轨，SSE 断线/被代理缓冲时不至于"全瞎"）。
 *
 * 复用 drone-events.js 的 SSE 基建经验（2026-09-03 缺陷②修复）：
 *   心跳必须发「数据帧」而非注释行 —— 注释行不触发浏览器 onmessage，
 *   前端看门狗无法喂狗会把健康空闲连接误判半死强重建。
 */
const KEEPALIVE_MS = 25000

const clients = new Set()   // { res, alive }

/** 广播一条告警（入库后由 store.onWarningInsert 触发） */
function broadcastWarning(w) {
  if (clients.size === 0) return 0
  // 🔴 2026-09-17 P0-2b：低于门限的分析记录（gatePassed=false）不推送。
  //   前端收到 SSE 只是**触发一次重新拉取**（onmessage → re()，1s 节流），
  //   而实时告警列表已排除这批 ⇒ 推了也是白发一次请求；
  //   更早的注释提过"新告警会先闪一下再消失"，这里顺手把这个闪烁也堵掉。
  //   存档是 60s 兜底轮询 + 打开面板时取一次，不依赖 SSE。
  if (w && w.gatePassed === false) return 0
  const evt = {
    type: 'warning',
    id: w.id,
    source: w.source || '',
    aiType: w.aiType || '',
    level: w.level ?? null,
    createdAt: w.createdAt || '',
    warningType: w.warningType || '',
  }
  const payload = `data: ${JSON.stringify(evt)}\n\n`
  let ok = 0
  for (const c of clients) {
    if (!c.alive) continue
    try { c.res.write(payload); ok++ } catch { c.alive = false }
  }
  return ok
}

function registerWarningsStream(app, { store, log }) {
  app.get('/api/warnings/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(': connected\n\n')
    const client = { res, alive: true }
    clients.add(client)
    const hb = setInterval(() => {
      if (!client.alive) { clearInterval(hb); return }
      try { res.write('data: {"type":"ping"}\n\n') } catch { client.alive = false }
    }, KEEPALIVE_MS)
    req.on('close', () => {
      client.alive = false
      clearInterval(hb)
      clients.delete(client)
      log.info(`[warnings-stream] SSE 客户端断开（当前 ${clients.size}）`)
    })
    log.info(`[warnings-stream] SSE 客户端接入（当前 ${clients.size}）`)
  })

  // 入库即广播
  store.onWarningInsert(w => {
    const n = broadcastWarning(w)
    if (n) log.info(`[warnings-stream] 推送告警 ${w.id} → ${n} 个客户端`)
  })
}

module.exports = { registerWarningsStream, broadcastWarning }
