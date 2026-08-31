import { useState, useEffect, useCallback, useMemo } from 'react'
import { authFetch } from '../../lib/apiFetch'
import { CheckCircle2, XCircle, HelpCircle, ChevronLeft, ChevronRight, Download, RotateCcw, ScanEye } from 'lucide-react'

// ── 负样本抽检标注（P3-2a）──
// 数据源：GET /api/straw/neg-classify（VLM 干扰物分类 + 人工复核记录）
// 提交：POST /api/review/neg-classify（upsert，同一帧重复提交覆盖）
// 图片：/api/review/image?path=record/<rel>（鉴权代理 + 缩略图）

const CYAN = '#00aaff'
const GREEN = '#4ade80'
const RED = '#ff4444'
const AMBER = '#ffb74d'
const PURPLE = '#bc8cff'
const GRAY = '#7d8590'

const CAT_COLORS: Record<string, string> = {
  pole: PURPLE,
  concrete: '#d29922',
  cloud: CYAN,
  building: GREEN,
  reflection: '#42b0e8',  // 水面 / 天空青色（江面倒影）
  none: GRAY,
  other: RED,
}
const CATS = ['pole', 'concrete', 'cloud', 'building', 'reflection', 'none', 'other']

const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  ok: { label: '✅ 正确', color: GREEN, bg: 'rgba(74,222,128,0.12)' },
  no: { label: '❌ 错误', color: RED, bg: 'rgba(255,68,68,0.12)' },
  dn: { label: '❓ 不确定', color: AMBER, bg: 'rgba(255,183,77,0.12)' },
}

const card: React.CSSProperties = {
  background: 'rgba(4,14,35,0.7)',
  border: '1px solid rgba(0,80,150,0.25)',
  borderRadius: 8,
  padding: '14px 16px',
}

interface Frame {
  fp: string
  rel: string
  cats: string[]
  raw: string
  ts: string
  review: string
  reviewer: string
  reviewedAt: string
  note: string
}

interface Stats {
  total: number
  reviewed: number
  byStatus: Record<string, number>
}

