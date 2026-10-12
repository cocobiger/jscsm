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
  // 🔴 2026-10-01 P0-9：**移除 gatePassed 门限过滤**（原 P0-2b / 2026-09-17）。
  //   原判断 `if (w && w.gatePassed === false) return 0`，批注理由是
  //   「前端收到 SSE 只是触发一次重新拉取，而实时告警列表已排除这批 ⇒ 推了也是白发一次请求」。
  //   —— 该前提现在**不成立**：
  //     ① 口径：10-01 拍板「冒装＝判罚证据，不聚合、不过滤、逐条直出」；store-db.js 已加
  //        GATE_EXEMPT_AI_TYPES=['渣土车冒装','渣土车帽盖'] 豁免，且 `gatePassed` 在 store-db.js
  //        **代码中零引用**（只写进 data_json，从不读取），前端全库亦 0 命中
  //        ⇒ 列表轨根本不按它过滤，不存在"先弹后消失"的闪烁。
  //     ② 实测（2026-10-01，库 842 条）：491 条「渣土车冒装」全部 judge_status=admitted
  //        （= 都会走到本函数），其中 **453 条 gatePassed=false** ⇒ 92.3% 的冒装实时推送被这行吃掉，
  //        前端只能等 60s 兜底轮询才看到 ⇒ 实时推送名存实亡（全库共 454 条被吞，占 54%）。
  //   准入口径已由 store-db.js 的 `judgeStatus === 'admitted'` 单点把关（P0-2 闸门），
  //   此处再按 gatePassed 二次过滤＝两个口径打架，故删除。
  const evt = {
    type: 'warning',
    // 保留原精简顶层字段（任何既有消费者不受影响 —— 带宽与契约均不回归）
    id: w.id,
    source: w.source || '',
    aiType: w.aiType || '',
    level: w.level ?? null,
    createdAt: w.createdAt || '',
    warningType: w.warningType || '',
    // 兼容超集：附完整告警对象，供前端直接渲染（免二次拉详情）。
    // 前端当前仅读 `type`（源码 + 线上构建产物双证），故此字段纯增量、零破坏。
    warning: w,
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
