import { useState, useEffect, useCallback, useMemo } from 'react'
import { apiFetch } from '../../lib/apiFetch'
import { roleAtLeast, type CurrentUser } from '../../lib/auth'

const CYAN = '#00aaff'
const GREEN = '#00e676'
const AMBER = '#ffd740'
const RED = '#ff4444'

interface RemoteChannel {
  channelSipId: string
  channelName: string
  deviceSipId: string
  deviceName: string
  snapshotUrl: string | null
  alreadyAdded: boolean
}

interface LocalChannel {
  channelSipId: string
  channelName: string
  deviceSipId: string
  deviceName: string
  streamId: string | null
  enabled: boolean
  remark: string
  aiTypes: string[]
  createdAt: string
  updatedAt: string
}

interface Stream {
  id: string
  name: string
  group?: string
  offline?: boolean
}

const inputStyle: React.CSSProperties = {
  padding: '5px 8px', background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.25)',
  borderRadius: 3, color: '#c8e6ff', fontSize: 12, outline: 'none', maxWidth: 180,
}

interface Props {
  user: CurrentUser
}

export function IotChannelManage({ user }: Props) {
  const [remote, setRemote] = useState<RemoteChannel[]>([])
  const [local, setLocal] = useState<LocalChannel[]>([])
  const [streams, setStreams] = useState<Stream[]>([])
  const [aiTypes, setAiTypes] = useState<string[]>([])
  const [loadingRemote, setLoadingRemote] = useState(false)
  const [toast, setToast] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  const isAdmin = roleAtLeast(user.role, 'admin')
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3000) }

  const loadLocal = useCallback(() => {
    apiFetch<LocalChannel[]>('/api/iot-channels').then(d => setLocal(Array.isArray(d) ? d : [])).catch(() => {})
  }, [])
  const loadStreams = useCallback(() => {
    apiFetch<Stream[]>('/api/streams').then(d => setStreams(Array.isArray(d) ? d : [])).catch(() => {})
  }, [])
  const loadAiTypes = useCallback(() => {
    apiFetch<Array<{ name: string }>>('/api/ai-types').then(d => { if (Array.isArray(d)) setAiTypes(d.map(x => x.name)) }).catch(() => {})
  }, [])
  const loadRemote = useCallback(() => {
    setLoadingRemote(true)
    apiFetch<{ ok?: boolean; channels?: RemoteChannel[] }>('/api/iot-analysis/iot-channels')
      .then((d: any) => { setRemote(Array.isArray(d?.channels) ? d.channels : []); setLoadingRemote(false) })
      .catch(() => setLoadingRemote(false))
  }, [])

  useEffect(() => {
    loadLocal(); loadStreams(); loadRemote(); loadAiTypes()
    const t = setInterval(() => { loadLocal() }, 15000)
    return () => clearInterval(t)
  }, [loadLocal, loadStreams, loadRemote, loadAiTypes])

  // streamId → 占用它的通道名（用于 1:1 冲突提示）
  const streamOwner = useMemo(() => {
    const m: Record<string, string> = {}
    for (const c of local) if (c.streamId) m[c.streamId] = c.channelName
    return m
  }, [local])

  // 接入一条远程通道（同名视频流自动推荐映射）
  const addChannel = async (rc: RemoteChannel) => {
    setBusyId(rc.channelSipId)
    const suggested = streams.find(s => s.name === rc.channelName)?.id || null
    try {
      await apiFetch('/api/iot-channels', {
        method: 'POST', body: JSON.stringify({
          channelSipId: rc.channelSipId, channelName: rc.channelName,
          deviceSipId: rc.deviceSipId, deviceName: rc.deviceName,
          streamId: suggested, enabled: true,
        }),
      })
      flash(suggested ? `已接入并自动映射「${rc.channelName}」` : `已接入「${rc.channelName}」（未映射，请在右侧补映射）`)
      loadLocal(); loadRemote()
    } catch (e: any) { flash('接入失败：' + (e?.error || e)) }
    finally { setBusyId(null) }
  }

  const setStream = async (c: LocalChannel, streamId: string | null) => {
    try {
      await apiFetch(`/api/iot-channels/${c.channelSipId}`, { method: 'PUT', body: JSON.stringify({ streamId }) })
      flash(streamId ? '映射已更新' : '已取消映射')
      loadLocal()
    } catch (e: any) { flash('更新失败：' + (e?.error || e)) }
  }

  const setChannelAiTypes = async (c: LocalChannel, next: string[]) => {
    try {
      await apiFetch(`/api/iot-channels/${c.channelSipId}/ai-types`, { method: 'PATCH', body: JSON.stringify({ aiTypes: next }) })
      loadLocal()
    } catch (e: any) { flash('AI类型更新失败：' + (e?.error || e)) }
  }

  const toggleEnabled = async (c: LocalChannel) => {
    try {
      await apiFetch(`/api/iot-channels/${c.channelSipId}`, { method: 'PUT', body: JSON.stringify({ enabled: !c.enabled }) })
      loadLocal()
    } catch (e: any) { flash('切换失败：' + (e?.error || e)) }
  }

  const removeChannel = async (c: LocalChannel) => {
    if (!confirm(`确认移除通道「${c.channelName}」？移除后停止轮询与告警（软删除，可重新接入）。`)) return
    setBusyId(c.channelSipId)
    try {
      await apiFetch(`/api/iot-channels/${c.channelSipId}`, { method: 'DELETE' })
      flash('已移除')
      loadLocal(); loadRemote()
    } catch (e: any) { flash('移除失败：' + (e?.error || e)) }
    finally { setBusyId(null) }
  }

  const btn = (color: string): React.CSSProperties => ({
    padding: '4px 10px', fontSize: 12, borderRadius: 3, border: `1px solid ${color}55`,
    background: `${color}15`, color, cursor: 'pointer',
  })

  if (!isAdmin) return <div style={{ color: '#3a5a70', padding: 40 }}>权限不足</div>

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', top: 80, right: 40, zIndex: 3000, background: 'rgba(0,40,80,0.95)', border: '1px solid rgba(0,150,220,0.3)', borderRadius: 6, padding: '10px 20px', color: CYAN, fontSize: 13 }}>
          {toast}
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', gap: 16, minHeight: 0 }}>
        {/* 左栏：远程通道（IoTCloud NVR 设备通道） */}
        <div style={{ width: '42%', display: 'flex', flexDirection: 'column', border: '1px solid rgba(0,150,220,0.15)', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 14px', background: 'rgba(0,30,70,0.5)', borderBottom: '1px solid rgba(0,150,220,0.15)' }}>
            <span style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 600 }}>远程通道（IoTCloud · NVR 设备通道）</span>
            <button onClick={loadRemote} style={btn(CYAN)}>{loadingRemote ? '加载中…' : '刷新'}</button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 10 }}>
            {loadingRemote && remote.length === 0 ? (
              <div style={{ color: '#3a5a70', fontSize: 12, padding: 20, textAlign: 'center' }}>加载远程通道…</div>
            ) : remote.length === 0 ? (
              <div style={{ color: '#3a5a70', fontSize: 12, padding: 20, textAlign: 'center' }}>暂无远程通道</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {remote.map(rc => (
                  <div key={rc.channelSipId} style={{ background: 'rgba(0,20,60,0.35)', border: '1px solid rgba(0,120,200,0.2)', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ height: 70, background: '#020a18', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {rc.snapshotUrl ? (
                        <img src={rc.snapshotUrl} alt={rc.channelName} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                      ) : <span style={{ color: '#2a4a60', fontSize: 10 }}>无抓拍</span>}
                    </div>
                    <div style={{ padding: '6px 8px' }}>
                      <div style={{ color: '#c8e6ff', fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rc.channelName || '(未命名)'}</div>
                      <div style={{ color: '#3a5a70', fontSize: 10, marginTop: 2 }}>{rc.deviceName || '—'} · {rc.channelSipId.slice(-6)}</div>
                      <div style={{ marginTop: 6 }}>
                        {rc.alreadyAdded ? (
                          <span style={{ display: 'inline-block', padding: '3px 10px', fontSize: 11, borderRadius: 3, background: 'rgba(0,230,118,0.12)', color: GREEN, border: '1px solid rgba(0,230,118,0.3)' }}>已接入</span>
                        ) : (
                          <button disabled={busyId === rc.channelSipId} onClick={() => addChannel(rc)} style={btn(CYAN)}>
                            {busyId === rc.channelSipId ? '接入中…' : '＋ 接入'}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 右栏：已接入通道 + 映射 */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', border: '1px solid rgba(0,150,220,0.15)', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 14px', background: 'rgba(0,30,70,0.5)', borderBottom: '1px solid rgba(0,150,220,0.15)' }}>
            <span style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 600 }}>已接入通道与映射（{local.length}）</span>
            <span style={{ color: '#3a5a70', fontSize: 11 }}>enabled+已映射 → 摄像头告警；未映射 = 草稿态</span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {local.length === 0 ? (
              <div style={{ color: '#3a5a70', fontSize: 12, padding: 30, textAlign: 'center' }}>暂无已接入通道，从左侧「接入」</div>
            ) : (
              local.map(c => {
                const mappedStream = streams.find(s => s.id === c.streamId)
                const suggested = streams.find(s => s.name === c.channelName)
                return (
                  <div key={c.channelSipId} style={{ display: 'grid', gridTemplateColumns: '1.3fr 1.4fr 1.4fr 70px 80px', gap: 10, padding: '10px 14px', borderBottom: '1px solid rgba(0,80,150,0.12)', alignItems: 'center' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: '#c8e6ff', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: c.enabled ? (c.streamId ? RED : GREEN) : '#3a5a70', boxShadow: c.enabled && c.streamId ? `0 0 6px ${RED}` : 'none' }} />
                        {c.channelName}
                      </div>
                      <div style={{ color: '#3a5a70', fontSize: 10, marginTop: 2 }}>{c.deviceName || '—'} · 接入于 {c.createdAt ? c.createdAt.slice(0, 10) : '—'}</div>
                    </div>
                    <div>
                      <select
                        value={c.streamId || ''}
                        onChange={e => setStream(c, e.target.value || null)}
                        style={inputStyle}
                      >
                        <option value="">未映射（不联动摄像头）</option>
                        {streams.map(s => {
                          const owner = streamOwner[s.id]
                          const occupied = owner && owner !== c.channelName
                          return <option key={s.id} value={s.id}>{s.name}{occupied ? `（已被「${owner}」占用）` : ''}{suggested && suggested.id === s.id ? ' ✓推荐' : ''}</option>
                        })}
                      </select>
                      {mappedStream && (
                        <div style={{ color: '#5a8aaa', fontSize: 10, marginTop: 2 }}>{mappedStream.group || ''} · {mappedStream.offline ? '离线' : '在线'}</div>
                      )}
                    </div>
                    <div>
                      <div style={{ color: '#5a8aaa', fontSize: 11, marginBottom: 4 }}>AI类型</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 70, overflowY: 'auto', padding: 4, border: '1px solid rgba(0,120,200,0.18)', borderRadius: 3, background: 'rgba(0,20,60,0.3)' }}>
                        {aiTypes.map(t => {
                          const checked = c.aiTypes.includes(t)
                          return (
                            <label key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#c8e6ff', fontSize: 11, cursor: 'pointer', padding: '2px 5px', borderRadius: 2, background: checked ? 'rgba(0,170,255,0.12)' : 'transparent', border: `1px solid ${checked ? 'rgba(0,170,255,0.3)' : 'transparent'}` }}>
                              <input type="checkbox" checked={checked} onChange={() => setChannelAiTypes(c, checked ? c.aiTypes.filter(x => x !== t) : [...c.aiTypes, t])} style={{ cursor: 'pointer' }} />
                              {t}
                            </label>
                          )
                        })}
                      </div>
                    </div>
                    <button onClick={() => toggleEnabled(c)} style={btn(c.enabled ? GREEN : '#3a5a70')}>{c.enabled ? '启用中' : '已停用'}</button>
                    <button disabled={busyId === c.channelSipId} onClick={() => removeChannel(c)} style={btn(RED)}>移除</button>
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 10, color: '#3a5a70', fontSize: 11, flexShrink: 0 }}>
        接入后通道进入轮询；映射视频流 + 启用 → 驾驶舱对应摄像头图标在 AI 推送时红闪告警（30 分钟内有效）。改动 30s 内生效，无需重启。
      </div>
    </div>
  )
}
