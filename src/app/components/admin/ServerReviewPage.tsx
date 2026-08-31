import { useCallback, useEffect, useRef, useState } from 'react'
import { CK, alpha } from '../../lib/cockpitTheme'
import { authFetch } from '../../lib/apiFetch'

interface Detection {
  id: number
  stream_id?: string
  ts?: string
  frame_path?: string
  boxes?: { cls: number; conf: number; x1: number; y1: number; x2: number; y2: number }[]
  label?: string
  source?: string
  max_conf?: number
  review_status?: string
}

const card = { background: 'rgba(0,20,50,0.4)', border: `1px solid rgba(0,150,220,0.15)`, borderRadius: 6, padding: '14px 16px' }
const btn = (bg: string, color: string, border: string): React.CSSProperties => ({
  flex: 1, background: bg, color, border: `1px solid ${border}`, padding: '6px 0', borderRadius: 4, fontSize: 12, cursor: 'pointer',
})
const mono = { fontFamily: "'JetBrains Mono', monospace" } as const

// 类别颜色：0=smoke 青 / 1=fire 红 / 2=house 黄（居民住房排除类）
const clsColor = (c: number) => c === 1 ? CK.red : c === 2 ? CK.amber : CK.cyan
const clsName = (c: number) => c === 1 ? 'fire' : c === 2 ? 'house' : 'smoke'

// 图片加载失败自动重试（最多 3 次），失败后显示占位 + 手动重试按钮
function RetryImg({ src, style, cover, onLoad }: { src: string; style?: React.CSSProperties; cover?: boolean; onLoad?: (e: React.SyntheticEvent<HTMLImageElement>) => void }) {
  const [fail, setFail] = useState(0)
  if (fail >= 3) {
    return (
      <div style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,20,50,0.45)', color: CK.textFaint, fontSize: 11, flexDirection: 'column', gap: 6 }}>
        <span>图片加载失败</span>
        <button onClick={() => setFail(0)} style={btn('rgba(0,20,50,0.4)', CK.textSub, alpha(CK.borderSoft, 0.6))}>重试</button>
      </div>
    )
  }
  // 失败后追加缓存破坏参数强制重新请求
  const retrySrc = fail > 0 ? (src.includes('?') ? src + '&r=' + fail : src + '?r=' + fail) : src
  return (
    <img src={retrySrc} alt="" loading="lazy" onError={() => setTimeout(() => setFail(f => f + 1), 300)}
      onLoad={onLoad}
      style={{ ...style, objectFit: cover ? 'cover' : 'contain', display: 'block' }} />
  )
}

