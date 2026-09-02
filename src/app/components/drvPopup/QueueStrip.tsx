import { useEffect, useState } from 'react'
import type { LiveEntry } from './dronePopupModel'
import { fmtDur, useNow } from './DronePopupWindow'

/**
 * v2 队列缩略图条（决策 D3：点击拉起；窗口已满时折叠「最新打开窗口」腾位）
 * 缩略图每 5s 经 /api/streams/live/snap 刷新（ZLM getSnap，需会话 token）。
 */

const CYAN = '#00aaff'
const RED = '#ff4444'

function QueueCard({ entry, token, onOpen }: { entry: LiveEntry; token: string; onOpen: (key: string) => void }) {
  const now = useNow(1000)
  const [imgNo, setImgNo] = useState(0)     // snap 缓存击穿计数
  const [imgOk, setImgOk] = useState(false)
  const [imgFailed, setImgFailed] = useState(false)

  // 每 5s 刷新缩略图（ZLM getSnap）
  useEffect(() => {
    setImgOk(false); setImgFailed(false)
    const t = window.setInterval(() => setImgNo(n => n + 1), 5000)
    return () => clearInterval(t)
  }, [entry.key])

  const live = entry.zlmOnline || !!entry.url
  return (
    <div
      onClick={() => onOpen(entry.key)}
      title="点击拉起播放（窗口已满时收起最新打开窗口腾位）"
      style={{
        width: 196, flexShrink: 0, cursor: 'pointer', borderRadius: 5, overflow: 'hidden',
        border: live ? '1px solid rgba(0,229,255,0.4)' : '1px solid rgba(0,150,220,0.25)',
        background: 'rgba(4,14,30,0.95)', pointerEvents: 'auto', transition: 'border-color 0.15s, transform 0.15s',
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = live ? '#00e5ff' : 'rgba(0,150,220,0.6)'; (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = live ? 'rgba(0,229,255,0.4)' : 'rgba(0,150,220,0.25)'; (e.currentTarget as HTMLElement).style.transform = 'none' }}
    >
      <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9', background: '#04101f' }}>
        {imgOk && !imgFailed ? (
          <img
            key={`${entry.key}-${imgNo}`}
            src={`/api/streams/live/snap?id=${encodeURIComponent(entry.streamId)}&token=${encodeURIComponent(token)}&t=${Date.now()}`}
            alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            onLoad={() => setImgOk(true)}
            onError={() => { setImgFailed(true); setImgOk(false) }}
          />
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'repeating-linear-gradient(0deg, rgba(0,40,80,0.15) 0 1px, transparent 1px 3px)' }}>
            <div style={{ width: 14, height: 14, border: `1.5px solid ${CYAN}25`, borderTop: `1.5px solid ${CYAN}`, borderRadius: '50%', animation: 'dpl-spin 1s linear infinite' }} />
          </div>
        )}
        <div style={{ position: 'absolute', top: 3, left: 3, display: 'flex', alignItems: 'center', gap: 3, padding: '0 4px', background: 'rgba(0,0,0,0.65)', borderRadius: 2 }}>
          <div style={{ width: 4, height: 4, borderRadius: '50%', background: live ? RED : '#666', boxShadow: live ? `0 0 4px ${RED}` : 'none' }} />
          <span style={{ color: live ? '#fff' : '#8aa', fontSize: 8, fontFamily: "'JetBrains Mono',monospace", fontWeight: 700 }}>{live ? 'LIVE' : '待接入'}</span>
        </div>
      </div>
      <div style={{ padding: '4px 6px', borderTop: '1px solid rgba(0,80,150,0.2)' }}>
        <div style={{ color: '#cfe8ff', fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.title}</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', color: '#5a8aaa', fontSize: 9, fontFamily: "'JetBrains Mono',monospace", marginTop: 2 }}>
          <span>{entry.deviceSn.length > 10 ? `${entry.deviceSn.slice(0, 8)}…` : entry.deviceSn}</span>
          <span>{fmtDur(now - entry.startedAt)}</span>
        </div>
      </div>
    </div>
  )
}

export function QueueStrip({ entries, token, onOpen }: {
  entries: LiveEntry[]
  token: string
  onOpen: (key: string) => void
}) {
  return (
    <div style={{ pointerEvents: 'auto', maxWidth: 900, display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 2, scrollbarWidth: 'none' }}>
      {entries.map(q => (
        <QueueCard key={`q-${q.key}-${q.openSeq}`} entry={q} token={token} onOpen={onOpen} />
      ))}
    </div>
  )
}
