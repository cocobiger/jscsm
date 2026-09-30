import { useState, useEffect, useCallback, useRef } from 'react'
import { StrawResultsView } from './StrawResultsView'
import { authFetch } from '../../lib/apiFetch'
import { Search, Camera } from 'lucide-react'

// ── 真烟样本工作台：模式A=检测结果复检 / 模式B=真烟采集（历史录制→隔离区→画框标注）──
// 标注画布复用 v3 单画布交互：画烟框(红) + 干扰框(青,带类型) + 自动跳下一张 + 快捷键

const CYAN = '#00aaff', GREEN = '#4ade80', RED = '#ff4444', AMBER = '#ffb74d', PURPLE = '#ab47bc'
const CAT_COLOR: Record<string, string> = { day: GREEN, dusk: AMBER, night: '#8ab4f8' }
const CAT_NAME: Record<string, string> = { day: '白天', dusk: '黄昏', night: '纯黑夜' }
const TYPE_NAME: Record<string, string> = { cloud: '云彩', water: '水面反光', veg: '植被', bldg: '建筑', other: '其他' }
const TYPE_KEYS = ['cloud', 'water', 'veg', 'bldg', 'other']

interface RecItem { name: string; path: string; mtime: string; size: number }
interface QuarItem { file: string; cat: string; brightness: number; has_box: boolean; verdict?: string; boxes?: any[]; addedAt?: string; movedAt?: string; invalid?: boolean; deleted?: boolean }

const card: React.CSSProperties = { background: 'rgba(4,14,35,0.7)', border: '1px solid rgba(0,80,150,0.25)', borderRadius: 8, padding: '14px 16px' }

export function SmokeSampleWorkbench() {
  const [mode, setMode] = useState<'review' | 'collect'>('review')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: 'calc(100vh - 190px)', overflowY: 'auto', paddingRight: 6 }}>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        {([
          ['review', '检测结果复检', Search],
          ['collect', '真烟采集（历史录制）', Camera],
        ] as const).map(([key, label, Icon]) => (
          <button key={key} onClick={() => setMode(key)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 18px', fontSize: 13, borderRadius: 4, cursor: 'pointer', fontWeight: 600,
            border: `1px solid ${mode === key ? PURPLE : 'rgba(171,71,188,0.25)'}`,
            background: mode === key ? 'rgba(171,71,188,0.15)' : 'transparent', color: mode === key ? PURPLE : '#5a8aaa',
          }}>{Icon && <Icon size={14} strokeWidth={1.75} />}{label}</button>
        ))}
      </div>
      {mode === 'review' ? <StrawResultsView /> : <CollectPanel />}
    </div>
  )
}