export function NegClassifyVerify() {
  const [frames, setFrames] = useState<Frame[]>([])
  const [stats, setStats] = useState<Stats>({ total: 0, reviewed: 0, byStatus: { ok: 0, no: 0, dn: 0, pending: 0 } })
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [filter, setFilter] = useState<'all' | 'pending' | 'ok' | 'no' | 'dn'>('pending')
  const [curIdx, setCurIdx] = useState(0)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const d = await authFetch('/api/straw/neg-classify').then(r => r.json())
      if (!d.ok) throw new Error(d.error || '加载失败')
      const map: Record<string, any> = {}
      for (const r of d.reviews || []) map[r.frame_path] = r
      const list: Frame[] = Object.entries(d.catalog || {}).map(([fp, v]: [string, any]) => {
        const rv = map[fp] || {}
        return {
          fp,
          rel: fp.replace('/video/shujuji/datasets/v5_candidates/', ''),
          cats: Array.isArray(v.cats) ? v.cats : [],
          raw: v.raw || '',
          ts: v.ts || '',
          review: rv.review_status === 'pending' ? '' : rv.review_status || '',
          reviewer: rv.reviewer || '',
          reviewedAt: rv.reviewed_at || '',
          note: rv.note || '',
        }
      })
      setFrames(list)
      setStats(d.stats || { total: list.length, reviewed: 0, byStatus: { ok: 0, no: 0, dn: 0, pending: list.length } })
      setCurIdx(0)
    } catch (e: any) {
      setErr(e?.message || String(e))
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    if (filter === 'all') return frames
    return frames.filter(f => (filter === 'pending' ? !f.review : f.review === filter))
  }, [frames, filter])

  const cur = filtered[curIdx] || null
  const imgUrl = cur ? `/api/review/image?path=${encodeURIComponent(cur.rel)}&w=1400` : ''
  const thumbUrl = (f: Frame) => `/api/review/image?path=${encodeURIComponent(f.rel)}&w=180`

  const submit = async (review: string) => {
    if (!cur || busy) return
    setBusy(true); setMsg('')
    try {
      const r = await authFetch('/api/review/neg-classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frame_path: cur.fp, review_status: review }),
      })
      const d = await r.json()
      if (!d.ok) throw new Error(d.error || '提交失败')
      setFrames(list => list.map(f => f.fp === cur.fp ? { ...f, review, reviewer: d.reviewer || '', reviewedAt: new Date().toLocaleString('zh-CN') } : f))
      // 同步本地统计
      setStats(s => {
        const by = { ...s.byStatus }
        const prev = cur.review || 'pending'
        by[prev] = Math.max(0, (by[prev] || 0) - 1)
        by[review] = (by[review] || 0) + 1
        return { ...s, reviewed: s.reviewed + (prev ? 0 : 1), byStatus: by }
      })
      setMsg(`✓ 已提交 [${cur.rel}] → ${STATUS_META[review].label}`)
    } catch (e: any) {
      setMsg('提交失败: ' + (e?.message || e))
    }
    setBusy(false)
    setTimeout(() => setMsg(''), 3000)
  }

  const undo = async () => {
    if (!cur || busy || !cur.review) return
    setBusy(true)
    try {
      await authFetch('/api/review/neg-classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frame_path: cur.fp, review_status: 'pending' }),
      })
      setFrames(list => list.map(f => f.fp === cur.fp ? { ...f, review: '', reviewer: '', reviewedAt: '' } : f))
      setStats(s => ({ ...s, reviewed: Math.max(0, s.reviewed - 1), byStatus: { ...s.byStatus, [cur.review]: Math.max(0, (s.byStatus[cur.review] || 0) - 1), pending: (s.byStatus.pending || 0) + 1 } }))
      setMsg('↩ 已撤销该帧判定')
    } catch (e: any) {
      setMsg('撤销失败: ' + (e?.message || e))
    }
    setBusy(false)
    setTimeout(() => setMsg(''), 3000)
  }

  const exportCsv = () => {
    const lines = ['frame_path,cats,raw,review']
    for (const f of frames) {
      lines.push(`${f.fp},"${f.cats.join('|')}","${f.raw.replace(/"/g, '""')}",${f.review}`)
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `neg_verify_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const statCard = (label: string, value: number, color: string) => (
    <div style={{ ...card, textAlign: 'center' }}>
      <div style={{ fontSize: 11, color: '#5a8aaa' }}>{label}</div>
      <div style={{ color, fontSize: 22, fontWeight: 700, marginTop: 2 }}>{value}</div>
    </div>
  )

  const filterBtn = (key: typeof filter, label: string) => (
    <button onClick={() => { setFilter(key); setCurIdx(0) }} style={{
      padding: '4px 12px', fontSize: 12, borderRadius: 4, cursor: 'pointer', fontWeight: 600,
      border: `1px solid ${filter === key ? CYAN : 'rgba(0,150,220,0.3)'}`,
      background: filter === key ? 'rgba(0,150,220,0.15)' : 'transparent',
      color: filter === key ? CYAN : '#5a8aaa',
    }}>{label}</button>
  )

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#5a8aaa', fontSize: 13 }}>加载抽检数据…</div>
  }
  if (err) {
    return <div style={{ padding: 40, textAlign: 'center', color: RED, fontSize: 13 }}>加载失败：{err}
      <div style={{ marginTop: 12 }}><button onClick={load} style={{ padding: '6px 18px', cursor: 'pointer', borderRadius: 4, border: '1px solid rgba(0,150,220,0.3)', background: 'rgba(0,80,180,0.12)', color: '#7ab8e0' }}>重试</button></div>
    </div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 统计卡 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 12 }}>
        {statCard('总帧数', stats.total, '#c8e6ff')}
        {statCard('已审', stats.reviewed, CYAN)}
        {statCard('✅ 正确', stats.byStatus.ok || 0, GREEN)}
        {statCard('❌ 错误', stats.byStatus.no || 0, RED)}
        {statCard('❓ 不确定', stats.byStatus.dn || 0, AMBER)}
        {statCard('待审', stats.byStatus.pending || 0, PURPLE)}
      </div>

      {/* 操作栏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: '#5a8aaa' }}>筛选：</span>
        {filterBtn('pending', '待审')}
        {filterBtn('all', '全部')}
        {filterBtn('ok', '✅ 正确')}
        {filterBtn('no', '❌ 错误')}
        {filterBtn('dn', '❓ 不确定')}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#3a5a70' }}>
          {filtered.length} 帧 · 手动复核 VLM 干扰物分类，结果回流训练负样本
        </span>
        <button onClick={exportCsv} style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', fontSize: 12, cursor: 'pointer', borderRadius: 4,
          border: '1px solid rgba(0,150,220,0.3)', background: 'rgba(0,80,180,0.12)', color: '#7ab8e0',
        }}><Download size={13} strokeWidth={1.75} />导出 CSV</button>
        {msg && <span style={{ fontSize: 12, color: msg.startsWith('✓') || msg.startsWith('↩') ? GREEN : RED }}>{msg}</span>}
      </div>

      {filtered.length === 0 ? (
        <div style={{ ...card, textAlign: 'center', padding: '40px 0', color: '#3a5a70', fontSize: 13 }}>
          该筛选下暂无帧。切换筛选，或点击「刷新」拉取最新分类数据。
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 420px', gap: 14, alignItems: 'start' }}>
          {/* 主查看区 */}
          <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: '#c8e6ff', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <ScanEye size={14} strokeWidth={1.75} />抽检标注 [{curIdx + 1}/{filtered.length}]
              </span>
              <span style={{ fontSize: 11, color: '#3a5a70', fontFamily: "'JetBrains Mono', monospace" }}>{cur?.rel}</span>
              {cur?.review && (
                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 3, color: STATUS_META[cur.review].color, background: STATUS_META[cur.review].bg }}>
                  {STATUS_META[cur.review].label} {cur.reviewer ? `· ${cur.reviewer}` : ''} {cur.reviewedAt ? `· ${cur.reviewedAt}` : ''}
                </span>
              )}
              <span style={{ marginLeft: 'auto', fontSize: 11, color: '#3a5a70' }}>{cur?.ts || '?'}</span>
            </div>

            <div style={{ background: 'rgba(0,10,25,0.6)', borderRadius: 6, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 320 }}>
              {cur && <img key={cur.fp} src={imgUrl} alt={cur.rel} style={{ maxWidth: '100%', maxHeight: 520, objectFit: 'contain', display: 'block' }} />}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: '#5a8aaa' }}>VLM 判定：</span>
              {(cur?.cats || []).map(c => (
                <span key={c} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 3, color: CAT_COLORS[c] || '#fff', border: `1px solid ${CAT_COLORS[c] || '#888'}`, background: `${CAT_COLORS[c] || '#888'}22` }}>{c}</span>
              ))}
              {(!cur?.cats || cur.cats.length === 0) && <span style={{ fontSize: 11, color: '#3a5a70' }}>（无干扰物，可能误判为 none/other）</span>}
              {cur?.raw && <span style={{ fontSize: 10, color: '#3a5a70', fontFamily: "'JetBrains Mono', monospace" }}>raw: "{cur.raw.slice(0, 60)}"</span>}
            </div>

            {/* 三态 + 导航 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {(['ok', 'no', 'dn'] as const).map(k => (
                <button key={k} onClick={() => submit(k)} disabled={busy} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 18px', fontSize: 13, fontWeight: 700, cursor: busy ? 'wait' : 'pointer', borderRadius: 4,
                  border: cur?.review === k ? `1px solid ${STATUS_META[k].color}` : '1px solid rgba(0,150,220,0.25)',
                  background: cur?.review === k ? STATUS_META[k].bg : 'transparent',
                  color: cur?.review === k ? STATUS_META[k].color : '#5a8aaa',
                }}>
                  {k === 'ok' ? <CheckCircle2 size={14} strokeWidth={1.75} /> : k === 'no' ? <XCircle size={14} strokeWidth={1.75} /> : <HelpCircle size={14} strokeWidth={1.75} />}
                  {STATUS_META[k].label}
                </button>
              ))}
              {cur?.review && (
                <button onClick={undo} disabled={busy} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', fontSize: 12, cursor: 'pointer', borderRadius: 4,
                  border: '1px solid rgba(255,170,60,0.4)', background: 'rgba(255,170,60,0.1)', color: AMBER,
                }}><RotateCcw size={13} strokeWidth={1.75} />撤销</button>
              )}
              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
                <button onClick={() => setCurIdx(i => (i - 1 + filtered.length) % filtered.length)} style={navBtn}><ChevronLeft size={14} />上一帧</button>
                <button onClick={() => setCurIdx(i => (i + 1) % filtered.length)} style={navBtn}>下一帧<ChevronRight size={14} /></button>
              </span>
            </div>
          </div>

          {/* 缩略图网格 */}
          <div style={{ ...card, padding: 10, maxHeight: 640, overflowY: 'auto' }}>
            <div style={{ fontSize: 11, color: '#5a8aaa', marginBottom: 8 }}>帧列表（点击跳转）· 共 {filtered.length} 帧</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8 }}>
              {filtered.map((f, i) => (
                <button key={f.fp} onClick={() => setCurIdx(i)} title={f.rel} style={{
                  position: 'relative', padding: 0, cursor: 'pointer', borderRadius: 4, overflow: 'hidden',
                  border: `2px solid ${i === curIdx ? CYAN : f.review ? STATUS_META[f.review].color : 'rgba(0,80,150,0.25)'}`,
                  background: 'rgba(0,10,25,0.6)', aspectRatio: '16/10',
                }}>
                  <img src={thumbUrl(f)} loading="lazy" alt={f.rel} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  <span style={{
                    position: 'absolute', top: 2, right: 2, fontSize: 10, padding: '1px 5px', borderRadius: 3, lineHeight: 1.4,
                    color: '#0a1628', fontWeight: 700,
                    background: f.review ? STATUS_META[f.review].color : 'rgba(125,133,144,0.85)',
                  }}>
                    {f.review ? (f.review === 'ok' ? '✓' : f.review === 'no' ? '✗' : '?') : '·'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div style={{ fontSize: 11, color: '#3a5a70', lineHeight: 1.8 }}>
        <b style={{ color: '#5a8aaa' }}>说明</b>：本页用于人工复核 <code style={{ color: PURPLE }}>VLM 干扰物分类</code>（pole 电线杆 / cloud 云 / building 建筑 / concrete 水泥地 / reflection 水面倒影 / none 无干扰 / other 其他）。
        判定结果持久化到后端 <code style={{ color: AMBER }}>straw_neg_reviews</code> 表，导出脚本据此生成训练负样本（ok 帧保留为负样本，no 帧剔除）。
        切换「待审」聚焦未复核帧，快捷键可配 ←/→ 与 1/2/3。
      </div>
    </div>
  )
}

const navBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 12px', fontSize: 12, cursor: 'pointer', borderRadius: 4,
  border: '1px solid rgba(0,150,220,0.3)', background: 'rgba(0,80,180,0.12)', color: '#7ab8e0',
}
