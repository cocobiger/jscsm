import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/apiFetch'
import { CK, alpha } from '../lib/cockpitTheme'
import type { GovModuleKey } from '../lib/govModules'

// ── payload 类型（与 govModules.validateRows 产物一致）──
interface ForecastDay { date: string; weekday: string; aqiMin: number; aqiMax: number; level: string; pm25: number | null; o3: number | null; primary: string | null }
interface PyramidLevel { level: string; name: string; total: number; done: number }
interface DocItem { category: string; title: string; dept: string | null; date: string | null; url: string | null }
interface AssessMetric { name: string; target: string; current: string; progress: number; status: string }

type GovData<T> = { payload: T | null; updated_at: string | null }

const DOC_CATS = ['政策制度', '法律法规', '标准规范', '改革措施']
const PYRAMID_COLORS: Record<string, string> = { A: '#ff5252', B: '#ff7043', C: '#ffd740', D: '#00aaff' }
const LEVEL_COLORS: Record<string, string> = {
  优: '#00e676', 良: '#ffd740', 轻度污染: '#ff7043', 轻度: '#ff7043',
  中度污染: '#ff5722', 中度: '#ff5722', 重度污染: '#ff4444', 重度: '#ff4444', 严重污染: '#c2185b',
}
const ASSESS_COLORS: Record<string, string> = { 达标: CK.green, 预警: CK.amber, 滞后: CK.red }

function levelColor(level: string) {
  return LEVEL_COLORS[level] || CK.cyanSoft
}

