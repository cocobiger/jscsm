/**
 * 电子围栏（ROI）编辑器 —— 挂在「AI分析存档」的第 6 个 tab 下
 *
 * 作用：在某通道的画面上**点选多边形**，并选取该多边形要作用的**识别算法**；
 *      保存后写入 iot_channels.roi（**按算法名分组**），各识别链按需拉取。
 *
 * 🔴 两条工程铁律（来自本项目踩坑）：
 *   1) 图上叠加层**必须与图像同宽高比**（禁 object-fit:cover）：
 *      这里用「img 定版 + 绝对定位 canvas 覆盖同一矩形」保证等比、不裁切。
 *      canvas 的 CSS 尺寸由容器决定，**坐标直接取归一化值**（offsetX / rect.width），
 *      因此与图像分辨率无关（换子码流/主码流都不用重画）。
 *   2) 契约单一出处：RoiConfig 定义在 lib/api-types.ts 里。
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { apiFetch, getToken } from '../../lib/apiFetch'
import { roleAtLeast, type CurrentUser } from '../../lib/auth'
import type { RoiConfig, RoiAlgoEntry } from '../../lib/api-types'

const CYAN = '#00aaff'
const GREEN = '#00e676'
const AMBER = '#ffd740'
const RED = '#ff4444'

/** 各算法在本平台的「电子围栏能力」——**一张表同时驱动"作用算法可选列表"与"效果徽标"**，
 *  以后新增一个支持围栏的算法只需在这里加一行（roi:true 即自动出现在选择器里）。
 *
 *  🔴 「可选列表」刻意**不**受"本通道绑定了哪些算法"限制 —— 否则绑错了/还没挂上的通道就只能干看着。
 *     围栏本身只是 `iot_channels.roi` 里按算法名分组的一段配置（键=算法名），**先画好存下**没有副作用；
 *     是否绑定只决定"会不会生效"，页面会用徽标 + 红色提示明确标出来（避免误以为已生效）。
 *
 *  ⚠ 名称必须与 `iot_channels.ai_types` / 各识别链取的 `algo` 值**逐字一致**。
 *     平台主数据真源 = 后端 `GET /api/ai-types`（`store.listAiTypes()`，后台可增删改，带 sortOrder/sourceKey）；
 *     现网实际用到的是「堆头未覆盖 / 道路扬尘 / 渣土车冒装」——
 *     业务口语里的「渣土车帽盖」= 库里的「渣土车冒装」（`muck_cover_det_v10_1280.onnx` 那条链）。
 */
const ALGO_SUPPORT: Record<string, { roi: boolean; done: boolean; note: string }> = {
  '堆头未覆盖': { roi: true, done: true, note: '已支持：送模型前掩码，框外不参与识别（“真的只看框内”）' },
  '渣土车冒装': { roi: true, done: false, note: '待上线：S4 改造（TASK 源码加 ROI 掩膜）已完成源码+编译+影子预演，等维护窗口替换即在生产生效；现在画好会先存下配置，替换后自动生效' },
  '道路扬尘': { roi: false, done: false, note: '本链尚未接入 ROI：该算法目前没有跑识别链（架构已备、未启用），围栏会先存下但不会生效' },
}

/** 「作用算法」里稳定提供的可选算法（顺序即展示顺序）= 已具备围栏能力的那些 */
const ALGO_CATALOG = Object.keys(ALGO_SUPPORT).filter(k => ALGO_SUPPORT[k].roi)

interface LocalChannel {
  channelSipId: string
  channelName: string
  deviceName: string | null
  streamId: string | null
  enabled: boolean
  aiTypes: string[]
  roi?: RoiConfig
}

const btn = (color: string, disabled = false): React.CSSProperties => ({
  padding: '5px 12px', fontSize: 12, borderRadius: 3,
  border: `1px solid ${color}55`, background: `${color}15`,
  color: disabled ? '#5a6a78' : color, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
})