function BoxDrawer({ src, onSave, onCancel, initialBoxes, cls, onClsChange }: { src: string; onSave: (boxes: any[]) => void; onCancel: () => void; initialBoxes?: any[]; cls: number; onClsChange: (c: number) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const [boxes, setBoxes] = useState<any[]>(initialBoxes || [])
  const [drawing, setDrawing] = useState<any>(null)
  // 原图模式：隐藏已有标注框，只看干净原图辅助人眼判断/标注（新画的框始终显示）
  const [hideBoxes, setHideBoxes] = useState(false)

  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      if (imgRef.current) {
        imgRef.current.src = src
        const canvas = canvasRef.current
        if (canvas) {
          canvas.width = img.naturalWidth
          canvas.height = img.naturalHeight
          redraw()
        }
      }
    }
    img.src = src
  }, [src])

  const redraw = () => {
    const canvas = canvasRef.current
    const img = imgRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !img || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    for (let i = 0; i < (hideBoxes ? 0 : boxes.length); i++) {
      const b = boxes[i]
      ctx.strokeStyle = clsColor(b.cls)
      ctx.lineWidth = 3
      ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1)
      ctx.fillStyle = clsColor(b.cls)
      ctx.font = 'bold 28px sans-serif'
      ctx.fillText(clsName(b.cls), b.x1, b.y1 - 8)
      // 右上角 × 删除标记（20×20 黑色块 + 白色 ×）
      const sx = b.x2 - 22, sy = b.y1 + 2
      ctx.fillStyle = 'rgba(0,0,0,0.65)'
      ctx.fillRect(sx, sy, 20, 20)
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5
      ctx.strokeRect(sx + 0.5, sy + 0.5, 19, 19)
      ctx.fillStyle = '#fff'; ctx.font = 'bold 18px sans-serif'
      ctx.fillText('×', sx + 5, sy + 16)
    }
    if (drawing) {
      ctx.strokeStyle = clsColor(cls)
      ctx.lineWidth = 2
      ctx.strokeRect(drawing.x1, drawing.y1, drawing.x2 - drawing.x1, drawing.y2 - drawing.y1)
    }
  }

  // 原图模式切换时重绘
  useEffect(() => { if (imgRef.current) redraw() }, [hideBoxes])  // eslint-disable-line react-hooks/exhaustive-deps

  const pos = (e: React.MouseEvent) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(canvas.width, (e.clientX - rect.left) * (canvas.width / rect.width))),
      y: Math.max(0, Math.min(canvas.height, (e.clientY - rect.top) * (canvas.height / rect.height))),
    }
  }

  return (
    <div>
      {/* 类别按钮行吸顶：弹层内容超高滚动时始终可见 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center', position: 'sticky', top: 0, zIndex: 5, background: 'rgba(4,18,40,0.97)', padding: '6px 2px', borderRadius: 4 }}>
        <span style={{ fontSize: 11, color: CK.textDim }}>类别:</span>
        <button onClick={() => onClsChange(0)} style={btn(cls === 0 ? alpha(CK.cyan, 0.25) : 'rgba(0,20,50,0.4)', cls === 0 ? CK.cyan : CK.textSub, cls === 0 ? alpha(CK.cyan, 0.6) : alpha(CK.borderSoft, 0.6))}>烟 smoke</button>
        <button onClick={() => onClsChange(1)} style={btn(cls === 1 ? alpha(CK.red, 0.25) : 'rgba(0,20,50,0.4)', cls === 1 ? CK.red : CK.textSub, cls === 1 ? alpha(CK.red, 0.6) : alpha(CK.borderSoft, 0.6))}>火 fire</button>
        <button onClick={() => onClsChange(2)} style={btn(cls === 2 ? alpha(CK.amber, 0.25) : 'rgba(0,20,50,0.4)', cls === 2 ? CK.amber : CK.textSub, cls === 2 ? alpha(CK.amber, 0.6) : alpha(CK.borderSoft, 0.6))}>房 house</button>
        <button onClick={() => setHideBoxes(v => !v)} title="隐藏模型标注框，只看干净原图辅助判断/标注（新画的框始终显示）" style={btn(hideBoxes ? alpha(CK.cyan, 0.25) : 'rgba(0,20,50,0.4)', hideBoxes ? CK.cyan : CK.textSub, hideBoxes ? alpha(CK.cyan, 0.6) : alpha(CK.borderSoft, 0.6))}>
          {hideBoxes ? '◉ 原图模式' : '○ 隐藏标注框'}
        </button>
        {boxes.length > 0 && <span style={{ fontSize: 11, color: CK.green, marginLeft: 'auto' }}>{boxes.length} 框</span>}
      </div>
      {/* 图 + 画布同一容器：限高 + 内部可滚，避免画布过大延伸到底部按钮区域 */}
      <div style={{ position: 'relative', maxHeight: '50vh', overflow: 'auto', background: '#000' }}>
        <img ref={imgRef} src={src} alt="" style={{ width: '100%', display: 'block' }} />
        <canvas ref={canvasRef} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', cursor: 'crosshair' }}
          onMouseDown={e => { const p = pos(e); setDrawing({ x1: p.x, y1: p.y, x2: p.x, y2: p.y }) }}
          onMouseMove={e => { if (drawing) { const p = pos(e); setDrawing({ ...drawing, x2: p.x, y2: p.y }); redraw() } }}
          onMouseUp={e => {
            const p = pos(e)
            // 点 × 删除单个框（点击位置在某框右上角 20×20 区域）
            const hitIdx = boxes.findIndex(b => p.x >= b.x2 - 22 && p.x <= b.x2 + 2 && p.y >= b.y1 + 2 && p.y <= b.y1 + 22)
            if (hitIdx >= 0) { setBoxes(boxes.filter((_, i) => i !== hitIdx)); setDrawing(null); redraw(); return }
            if (drawing) {
              const b = { x1: Math.min(drawing.x1, drawing.x2), y1: Math.min(drawing.y1, drawing.y2), x2: Math.max(drawing.x1, drawing.x2), y2: Math.max(drawing.y1, drawing.y2), cls, conf: 1.0 }
              if (b.x2 - b.x1 > 5 && b.y2 - b.y1 > 5) { setBoxes([...boxes, b]); setDrawing(null); redraw() }
              else setDrawing(null)
            }
          }}
        />
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button onClick={() => onSave(boxes)} style={btn(alpha(CK.cyan, 0.15), CK.cyan, alpha(CK.cyan, 0.4))}>保存画框（真烟）</button>
        <button onClick={() => { if (boxes.length) { setBoxes(boxes.slice(0, -1)); setTimeout(redraw, 0) } }} style={btn('rgba(0,20,50,0.4)', CK.textDim, alpha(CK.border, 0.3))}>撤销</button>
        <button onClick={onCancel} style={btn('rgba(0,20,50,0.4)', CK.textDim, alpha(CK.border, 0.3))}>取消</button>
      </div>
    </div>
  )
}