function CollectPanel() {
  const [records, setRecords] = useState<RecItem[]>([])
  const [selRec, setSelRec] = useState('')
  const [step, setStep] = useState(8)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [items, setItems] = useState<QuarItem[]>([])
  const [byCat, setByCat] = useState<Record<string, number>>({})
  const [catFilter, setCatFilter] = useState('')
  const [verFilter, setVerFilter] = useState('')
  const [annotating, setAnnotating] = useState<number | null>(null)  // 当前标注的样本索引
  const [inspect, setInspect] = useState<any>(null)
  const [ingMsg, setIngMsg] = useState('')
  const [multi, setMulti] = useState(false)                     // 多选模式
  const [sel, setSel] = useState<Set<string>>(new Set())        // 选中集合 "cat|file"
  const [trashView, setTrashView] = useState(false)             // 回收站视图
  const [markMsg, setMarkMsg] = useState('')
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  const loadQuar = useCallback(() => {
    authFetch('/api/collect/quarantine').then(r => r.json()).then(d => {
      if (d && d.ok) { setItems(d.items || []); setByCat(d.byCat || {}) }
    }).catch(() => {})
  }, [])
  const loadRec = useCallback(() => {
    authFetch('/api/collect/records').then(r => r.json()).then(d => {
      if (d && d.ok && Array.isArray(d.items)) setRecords(d.items)
    }).catch(() => {})
  }, [])
  useEffect(() => { loadRec(); loadQuar() }, [loadRec, loadQuar])

  const extract = async () => {
    if (!selRec) { setMsg('请先选择录制'); return }
    setBusy(true); setMsg('抽帧中（约 1~3 分钟）…')
    try {
      const r = await authFetch('/api/collect/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: selRec, step }) }).then(x => x.json())
      if (r && r.ok) setMsg(`抽帧完成：${r.extracted} 帧 → 白天 ${r.deposited.day} / 黄昏 ${r.deposited.dusk} / 黑夜 ${r.deposited.night}`)
      else setMsg('抽帧失败：' + (r?.error || '未知'))
      loadQuar()
    } catch (e) { setMsg('抽帧异常：' + (e as Error).message) }
    setBusy(false)
  }

  const submitAnnotate = async (cat: string, file: string, verdict: string, boxes: any[]) => {
    await authFetch('/api/collect/annotate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cat, file, verdict, boxes }) }).then(r => r.json()).catch(() => {})
    loadQuar()
  }

  const doInspect = async () => {
    const r = await authFetch('/api/collect/inspect').then(x => x.json()).catch(() => null)
    setInspect(r)
  }

  const doMark = async (items: { cat: string; file: string }[], action: 'invalid' | 'delete' | 'restore') => {
    let reason = ''
    if (action === 'delete' && items.length >= 10) {
      reason = window.prompt(`确认把 ${items.length} 张移入回收站？可填原因（留空直接确定）`) ?? '__CANCEL__'
      if (reason === '__CANCEL__') return
    }
    const r = await authFetch('/api/collect/mark', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, action, reason }),
    }).then(x => x.json()).catch(() => null)
    if (r && r.ok) {
      setMarkMsg(`${action === 'invalid' ? '已标记无效' : action === 'delete' ? '已移入回收站' : '已恢复'} ${r.affected} 张`)
      setSel(new Set())
      loadQuar()
      setTimeout(() => setMarkMsg(''), 3000)
    } else setMarkMsg('操作失败：' + (r?.error || '未知'))
  }
  const doIngest = async () => {
    const r = await authFetch('/api/collect/ingest', { method: 'POST' }).then(x => x.json()).catch(() => null)
    if (r && r.ingest) { setIngMsg(`✅ 入集成功：${r.added} 帧 → 子集 ${r.sub}`); setInspect(null) }
    else setIngMsg(`⛔ 入集失败：${r?.error || '未知'}`)
    loadQuar()
  }

  const filtered = items.filter(i => {
    if (trashView) return i.deleted
    if (i.deleted || i.invalid) return false
    return (!catFilter || i.cat === catFilter) && (!verFilter || (verFilter === 'todo' ? !i.verdict : i.verdict === verFilter))
  })
  const doneCount = items.filter(i => i.verdict && !i.deleted).length
  const invalDel = {
    invalid: items.filter(i => i.invalid && !i.deleted).length,
    deleted: items.filter(i => i.deleted).length,
  }
  const visibleCount = items.length - invalDel.invalid - invalDel.deleted

  // 按时间倒序（新采集在前）
  const sorted = [...filtered].reverse()
  // 录制按日期分组（倒序）
  const recByDate: Record<string, RecItem[]> = {}
  records.forEach(r => { const d = (r.mtime || '').slice(0, 10); (recByDate[d] = recByDate[d] || []).push(r) })
  const recDates = Object.keys(recByDate).sort().reverse()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 数据源 + 抽帧 */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 700 }}>📼 历史录制</span>
          <select value={selRec} onChange={e => setSelRec(e.target.value)} style={{ background: 'rgba(4,14,35,0.8)', color: '#c8e6ff', border: '1px solid rgba(0,170,255,0.3)', borderRadius: 5, padding: '6px 10px', fontSize: 12, maxWidth: 400 }}>
            <option value="">— 选择录制（按日期倒序）—</option>
            {recDates.map(d => (
              <optgroup key={d} label={`📅 ${d}`}>
                {recByDate[d].map(r => <option key={r.path} value={r.path}>{r.mtime?.slice(11, 16)} · {r.name}</option>)}
              </optgroup>
            ))}
          </select>
          <span style={{ color: '#5a8aaa', fontSize: 12 }}>抽帧间隔</span>
          <select value={step} onChange={e => setStep(Number(e.target.value))} style={{ background: 'rgba(4,14,35,0.8)', color: '#c8e6ff', border: '1px solid rgba(0,170,255,0.3)', borderRadius: 5, padding: '6px 8px', fontSize: 12 }}>
            {[3, 5, 8, 10, 15].map(s => <option key={s} value={s}>每 {s} 秒</option>)}
          </select>
          <button onClick={extract} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 16px', fontSize: 13, borderRadius: 5, cursor: busy ? 'not-allowed' : 'pointer', background: busy ? 'rgba(0,170,255,0.1)' : '#1668dc', color: '#fff', border: '1px solid #1668dc', fontWeight: 700 }}>
            {busy ? '抽帧中…' : '🎬 抽帧采集'}
          </button>
        </div>
        {msg && <div style={{ marginTop: 8, fontSize: 12.5, color: msg.includes('完成') ? GREEN : AMBER }}>{msg}</div>}
      </div>

      {/* 隔离区清单 */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 700 }}>🧪 隔离区样本</span>
          <span style={{ fontSize: 12, color: '#5a8aaa' }}>
            {trashView
              ? `🗑 回收站 ${invalDel.deleted} 帧（可恢复）`
              : `共 ${visibleCount} 帧（白天 ${byCat.day ?? 0} / 黄昏 ${byCat.dusk ?? 0} / 黑夜 ${byCat.night ?? 0}）· 已标注 ${doneCount} / 未标 ${visibleCount - doneCount}${invalDel.invalid ? ` · 已标记无效 ${invalDel.invalid}` : ''}`}
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={() => { setMulti(!multi); setSel(new Set()) }} style={{
            padding: '3px 12px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
            border: `1px solid ${multi ? '#1668dc' : 'rgba(22,104,220,0.35)'}`,
            background: multi ? 'rgba(22,104,220,0.18)' : 'transparent', color: multi ? '#7fb8ff' : '#5a8aaa', fontWeight: multi ? 700 : 400,
          }}>{multi ? '✓ 退出多选' : '☑ 多选'}</button>
          <button onClick={() => { setTrashView(!trashView); setSel(new Set()); setCatFilter(''); setVerFilter('') }} style={{
            padding: '3px 12px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
            border: `1px solid ${trashView ? '#d46b08' : 'rgba(212,107,8,0.35)'}`,
            background: trashView ? 'rgba(212,107,8,0.15)' : 'transparent', color: trashView ? '#ffb74d' : '#5a8aaa', fontWeight: trashView ? 700 : 400,
          }}>{trashView ? '← 返回清单' : `🗑 回收站 (${invalDel.deleted})`}</button>
          {markMsg && <span style={{ fontSize: 12, color: GREEN }}>{markMsg}</span>}
          {['', 'day', 'dusk', 'night'].map(k => (
            <button key={k || 'all'} onClick={() => setCatFilter(k)} style={{ padding: '3px 12px', fontSize: 11, borderRadius: 4, cursor: 'pointer', border: `1px solid ${catFilter === k ? CYAN : 'rgba(0,170,255,0.25)'}`, background: catFilter === k ? 'rgba(0,170,255,0.12)' : 'transparent', color: catFilter === k ? CYAN : '#5a8aaa' }}>{k === '' ? '全部' : CAT_NAME[k]}</button>
          ))}
          <span style={{ width: 1, height: 18, background: 'rgba(0,150,220,.3)' }} />
          {[['', '全部状态'], ['todo', '未标注'], ['ok', '✅真烟'], ['wrong', '❌误报'], ['unsure', '❓不确定']].map(([k, l]) => (
            <button key={k} onClick={() => setVerFilter(k)} style={{ padding: '3px 12px', fontSize: 11, borderRadius: 4, cursor: 'pointer', border: `1px solid ${verFilter === k ? GREEN : 'rgba(74,222,128,0.25)'}`, background: verFilter === k ? 'rgba(74,222,128,0.12)' : 'transparent', color: verFilter === k ? GREEN : '#5a8aaa' }}>{l}</button>
          ))}
        </div>
        {/* 体检 + 入集（防污染闸） */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
          <button onClick={doInspect} style={{ padding: '6px 14px', fontSize: 12, borderRadius: 5, cursor: 'pointer', border: '1px solid rgba(0,170,255,0.4)', background: 'rgba(0,170,255,0.1)', color: CYAN, fontWeight: 600 }}>🧪 体检（6 道闸）</button>
          <button onClick={doIngest} disabled={!inspect?.allpass} style={{ padding: '6px 14px', fontSize: 12, borderRadius: 5, cursor: inspect?.allpass ? 'pointer' : 'not-allowed', border: '1px solid rgba(74,222,128,0.4)', background: inspect?.allpass ? 'rgba(74,222,128,0.15)' : 'rgba(74,222,128,0.05)', color: inspect?.allpass ? GREEN : '#3a5568', fontWeight: 700 }}>⬆ 配平入集</button>
          {inspect?.counts && <span style={{ fontSize: 12, color: '#7ab8e0' }}>真烟 {inspect.counts.ok} / 误报 {inspect.counts.wrong} / 不确定 {inspect.counts.unsure}</span>}
          {ingMsg && <span style={{ fontSize: 12, color: ingMsg.includes('✅') ? GREEN : RED }}>{ingMsg}</span>}
        </div>
        {inspect?.gates && (
          <div style={{ marginTop: 8, border: '1px solid rgba(0,150,220,0.2)', borderRadius: 6, padding: '8px 12px', background: 'rgba(4,14,35,0.5)' }}>
            {inspect.gates.map((g: any, i: number) => (
              <div key={i} style={{ display: 'flex', gap: 8, fontSize: 12, padding: '2px 0', alignItems: 'center' }}>
                <span style={{ color: g.pass ? GREEN : RED, flexShrink: 0, fontWeight: 700 }}>{g.pass ? '✅' : '❌'}</span>
                <span style={{ color: '#9ad6f0', flexShrink: 0, width: 80 }}>{g.name}</span>
                <span style={{ color: g.pass ? '#5a8aaa' : '#ff8a80' }}>{g.detail}</span>
              </div>
            ))}
            {!inspect.allpass && <div style={{ fontSize: 11.5, color: AMBER, marginTop: 4 }}>⚠️ 有闸门未通过，入集被阻断。请继续采集/标注，攒够数量并配平后再试。</div>}
          </div>
        )}
        {/* 批量操作条（多选模式） */}
        {multi && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, padding: '8px 12px', background: 'rgba(22,104,220,0.1)', border: '1px solid rgba(22,104,220,0.3)', borderRadius: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: '#7fb8ff', fontWeight: 700 }}>已选 {sel.size} 张</span>
            <button onClick={() => setSel(new Set(sorted.map(x => x.cat + '|' + x.file)))} style={{ padding: '4px 12px', fontSize: 12, borderRadius: 4, cursor: 'pointer', border: '1px solid rgba(22,104,220,0.4)', background: 'transparent', color: '#7fb8ff' }}>全选当前（{sorted.length}）</button>
            <button onClick={() => setSel(new Set())} style={{ padding: '4px 12px', fontSize: 12, borderRadius: 4, cursor: 'pointer', border: '1px solid rgba(90,107,122,0.5)', background: 'transparent', color: '#8b9aab' }}>清空选择</button>
            <span style={{ flex: 1 }} />
            {trashView ? (
              <button disabled={!sel.size} onClick={() => doMark([...sel].map(k => ({ cat: k.split('|')[0], file: k.split('|')[1] })), 'restore')}
                style={{ padding: '6px 16px', fontSize: 13, borderRadius: 5, cursor: sel.size ? 'pointer' : 'not-allowed', border: '1px solid #4ade80', background: sel.size ? 'rgba(74,222,128,0.15)' : 'transparent', color: sel.size ? GREEN : '#3a5568', fontWeight: 700 }}>↩ 批量恢复</button>
            ) : (
              <>
                <button disabled={!sel.size} onClick={() => doMark([...sel].map(k => ({ cat: k.split('|')[0], file: k.split('|')[1] })), 'invalid')}
                  style={{ padding: '6px 16px', fontSize: 13, borderRadius: 5, cursor: sel.size ? 'pointer' : 'not-allowed', border: '1px solid #ffb74d', background: sel.size ? 'rgba(255,183,77,0.15)' : 'transparent', color: sel.size ? AMBER : '#3a5568', fontWeight: 700 }}>⊘ 批量标记无效</button>
                <button disabled={!sel.size} onClick={() => doMark([...sel].map(k => ({ cat: k.split('|')[0], file: k.split('|')[1] })), 'delete')}
                  style={{ padding: '6px 16px', fontSize: 13, borderRadius: 5, cursor: sel.size ? 'pointer' : 'not-allowed', border: '1px solid #ff4444', background: sel.size ? 'rgba(255,68,68,0.15)' : 'transparent', color: sel.size ? RED : '#3a5568', fontWeight: 700 }}>✕ 批量移入回收站</button>
              </>
            )}
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8, marginTop: 10 }}>
          {sorted.length === 0 && <div style={{ color: '#5a8aaa', fontSize: 12 }}>暂无样本（先抽帧采集）</div>}
          {sorted.map((it, i) => {
            const key = it.cat + '|' + it.file
            const isSel = sel.has(key)
            return (
            <div key={i}
              onClick={() => { if (multi) { const s = new Set(sel); isSel ? s.delete(key) : s.add(key); setSel(s) } else setAnnotating(i) }}
              onMouseEnter={() => setHoverIdx(i)} onMouseLeave={() => setHoverIdx(null)}
              style={{ background: 'rgba(4,14,35,0.85)', border: `1px solid ${isSel ? '#1668dc' : 'rgba(0,80,150,0.25)'}`, borderRadius: 6, overflow: 'hidden', cursor: multi ? 'pointer' : 'zoom-in', position: 'relative' }}>
              <div style={{ position: 'relative', aspectRatio: '4/3', background: '#0a1a2e' }}>
                <img src={`/api/collect/image?cat=${it.cat}&file=${encodeURIComponent(it.file)}`} alt={it.file} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
                <span style={{ position: 'absolute', left: 5, top: 5, fontSize: 10, padding: '1px 7px', borderRadius: 8, background: CAT_COLOR[it.cat], color: '#04101f', fontWeight: 700 }}>{CAT_NAME[it.cat]}</span>
                {it.verdict && !multi && <span style={{ position: 'absolute', right: 5, top: 5, fontSize: 10, padding: '1px 7px', borderRadius: 8, background: it.verdict === 'ok' ? GREEN : it.verdict === 'wrong' ? RED : AMBER, color: '#04101f', fontWeight: 700 }}>{it.verdict === 'ok' ? '✅真烟' : it.verdict === 'wrong' ? '❌误报' : '❓不确定'}</span>}
                {/* 多选勾选框 */}
                {multi && <span style={{ position: 'absolute', left: 5, top: 5, width: 18, height: 18, borderRadius: 4, border: `2px solid ${isSel ? '#1668dc' : '#5a6b7a'}`, background: isSel ? '#1668dc' : 'rgba(0,0,0,.5)', color: '#fff', fontSize: 12, lineHeight: '16px', textAlign: 'center', fontWeight: 700 }}>{isSel ? '✓' : ''}</span>}
                {/* hover 操作按钮（非多选模式）*/}
                {!multi && hoverIdx === i && (
                  <div style={{ position: 'absolute', right: 5, bottom: 5, display: 'flex', gap: 4 }}>
                    {trashView ? (
                      <button onClick={e => { e.stopPropagation(); doMark([{ cat: it.cat, file: it.file }], 'restore') }}
                        style={{ padding: '3px 8px', fontSize: 11, borderRadius: 4, border: '1px solid #4ade80', background: 'rgba(74,222,128,.9)', color: '#04101f', cursor: 'pointer', fontWeight: 700 }}>↩ 恢复</button>
                    ) : (
                      <>
                        <button onClick={e => { e.stopPropagation(); doMark([{ cat: it.cat, file: it.file }], 'invalid') }}
                          title="标记无效（隐藏但保留数据）"
                          style={{ padding: '3px 8px', fontSize: 11, borderRadius: 4, border: '1px solid #ffb74d', background: 'rgba(255,183,77,.9)', color: '#04101f', cursor: 'pointer', fontWeight: 700 }}>⊘ 无效</button>
                        <button onClick={e => { e.stopPropagation(); doMark([{ cat: it.cat, file: it.file }], 'delete') }}
                          title="移入回收站（可恢复）"
                          style={{ padding: '3px 8px', fontSize: 11, borderRadius: 4, border: '1px solid #ff4444', background: 'rgba(255,68,68,.9)', color: '#fff', cursor: 'pointer', fontWeight: 700 }}>✕ 删除</button>
                      </>
                    )}
                  </div>
                )}
              </div>
              <div style={{ padding: '4px 7px', fontSize: 10, color: '#5a8aaa', fontFamily: 'Consolas,monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {it.file} · 亮度 {Math.round(it.brightness)}<br />
                入库 {(it.addedAt || it.movedAt || '').slice(5, 16)}
              </div>
            </div>
            )
          })}
        </div>
      </div>

      {/* 标注画布模态（v3 交互：画框 + 自动跳下一张） */}
      {annotating != null && sorted[annotating] && (
        <AnnotateModal items={sorted} startIdx={annotating} onAnnotate={submitAnnotate} onClose={() => setAnnotating(null)} />
      )}
    </div>
  )
}

