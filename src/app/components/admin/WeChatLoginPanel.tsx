import { useCallback, useEffect, useRef, useState } from 'react'
import { authFetch } from '../../lib/apiFetch'
import type {
  WechatStatusResp, WechatTargetsResp, WechatTestSendResp, WechatRefreshResp, WechatDefaultTarget,
} from '../../lib/api-types'
import { RefreshCw, QrCode, CheckCircle2, Send, WifiOff } from 'lucide-react'

/**
 * 驾驶舱「微信登录」面板（P3 · 2026-10-13）
 * 位置：秸秆焚烧监控 → 责任映射 / 微信群推送（ResponsibilityManager 顶部）
 *
 * 职责：
 *   ① 监控微信在线状态（后端 /api/wechat/status 合成判定：桥驱动证据 或 窗口几何兜底）
 *   ② 离线时显示登录二维码（**带 Authorization 头取 blob** —— 该接口 adminOnly + no-store，
 *      不能直接 <img src>，否则会 401 且可能被缓存）
 *   ③ 扫码后自动切到「已登录」并显示登录的号
 *   ④ 超时可手动刷新（后端落 reset.request → 226 上的守护重置客户端 → 出新码）
 *   ⑤ 已登录后选择全局默认推送对象
 *
 * 设计要求：
 *   * 未登录时 5s 轮询；已登录时降到 30s 心跳（已登录不需要盯二维码）
 *   * 二维码按 md5 变化才重新拉取（no-store，避免无谓流量）
 *   * 所有 blob URL 必须 revoke，否则长时间开着页面会泄漏内存
 */

const GREEN = '#4ade80'
const RED = '#ff4444'
const AMBER = '#ffb74d'
const ORANGE = '#ff7043'

const card: React.CSSProperties = {
  background: 'rgba(4,14,35,0.7)',
  border: '1px solid rgba(0,80,150,0.25)',
  borderRadius: 8,
  padding: '14px 16px',
}

const smallBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '5px 14px', fontSize: 12, borderRadius: 4, cursor: 'pointer', fontWeight: 600,
  border: '1px solid rgba(255,112,67,0.35)', background: 'rgba(255,112,67,0.12)', color: ORANGE,
}

