import { useDashboard } from '../../context/DashboardContext'

const CYAN = '#00aaff'
const GREEN = '#00e676'
const AMBER = '#ffd740'
const ORANGE = '#ff7043'
const RED = '#ff4444'
const PURPLE = '#ab47bc'

function StatusDot({ status }: { status: 'connected' | 'disconnected' | 'connecting' | 'error' }) {
  const colors = { connected: GREEN, disconnected: '#3a5a70', connecting: AMBER, error: RED }
  const labels = { connected: '已连接', disconnected: '未连接', connecting: '连接中…', error: '错误' }
  const c = colors[status]
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%', background: c,
        boxShadow: status === 'connected' ? `0 0 6px ${c}` : 'none',
        display: 'inline-block',
        animation: status === 'connecting' ? 'pulse-dot 1s infinite' : 'none',
      }} />
      <span style={{ color: c, fontSize: 12 }}>{labels[status]}</span>
    </span>
  )
}

function StatCard({ label, value, sub, color = CYAN }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div style={{
      background: 'rgba(0,20,50,0.5)',
      border: `1px solid ${color}25`,
      borderRadius: 6,
      padding: '16px 20px',
      borderLeft: `3px solid ${color}`,
    }}>
      <div style={{ color: '#5a8aaa', fontSize: 12, marginBottom: 6 }}>{label}</div>
      <div style={{ color, fontSize: 28, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ color: '#3a5a70', fontSize: 11, marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

export function OverviewPage() {
  const { status, mqttConfig, videoStreams, dataLog, clearLog, simulateMqttConnect, simulateMqttDisconnect } = useDashboard()

  const streamsByGroup = videoStreams.reduce<Record<string, number>>((acc, s) => {
    acc[s.group] = (acc[s.group] ?? 0) + 1
    return acc
  }, {})

  return (
    <div style={{ padding: '24px 28px', overflowY: 'auto', height: '100%', scrollbarWidth: 'none' }}>
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ color: '#c8e6ff', fontSize: 18, fontWeight: 600, marginBottom: 4 }}>系统概览</h2>
        <p style={{ color: '#3a5a70', fontSize: 13 }}>各数据通道连接状态与接入量统计</p>
      </div>

      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 28 }}>
        <StatCard label="视频流总数" value={status.streamCount} sub={`${status.onlineStreams} 路在线`} color={CYAN} />
        <StatCard label="已推送告警" value={status.pushedAlerts} sub="累计推送" color={RED} />
        <StatCard label="MQTT消息" value={status.mqttMessageCount} sub="累计接收" color={GREEN} />
        <StatCard label="数据日志" value={dataLog.length} sub="最近200条" color={PURPLE} />
      </div>

      {/* Connection panels */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 28 }}>
        {/* MQTT status */}
        <div style={{ background: 'rgba(0,20,50,0.4)', border: '1px solid rgba(0,150,220,0.15)', borderRadius: 6, padding: '18px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: '#c8e6ff', fontSize: 14, fontWeight: 600 }}>MQTT Broker</span>
              {status.mqtt === 'disconnected' && (
                <span
                  title={'未连接可能原因：① Broker 服务未启动 ② brokerUrl 配置错误 ③ 网络/防火墙不通 ④ 账号密码错误。\n排查步骤：确认服务→核对 MQTT 配置页→点击"模拟连接"验证。'}
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 15, height: 15, borderRadius: '50%',
                    border: '1px solid rgba(255,112,67,0.5)', color: '#ff7043',
                    fontSize: 10, cursor: 'help', fontStyle: 'normal',
                  }}
                >?</span>
              )}
            </span>
            <StatusDot status={status.mqtt} />
          </div>
          <div style={{ color: '#5a8aaa', fontSize: 12, marginBottom: 8 }}>
            <span style={{ color: '#3a5a70' }}>地址：</span>{mqttConfig.brokerUrl}
          </div>
          <div style={{ color: '#5a8aaa', fontSize: 12, marginBottom: 14 }}>
            <span style={{ color: '#3a5a70' }}>订阅：</span>{mqttConfig.topics.filter(t => t.enabled).length} 个 Topic
          </div>
          {status.mqttLastMessage && (
            <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: 3, padding: '6px 8px', fontSize: 11, color: '#5a8aaa', fontFamily: "'JetBrains Mono', monospace", marginBottom: 12, wordBreak: 'break-all' }}>
              最后消息：{status.mqttLastMessage}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            {status.mqtt === 'disconnected' || status.mqtt === 'error' ? (
              <button onClick={simulateMqttConnect} style={btnStyle(GREEN)}>模拟连接</button>
            ) : status.mqtt === 'connected' ? (
              <button onClick={simulateMqttDisconnect} style={btnStyle(RED)}>断开连接</button>
            ) : (
              <button disabled style={{ ...btnStyle(AMBER), opacity: 0.6, cursor: 'default' }}>连接中…</button>
            )}
          </div>
        </div>

        {/* Video stream groups */}
        <div style={{ background: 'rgba(0,20,50,0.4)', border: '1px solid rgba(0,150,220,0.15)', borderRadius: 6, padding: '18px 20px' }}>
          <div style={{ color: '#c8e6ff', fontSize: 14, fontWeight: 600, marginBottom: 14 }}>视频流分组状态</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {Object.entries(streamsByGroup).map(([group, count]) => {
              const online = videoStreams.filter(s => s.group === group && !s.offline).length
              const pct = Math.round(online / count * 100)
              return (
                <div key={group} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ color: '#7ab8e0', fontSize: 12, width: 70, flexShrink: 0 }}>{group}</span>
                  <div style={{ flex: 1, height: 6, background: 'rgba(0,60,120,0.4)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: pct === 100 ? GREEN : pct > 60 ? AMBER : ORANGE, borderRadius: 3 }} />
                  </div>
                  <span style={{ color: '#5a8aaa', fontSize: 11, fontFamily: "'JetBrains Mono', monospace", width: 52, textAlign: 'right', flexShrink: 0 }}>
                    {online}/{count}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Data log */}
      <div style={{ background: 'rgba(0,20,50,0.4)', border: '1px solid rgba(0,150,220,0.15)', borderRadius: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid rgba(0,80,150,0.2)' }}>
          <span style={{ color: '#c8e6ff', fontSize: 14, fontWeight: 600 }}>数据接入日志</span>
          <button onClick={clearLog} style={btnStyle('#5a8aaa', 'sm')}>清空</button>
        </div>
        <div style={{ maxHeight: 280, overflowY: 'auto', scrollbarWidth: 'none' }}>
          {dataLog.length === 0 ? (
            <div style={{ padding: '32px 0', textAlign: 'center', color: '#3a5a70', fontSize: 13 }}>
              暂无数据日志
              <div style={{ marginTop: 8, fontSize: 12 }}>
                还没有接入数据？请到
                <span style={{ color: CYAN }}>「MQTT 配置」</span>或
                <span style={{ color: CYAN }}>「气体采集预警」</span>
                页添加数据源并启用，消息到达后即在此显示。
              </div>
            </div>
          ) : dataLog.map(entry => (
            <div key={entry.id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 16px',
              borderBottom: '1px solid rgba(0,50,100,0.15)',
              fontSize: 11,
            }}>
              <span style={{ color: '#3a5a70', fontFamily: "'JetBrains Mono', monospace", flexShrink: 0 }}>{entry.time}</span>
              <span style={{
                padding: '1px 6px', borderRadius: 2, flexShrink: 0,
                background: entry.source === 'mqtt' ? 'rgba(0,170,255,0.15)' : entry.source === 'http' ? 'rgba(0,230,118,0.15)' : 'rgba(171,71,188,0.15)',
                color: entry.source === 'mqtt' ? CYAN : entry.source === 'http' ? GREEN : PURPLE,
              }}>{entry.source.toUpperCase()}</span>
              <span style={{ color: '#5a8aaa', flexShrink: 0 }}>{entry.topic}</span>
              <span style={{
                color: '#3a5a70', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis',
                whiteSpace: 'nowrap', fontFamily: "'JetBrains Mono', monospace",
              }}>{entry.payload}</span>
              <span style={{ color: entry.status === 'ok' ? GREEN : RED, flexShrink: 0 }}>{entry.status === 'ok' ? '✓' : '✕'}</span>
            </div>
          ))}
        </div>
      </div>

      <style>{`@keyframes pulse-dot { 0%,100%{opacity:1}50%{opacity:0.3} }`}</style>
    </div>
  )
}

function btnStyle(color: string, size: 'sm' | 'md' = 'md') {
  return {
    padding: size === 'sm' ? '3px 10px' : '5px 14px',
    fontSize: size === 'sm' ? 11 : 12,
    borderRadius: 3,
    border: `1px solid ${color}55`,
    background: `${color}18`,
    color,
    cursor: 'pointer' as const,
    transition: 'all 0.15s',
  }
}