export function RoiEditor({ user }: { user?: CurrentUser | null }) {
  // 🔴 roleAtLeast(actual: Role, required)：第一个参数是**角色字符串**（不是 user 对象）。
  //   照 IotArchivePage/IotChannelManage 的写法传 user.role，否则查表 undefined → isAdmin 恒 false（点击会被静默忽略）。
  const isAdmin = roleAtLeast(user?.role, 'admin')
  const [channels, setChannels] = useState<LocalChannel[]>([])
  const [activeSpid, setActiveSpid] = useState('')
  const [algo, setAlgo] = useState('堆头未覆盖')
  const [points, setPoints] = useState<Array<[number, number]>>([])   // 归一化 0~1
  const [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ t: 'ok' | 'err'; m: string } | null>(null)
  const [imgTick, setImgTick] = useState(Date.now())
  // ── 图源：'ref' = 该通道的**算法输入原始帧**（推荐，与掩膜作用帧同源）；'live' = 实时快照 ──
  //   🔴 为什么参考图优先：实时快照走 ZLM 按需拉流，没人播放时返回的是 ZLM logo 占位图；
  //      且渣土车 6 路在 iot_channels 里 stream_id 为 null，根本取不到实时流。
  const [srcKind, setSrcKind] = useState<'ref' | 'live'>('ref')
  // 实际加载到的画面尺寸（用于页面提示，便于确认"看到的就是算法看到的"）
  const [imgInfo, setImgInfo] = useState<{ w: number; h: number; kind: 'ref' | 'live' } | null>(null)
  // 本通道的「参考图」是否已经失败过（失败过就不再显示「← 回到参考图」，避免点了又弹回来的死循环）
  const [refFailed, setRefFailed] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  // 拖动微调：dragIdx = 正在拖的顶点序号；dragMoved = 本次按下是否真的移动过（用于区分"拖"与"点"）
  const dragRef = useRef<{ idx: number; moved: boolean } | null>(null)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)

  const active = useMemo(() => channels.find(c => c.channelSipId === activeSpid) || null, [channels, activeSpid])

  /** 该通道**已绑定**的算法（来自 iot_channels.ai_types）—— 只影响"会不会生效"，不影响能不能画 */
  const boundAlgos = useMemo(
    () => (active?.aiTypes && active.aiTypes.length) ? active.aiTypes : [],
    [active])

  /** 「作用算法」可选项 = 平台算法目录 ∪ 该通道已绑定的算法（去重、保序） */
  const algos = useMemo(() => {
    const out = [...ALGO_CATALOG]
    for (const a of boundAlgos) if (!out.includes(a)) out.push(a)
    return out
  }, [boundAlgos.join('|')])   // eslint-disable-line react-hooks/exhaustive-deps

  // ── 加载通道 ──
  const load = useCallback(async () => {
    try {
      const list: LocalChannel[] = await apiFetch('/api/iot-channels')
      const arr = Array.isArray(list) ? list : []
      setChannels(arr)
      // 默认选**第一个绑了流的**通道 —— 否则首屏只会看到「该通道未绑定视频流」
      setActiveSpid(prev => prev || (arr.find(c => c.streamId)?.channelSipId || arr[0]?.channelSipId || ''))
    } catch (e: any) { setMsg({ t: 'err', m: '加载通道失败：' + (e?.error || e) }) }
  }, [])
  useEffect(() => { load() }, [load])

  // 🔴 切通道时把 algo 收敛到**可选项列表内**（保留用户选择；只有当它不在列表里才回落到第一项）
  //   注意：依赖里**不放 algo**，否则用户手动切算法会被这个 effect 弹回去。
  useEffect(() => {
    if (!active) return
    setAlgo(prev => (algos.includes(prev) ? prev : algos[0]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // ── 切通道时重置图源为「参考图」（每路都优先参考图）+ 清掉拖动/悬停**与上一条遗留消息** ──
  //   （遗留消息会误导：换了通道还挂着"该通道暂时没有可用画面"）
  useEffect(() => {
    setSrcKind('ref'); setImgInfo(null); setMsg(null); setRefFailed(false)
    dragRef.current = null; setDragging(false); setHoverIdx(null)
  }, [activeSpid])

  // ── 切通道/算法时，回填已存的多边形 ──
  useEffect(() => {
    if (!active) return
    const entry: RoiAlgoEntry | undefined = (active.roi || {})[algo]
    if (entry && Array.isArray(entry.polygon) && entry.polygon.length >= 3) {
      setPoints(entry.polygon.map(p => [p[0], p[1]] as [number, number]))
      setEnabled(entry.enable !== false)
    } else {
      setPoints([]); setEnabled(true)
    }
  }, [active, algo])

  // ── 画布重绘（**尺寸驱动、幂等**）──
  //   🔴 这里修的是一个真实 bug：之前把 `cv.width = clientWidth` 写进 img 的 onLoad，
  //      而**给 canvas.width/height 赋值会清空画布**；若新通道的参考图与上一张宽高比相同，
  //      `setImgAspect` 就不是状态变化 → 不会触发重绘 →「多边形：8 个点」但画布一片空白。
  //      → 现在把"同步尺寸 + 绘制"合成一个函数：尺寸只在**真的变了**时才赋值，并且每次都重画。
  const draw = useCallback(() => {
    const cv = canvasRef.current
    const img = imgRef.current
    if (!cv || !img) return
    const w = img.clientWidth, h = img.clientHeight
    if (!w || !h) return
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h }   // 仅在变化时赋值（避免无谓清空）
    const W = cv.width, H = cv.height
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, W, H)
    if (!points.length) return
    ctx.lineWidth = Math.max(2, W / 400)
    ctx.strokeStyle = enabled ? GREEN : '#888'
    ctx.fillStyle = enabled ? 'rgba(0,230,118,0.16)' : 'rgba(136,136,136,0.14)'
    ctx.beginPath()
    points.forEach(([x, y], i) => {
      const px = x * W, py = y * H
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
    })
    if (points.length >= 3) { ctx.closePath(); ctx.fill() }
    ctx.stroke()
    const R = Math.max(4, W / 200)
    points.forEach(([x, y], i) => {
      const hot = dragging ? dragRef.current?.idx === i : hoverIdx === i
      ctx.beginPath()
      ctx.arc(x * W, y * H, hot ? R + 3 : R, 0, Math.PI * 2)
      ctx.fillStyle = (i === 0) ? AMBER : CYAN
      ctx.fill()
      if (hot) { ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke() }
      ctx.font = `${Math.max(11, W / 60)}px sans-serif`
      ctx.fillStyle = '#fff'
      ctx.fillText(String(i + 1), x * W + 9, y * H - 9)
    })
  }, [points, enabled, hoverIdx, dragging])

  useEffect(() => { draw() }, [draw])

  // 画布尺寸变化（图加载完成 / 窗口缩放 / 布局变化）→ 重画。用 ref 拿最新 draw，避免反复重挂 observer
  const drawRef = useRef(draw)
  useEffect(() => { drawRef.current = draw }, [draw])
  useEffect(() => {
    const img = imgRef.current
    if (!img) return
    const ro = new ResizeObserver(() => drawRef.current())
    ro.observe(img)
    return () => ro.disconnect()
  }, [activeSpid, srcKind])

  // ── 指针交互：拖动顶点做微调 / 点空白加点 / Shift+点顶点删点 ──
  const HIT_PX = 12   // 顶点命中半径（CSS 像素，便于小窗口下也能抓住）

  const toNorm = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect()
    const nx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    const ny = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
    return [Number(nx.toFixed(4)), Number(ny.toFixed(4))]
  }

  const hitVertex = (e: React.PointerEvent<HTMLCanvasElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect()
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    let best = -1, bestD = HIT_PX
    points.forEach(([x, y], i) => {
      const d = Math.hypot(x * rect.width - mx, y * rect.height - my)
      if (d <= bestD) { bestD = d; best = i }
    })
    return best
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isAdmin) return
    const idx = hitVertex(e)
    if (idx < 0) return                              // 空白处按下：留给 pointerup 判断成"加点"
    if (e.shiftKey) {                                 // Shift + 点顶点 = 删除该点
      setPoints(p => p.filter((_, i) => i !== idx))
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)    // 拖出画布也能继续
    dragRef.current = { idx, moved: false }
    setDragging(true)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current
    if (!d) { setHoverIdx(isAdmin ? (hitVertex(e) >= 0 ? hitVertex(e) : null) : null); return }
    const [nx, ny] = toNorm(e)
    d.moved = true
    setPoints(p => p.map((pt, i) => (i === d.idx ? [nx, ny] as [number, number] : pt)))
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current
    if (d) { dragRef.current = null; setDragging(false); return }   // 拖过 / 只是点了顶点：都不加点
    if (!isAdmin) return
    const [nx, ny] = toNorm(e)
    setPoints(p => [...p, [nx, ny]])                  // 空白轻点 = 加点
  }

  const save = async () => {
    if (!active) return
    if (points.length < 3) { setMsg({ t: 'err', m: '至少需要 3 个点才能构成多边形' }); return }
    setBusy(true); setMsg(null)
    try {
      const nextRoi: RoiConfig = { ...(active.roi || {}) }
      nextRoi[algo] = { enable: enabled, coord: 'norm', polygon: points.map(p => [p[0], p[1]]), fill: 114 }
      const row: LocalChannel = await apiFetch(`/api/iot-channels/${encodeURIComponent(active.channelSipId)}/roi`, {
        method: 'PATCH', body: JSON.stringify({ roi: nextRoi }),
      })
      setChannels(cs => cs.map(c => c.channelSipId === active.channelSipId ? { ...c, roi: (row as any)?.roi ?? nextRoi } : c))
      const tail = !algoBound
        ? '（注意：本通道未绑定该算法 → 配置已存下，但该识别链不会拉取）'
        : (ALGO_SUPPORT[algo]?.done ? '' : '（注意：该算法尚未改造，暂不生效）')
      setMsg({ t: 'ok', m: `已保存：${active.channelName} · ${algo} · ${points.length} 个点` + tail })
    } catch (e: any) { setMsg({ t: 'err', m: '保存失败：' + (e?.error || e) }) }
    finally { setBusy(false) }
  }

  const clearAlgo = async () => {
    if (!active) return
    setBusy(true); setMsg(null)
    try {
      const nextRoi: RoiConfig = { ...(active.roi || {}) }
      delete nextRoi[algo]
      const row: LocalChannel = await apiFetch(`/api/iot-channels/${encodeURIComponent(active.channelSipId)}/roi`, {
        method: 'PATCH', body: JSON.stringify({ roi: nextRoi }),
      })
      setChannels(cs => cs.map(c => c.channelSipId === active.channelSipId ? { ...c, roi: (row as any)?.roi ?? nextRoi } : c))
      setPoints([])
      setMsg({ t: 'ok', m: `已删除：${active.channelName} · ${algo} 的围栏` })
    } catch (e: any) { setMsg({ t: 'err', m: '删除失败：' + (e?.error || e) }) }
    finally { setBusy(false) }
  }

  // ── 图源 ①：参考图 = 该通道的**算法输入原始帧**（服务器已按每路发布到 /images/_ref/<spid>.jpg）──
  //   与「掩膜作用帧」同源同宽高比 → 在这里画的围栏不会错位。
  //   `t=imgTick` 用于绕过 12 机图片代理的 24h 内存缓存（「刷新画面」按钮会更新 imgTick）。
  const refUrl = active
    ? `/api/iot-image?url=${encodeURIComponent(`http://172.16.8.11:5001/images/_ref/${active.channelSipId}.jpg`)}&t=${imgTick}`
    : ''
  // ── 图源 ②：实时快照（ZLM 按需拉流；当前没人推流时它返回的是 ZLM 的 logo 占位图）──
  const liveUrl = active?.streamId
    ? `/api/streams/live/snap?id=${encodeURIComponent(active.streamId)}&token=${encodeURIComponent(getToken())}&t=${imgTick}`
    : ''
  const imgUrl = srcKind === 'ref' ? refUrl : liveUrl

  /** 参考图取不到时自动回退实时快照；两者都取不到才报错 */
  const onImgError = () => {
    if (srcKind === 'ref' && liveUrl) {
      setRefFailed(true)
      setSrcKind('live')
      setMsg({ t: 'err', m: '该通道暂无「参考图」，已回退实时快照（若当前无推流，画面可能是播放器占位图）' })
      return
    }
    setImgInfo(null)
    setMsg({
      t: 'err',
      m: srcKind === 'live'
        ? '实时快照不可用（该通道当前无推流）—— 可点「刷新画面」或改用参考图'
        : '该通道暂时没有可用画面（参考图未发布）',
    })
  }

  /** 🔴 ZLM 在"没有推流"时返回的是它自带的 logo 占位图（实测恒定 1024×512、字节数也完全相同）。
   *  真实码流不会是 1024×512，因此用它当"这是占位图不是画面"的判据，显式告诉用户别在这上面画围栏。 */
  const isPlaceholder = srcKind === 'live' && imgInfo?.w === 1024 && imgInfo?.h === 512

  const algoBound = boundAlgos.includes(algo)   // 当前选的算法是否已挂在该通道上（只影响"会不会生效"）

  // ── 已保存的多边形（微调的基准）：用于"与已保存对比"与"还原" ──
  const savedPts = useMemo<Array<[number, number]>>(() => {
    const e: RoiAlgoEntry | undefined = active?.roi?.[algo]
    return (e && Array.isArray(e.polygon) && e.polygon.length >= 3)
      ? e.polygon.map(p => [p[0], p[1]] as [number, number]) : []
  }, [active, algo])

  const sameAsSaved = savedPts.length === points.length &&
    savedPts.every((p, i) => Math.abs(p[0] - points[i][0]) < 1e-6 && Math.abs(p[1] - points[i][1]) < 1e-6)

  return (
    <div style={{ flex: 1, overflow: 'auto', display: 'flex', gap: 14, minHeight: 0 }}>
      {/* ── 左：通道列表 ── */}
      <div style={{ width: 230, flexShrink: 0, overflow: 'auto' }}>
        <div style={{ color: '#5a8aaa', fontSize: 12, marginBottom: 6 }}>选择通道（共 {channels.length}）</div>
        {channels.map(c => {
          const n = Object.keys(c.roi || {}).length
          return (
            <div key={c.channelSipId} onClick={() => setActiveSpid(c.channelSipId)}
              style={{
                padding: '7px 9px', marginBottom: 4, borderRadius: 3, cursor: 'pointer', fontSize: 12,
                border: `1px solid ${c.channelSipId === activeSpid ? 'rgba(0,170,255,0.45)' : 'rgba(0,120,200,0.18)'}`,
                background: c.channelSipId === activeSpid ? 'rgba(0,170,255,0.1)' : 'transparent',
                color: c.channelSipId === activeSpid ? CYAN : '#8fb2c8',
              }}>
              <div style={{ fontWeight: 600 }}>{c.channelName}</div>
              <div style={{ color: '#4a6a80', fontSize: 11, marginTop: 2 }}>
                {c.streamId ? '有流' : '无实时流·用参考图'} · 围栏 {n ? `${n} 个算法` : '未配'}
              </div>
            </div>
          )
        })}
      </div>

      {/* ── 右：编辑区 ── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* 算法选择：平台可配置的算法目录 ∪ 本通道已绑定的算法（**不再被"本通道绑了什么"锁死**） */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={{ color: '#5a8aaa', fontSize: 12 }}>作用算法：</span>
          {algos.map(a => {
            const bound = boundAlgos.includes(a)
            const on = a === algo
            return (
              <button key={a} onClick={() => setAlgo(a)} title={bound ? '本通道已绑定该算法' : '本通道未绑定该算法：围栏会先存下，但该识别链不会拉取/不生效'}
                style={{
                  ...btn(on ? CYAN : '#5a7a90'),
                  fontWeight: on ? 600 : 400,
                  borderStyle: bound ? 'solid' : 'dashed',
                }}>
                {a}{bound ? '' : ' · 未绑定'}
              </button>
            )
          })}
          {ALGO_SUPPORT[algo] && algoBound && (
            <span style={{
              fontSize: 11, padding: '2px 8px', borderRadius: 10,
              background: ALGO_SUPPORT[algo].done ? 'rgba(0,230,118,0.12)' : 'rgba(255,215,64,0.12)',
              color: ALGO_SUPPORT[algo].done ? GREEN : AMBER,
              border: `1px solid ${ALGO_SUPPORT[algo].done ? 'rgba(0,230,118,0.3)' : 'rgba(255,215,64,0.3)'}`,
            }}>{ALGO_SUPPORT[algo].done ? '✓ 本链已支持“只看框内”' : '⏳ 本链尚未支持'}</span>
          )}
          {!algoBound && (
            <span style={{
              fontSize: 11, padding: '2px 8px', borderRadius: 10,
              background: 'rgba(255,107,107,0.12)', color: RED, border: '1px solid rgba(255,107,107,0.35)',
            }}>⚠ 本通道未绑定该算法 → 现在画了不生效</span>
          )}
        </div>
        {ALGO_SUPPORT[algo] && (
          <div style={{ color: '#4a6a80', fontSize: 11, marginBottom: 8 }}>
            {ALGO_SUPPORT[algo].note}
            {!algoBound && (
              <><br /><span style={{ color: RED }}>
                ⚠ 且该算法<b>没有挂在本通道上</b>（本通道当前绑定：{boundAlgos.length ? boundAlgos.join('、') : '无'}）。
                要让围栏生效，先在「通道接入」里给本通道挂上「{algo}」；现在保存只会先把配置存下来，不会被任何识别链拉取。
              </span></>
            )}
          </div>
        )}

        {/* 图源标识（让人一眼知道"我画在哪张图上"） */}
        {active && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap', fontSize: 11 }}>
            <span style={{
              padding: '2px 8px', borderRadius: 10,
              background: isPlaceholder ? 'rgba(255,107,107,0.12)' : (srcKind === 'ref' ? 'rgba(0,230,118,0.12)' : 'rgba(255,215,64,0.12)'),
              color: isPlaceholder ? RED : (srcKind === 'ref' ? GREEN : AMBER),
              border: `1px solid ${isPlaceholder ? 'rgba(255,107,107,0.35)' : (srcKind === 'ref' ? 'rgba(0,230,118,0.3)' : 'rgba(255,215,64,0.3)')}`,
            }}>
              {isPlaceholder ? '⛔ 播放器占位图（当前无推流，不是画面）'
                : srcKind === 'ref' ? '📷 参考图（算法输入原始帧）' : '🎥 实时快照'}
            </span>
            {imgInfo && (
              <span className="mono" style={{ color: isPlaceholder ? RED : '#4a6a80' }}>
                {imgInfo.w}×{imgInfo.h}
                {isPlaceholder ? '（占位图固定尺寸，别在这上面画围栏）'
                  : srcKind === 'ref' ? '（与掩膜作用帧同宽高比 → 围栏不会错位）' : ''}
              </span>
            )}
            {srcKind === 'live' && liveUrl && !refFailed && (
              <button onClick={() => setSrcKind('ref')} style={btn('#5a7a90')}>← 回到参考图</button>
            )}
          </div>
        )}

        {/* 画面 + 叠加层（同矩形 → 等比，不裁切） */}
        <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%', alignSelf: 'flex-start', border: '1px solid rgba(0,120,200,0.25)', borderRadius: 3 }}>
          {imgUrl ? (
            <>
              <img ref={imgRef} src={imgUrl} alt={active?.channelName || ''} draggable={false}
                style={{ display: 'block', maxWidth: '100%', maxHeight: '52vh', height: 'auto', userSelect: 'none' }}
                onLoad={() => {
                  const el = imgRef.current
                  if (el && el.naturalWidth && el.naturalHeight) {
                    setImgInfo({ w: el.naturalWidth, h: el.naturalHeight, kind: srcKind })
                    setMsg(null)   // 图取到了 → 清掉上一条失败提示（否则会挂着误导人）
                  }
                  // 🔴 必须在这里主动画一次：canvas.width 赋值会清空画布，而"尺寸变化"未必带来 state 变化
                  drawRef.current()
                  requestAnimationFrame(() => drawRef.current())
                }}
                onError={onImgError} />
              <canvas ref={canvasRef}
                onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
                onPointerLeave={() => setHoverIdx(null)}
                style={{
                  position: 'absolute', inset: 0, width: '100%', height: '100%', touchAction: 'none',
                  cursor: !isAdmin ? 'not-allowed' : dragging ? 'grabbing' : (hoverIdx !== null ? 'grab' : 'crosshair'),
                }} />
            </>
          ) : (
            <div style={{ width: 640, height: 360, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#5a8aaa', fontSize: 13 }}>
              {active ? '该通道暂无可用画面' : '请选择通道'}
            </div>
          )}
        </div>

        {/* 工具条 */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
          <span style={{ color: '#5a8aaa', fontSize: 12 }}>多边形：{points.length} 个点{points.length < 3 && points.length > 0 ? '（还差 ' + (3 - points.length) + ' 个）' : ''}</span>
          {/* 与"已保存"的差异提示 —— 微调时一眼知道改没改、要不要保存 */}
          {savedPts.length >= 3 && (
            <span style={{
              fontSize: 11, padding: '2px 8px', borderRadius: 10,
              color: sameAsSaved ? '#4a6a80' : AMBER,
              border: `1px solid ${sameAsSaved ? 'rgba(120,140,160,0.3)' : 'rgba(255,215,64,0.35)'}`,
              background: sameAsSaved ? 'transparent' : 'rgba(255,215,64,0.1)',
            }}>{sameAsSaved ? `与已保存一致（${savedPts.length} 个点）` : `已保存 ${savedPts.length} 个点 · 当前有改动未保存`}</span>
          )}
          <button onClick={() => setPoints(p => p.slice(0, -1))} disabled={!points.length || busy} style={btn('#5a7a90', !points.length || busy)}>撤销上一点</button>
          <button onClick={() => setPoints(savedPts.map(p => [p[0], p[1]] as [number, number]))}
            disabled={busy || savedPts.length < 3 || sameAsSaved} style={btn('#5a7a90', busy || savedPts.length < 3 || sameAsSaved)}>还原为已保存</button>
          <button onClick={() => setPoints([])} disabled={!points.length || busy} style={btn('#5a7a90', !points.length || busy)}>清空</button>
          <button onClick={() => setImgTick(Date.now())} style={btn(CYAN)}>刷新画面</button>
          <label style={{ color: '#8fb2c8', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />启用
          </label>
          <button onClick={save} disabled={busy || points.length < 3 || !isAdmin} style={btn(GREEN, busy || points.length < 3 || !isAdmin)}>保存围栏</button>
          <button onClick={clearAlgo} disabled={busy || !isAdmin} style={btn(RED, busy || !isAdmin)}>删除该算法的围栏</button>
        </div>

        <div style={{ color: '#4a6a80', fontSize: 11, marginTop: 8, lineHeight: 1.7 }}>
          · 画面默认显示<b>该通道的算法输入原始帧（参考图）</b>——与算法实际"看到"的那一帧同源同宽高比，
            因此在这里点的多边形与真正生效的掩膜<b>严格对齐</b>；取不到时才回退实时快照。<br />
          · 打开通道时<b>已保存的围栏会直接画在画面上</b>；<b>拖动顶点即可微调</b>（拖到哪算哪，松开即定），
            改完点「保存围栏」；想反悔点「还原为已保存」。<br />
          · <b>点击空白处加点</b>（至少 3 点）；<b>Shift + 点击顶点 = 删除该点</b>；坐标按<b>归一化</b>存储，与分辨率无关。<br />
          · <b>⚠ 多边形只在相机视角固定时有效</b>：若该 PTZ 在巡航/预置位轮换，围栏会失效，请先在现场锁定视角。<br />
          · 保存后各识别链在<b>下一轮（≤5 分钟）</b>自动拉取生效，无需重启服务。
        </div>

        {msg && (
          <div style={{ marginTop: 8, fontSize: 12, color: msg.t === 'ok' ? GREEN : RED }}>
            {msg.t === 'ok' ? '✓ ' : '✕ '}{msg.m}
          </div>
        )}
      </div>
    </div>
  )
}