function SectionTitle({ title, color = CK.cyanSoft, extra }: { title: string; color?: string; extra?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-1" style={{ paddingLeft: 6 }}>
      <div style={{ width: 3, height: 10, background: color, borderRadius: 1, boxShadow: `0 0 5px ${alpha(color, 0.7)}` }} />
      <span style={{ color: CK.textSub, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em' }}>{title}</span>
      {extra}
    </div>
  )
}

/** 空数据占位：指引去管理后台导入 */
function EmptyHint({ label }: { label: string }) {
  return (
    <div style={{
      padding: '12px 8px', textAlign: 'center',
      border: '1px dashed rgba(0,150,220,0.25)', borderRadius: 4,
      color: CK.textFaint, fontSize: 11, lineHeight: 1.7,
    }}>
      「{label}」待导入
      <br />
      <span style={{ fontSize: 10 }}>管理后台 → 政务数据导入</span>
    </div>
  )
}

/**
 * P2 政务驾驶舱：空气质量预报 / 治理任务金字塔 / 考核评价 / 制度规范。
 * 数据全部来自管理后台 Excel 导入（/api/gov/:module），60s 轮询。
 */
export function GovPanel() {
  const [forecast, setForecast] = useState<GovData<{ days: ForecastDay[] }> | null>(null)
  const [pyramid, setPyramid] = useState<GovData<{ levels: PyramidLevel[] }> | null>(null)
  const [docs, setDocs] = useState<GovData<{ docs: DocItem[] }> | null>(null)
  const [assess, setAssess] = useState<GovData<{ metrics: AssessMetric[] }> | null>(null)
  const [docCat, setDocCat] = useState(DOC_CATS[0])

  useEffect(() => {
    const load = (m: GovModuleKey, setter: (d: any) => void) =>
      apiFetch<GovData<unknown>>(`/api/gov/${m}`).then(d => setter(d)).catch(() => {})
    const loadAll = () => {
      load('forecast', setForecast)
      load('pyramid', setPyramid)
      load('documents', setDocs)
      load('assessment', setAssess)
    }
    loadAll()
    const t = setInterval(loadAll, 60000)
    return () => clearInterval(t)
  }, [])

  const forecastDays = forecast?.payload?.days || []
  const pyramidLevels = pyramid?.payload?.levels || []
  const docList = docs?.payload?.docs || []
  const assessMetrics = assess?.payload?.metrics || []
  const filteredDocs = docList.filter(d => d.category === docCat)

  return (
    <div
      className="flex flex-col h-full overflow-y-auto px-2 py-1.5 gap-2"
      style={{
        scrollbarWidth: 'none',
        borderLeft: `3px solid ${CK.teal}`,
        background: 'linear-gradient(90deg, rgba(0,188,212,0.05), transparent 60%)',
        borderTop: '1px solid rgba(0,150,220,0.1)',
      }}
    >
      {/* ── 空气质量预报（未来 6 天）── */}
      <div>
        <SectionTitle title="空气质量预报" color={CK.cyan} />
        {forecastDays.length === 0 ? <EmptyHint label="空气质量预报" /> : (
          <div style={{ display: 'flex', gap: 4, overflowX: 'auto', scrollbarWidth: 'none', paddingBottom: 2 }}>
            {forecastDays.map(d => {
              const c = levelColor(d.level)
              return (
                <div
                  key={d.date}
                  style={{
                    flex: '1 0 64px', minWidth: 64,
                    background: `linear-gradient(170deg, ${alpha(c, 0.14)}, rgba(6,14,32,0.45) 70%)`,
                    border: `1px solid ${alpha(c, 0.35)}`,
                    borderRadius: 4, padding: '5px 4px',
                    textAlign: 'center',
                    boxShadow: `inset 0 0 12px -8px ${alpha(c, 0.5)}`,
                  }}
                >
                  <div style={{ color: CK.textDim, fontSize: 10 }}>{d.date.slice(5)}</div>
                  <div style={{ color: CK.textSub, fontSize: 10 }}>{d.weekday}</div>
                  <div style={{
                    margin: '4px auto', padding: '2px 0', width: '86%',
                    background: alpha(c, 0.18), border: `1px solid ${alpha(c, 0.5)}`,
                    borderRadius: 3, color: c, fontSize: 11, fontWeight: 700,
                    textShadow: `0 0 6px ${alpha(c, 0.5)}`,
                  }}>
                    {d.level}
                  </div>
                  <div style={{ color: CK.textMain, fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}>
                    {d.aqiMin}~{d.aqiMax}
                  </div>
                  <div style={{ color: CK.textFaint, fontSize: 9, marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {d.primary ? `首要 ${d.primary}` : '—'}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── 治理任务金字塔 ── */}
      <div>
        <SectionTitle title="治理任务" color={CK.orange} />
        {pyramidLevels.length === 0 ? <EmptyHint label="治理任务" /> : (
          <div className="flex items-center gap-2">
            <PyramidChart levels={pyramidLevels} />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
              {pyramidLevels.map(l => {
                const c = PYRAMID_COLORS[l.level] || CK.cyanSoft
                const pct = l.total > 0 ? Math.round((l.done / l.total) * 100) : 0
                return (
                  <div key={l.level} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{
                      width: 14, height: 14, borderRadius: 2, flexShrink: 0,
                      background: alpha(c, 0.2), border: `1px solid ${alpha(c, 0.6)}`,
                      color: c, fontSize: 9, fontWeight: 700,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {l.level}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="flex items-center justify-between">
                        <span style={{ color: CK.textSub, fontSize: 10, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.name}</span>
                        <span style={{ color: c, fontSize: 10, fontFamily: "'JetBrains Mono', monospace", flexShrink: 0 }}>
                          {l.done}/{l.total}
                        </span>
                      </div>
                      <div style={{ height: 3, background: 'rgba(0,60,120,0.35)', borderRadius: 2, marginTop: 2, overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: c, borderRadius: 2, opacity: 0.85 }} />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── 考核评价 ── */}
      <div>
        <SectionTitle title="考核评价" color={CK.green} />
        {assessMetrics.length === 0 ? <EmptyHint label="考核评价" /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {assessMetrics.map(m => {
              const c = ASSESS_COLORS[m.status] || CK.cyanSoft
              return (
                <div key={m.name} style={{
                  padding: '4px 7px',
                  background: 'rgba(8,20,44,0.45)',
                  border: '1px solid rgba(0,150,220,0.12)',
                  borderRadius: 4,
                }}>
                  <div className="flex items-center justify-between">
                    <span style={{ color: CK.textMain, fontSize: 11 }}>{m.name}</span>
                    <span style={{
                      padding: '0 7px', fontSize: 10, borderRadius: 2,
                      background: alpha(c, 0.14), border: `1px solid ${alpha(c, 0.5)}`,
                      color: c, fontWeight: 600,
                    }}>
                      {m.status}
                    </span>
                  </div>
                  <div className="flex items-center justify-between" style={{ marginTop: 2 }}>
                    <span style={{ color: CK.textFaint, fontSize: 10 }}>目标 {m.target}</span>
                    <span style={{ color: CK.textSub, fontSize: 10 }}>当前 <b style={{ color: c, fontFamily: "'JetBrains Mono', monospace" }}>{m.current}</b></span>
                  </div>
                  <div style={{ height: 4, background: 'rgba(0,60,120,0.35)', borderRadius: 2, marginTop: 3, overflow: 'hidden' }}>
                    <div style={{
                      width: `${m.progress}%`, height: '100%',
                      background: `linear-gradient(90deg, ${alpha(c, 0.5)}, ${c})`,
                      borderRadius: 2, boxShadow: `0 0 5px ${alpha(c, 0.4)}`,
                    }} />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── 制度规范 ── */}
      <div>
        <div className="flex items-center gap-2 mb-1" style={{ paddingLeft: 6 }}>
          <div style={{ width: 3, height: 10, background: CK.purple, borderRadius: 1, boxShadow: `0 0 5px ${alpha(CK.purple, 0.7)}` }} />
          {DOC_CATS.map(cat => (
            <button
              key={cat}
              onClick={() => setDocCat(cat)}
              style={{
                padding: '1px 7px', fontSize: 10, cursor: 'pointer',
                color: docCat === cat ? '#d49ae8' : CK.textDim,
                fontWeight: docCat === cat ? 700 : 400,
                background: docCat === cat ? 'rgba(171,71,188,0.14)' : 'transparent',
                border: `1px solid ${docCat === cat ? 'rgba(171,71,188,0.45)' : 'transparent'}`,
                borderRadius: 3, transition: 'all 0.15s',
              }}
            >
              {cat}
            </button>
          ))}
        </div>
        {docList.length === 0 ? <EmptyHint label="制度规范" /> : filteredDocs.length === 0 ? (
          <div style={{ color: CK.textFaint, fontSize: 11, padding: '8px 0', paddingLeft: 6 }}>「{docCat}」类暂无文档</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {filteredDocs.map((d, i) => {
              const inner = (
                <>
                  <span style={{
                    width: 5, height: 5, transform: 'rotate(45deg)', flexShrink: 0,
                    background: CK.purple, boxShadow: `0 0 4px ${alpha(CK.purple, 0.7)}`,
                  }} />
                  <span style={{ flex: 1, minWidth: 0, color: CK.textSub, fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {d.title}
                  </span>
                  <span style={{ color: CK.textFaint, fontSize: 10, flexShrink: 0 }}>
                    {d.dept || ''}{d.date ? ` ${d.date.slice(2)}` : ''}
                  </span>
                </>
              )
              const rowStyle: React.CSSProperties = {
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '4px 7px',
                background: 'rgba(8,20,44,0.45)',
                border: '1px solid rgba(0,150,220,0.10)',
                borderRadius: 3,
              }
              return d.url ? (
                <a key={i} href={d.url} target="_blank" rel="noopener noreferrer" style={{ ...rowStyle, textDecoration: 'none', cursor: 'pointer' }}>
                  {inner}
                </a>
              ) : (
                <div key={i} style={rowStyle}>{inner}</div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

/** SVG 治理任务金字塔：A 顶 D 底，层宽递减，发光描边 */
function PyramidChart({ levels }: { levels: PyramidLevel[] }) {
  const W = 148
  const H = 118
  const cx = W / 2
  const n = Math.max(levels.length, 1)
  const layerH = (H - 6) / n
  const topW = 26
  const botW = W - 8
  const widthAt = (t: number) => topW + (botW - topW) * t // t: 0(顶)→1(底)

  return (
    <svg width={W} height={H} style={{ flexShrink: 0 }} aria-label="治理任务金字塔">
      <defs>
        <filter id="pyramid-glow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2.2" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      {levels.map((l, i) => {
        const t0 = i / n
        const t1 = (i + 1) / n
        const y0 = 3 + t0 * (H - 6)
        const y1 = 3 + t1 * (H - 6) - 2 // 层间留缝
        const w0 = widthAt(t0)
        const w1 = widthAt(t1)
        const c = PYRAMID_COLORS[l.level] || CK.cyanSoft
        const midY = (y0 + y1) / 2
        return (
          <g key={l.level} filter="url(#pyramid-glow)">
            <polygon
              points={`${cx - w0 / 2},${y0} ${cx + w0 / 2},${y0} ${cx + w1 / 2},${y1} ${cx - w1 / 2},${y1}`}
              fill={alpha(c, 0.22)}
              stroke={c}
              strokeWidth="1.2"
            />
            <text x={cx} y={midY + 1} textAnchor="middle" dominantBaseline="middle"
              fill={c} fontSize="11" fontWeight="700">
              {l.level}
            </text>
            <text x={cx} y={midY + 12} textAnchor="middle" dominantBaseline="middle"
              fill={CK.textSub} fontSize="8">
              {l.total}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