export function WeChatLoginPanel({ onStatusChange }: { onStatusChange?: (s: WechatStatusResp | null) => void }) {
  const [st, setSt] = useState<WechatStatusResp | null>(null)
  const [err, setErr] = useState('')
  const [qrUrl, setQrUrl] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [note, setNote] = useState('')
  const lastMd5 = useRef<string>('')
  const urlRef = useRef<string>('')
  const stRef = useRef<WechatStatusResp | null>(null)

  // ── 状态轮询（未登录 5s / 已登录 30s）──
  const loadStatus = useCallback(async (force = false) => {
    try {
      const r = await authFetch(`/api/wechat/status${force ? '?force=1' : ''}`)
      const d: WechatStatusResp = await r.json()
      setSt(d)
      stRef.current = d
      onStatusChange?.(d)
      setErr(d.bridge && !d.bridge.reachable ? (d.bridge.error || '桥不可达') : '')
    } catch (e) {
      setErr('状态查询失败: ' + ((e as Error)?.message || e))
    }
    // onStatusChange 由父组件传入；此处刻意不进依赖，避免父组件每次渲染都重建定时器
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      await loadStatus()
      if (!alive) return
      const loggedIn = stRef.current?.loggedIn
      timer = setTimeout(tick, loggedIn ? 30000 : 5000)
    }
    tick()
    return () => { alive = false; clearTimeout(timer) }
  }, [loadStatus])

  // ── 二维码：md5 变化才重新拉（必须带 Authorization 头，所以走 blob）──
  useEffect(() => {
    const md5 = st?.qr?.md5 || ''
    if (!st || st.loggedIn || !st.qr?.available) return
    if (md5 && md5 === lastMd5.current && qrUrl) return
    let cancelled = false
    ;(async () => {
      try {
        const r = await authFetch(`/api/wechat/qr${md5 ? `?v=${md5}` : ''}`)
        if (r.status === 409) { setNote('微信已登录，无二维码'); return }
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          setNote((j as { error?: string }).error || `取二维码失败 HTTP ${r.status}`)
          return
        }
        const blob = await r.blob()
        if (cancelled) return
        const url = URL.createObjectURL(blob)
        if (urlRef.current) URL.revokeObjectURL(urlRef.current)   // 防泄漏
        urlRef.current = url
        lastMd5.current = md5
        setQrUrl(url)
        setNote('')
      } catch (e) {
        if (!cancelled) setNote('取二维码失败: ' + ((e as Error)?.message || e))
      }
    })()
    return () => { cancelled = true }
  }, [st, qrUrl])

  // 卸载时释放 blob
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current) }, [])

  // ── 手动刷新：请求重置 → 本地进「重置中」→ 等新 md5 ──
  const doRefresh = async () => {
    setRefreshing(true)
    setNote('已请求重置，守护最迟 30 秒内动手，约 1 分钟出新码…')
    try {
      const r = await authFetch('/api/wechat/qr/refresh', { method: 'POST' })
      const d: WechatRefreshResp = await r.json()
      if (d.hint) setNote(d.hint)
      if (!d.ok) setNote(d.error || '刷新请求失败')
    } catch (e) {
      setNote('刷新请求失败: ' + ((e as Error)?.message || e))
    }
    // 紧接着高频轮询，等新码出现
    const before = lastMd5.current
    for (let i = 0; i < 40; i++) {
      await new Promise(res => setTimeout(res, 3000))
      await loadStatus(true)
      const cur = stRef.current
      if (cur && !cur.loggedIn && cur.qr?.md5 && cur.qr.md5 !== before) {
        setNote('✅ 已生成新的二维码')
        break
      }
      if (cur?.loggedIn) { setNote('✅ 微信已登录'); break }
    }
    setRefreshing(false)
  }

  const loggedIn = !!st?.loggedIn
  const bridgeDown = !!st && st.bridge && !st.bridge.reachable
  const ageSec = st?.qr?.ageSec ?? null
  const stale = ageSec !== null && st != null && ageSec > st.qrStaleSec
  const pending = refreshing || !!st?.resetting

  const dot = bridgeDown ? RED : loggedIn ? GREEN : AMBER
  const headline = bridgeDown ? '桥不可达' : loggedIn ? '已登录' : '未登录 · 请扫码'

  return (
    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 标题栏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{
          width: 9, height: 9, borderRadius: '50%', background: dot,
          boxShadow: `0 0 8px ${dot}`, flex: 'none',
        }} />
        <span style={{ color: '#c8e6ff', fontSize: 14, fontWeight: 700 }}>微信登录</span>
        <span style={{ color: dot, fontSize: 13, fontWeight: 700 }}>{headline}</span>

        {loggedIn && (
          <span style={{ fontSize: 12, color: '#7ab8e0' }}>
            {(st?.self?.remark || st?.self?.nick_name || st?.self?.wxid || '未知账号')}
            {st?.wechatVersion ? ` · 微信 ${st.wechatVersion}` : ''}
            {st?.via ? ` · 判据=${st.via === 'driver' ? '数据库' : '窗口几何'}` : ''}
            {typeof st?.groupsCount === 'number' ? ` · 群 ${st.groupsCount}` : ''}
            {typeof st?.sessionsCount === 'number' ? ` · 会话 ${st.sessionsCount}` : ''}
          </span>
        )}

        {!loggedIn && !bridgeDown && (
          <span style={{ fontSize: 12, color: stale ? AMBER : '#5a8aaa' }}>
            {ageSec === null ? '（码龄未知）'
              : stale ? `⚠️ 二维码已生成 ${ageSec} 秒，可能快过期，建议点刷新`
                      : `二维码 ${ageSec} 秒前生成`}
          </span>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {pending && <span style={{ fontSize: 12, color: AMBER }}>重置中…</span>}
          {!loggedIn && (
            <button onClick={doRefresh} disabled={pending} style={{ ...smallBtn, cursor: pending ? 'wait' : 'pointer', opacity: pending ? 0.6 : 1 }}>
              <RefreshCw size={13} strokeWidth={2} />
              {pending ? '重置中…' : '手动刷新二维码'}
            </button>
          )}
        </div>
      </div>

      {/* 错误 / 提示 */}
      {err && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: RED, background: 'rgba(255,60,60,0.08)', border: '1px solid rgba(255,80,80,0.25)', borderRadius: 6, padding: '8px 10px' }}>
          <WifiOff size={14} strokeWidth={2} style={{ flex: 'none', marginTop: 2 }} />
          <span>{err}　（后台可查 <code>journalctl -u wxbridge-watchdog</code> / <code>/var/log/wxbridge_watchdog.log</code>；看门狗每分钟自愈一次）</span>
        </div>
      )}
      {note && <div style={{ fontSize: 12, color: '#7ab8e0' }}>{note}</div>}

      {/* 未登录：二维码 */}
      {!loggedIn && !bridgeDown && (
        <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{
            background: '#fff', padding: 10, borderRadius: 8, flex: 'none',
            display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 160, minHeight: 160,
          }}>
            {qrUrl
              ? <img src={qrUrl} alt="微信登录二维码" style={{ width: 160, height: 160, imageRendering: 'pixelated', display: 'block' }} />
              : <div style={{ color: '#94a3b8', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <QrCode size={18} /> 二维码加载中…
                </div>}
          </div>
          <div style={{ fontSize: 12, color: '#7ab8e0', lineHeight: 1.9, minWidth: 260, flex: 1 }}>
            <div style={{ color: '#c8e6ff', fontWeight: 700, marginBottom: 4 }}>扫码登录步骤</div>
            <div>1. 用<b>推送用的那个微信号</b>在手机上扫左侧二维码（建议小号）</div>
            <div>2. 手机上确认登录；本页 5 秒内会自动变为「已登录」</div>
            <div>3. 登录后在下方「责任映射」里为各镇街选择推送的群/人</div>
            <div style={{ color: AMBER, marginTop: 6 }}>
              ⚠️ 二维码有效期约 2–5 分钟，过期后点「手动刷新二维码」即可重出（无需人工上机）。
              守护每 60 秒会自动换一张，所以这里的码一般已是新鲜的。
            </div>
            <div style={{ color: '#5a8aaa', marginTop: 6 }}>
              提示：请在微信里<b>关闭自动更新</b>；微信升级到未适配版本会导致推送失效。
            </div>
          </div>
        </div>
      )}

      {/* 已登录：全局默认推送对象 */}
      {loggedIn && <DefaultTargetPicker current={st?.defaultTarget || null} onSaved={() => loadStatus(true)} />}
    </div>
  )
}