// ── 单画布标注器（移植 v3 交互）──
function AnnotateModal({ items, startIdx, onAnnotate, onClose }: {
  items: QuarItem[]; startIdx: number; onAnnotate: (cat: string, file: string, v: string, boxes: any[]) => void; onClose: () => void
}) {
  const [idx, setIdx] = useState(startIdx)
  const [mode, setMode] = useState<'smoke' | 'distractor'>('smoke')
  const [smoke, setSmoke] = useState<Box[]>([])
  const [dist, setDist] = useState<Box[]>([])
  const [draft, setDraft] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const [showType, setShowType] = useState(false)
  const [W, setW] = useState(960); const [H, setH] = useState(720)
  const imgRef = useRef<HTMLImageElement>(null)

  const it = items[idx]

  useEffect(() => {
    // 切样本时加载已有框 + 尺寸
    setSmoke((it.boxes || []).filter((b: any) => b.kind === 'smoke').map((b: any) => ({ x: b.x, y: b.y, w: b.w, h: b.h })))
    setDist((it.boxes || []).filter((b: any) => b.kind === 'distractor').map((b: any) => ({ x: b.x, y: b.y, w: b.w, h: b.h, t: b.type || 'cloud' })))
    const im = new Image()
    im.onload = () => { setW(im.naturalWidth); setH(im.naturalHeight) }
    im.src = `/api/collect/image?cat=${it.cat}&file=${encodeURIComponent(it.file)}`
  }, [idx, it])

  function pos(e: React.MouseEvent) {
    const r = imgRef.current!.getBoundingClientRect()
    return { x: Math.max(0, Math.min(W, (e.clientX - r.left) / r.width * W)), y: Math.max(0, Math.min(H, (e.clientY - r.top) / r.height * H)) }
  }
  function onDown(e: React.MouseEvent) {
    const p = pos(e); setDraft({ x1: p.x, y1: p.y, x2: p.x, y2: p.y })
  }
  function onMove(e: React.MouseEvent) {
    if (!draft) return
    const p = pos(e); setDraft({ ...draft, x2: p.x, y2: p.y })
  }
  function onUp() {
    if (!draft) return
    const x = Math.round(Math.min(draft.x1, draft.x2)), y = Math.round(Math.min(draft.y1, draft.y2))
    const w = Math.round(Math.abs(draft.x2 - draft.x1)), h = Math.round(Math.abs(draft.y2 - draft.y1))
    setDraft(null)
    if (w < 8 || h < 8) return
    if (mode === 'smoke') setSmoke(s => [...s, { x, y, w, h }])
    else { setShowType(true); (window as any).__pendingDist = { x, y, w, h } }
  }
  function pickType(t: string) {
    const b = (window as any).__pendingDist; setShowType(false)
    if (b) setDist(s => [...s, { ...b, t }])
    ;(window as any).__pendingDist = null
  }
  function undoBox() { mode === 'smoke' ? setSmoke(s => s.slice(0, -1)) : setDist(s => s.slice(0, -1)) }

  function judge(v: string) {
    const boxes = [...smoke.map(b => ({ ...b, kind: 'smoke' })), ...dist.map(b => ({ x: b.x, y: b.y, w: b.w, h: b.h, kind: 'distractor', type: b.t }))]
    onAnnotate(it.cat, it.file, v, boxes)
    // 跳下一个未判
    const next = items.find((x, i) => i > idx && !x.verdict)
    if (next) setIdx(items.indexOf(next))
    else onClose()
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); judge('ok') }
    else if (e.key === 'Escape') onClose()
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); undoBox() }
    else if (e.key === 'x' || e.key === 'X') judge('wrong')
    else if (e.key === 'u' || e.key === 'U') judge('unsure')
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(2,8,20,0.92)', zIndex: 9999, display: 'flex', flexDirection: 'column' }} onKeyDown={onKey} tabIndex={0}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 14px', background: '#0d1117', borderBottom: '1px solid #30363d', flexWrap: 'wrap' }}>
        <span style={{ color: '#58a6ff', fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {it.file} · <span style={{ color: CAT_COLOR[it.cat] }}>{CAT_NAME[it.cat]}</span> · {W}×{H} · 第 {idx + 1}/{items.length}
        </span>
        <span style={{ color: '#7ab8e0', fontSize: 12 }}>框类型：</span>
        <button onClick={e => { e.stopPropagation(); setMode('smoke') }} style={mbtn(mode === 'smoke')}>烟羽（红框）</button>
        <button onClick={e => { e.stopPropagation(); setMode('distractor') }} style={mbtn(mode === 'distractor')}>干扰区（青框）</button>
        <button onClick={e => { e.stopPropagation(); undoBox() }} style={{ padding: '5px 12px', fontSize: 12, borderRadius: 5, cursor: 'pointer', border: '1px solid #30363d', background: '#21262d', color: '#c9d1d9' }}>↩ 撤销框</button>
        <button onClick={e => { e.stopPropagation(); judge('ok') }} style={{ padding: '6px 14px', fontSize: 13, borderRadius: 5, cursor: 'pointer', border: '1px solid #4ade80', background: 'rgba(74,222,128,0.15)', color: '#4ade80', fontWeight: 700 }}>✅ 真烟</button>
        <button onClick={e => { e.stopPropagation(); judge('wrong') }} style={{ padding: '6px 14px', fontSize: 13, borderRadius: 5, cursor: 'pointer', border: '1px solid #ff4444', background: 'rgba(255,68,68,0.15)', color: '#ff4444', fontWeight: 700 }}>❌ 误报</button>
        <button onClick={e => { e.stopPropagation(); judge('unsure') }} style={{ padding: '6px 14px', fontSize: 13, borderRadius: 5, cursor: 'pointer', border: '1px solid #ffb74d', background: 'rgba(255,183,77,0.15)', color: '#ffb74d', fontWeight: 700 }}>❓ 不确定</button>
        <button onClick={e => { e.stopPropagation(); onClose() }} style={{ padding: '6px 12px', fontSize: 12, borderRadius: 5, cursor: 'pointer', border: '1px solid rgba(255,68,68,0.4)', background: 'rgba(255,68,68,0.12)', color: '#ff8a80' }}>✕ 关闭</button>
      </div>
      <div onClick={e => e.stopPropagation()} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden', cursor: 'crosshair' }}
        onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp}>
        <div style={{ position: 'relative' }}>
          <img ref={imgRef} src={`/api/collect/image?cat=${it.cat}&file=${encodeURIComponent(it.file)}`} alt={it.file} style={{ maxWidth: '92vw', maxHeight: '78vh', display: 'block', userSelect: 'none' }} draggable={false} />
          {smoke.map((b, i) => <div key={'s' + i} style={{ position: 'absolute', left: b.x / W * 100 + '%', top: b.y / H * 100 + '%', width: b.w / W * 100 + '%', height: b.h / H * 100 + '%', border: '2px solid #ff4444', boxSizing: 'border-box', pointerEvents: 'none' }}><b style={{ position: 'absolute', left: -2, top: -17, fontSize: 11, background: '#ff4444', color: '#fff', padding: '0 4px', borderRadius: 3, whiteSpace: 'nowrap' }}>烟羽</b></div>)}
          {dist.map((b, i) => <div key={'d' + i} style={{ position: 'absolute', left: b.x / W * 100 + '%', top: b.y / H * 100 + '%', width: b.w / W * 100 + '%', height: b.h / H * 100 + '%', border: '2px dashed #22d3ee', boxSizing: 'border-box', pointerEvents: 'none' }}><b style={{ position: 'absolute', left: -2, top: -17, fontSize: 11, background: '#22d3ee', color: '#04101f', padding: '0 4px', borderRadius: 3, whiteSpace: 'nowrap' }}>{TYPE_NAME[b.t || 'cloud']}</b></div>)}
          {draft && (() => { const x = Math.min(draft.x1, draft.x2), y = Math.min(draft.y1, draft.y2), w = Math.abs(draft.x2 - draft.x1), h = Math.abs(draft.y2 - draft.y1); return <div style={{ position: 'absolute', left: x / W * 100 + '%', top: y / H * 100 + '%', width: w / W * 100 + '%', height: h / H * 100 + '%', border: '2px dashed #ffd33d', background: 'rgba(255,211,61,.15)', boxSizing: 'border-box', pointerEvents: 'none' }} /> })()}
          {showType && (
            <div onClick={e => e.stopPropagation()} style={{ position: 'absolute', left: 10, bottom: 10, background: '#0d1117', border: '1px solid #22d3ee', borderRadius: 6, padding: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {TYPE_KEYS.map(k => <button key={k} onClick={() => pickType(k)} style={{ border: '1px solid #30363d', background: '#21262d', color: '#c9d1d9', borderRadius: 4, padding: '5px 10px', fontSize: 12, cursor: 'pointer' }}>{TYPE_NAME[k]}</button>)}
            </div>
          )}
        </div>
        <div style={{ position: 'absolute', left: 12, bottom: 12, fontSize: 11, fontFamily: 'Consolas,monospace', background: 'rgba(0,0,0,.7)', color: '#8b949e', padding: '3px 8px', borderRadius: 4 }}>
          拖拽画框 · Enter=真烟 X=误报 U=不确定 · Delete=删框 · Esc=关闭
        </div>
      </div>
    </div>
  )
}
function mbtn(on: boolean): React.CSSProperties {
  return { padding: '5px 12px', fontSize: 12, borderRadius: 5, cursor: 'pointer', border: on ? '1px solid #fff' : '1px solid #30363d', background: on ? '#fff' : '#21262d', color: on ? '#0a1628' : '#c9d1d9', fontWeight: 700 }
}
interface Box { x: number; y: number; w: number; h: number; t?: string }
