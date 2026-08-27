import { useState, useEffect, useCallback } from 'react'
import { authFetch } from '../../lib/apiFetch'

const CYAN = '#00aaff'
const GREEN = '#00e676'
const AMBER = '#ffd740'
const ORANGE = '#ff7043'
const RED = '#ff4444'

interface EngineStatus {
  engine: { ok: boolean; model_version?: string; model_path?: string; workers: Record<string, { running: boolean; detects: number; alerts: number; last_label: string; last_conf: number; last_ms: number }> } | null
  metrics: { version: string; workers: number; total_detects: number; total_alerts: number; per_stream: Record<string, { detects: number; alerts: number; last_label: string; last_conf: number; infer_ms: number; report_latency_ms: number; last_report_ok: boolean }> } | null
  sampleStats: { true: number; false: number; miss: number }
}

const card: React.CSSProperties = {
  background: 'rgba(4,16,38,0.75)', border: '1px solid rgba(0,120,220,0.18)',
  borderRadius: 8, padding: 14, marginBottom: 14,
}

const th: React.CSSProperties = {
  textAlign: 'left', padding: '8px 12px', fontSize: 12, color: '#5a8aaa',
  borderBottom: '1px solid rgba(0,120,220,0.2)', whiteSpace: 'nowrap',
}

const td: React.CSSProperties = {
  padding: '8px 12px', fontSize: 13, color: '#c8e6ff',
  borderBottom: '1px solid rgba(0,60,120,0.15)', fontFamily: "'JetBrains Mono', 'Consolas', monospace",
}