export function ServerReviewPage() {
  const [rows, setRows] = useState<Detection[]>([])
  const [stats, setStats] = useState<any>(null)
  const [status, setStatus] = useState('pending')
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [drawingId, setDrawingId] = useState<number | null>(null)
  const [boxCls, setBoxCls] = useState(0)  // 画框类别：0=smoke 1=fire 2=house（底部操作栏 + 画框面板同步）
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [focusIdx, setFocusIdx] = useState<number | null>(null)
  const [fSource, setFSource] = useState('')
  const [fMinConf, setFMinConf] = useState('')
  const [fSort, setFSort] = useState('ts')
  // P0 新增：撤销上一步 / 已处理✓角标 / 快捷键帮助
  const [lastAction, setLastAction] = useState<{ id: number; label: string } | null>(null)
  const [doneIds, setDoneIds] = useState<Set<number>>(new Set())
  const [showHelp, setShowHelp] = useState(false)
  // 已复检本地状态：标注后即时更新（不等待刷新），卡片置灰 + ✓ 标签
  const [imgSizes, setImgSizes] = useState<Record<number, { w: number; h: number }>>({})
  // P1.5 分页：每页 60 条 + 加载更多（避免一次加载 500 张原图卡死）
  const PAGE_SIZE = 60
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)

  const load = useCallback(async (st = status, targetPage = 1) => {
    try {
      const params = new URLSearchParams({ status: st, limit: String(PAGE_SIZE), offset: String((targetPage - 1) * PAGE_SIZE) })
      if (fSource) params.set('source', fSource)
      if (fMinConf) params.set('min_conf', fMinConf)
      if (fSort) params.set('sort', fSort)
      const r = await fetch(`/api/review/list?${params}`)
      const d = await r.json()
      if (d.ok) {
        if (targetPage === 1) setRows(d.rows || [])
        else setRows(prev => [...prev, ...(d.rows || [])])
        setHasMore((d.total || 0) > targetPage * PAGE_SIZE)
      }
    } catch {}
    try {
      const s = await fetch('/api/review/stats')
      const sd = await s.json()
      if (sd.ok) setStats(sd)
    } catch {}
    setLoading(false)
  }, [status, fSource, fMinConf, fSort])

  useEffect(() => { setPage(1); load(status, 1) }, [load])

  const loadMore = () => { const np = page + 1; setPage(np); load(status, np) }

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 2500) }

  const submit = async (id: number, review_status: string) => {
    try {
      // reviewer 不再硬编码 admin：后端从登录 token 解析并绑定
      await authFetch('/api/review/submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, review_status }),
      })
      flash(`#${id} → ${review_status}`)
      setLastAction({ id, label: review_status })
      setDoneIds(prev => new Set(prev).add(id))
      // 本地即时更新该行状态（不等待重新加载）
      setRows(prev => prev.map(r => r.id === id ? { ...r, review_status } : r))
    } catch { flash('提交失败') }
  }

  // 撤销上一步判定（仅弹层内生效，回退 pending 并回到上一张）
  const undo = async () => {
    if (!lastAction) { flash('无可撤销操作'); return }
    const uid = lastAction.id
    try {
      await fetch('/api/review/undo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: uid }),
      })
      flash(`#${uid} 已撤销（${lastAction.label} → 待复检）`)
      setLastAction(null)
      setDoneIds(prev => { const s = new Set(prev); s.delete(uid); return s })
      gotoFocus(-1)
      load(status, page)
    } catch { flash('撤销失败') }
  }

  const submitMany = async (ids: number[], review_status: string) => {
    for (const id of ids) await authFetch('/api/review/submit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, review_status }),
    })
    flash(`批量 ${ids.length} 条 → ${review_status}`)
    setSelected(new Set())
    load(status, page)
  }

  // 批量把记录框标为 smoke（无人机视角秸秆判定以烟为主）
  const markAllSmoke = async (ids: number[]) => {
    try {
      const r = await fetch('/api/review/bulk-class', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      }).then(x => x.json())
      if (r.ok) {
        flash(`☁ 已标为烟（smoke）：${r.changed} 条 / ${r.boxesChanged} 框`)
        setRows(prev => prev.map(rr => ids.includes(rr.id) ? { ...rr, label: 'smoke', boxes: (rr.boxes || []).map((b: any) => ({ ...b, cls: 0 })) } : rr))
      } else flash(r.error || '操作失败')
    } catch { flash('操作失败') }
  }

  const saveBoxes = async (id: number, boxes: any[]) => {
    try {
      // 记录级 label 按框类别优先级：smoke（烟为主）> fire > house（房屋排除）
      const hasSmoke = boxes.some((b: any) => b.cls === 0)
      const hasFire = boxes.some((b: any) => b.cls === 1)
      const hasHouse = boxes.some((b: any) => b.cls === 2)
      const label = hasSmoke ? 'smoke' : hasFire ? 'fire' : hasHouse ? 'house' : 'fire'
      await authFetch('/api/review/box', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, boxes, label }),
      })
      flash(`#${id} 画框已保存（${boxes.length} 框）→ 真烟`)
      setLastAction({ id, label: '画框' })
      setDoneIds(prev => new Set(prev).add(id))
      setRows(prev => prev.map(r => r.id === id ? { ...r, review_status: 'true', boxes } : r))
      setDrawingId(null)
      // 停留本张：多目标图可继续画第二个框；按 → 或 1/2 再走
    } catch { flash('保存失败') }
  }

  const srcOf = (p?: string, w?: number) => p ? `/api/review/image?path=${encodeURIComponent(p)}${w ? `&w=${w}` : ''}` : ''

  // ---- 放大复核（弹层）----
  const focusRow = focusIdx !== null ? rows[focusIdx] : null
  const gotoFocus = (delta: number) => {
    if (focusIdx === null) return
    const n = focusIdx + delta
    if (n >= 0 && n < rows.length) setFocusIdx(n)
  }
  useEffect(() => {
    if (focusIdx === null) return
    const onKey = (e: KeyboardEvent) => {
      const r = rows[focusIdx]
      if (!r) return
      if (e.key === '1') { submit(r.id, 'true'); gotoFocus(1) }
      else if (e.key === '2') { submit(r.id, 'false'); gotoFocus(1) }
      else if (e.key === '3') { setDrawingId(r.id) }
      else if (e.key === '5' || (e.ctrlKey && e.key.toLowerCase() === 'z')) { e.preventDefault(); undo() }
      else if (e.key === 'h' || e.key === 'H') setShowHelp(s => !s)
      else if (e.key === 'ArrowRight') gotoFocus(1)
      else if (e.key === 'ArrowLeft') gotoFocus(-1)
      else if (e.key === 'Escape') { setFocusIdx(null); setDrawingId(null); setShowHelp(false) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusIdx, rows, undo, lastAction])

  const pending = (stats?.byStatus || []).find((s: any) => s.review_status === 'pending')?.c ?? 0
  const total = stats?.total ?? 0
  const done = total - pending
  const progress = total ? Math.round((done / total) * 100) : 0

  const toggleSelect = (id: number) => {
    const s = new Set(selected)
    if (s.has(id)) s.delete(id); else s.add(id)
    setSelected(s)
  }

  // 缩略图状态色：稍后处理(uncertain) → 黄边；有 fire 检测 → 红边；有 smoke → 蓝边；仅 house → 橙边；无检出 → 灰边
  const thumbBorder = (r: Detection) => {
    if (r.review_status === 'uncertain') return `2px solid #ffd740`
    const hasFire = (r.boxes || []).some(b => b.cls === 1)
    const hasSmoke = (r.boxes || []).some(b => b.cls === 0)
    const hasHouse = (r.boxes || []).some(b => b.cls === 2)
    if (hasFire) return `2px solid ${CK.red}`
    if (hasSmoke) return `2px solid ${CK.cyan}`
    if (hasHouse) return `2px solid #ff9f43`
    return `2px solid ${alpha(CK.borderSoft, 0.5)}`
  }
  const hasBox = (r: Detection) => (r.boxes || []).length > 0

  return (
    <div style={{ padding: '12px 16px 24px', color: CK.textMain }}>
      <div style={{ marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0, color: CK.textMain, letterSpacing: 1 }}>AI 检测复检</h2>
          <p style={{ fontSize: 11, color: CK.textDim, margin: '4px 0 0' }}>点击缩略图放大复核 · 1=真烟 2=误报 3=画框 5=撤销 h=帮助 ←/→=上下张 Esc=退出</p>
        </div>
      </div>

      {/* 进度条 */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: CK.textDim, marginBottom: 4 }}>
          <span style={mono}>已标 {done} / {total}</span>
          <span style={{ color: CK.cyan }}>{progress}%</span>
        </div>
        <div style={{ background: 'rgba(0,60,120,0.4)', borderRadius: 3, height: 6, overflow: 'hidden' }}>
          <div style={{ width: `${progress}%`, background: CK.cyan, height: '100%', borderRadius: 3 }} />
        </div>
      </div>

      {/* 状态 tab（一行） */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {[['pending', '待复检'], ['uncertain', '稍后处理'], ['true', '确认真烟'], ['false', '确认误报']].map(([k, l]) => {
          const isAct = status === k
          const isYellow = k === 'uncertain'
          return (
            <button key={k} onClick={() => { setStatus(k); setSelected(new Set()); setFocusIdx(null) }}
              style={{
                background: isAct ? (isYellow ? 'rgba(255,215,64,0.2)' : alpha(CK.cyan, 0.2)) : 'rgba(0,20,50,0.4)',
                color: isAct ? (isYellow ? '#ffd740' : CK.cyan) : CK.textSub,
                border: `1px solid ${isAct ? (isYellow ? 'rgba(255,215,64,0.5)' : alpha(CK.cyan, 0.5)) : alpha(CK.borderSoft, 0.6)}`,
                padding: '5px 14px', borderRadius: 4, fontSize: 12, cursor: 'pointer',
              }}>
              {l}
            </button>
          )
        })}
      </div>

      {/* 过滤器（一行，弱化次要） */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center', opacity: 0.85 }}>
        <span style={{ fontSize: 11, color: CK.textFaint }}>筛选:</span>
        <select value={fSource} onChange={e => { setFSource(e.target.value); setSelected(new Set()) }}
          style={{ background: 'rgba(0,20,50,0.5)', color: CK.textMain, border: `1px solid ${alpha(CK.borderSoft, 0.6)}`, padding: '5px 8px', borderRadius: 4, fontSize: 12 }}>
          <option value="">全部来源</option>
          <option value="alert">alert 告警</option>
          <option value="low">low 低分</option>
          <option value="random">random 随机</option>
          <option value="picall">picall 截图</option>
          <option value="picall_random">picall 无检出</option>
        </select>
        <select value={fMinConf} onChange={e => { setFMinConf(e.target.value); setSelected(new Set()) }}
          style={{ background: 'rgba(0,20,50,0.5)', color: CK.textMain, border: `1px solid ${alpha(CK.borderSoft, 0.6)}`, padding: '5px 8px', borderRadius: 4, fontSize: 12 }}>
          <option value="">全部置信度</option>
          <option value="0.5">≥ 0.50</option>
          <option value="0.4">≥ 0.40</option>
          <option value="0.3">≥ 0.30</option>
        </select>
        <select value={fSort} onChange={e => { setFSort(e.target.value); setSelected(new Set()) }}
          style={{ background: 'rgba(0,20,50,0.5)', color: CK.textMain, border: `1px solid ${alpha(CK.borderSoft, 0.6)}`, padding: '5px 8px', borderRadius: 4, fontSize: 12 }}>
          <option value="ts">按时间</option>
          <option value="conf">按置信度</option>
        </select>
        {status === 'uncertain' && <span style={{ fontSize: 11, color: '#ffd740' }}>黄色卡片 = 待回头复核</span>}
      </div>

      {/* 批量操作栏（本页全选 / 本页全误报） */}
      {status === 'pending' && rows.length > 0 && (
        <div style={{ ...card, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10, borderColor: alpha(CK.cyan, 0.4), flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: CK.cyan }}>{selected.size ? `已选 ${selected.size} 条` : `本页 ${rows.length} 条`}</span>
          <button onClick={() => setSelected(new Set(rows.map(r => r.id)))} style={btn(alpha(CK.cyan, 0.15), CK.cyan, alpha(CK.cyan, 0.4))}>☑ 本页全选</button>
          <button onClick={() => submitMany(rows.map(r => r.id), 'false')} style={btn(alpha(CK.red, 0.15), CK.red, alpha(CK.red, 0.4))}>⚡ 本页全误报</button>
          {selected.size > 0 && (
            <>
              <button onClick={() => submitMany([...selected], 'true')} style={btn(alpha(CK.green, 0.15), CK.green, alpha(CK.green, 0.4))}>批量真烟</button>
              <button onClick={() => submitMany([...selected], 'false')} style={btn(alpha(CK.red, 0.15), CK.red, alpha(CK.red, 0.4))}>批量误报</button>
              <button onClick={() => setSelected(new Set())} style={btn('rgba(0,20,50,0.4)', CK.textDim, alpha(CK.border, 0.3))}>取消选择</button>
            </>
          )}
        </div>
      )}

      {/* 确认真烟 tab：批量标为烟（无人机视角烟为主判定） */}
      {status === 'true' && rows.length > 0 && (
        <div style={{ ...card, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10, borderColor: alpha(CK.cyan, 0.4), flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: CK.textDim }}>本页 {rows.length} 张真烟 · 框类别当前为 {rows.filter(r => (r.boxes || []).some(b => b.cls === 0)).length ? '部分 smoke' : '全部 fire'}</span>
          <button onClick={() => markAllSmoke(rows.map(r => r.id))} style={btn(alpha(CK.cyan, 0.18), CK.cyan, alpha(CK.cyan, 0.5))}>☁ 本页全部标为烟（smoke）</button>
          <button onClick={() => markAllSmoke(rows.map(r => r.id).filter((_, i) => selected.has(rows[i].id)))} disabled={selected.size === 0}
            style={btn(selected.size ? alpha(CK.cyan, 0.18) : 'rgba(0,20,50,0.3)', selected.size ? CK.cyan : CK.textDim, alpha(CK.cyan, selected.size ? 0.5 : 0.2))}>☁ 所选标为烟（{selected.size}）</button>
          {selected.size > 0 && <button onClick={() => setSelected(new Set())} style={btn('rgba(0,20,50,0.4)', CK.textDim, alpha(CK.border, 0.3))}>取消选择</button>}
        </div>
      )}

      {msg && <div style={{ ...card, marginBottom: 12, fontSize: 12, color: CK.green, borderColor: alpha(CK.green, 0.3), padding: '8px 14px' }}>{msg}</div>}

      {/* 缩略图网格 */}
      {loading ? <div style={{ color: CK.textDim, fontSize: 12 }}>加载中...</div> : rows.length === 0 ? (
        <div style={{ color: CK.textFaint, fontSize: 12, textAlign: 'center', padding: 40 }}>暂无记录</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))', gap: 10 }}>
          {rows.map((r, idx) => {
            const done = doneIds.has(r.id) || (status !== 'pending' && r.review_status !== 'pending')
            const sz = imgSizes[r.id]
            const iw = sz?.w || 2942, ih = sz?.h || 1732
            return (
            <div key={r.id}
              onClick={() => { setFocusIdx(idx); setDrawingId(null) }}
              style={{ background: 'rgba(0,20,50,0.4)', border: selected.has(r.id) ? `2px solid ${CK.cyan}` : thumbBorder(r), borderRadius: 6, overflow: 'hidden', cursor: 'pointer', transition: 'border-color .15s', opacity: done && status === 'pending' ? 0.55 : 1 }}>
              <div style={{ position: 'relative', aspectRatio: '16/9' }}>
                <RetryImg src={srcOf(r.frame_path, 400)} cover style={{ width: '100%', height: '100%' }}
                  onLoad={e => {
                    const nw = (e.target as HTMLImageElement).naturalWidth, nh = (e.target as HTMLImageElement).naturalHeight
                    if (nw && nh) setImgSizes(prev => (prev[r.id] ? prev : { ...prev, [r.id]: { w: nw, h: nh } }))
                  }} />
                {/* 检测框缩略指示（按图片实际尺寸归一化） */}
                {(r.boxes || []).map((b, i) => (
                  <div key={i} style={{
                    position: 'absolute',
                    left: `${(b.x1 / iw) * 100}%`, top: `${(b.y1 / ih) * 100}%`,
                    width: `${((b.x2 - b.x1) / iw) * 100}%`, height: `${((b.y2 - b.y1) / ih) * 100}%`,
                    border: `1px solid ${clsColor(b.cls)}`, boxSizing: 'border-box',
                  }} />
                ))}
                {/* 右上角：有检出标记 + conf（按最高优先级类别着色） */}
                {hasBox(r) && (
                  <span style={{ position: 'absolute', top: 4, right: 4, background: 'rgba(0,10,25,0.75)', color: (r.boxes || []).some(b => b.cls === 1) ? CK.red : (r.boxes || []).some(b => b.cls === 0) ? CK.cyan : CK.amber, fontSize: 10, padding: '1px 5px', borderRadius: 3, ...mono }}>
                    {(r.max_conf || 0).toFixed(2)}
                  </span>
                )}
                {(status === 'pending' || status === 'true') && (
                  <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSelect(r.id)}
                    onClick={e => e.stopPropagation()}
                    style={{ position: 'absolute', top: 4, left: 4, width: 15, height: 15, cursor: 'pointer' }} />
                )}
                {done && (
                  <span style={{
                    position: 'absolute', bottom: 4, right: 4, background: CK.green, color: '#000',
                    borderRadius: 3, padding: '1px 7px', display: 'flex', alignItems: 'center',
                    fontSize: 11, fontWeight: 700, lineHeight: 1.5, boxShadow: '0 0 6px rgba(0,230,118,0.5)',
                  }}>✓ 已复检</span>
                )}
              </div>
              <div style={{ padding: '5px 8px', display: 'flex', justifyContent: 'space-between', fontSize: 10, color: CK.textDim, ...mono }}>
                <span>#{r.id}</span>
                <span>{r.source}</span>
              </div>
            </div>
            )
          })}
        </div>
      )}

      {/* 加载更多 */}
      {hasMore && (
        <div style={{ textAlign: 'center', marginTop: 14 }}>
          <button onClick={loadMore} style={{ background: alpha(CK.cyan, 0.12), color: CK.cyan, border: `1px solid ${alpha(CK.cyan, 0.4)}`, padding: '7px 28px', borderRadius: 5, fontSize: 12, cursor: 'pointer' }}>
            加载更多（已显示 {rows.length} 条）↓
          </button>
        </div>
      )}

      {/* 放大复核弹层 */}
      {focusIdx !== null && focusRow && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,8,20,0.88)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ position: 'relative', width: 'min(1200px, 94vw)', maxHeight: '96vh', display: 'flex', flexDirection: 'column', background: 'rgba(4,18,40,0.96)', border: `1px solid ${alpha(CK.cyan, 0.35)}`, borderRadius: 10, boxShadow: `0 0 40px rgba(0,140,255,0.15)`, overflowX: 'hidden', overflowY: 'auto' }}>
            {/* 顶栏 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: `1px solid ${alpha(CK.borderSoft, 0.4)}` }}>
              <span style={{ fontSize: 12, color: CK.cyan, ...mono }}>
                {focusIdx + 1} / {rows.length} · #{focusRow.id} · {focusRow.stream_id} · conf {(focusRow.max_conf || 0).toFixed(2)}
              </span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button onClick={() => setShowHelp(s => !s)} style={btn('rgba(0,20,50,0.4)', showHelp ? CK.cyan : CK.textDim, alpha(CK.cyan, showHelp ? 0.5 : 0.3))}>? 帮助（h）</button>
                <button onClick={() => { setFocusIdx(null); setDrawingId(null); setShowHelp(false) }} style={btn('rgba(0,20,50,0.4)', CK.textDim, alpha(CK.border, 0.3))}>✕ 退出（Esc）</button>
              </div>
            </div>
            {/* 目标位置（告警带 GPS 时显示） */}
            {typeof focusRow.lat === 'number' && typeof focusRow.lng === 'number' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 14px', background: alpha(CK.green, 0.06), borderBottom: `1px solid ${alpha(CK.borderSoft, 0.3)}`, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, color: CK.green, ...mono }}>📍 {focusRow.lat.toFixed(6)}, {focusRow.lng.toFixed(6)}</span>
                <a href={`https://map.qq.com/?pt=${focusRow.lat},${focusRow.lng}`} target="_blank" rel="noreferrer"
                  style={{ fontSize: 11, color: CK.cyan, textDecoration: 'none', borderBottom: `1px dashed ${alpha(CK.cyan, 0.4)}` }}>腾讯地图打开</a>
                <a href={`https://uri.amap.com/marker?position=${focusRow.lng},${focusRow.lat}&name=焚烧疑似点`} target="_blank" rel="noreferrer"
                  style={{ fontSize: 11, color: CK.cyan, textDecoration: 'none', borderBottom: `1px dashed ${alpha(CK.cyan, 0.4)}` }}>高德地图打开</a>
              </div>
            )}
            {/* 大图 */}
            <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000', padding: 10 }}>
              <div style={{ position: 'relative', maxWidth: '100%', maxHeight: '70vh', lineHeight: 0 }}>
                <RetryImg src={srcOf(focusRow.frame_path) || ''} style={{ maxWidth: '100%', maxHeight: '70vh', width: 'auto', height: 'auto' }}
                  onLoad={e => {
                    const nw = (e.target as HTMLImageElement).naturalWidth, nh = (e.target as HTMLImageElement).naturalHeight
                    if (nw && nh) setImgSizes(prev => (prev[focusRow.id] ? prev : { ...prev, [focusRow.id]: { w: nw, h: nh } }))
                  }} />
                {(() => { const sz = imgSizes[focusRow.id]; const iw = sz?.w || 2942, ih = sz?.h || 1732
                return (focusRow.boxes || []).map((b, i) => (
                  <div key={i} style={{
                    position: 'absolute',
                    left: `${(b.x1 / iw) * 100}%`, top: `${(b.y1 / ih) * 100}%`,
                    width: `${((b.x2 - b.x1) / iw) * 100}%`, height: `${((b.y2 - b.y1) / ih) * 100}%`,
                    border: `2px solid ${clsColor(b.cls)}`, boxSizing: 'border-box',
                  }}>
                    <span style={{ position: 'absolute', top: -16, left: 0, background: clsColor(b.cls), color: '#000', fontSize: 10, padding: '0 4px', borderRadius: 2, fontWeight: 600, lineHeight: '14px' }}>
                      {clsName(b.cls)} {b.conf.toFixed(2)}
                    </span>
                  </div>
                )) })()}
              </div>
            </div>
            {/* 画框区 */}
            {drawingId === focusRow.id && (
              <div style={{ padding: '8px 14px 0', borderTop: `1px solid ${alpha(CK.borderSoft, 0.4)}` }}>
                <BoxDrawer src={srcOf(focusRow.frame_path) || ''} initialBoxes={focusRow.boxes || []} cls={boxCls} onClsChange={setBoxCls} onSave={boxes => saveBoxes(focusRow.id, boxes)} onCancel={() => setDrawingId(null)} />
              </div>
            )}
            {/* 最近操作反馈 */}
            {lastAction && (
              <div style={{ padding: '5px 14px', background: 'rgba(0,230,118,0.08)', borderTop: `1px solid ${alpha(CK.green, 0.2)}`, fontSize: 11, color: CK.green }}>
                ✓ #{lastAction.id} 已复检（{lastAction.label === 'true' ? '真烟' : lastAction.label === 'false' ? '误报' : lastAction.label === '画框' ? '画框补标 → 真烟' : lastAction.label}）· 按 5/Ctrl+Z 可撤销
              </div>
            )}
            {/* 操作栏（含画框类别切换，底部吸底固定，避免被画布框遮挡） */}
            <div style={{ display: 'flex', gap: 8, padding: '10px 14px', borderTop: `1px solid ${alpha(CK.borderSoft, 0.4)}`, flexWrap: 'wrap', alignItems: 'center', position: 'sticky', bottom: 0, zIndex: 10, background: 'rgba(4,18,40,0.97)', boxShadow: '0 -2px 8px rgba(0,0,0,0.4)' }}>
              <span style={{ fontSize: 11, color: CK.textDim }}>画框类别:</span>
              <button onClick={() => setBoxCls(0)} style={btn(boxCls === 0 ? alpha(CK.cyan, 0.25) : 'rgba(0,20,50,0.4)', boxCls === 0 ? CK.cyan : CK.textSub, boxCls === 0 ? alpha(CK.cyan, 0.6) : alpha(CK.borderSoft, 0.6))}>烟</button>
              <button onClick={() => setBoxCls(1)} style={btn(boxCls === 1 ? alpha(CK.red, 0.25) : 'rgba(0,20,50,0.4)', boxCls === 1 ? CK.red : CK.textSub, boxCls === 1 ? alpha(CK.red, 0.6) : alpha(CK.borderSoft, 0.6))}>火</button>
              <button onClick={() => setBoxCls(2)} style={btn(boxCls === 2 ? alpha(CK.amber, 0.25) : 'rgba(0,20,50,0.4)', boxCls === 2 ? CK.amber : CK.textSub, boxCls === 2 ? alpha(CK.amber, 0.6) : alpha(CK.borderSoft, 0.6))}>房</button>
              <button onClick={() => { submit(focusRow.id, 'true'); gotoFocus(1) }} style={btn(alpha(CK.green, 0.2), CK.green, alpha(CK.green, 0.5))}>1 · 真烟</button>
              <button onClick={() => { submit(focusRow.id, 'false'); gotoFocus(1) }} style={btn(alpha(CK.red, 0.2), CK.red, alpha(CK.red, 0.5))}>2 · 误报</button>
              <button onClick={() => setDrawingId(focusRow.id)} style={btn(alpha(CK.cyan, 0.2), CK.cyan, alpha(CK.cyan, 0.5))}>3 · 画框</button>
              <button onClick={() => gotoFocus(-1)} style={btn('rgba(0,20,50,0.4)', CK.textSub, alpha(CK.border, 0.3))}>← 上一张</button>
              <button onClick={() => gotoFocus(1)} style={btn('rgba(0,20,50,0.4)', CK.textSub, alpha(CK.border, 0.3))}>下一张 →</button>
            </div>
            {/* 快捷键帮助浮层 */}
            {showHelp && (
              <div style={{ position: 'absolute', inset: 0, background: 'rgba(2,8,20,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5 }}>
                <div style={{ background: 'rgba(4,18,40,0.98)', border: `1px solid ${alpha(CK.cyan, 0.4)}`, borderRadius: 10, padding: '18px 24px', minWidth: 340, boxShadow: '0 8px 40px rgba(0,0,0,0.5)' }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: CK.cyan, marginBottom: 12 }}>⌨️ 快捷键速查</div>
                  {([
                    ['1', '真烟（保存后跳下一张）'],
                    ['2', '误报（保存后跳下一张）'],
                    ['3', '画框补标（保存后停留本张，可画多个框）'],
                    ['5 / Ctrl+Z', '撤销上一步（回退到待复检）'],
                    ['← →', '上一张 / 下一张'],
                    ['Esc', '退出弹层'],
                    ['h', '打开 / 关闭本帮助'],
                  ] as const).map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', gap: 10, marginBottom: 6, fontSize: 12, color: CK.textMain }}>
                      <span style={{ minWidth: 96, color: CK.cyan, ...mono, textAlign: 'right' }}>{k}</span>
                      <span style={{ color: CK.textDim }}>{v}</span>
                    </div>
                  ))}
                  <div style={{ marginTop: 10, fontSize: 11, color: CK.textFaint }}>再次按 h 或 Esc 关闭</div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