// ── 全局默认推送对象（方案 C：逐行为主、全局兜底）──
//   ⚠️ 目前只做「配置读写」；让推送链路真正回落到它需要改 strawWorkflow（单独的 T16 步骤）。
function DefaultTargetPicker({ current, onSaved }: { current: WechatDefaultTarget | null; onSaved: () => void }) {
  const { targets, loading, error, reload } = useWechatTargets(true)
  const [sel, setSel] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async (clear = false) => {
    setBusy(true); setMsg('')
    try {
      const body = clear ? { clear: true } : { target: sel, kind: selKind(sel, targets) }
      const r = await authFetch('/api/wechat/default-target', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const d = await r.json()
      setMsg(d.ok ? '✓ 已保存' : ('失败: ' + (d.error || '')))
      if (d.ok) onSaved()
    } catch (e) {
      setMsg('失败: ' + ((e as Error)?.message || e))
    }
    setBusy(false)
    setTimeout(() => setMsg(''), 4000)
  }

  return (
    <div style={{ borderTop: '1px solid rgba(0,80,150,0.2)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: '#5a8aaa', flex: 'none' }}>全局默认推送对象</span>
        <select value={sel} onChange={e => setSel(e.target.value)} style={selectStyle}>
          <option value="">— 请选择群 / 个人 —</option>
          {targets.groups.length > 0 && (
            <optgroup label={`微信群（${targets.groups.length}）`}>
              {targets.groups.map(t => <option key={t.wxid || t.name} value={t.name}>{t.name}{t.memberCount ? `（${t.memberCount}人）` : ''}</option>)}
            </optgroup>
          )}
          {targets.contacts.length > 0 && (
            <optgroup label={`个人（${targets.contacts.length}）`}>
              {targets.contacts.map(t => <option key={t.wxid || t.name} value={t.name}>{t.name}</option>)}
            </optgroup>
          )}
        </select>
        <button onClick={() => save(false)} disabled={busy || !sel} style={{ ...smallBtn, opacity: busy || !sel ? 0.5 : 1 }}>
          <CheckCircle2 size={13} /> 设为默认
        </button>
        {current && (
          <button onClick={() => save(true)} disabled={busy} style={{ ...smallBtn, borderColor: 'rgba(255,80,80,0.3)', background: 'rgba(255,60,60,0.1)', color: RED }}>
            清除
          </button>
        )}
        <button onClick={reload} disabled={loading} style={{ ...smallBtn, borderColor: 'rgba(0,150,220,0.3)', background: 'rgba(0,80,180,0.12)', color: '#7ab8e0' }}>
          {loading ? '读取中…' : '刷新列表'}
        </button>
        {msg && <span style={{ fontSize: 12, color: msg.startsWith('✓') ? GREEN : RED }}>{msg}</span>}
      </div>
      <div style={{ fontSize: 12, color: '#7ab8e0' }}>
        当前：{current ? <b style={{ color: GREEN }}>{current.name}</b> : <span style={{ color: AMBER }}>未设置</span>}
        {current?.setAt ? `（${current.setAt} 由 ${current.setBy || '-'} 设置）` : ''}
        {error && <span style={{ color: RED }}>　· {error}</span>}
      </div>
      {targets.caveat && <div style={{ fontSize: 11.5, color: '#5a8aaa' }}>⚠️ {targets.caveat}</div>}
    </div>
  )
}

// ── 会话清单（供下拉使用；登录后才拉）──
export function useWechatTargets(enabled: boolean) {
  const [targets, setTargets] = useState<WechatTargetsResp>({
    ok: false, loggedIn: false, driver: null, bridge: { reachable: true },
    groups: [], contacts: [], counts: { groups: 0, contacts: 0 },
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const reload = useCallback(async (force = false) => {
    setLoading(true); setError('')
    try {
      const r = await authFetch(`/api/wechat/targets${force ? '?force=1' : ''}`)
      const d: WechatTargetsResp = await r.json()
      setTargets(d)
      if (d.error) setError(d.error)
      else if (!d.loggedIn) setError('微信未登录，无法列出会话')
    } catch (e) {
      setError('会话列表读取失败: ' + ((e as Error)?.message || e))
    }
    setLoading(false)
  }, [])

  useEffect(() => { if (enabled) reload() }, [enabled, reload])
  return { targets, loading, error, reload: () => reload(true) }
}

export const selectStyle: React.CSSProperties = {
  background: 'rgba(0,20,60,0.6)', color: '#c8e6ff', border: '1px solid rgba(0,150,220,0.3)',
  borderRadius: 3, padding: '5px 8px', fontSize: 12, minWidth: 200, maxWidth: 320,
}

/** 从清单里判断某个名字是群还是个人 */
export function selKind(name: string, t: WechatTargetsResp): 'group' | 'contact' {
  if (t.groups.some(g => g.name === name)) return 'group'
  if (t.contacts.some(c => c.name === name)) return 'contact'
  return 'group'
}

/** 按名字取出 webhook（服务端已拼好；取不到就按默认规则拼一个，保证后端推送识别得了 :18888） */
export function webhookOf(name: string, t: WechatTargetsResp): string {
  const hit = [...t.groups, ...t.contacts].find(x => x.name === name)
  if (hit) return hit.webhook
  return 'http://172.16.8.16:18888/send?group=' + encodeURIComponent(name)
}

// ── 单个责任行的「发测试」按钮 ──
export function TestSendButton({ webhook, target, disabled }: { webhook: string; target: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [okColor, setOkColor] = useState(GREEN)

  const send = async () => {
    if (!webhook) { setMsg('该行未配置 webhook'); setOkColor(RED); return }
    setBusy(true); setMsg('')
    try {
      const r = await authFetch('/api/wechat/test-send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, webhook }),
      })
      const d: WechatTestSendResp = await r.json()
      if (d.ok) { setMsg('✓ 已发送'); setOkColor(GREEN) }
      else if (d.isVerifyFP) { setMsg('⚠ 桥误报（消息通常已发出）'); setOkColor(AMBER) }
      else { setMsg('✗ ' + (d.errmsg || d.error || '发送失败')); setOkColor(RED) }
    } catch (e) {
      setMsg('✗ ' + ((e as Error)?.message || e)); setOkColor(RED)
    }
    setBusy(false)
    setTimeout(() => setMsg(''), 6000)
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button onClick={send} disabled={busy || disabled} title="向该对象发一条测试消息"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 8px', fontSize: 11, cursor: busy ? 'wait' : 'pointer', borderRadius: 3,
          border: '1px solid rgba(74,222,128,0.35)', background: 'rgba(74,222,128,0.1)', color: GREEN,
          opacity: busy || disabled ? 0.5 : 1,
        }}>
        <Send size={11} strokeWidth={2} />{busy ? '发送中' : '发测试'}
      </button>
      {msg && <span style={{ fontSize: 11, color: okColor, whiteSpace: 'nowrap' }}>{msg}</span>}
    </span>
  )
}