export function StrawEnginePage() {
  const [data, setData] = useState<EngineStatus | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    authFetch('/api/straw-engine/status')
      .then(r => r.json())
      .then((d: EngineStatus) => { setData(d); setErr(''); setLoading(false) })
      .catch(() => { setErr('推理引擎状态获取失败'); setLoading(false) })
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 10000)   // 10s 自动刷新
    return () => clearInterval(t)
  }, [load])

  const online = !!data?.engine?.ok
  const perStream = data?.metrics?.per_stream || {}
  const streamIds = Object.keys(perStream)
  const totalSamples = (data?.sampleStats?.true || 0) + (data?.sampleStats?.false || 0) + (data?.sampleStats?.miss || 0)

  const statusColor = (s: boolean) => (s ? GREEN : RED)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <div style={{ width: 3, height: 18, background: CYAN, borderRadius: 1 }} />
        <span style={{ color: '#c8e6ff', fontSize: 16, fontWeight: 700 }}>秸秆推理引擎健康</span>
        <span style={{ fontSize: 12, color: '#5a8aaa' }}>
          自动刷新 10s · 数据源：<code style={{ color: AMBER }}>/api/straw-engine/status</code>
        </span>
        <span style={{
          padding: '3px 12px', fontSize: 12, fontWeight: 700, borderRadius: 3,
          background: data?.engine?.model_version === 'v2' ? 'rgba(74,222,128,0.15)' : 'rgba(255,170,60,0.15)',
          border: `1px solid ${data?.engine?.model_version === 'v2' ? '#4ade80' : '#ffb74d'}60`,
          color: data?.engine?.model_version === 'v2' ? '#4ade80' : '#ffb74d',
        }}>🧠 模型 {data?.engine?.model_version || '…'}</span>
        <button onClick={load} style={{
          marginLeft: 'auto', padding: '4px 14px', fontSize: 12, borderRadius: 3, cursor: 'pointer',
          border: '1px solid rgba(0,150,220,0.3)', background: 'rgba(0,80,180,0.12)', color: '#7ab8e0',
        }}>立即刷新</button>
      </div>

      {loading && !data ? (
        <div style={{ color: '#5a8aaa', fontSize: 13 }}>加载中...</div>
      ) : err ? (
        <div style={{ color: RED, fontSize: 13 }}>{err}（推理引擎未启动或不可达）</div>
      ) : (
        <>
          {/* 引擎状态总览 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
            <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 12, color: '#5a8aaa' }}>引擎状态</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', background: statusColor(online), boxShadow: online ? `0 0 8px ${GREEN}` : 'none' }} />
                <span style={{ color: statusColor(online), fontSize: 16, fontWeight: 700 }}>{online ? '在线' : '离线'}</span>
              </div>
              <div style={{ fontSize: 12, color: '#5a8aaa' }}>引擎版本 <span style={{ color: '#7ab8e0', fontFamily: 'monospace' }}>{data?.metrics?.version || '-'}</span>
                <span style={{ marginLeft: 10 }}>模型版本 <span style={{ color: data?.engine?.model_version === 'v2' ? GREEN : AMBER, fontFamily: 'monospace' }}>{data?.engine?.model_version || '-'}</span></span>
              </div>
            </div>
            <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 12, color: '#5a8aaa' }}>推理 worker</div>
              <div style={{ color: '#c8e6ff', fontSize: 20, fontWeight: 700 }}>{streamIds.length}<span style={{ fontSize: 13, color: '#5a8aaa' }}> 路</span></div>
              <div style={{ fontSize: 12, color: '#5a8aaa' }}>累计检测 <span style={{ color: CYAN, fontFamily: 'monospace' }}>{data?.metrics?.total_detects || 0}</span></div>
            </div>
            <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 12, color: '#5a8aaa' }}>累计告警</div>
              <div style={{ color: ORANGE, fontSize: 20, fontWeight: 700 }}>{data?.metrics?.total_alerts || 0}</div>
              <div style={{ fontSize: 12, color: '#5a8aaa' }}>最新上报<span style={{ color: '#7ab8e0', fontFamily: 'monospace' }}> {' '}{Object.values(perStream).filter(s => s.last_report_ok).length}/{streamIds.length} OK</span></div>
            </div>
            <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 12, color: '#5a8aaa' }}>复核样本（边工作边训练）</div>
              <div style={{ color: '#c8e6ff', fontSize: 20, fontWeight: 700 }}>{totalSamples}</div>
              <div style={{ fontSize: 12, fontFamily: 'monospace' }}>
                <span style={{ color: GREEN }}>真警 {data?.sampleStats?.true || 0}</span>
                {' '}<span style={{ color: RED }}>误报 {data?.sampleStats?.false || 0}</span>
                {' '}<span style={{ color: AMBER }}>漏报 {data?.sampleStats?.miss || 0}</span>
              </div>
            </div>
          </div>

          {/* 各路流状态 */}
          <div style={card}>
            <div style={{ fontSize: 13, color: '#7ab8e0', fontWeight: 700, marginBottom: 10 }}>各路推理流状态</div>
            {streamIds.length === 0 ? (
              <div style={{ color: '#5a8aaa', fontSize: 12 }}>暂无已配置的推理流（检查 straw-engine/config/config.json）</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={th}>streamId</th>
                      <th style={th}>运行</th>
                      <th style={th}>检测数</th>
                      <th style={th}>告警数</th>
                      <th style={th}>最近类别</th>
                      <th style={th}>置信度</th>
                      <th style={th}>推理延迟</th>
                      <th style={th}>上报延迟</th>
                      <th style={th}>上报状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {streamIds.map(sid => {
                      const s = perStream[sid]
                      return (
                        <tr key={sid}>
                          <td style={td}>{sid}</td>
                          <td style={{ ...td, color: statusColor(s.running !== false) }}>{s.running !== false ? '运行中' : '停止'}</td>
                          <td style={td}>{s.detects}</td>
                          <td style={{ ...td, color: s.alerts > 0 ? ORANGE : '#5a8aaa' }}>{s.alerts}</td>
                          <td style={{ ...td, color: s.last_label === 'fire' ? RED : s.last_label === 'smoke' ? AMBER : '#5a8aaa' }}>
                            {s.last_label || '-'}
                          </td>
                          <td style={td}>{s.last_conf ? `${(s.last_conf * 100).toFixed(1)}%` : '-'}</td>
                          <td style={{ ...td, color: (s.infer_ms || 0) > 1000 ? RED : GREEN }}>{s.infer_ms ? `${s.infer_ms}ms` : '-'}</td>
                          <td style={td}>{s.report_latency_ms ? `${s.report_latency_ms}ms` : '-'}</td>
                          <td style={{ ...td, color: s.last_report_ok ? GREEN : RED }}>{s.last_report_ok ? '成功' : '失败'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* 说明 */}
          <div style={{ ...card, fontSize: 12, color: '#5a8aaa', lineHeight: 1.8 }}>
            <b style={{ color: '#7ab8e0' }}>说明</b>：推理引擎为独立 systemd 服务（straw-engine，端口 7200）。告警链为「拉流 → 抽帧 → 检测 → 确认状态机 → 上报 → 入库」。
            「推理延迟 &gt;1s」建议排查 ORT_THREADS / CPUQuota 配置；「上报失败」建议排查驾驶舱后端 /api/straw-alert 可达性。
          </div>

          {/* 告警工作台：列表 + 复核 */}
          <StrawReviewBoard />
        </>
      )}
    </div>
  )
}

// ── 告警工作台：列表 + 详情 + 复核 ──
export function StrawReviewBoard() {
  const [list, setList] = useState<any[]>([])
  const [picked, setPicked] = useState<any | null>(null)
  const [resp, setResp] = useState<any | null>(null)
  const [verdict, setVerdict] = useState('true')
  const [reason, setReason] = useState('晨雾')
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(() => {
    authFetch('/api/warnings?limit=20')
      .then((r) => r.json())
      .then((d: any) => {
        const arr = Array.isArray(d) ? d : (d.list || d.data || [])
        setList(arr.filter((x: any) => String(x.id || '').startsWith('straw')))
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [load])

  const open = async (w: any) => {
    setPicked(w)
    setVerdict('true')
    setReason('晨雾')
    setMsg('')
    // 实时反查责任单位
    if (w.lat && w.lon) {
      const r = await authFetch('/api/straw/responsibility?lng=' + w.lon + '&lat=' + w.lat)
        .then((res) => res.json()).catch(() => null)
      setResp(r)
    } else {
      setResp(null)
    }
  }

  const submitReview = async () => {
    if (!picked) return
    setLoading(true)
    try {
      const r = await authFetch('/api/straw-review/' + picked.id, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict, reason, reviewer: 'admin' }),
      }).then((res) => res.json())
      setMsg(r.ok ? '✓ 复核成功，样本已入库' : '失败: ' + (r.error || ''))
      setTimeout(() => { setPicked(null); load() }, 800)
    } catch (e: any) {
      setMsg('失败: ' + (e?.message || e))
    }
    setLoading(false)
  }

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div style={{ width: 3, height: 18, background: ORANGE, borderRadius: 1 }} />
        <span style={{ color: '#c8e6ff', fontSize: 15, fontWeight: 700 }}>告警工作台</span>
        <span style={{ fontSize: 12, color: '#5a8aaa' }}>自动刷新 15s · 当前 {list.length} 条 straw 告警</span>
      </div>
      {list.length === 0 ? (
        <div style={{ color: '#5a8aaa', fontSize: 12 }}>暂无 straw 告警（推理引擎持续运行中，告警入库后在此显示）</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>id</th>
                <th style={th}>时间</th>
                <th style={th}>类别</th>
                <th style={th}>置信度</th>
                <th style={th}>坐标</th>
                <th style={th}>微信推送</th>
                <th style={th}>复核</th>
                <th style={th}>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((w) => (
                <tr key={w.id}>
                  <td style={td}>{String(w.id).slice(0, 28)}…</td>
                  <td style={td}>{w.time || w.createdAt?.slice(11, 19) || '-'}</td>
                  <td style={td}>{w.label || w.aiType || '-'}</td>
                  <td style={td}>{w.aiConfidence ? (w.aiConfidence * 100).toFixed(1) + '%' : '-'}</td>
                  <td style={td}>{w.lat?.toFixed(4) || '-'}, {w.lon?.toFixed(4) || '-'}</td>
                  <td style={{ ...td, color: w.wechatPush?.pushed ? GREEN : w.wechatPush ? AMBER : '#5a8aaa', fontSize: 11 }}>
                    {w.wechatPush ? (w.wechatPush.pushed ? '已推送' : (w.wechatPush.reason || '未推送').slice(0, 18)) : '未处理'}
                  </td>
                  <td style={{ ...td, color: w.review === 'true' ? GREEN : w.review === 'false' ? RED : w.review === 'miss' ? AMBER : '#5a8aaa' }}>
                    {w.review === 'true' ? '真警' : w.review === 'false' ? '误报' : w.review === 'miss' ? '漏报' : '未复核'}
                  </td>
                  <td style={td}>
                    <button onClick={() => open(w)} style={{
                      padding: '3px 10px', fontSize: 11, borderRadius: 3, cursor: 'pointer',
                      border: '1px solid rgba(0,150,220,0.4)', background: 'rgba(0,80,180,0.15)', color: '#7ab8e0',
                    }}>查看 / 复核</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 详情 + 复核弹窗 */}
      {picked && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 3000,
          background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => setPicked(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{
            background: '#040e25', border: '1px solid rgba(0,150,220,0.4)', borderRadius: 10,
            padding: 22, width: 720, maxHeight: '88vh', overflowY: 'auto',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <div style={{ width: 3, height: 18, background: CYAN }} />
              <span style={{ color: '#c8e6ff', fontSize: 15, fontWeight: 700 }}>告警详情 / 复核</span>
              <button onClick={() => setPicked(null)} style={{
                marginLeft: 'auto', padding: '3px 10px', fontSize: 11, cursor: 'pointer',
                border: '1px solid rgba(150,150,180,0.3)', background: 'transparent', color: '#7ab8e0',
                borderRadius: 3,
              }}>关闭 ✕</button>
            </div>

            {picked.picUrl && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, color: '#5a8aaa', marginBottom: 4 }}>📷 证据截图</div>
                <img src={picked.picUrl} alt="evidence"
                  style={{ width: '100%', borderRadius: 6, border: '1px solid rgba(0,150,220,0.2)' }} />
              </div>
            )}
            {picked.wechatPush?.cardUrl && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, color: '#5a8aaa', marginBottom: 4 }}>🃏 告警卡片（微信推送图）</div>
                <img src={picked.wechatPush.cardUrl} alt="card"
                  style={{ width: '100%', borderRadius: 6, border: '1px solid rgba(0,150,220,0.2)' }} />
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', rowGap: 6, columnGap: 12, fontSize: 12, color: '#c8e6ff', marginBottom: 14 }}>
              <div style={{ color: '#5a8aaa' }}>告警 ID</div><div style={{ fontFamily: 'monospace' }}>{picked.id}</div>
              <div style={{ color: '#5a8aaa' }}>类别 / 置信度</div><div>{picked.label || picked.aiType} · {Math.round((picked.aiConfidence || 0) * 100)}%</div>
              <div style={{ color: '#5a8aaa' }}>时间</div><div>{picked.time || picked.createdAt}</div>
              <div style={{ color: '#5a8aaa' }}>坐标</div><div>{picked.lat?.toFixed(5)}, {picked.lon?.toFixed(5)}</div>
              <div style={{ color: '#5a8aaa' }}>流</div><div>{picked.streamId}</div>
              <div style={{ color: '#5a8aaa' }}>附近人员</div>
              <div style={{ color: (picked.nearbyPersons || 0) > 0 ? '#ff8a65' : GREEN }}>
                {picked.nearbyPersons ? `有人（${picked.nearbyPersons}人）→ 无人机抵近喊话` : '无人 → 推送街道办处置'}
              </div>
              {resp?.town && (
                <>
                  <div style={{ color: '#5a8aaa' }}>行政反查</div>
                  <div style={{ color: GREEN }}>✓ {resp.town.name} <span style={{ color: '#5a8aaa', fontSize: 10 }}>({resp.town.divisionCode || '无 code'})</span></div>
                </>
              )}
              {resp?.responsibility && (
                <>
                  <div style={{ color: '#5a8aaa' }}>责任单位</div>
                  <div>{resp.responsibility.unit} · 责任人 {resp.responsibility.person || '-'}{resp.responsibility.phone ? '（' + resp.responsibility.phone + '）' : ''}</div>
                  <div style={{ color: '#5a8aaa' }}>微信群</div>
                  <div style={{ fontSize: 10, color: resp.responsibility.webhook ? '#7ab8e0' : AMBER }}>
                    {resp.responsibility.webhook ? '已配置（demo 未真实推送）' : '未配置'}
                  </div>
                </>
              )}
              {picked.wechatPush && (
                <>
                  <div style={{ color: '#5a8aaa' }}>推送结果</div>
                  <div style={{ color: picked.wechatPush.pushed ? GREEN : AMBER, fontSize: 11 }}>
                    {picked.wechatPush.pushed ? '✓ 已推送' : '✗ ' + (picked.wechatPush.reason || '失败')}
                  </div>
                </>
              )}
            </div>

            <div style={{ borderTop: '1px solid rgba(0,150,220,0.2)', paddingTop: 14 }}>
              <div style={{ color: '#7ab8e0', fontSize: 12, fontWeight: 700, marginBottom: 8 }}>人工复核（边工作边训练）</div>
              <div style={{ display: 'flex', gap: 14, fontSize: 12, marginBottom: 10, color: '#c8e6ff' }}>
                <label><input type="radio" name="v" value="true" checked={verdict === 'true'} onChange={() => setVerdict('true')} /> 真警</label>
                <label><input type="radio" name="v" value="false" checked={verdict === 'false'} onChange={() => setVerdict('false')} /> 误报</label>
                <label><input type="radio" name="v" value="miss" checked={verdict === 'miss'} onChange={() => setVerdict('miss')} /> 漏报</label>
              </div>
              {verdict === 'false' && (
                <select value={reason} onChange={(e) => setReason(e.target.value)} style={{
                  width: '100%', padding: '6px 10px', fontSize: 12, marginBottom: 10,
                  background: 'rgba(0,20,60,0.6)', color: '#c8e6ff', border: '1px solid rgba(0,150,220,0.3)', borderRadius: 3,
                }}>
                  <option>晨雾</option>
                  <option>白云</option>
                  <option>烟囱</option>
                  <option>扬尘</option>
                  <option>反光</option>
                  <option>乡村土路</option>
                  <option>其他</option>
                </select>
              )}
              <button onClick={submitReview} disabled={loading} style={{
                width: '100%', padding: '8px', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                border: 'none', borderRadius: 4, color: '#fff',
                background: loading ? '#3a5a70' : 'linear-gradient(90deg, #0080d0, #00aaff)',
              }}>{loading ? '提交中…' : '提交复核'}</button>
              {msg && <div style={{ marginTop: 8, fontSize: 12, color: msg.startsWith('✓') ? GREEN : RED }}>{msg}</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
