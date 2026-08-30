import { useState } from 'react'
import { OverviewPage } from './OverviewPage'
import { ServerMonitorPage } from './ServerMonitorPage'
import { ServerReviewPage } from './ServerReviewPage'
import { TunePage } from './TunePage'
import { VideoStreamPage } from './VideoStreamPage'
import { MqttPage } from './MqttPage'
import { AlertFormatPage } from './AlertFormatPage'
import { AirQualityDataPage } from './AirQualityDataPage'
import { GasMonitorPage } from './GasMonitorPage'
import { SmsWarningPage } from './SmsWarningPage'
import { StatsPage } from './StatsPage'
import { MediaServerPage } from './MediaServerPage'
import { UsersPage } from './UsersPage'
import { EnterprisePage } from './EnterprisePage'
import { SmartPushPage } from './SmartPushPage'
import { WorkReportPage } from './WorkReportPage'
import { IotArchivePage } from './IotArchivePage'
import { GovDataPage } from './GovDataPage'
import { StrawMonitorPage } from './StrawMonitorPage'
import { MapCenterPage } from './MapCenterPage'
import { useDashboard } from '../../context/DashboardContext'
import { changePassword, ROLE_LABELS, roleAtLeast, type CurrentUser } from '../../lib/auth'

const CYAN = '#00aaff'
const GREEN = '#00e676'
const AMBER = '#ffd740'
const RED = '#ff4444'

type Page = 'overview' | 'video' | 'media' | 'mqtt' | 'alert' | 'airquality' | 'gas' | 'sms' | 'stats' | 'users' | 'enterprise' | 'smartpush' | 'iotarchive' | 'workreport' | 'govdata' | 'straw' | 'map' | 'servermonitor' | 'review' | 'tune'

// minRole：访问该页所需最低角色（viewer=任意登录可看）
import type { LucideIcon } from 'lucide-react'
import { LayoutDashboard, Video, Server, Radio, Bell, Send, FileText, Database, Wind, FlaskConical, Bot, Flame, Map, MessageSquare, BarChart3, Building2, Users, Activity, ClipboardCheck, SlidersHorizontal } from 'lucide-react'
const NAV: { key: Page; label: string; icon: LucideIcon; desc: string; minRole: 'viewer' | 'operator' | 'admin' }[] = [
  { key: 'overview',   label: '系统总览',   icon: LayoutDashboard, desc: '连接状态与数据统计', minRole: 'viewer' },
  { key: 'servermonitor', label: '服务器监控', icon: Activity,   desc: 'CPU/内存/磁盘/服务 · 异常邮件告警', minRole: 'viewer' },
  { key: 'review',     label: 'AI 检测复检', icon: ClipboardCheck, desc: '人工判定检测结果 · 数据回流迭代', minRole: 'viewer' },
  { key: 'tune',       label: '算法调参',   icon: SlidersHorizontal, desc: '自研算法参数优化 · 搜索/应用/回滚', minRole: 'admin' },
  { key: 'video',      label: '视频流管理', icon: Video,           desc: 'RTSP / HLS 流配置', minRole: 'viewer' },
  { key: 'media',      label: '流媒体服务器', icon: Server,        desc: 'ZLMediaKit 节点配置', minRole: 'admin' },
  { key: 'mqtt',       label: 'MQTT 配置',  icon: Radio,           desc: 'Broker 与 Topic 订阅', minRole: 'admin' },
  { key: 'alert',      label: '告警接入',   icon: Bell,            desc: 'JSON 格式映射与测试', minRole: 'admin' },
  { key: 'smartpush',  label: '智治推送',   icon: Send,            desc: '城运中心处置预案对接', minRole: 'admin' },
  { key: 'workreport', label: '智治工作报表', icon: FileText,      desc: '推送处置工作统计报表', minRole: 'viewer' },
  { key: 'govdata',    label: '政务数据导入', icon: Database,      desc: '预报/治理任务/制度/考核 Excel 导入', minRole: 'admin' },
  { key: 'airquality', label: '市局监测站数据', icon: Wind,        desc: '市局整点数据管理与推送', minRole: 'viewer' },
  { key: 'gas',        label: '气体采集预警', icon: FlaskConical,  desc: '数据源采集与污染物预警', minRole: 'viewer' },
  { key: 'iotarchive', label: 'AI分析存档',  icon: Bot,           desc: 'IoT视频分析记录按通道归档', minRole: 'viewer' },
  { key: 'straw',      label: '秸秆焚烧监控', icon: Flame,         desc: '无人机秸秆 · 引擎/告警/责任推送/复核', minRole: 'viewer' },
  { key: 'map',        label: '地图管理',   icon: Map,             desc: '图标 / 点位 / 坐标系 / 边界', minRole: 'operator' },
  { key: 'sms',        label: '短信预警推送', icon: MessageSquare, desc: '云MAS 短信通知与联系人', minRole: 'operator' },
  { key: 'stats',      label: '数据统计报表', icon: BarChart3,     desc: '采集趋势与超标统计', minRole: 'viewer' },
  { key: 'enterprise', label: '重点企业管理', icon: Building2,     desc: '企业名单与污染事件', minRole: 'operator' },
  { key: 'users',      label: '用户管理',   icon: Users,           desc: '账号、角色与权限', minRole: 'admin' },
]

interface Props {
  onClose: () => void
  user: CurrentUser
  onLogout: () => void
}

export function AdminPanel({ onClose, user, onLogout }: Props) {
  // 按角色过滤可见菜单
  const navItems = NAV.filter(n => roleAtLeast(user.role, n.minRole))
  const [page, setPage] = useState<Page>(navItems[0]?.key || 'overview')
  const { status } = useDashboard()
  const [showPwd, setShowPwd] = useState(user.forceChange === true)
  const [oldPwd, setOldPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [pwdMsg, setPwdMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const savePwd = async () => {
    if (newPwd.length < 6) { setPwdMsg({ ok: false, text: '新密码至少 6 位' }); return }
    try {
      await changePassword(oldPwd, newPwd)
      setPwdMsg({ ok: true, text: '密码已修改' })
      setTimeout(() => { setShowPwd(false); setOldPwd(''); setNewPwd(''); setPwdMsg(null) }, 800)
    } catch (e: any) {
      setPwdMsg({ ok: false, text: e?.error || '修改失败' })
    }
  }

  const mqttColor = { connected: GREEN, disconnected: '#3a5a70', connecting: AMBER, error: RED }[status.mqtt]

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 2000,
      background: '#030c1e',
      display: 'flex', flexDirection: 'column',
      fontFamily: "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif",
    }}>
      {/* Top bar */}
      <div style={{
        height: 56, flexShrink: 0,
        display: 'flex', alignItems: 'center',
        padding: '0 24px',
        background: 'linear-gradient(90deg, #040e25, #061530 50%, #040e25)',
        borderBottom: '1px solid rgba(0,150,220,0.2)',
        boxShadow: '0 2px 20px rgba(0,100,255,0.1)',
      }}>
        {/* Back button */}
        <button
          onClick={onClose}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '5px 14px', fontSize: 12, borderRadius: 3,
            border: '1px solid rgba(0,150,220,0.3)',
            background: 'rgba(0,80,180,0.12)',
            color: '#7ab8e0', cursor: 'pointer',
            marginRight: 20,
          }}
        >
          ← 返回驾驶舱
        </button>

        {/* Title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 3, height: 18, background: CYAN, borderRadius: 1 }} />
          <span style={{ color: '#c8e6ff', fontSize: 16, fontWeight: 700, letterSpacing: '0.06em' }}>
            数据接入管理后台
          </span>
          <span style={{ color: '#3a5a70', fontSize: 12 }}>万州区生态环境局AI环境防控物联网系统</span>
        </div>

        {/* Status strip */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: mqttColor, boxShadow: status.mqtt === 'connected' ? `0 0 6px ${mqttColor}` : 'none' }} />
            <span style={{ color: '#5a8aaa', fontSize: 12 }}>MQTT</span>
            <span style={{ color: mqttColor, fontSize: 12 }}>{status.mqtt === 'connected' ? '已连接' : status.mqtt === 'connecting' ? '连接中' : '未连接'}</span>
          </div>
          <div style={{ width: 1, height: 18, background: 'rgba(0,100,180,0.3)' }} />
          <div style={{ color: '#5a8aaa', fontSize: 12 }}>
            视频流 <span style={{ color: GREEN, fontFamily: "'JetBrains Mono', monospace" }}>{status.onlineStreams}</span>
            <span style={{ color: '#3a5a70' }}>/{status.streamCount}</span>
          </div>
          <div style={{ width: 1, height: 18, background: 'rgba(0,100,180,0.3)' }} />
          <div style={{ color: '#5a8aaa', fontSize: 12 }}>
            推送告警 <span style={{ color: RED, fontFamily: "'JetBrains Mono', monospace" }}>{status.pushedAlerts}</span>
          </div>
          <div style={{ width: 1, height: 18, background: 'rgba(0,100,180,0.3)' }} />
          {/* 当前用户 + 角色 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: '#7ab8e0', fontSize: 12 }}>👤 {user.username}</span>
            <span style={{ padding: '1px 7px', fontSize: 11, borderRadius: 2, background: `${CYAN}18`, border: `1px solid ${CYAN}44`, color: CYAN }}>
              {ROLE_LABELS[user.role]}
            </span>
          </div>
          <button onClick={() => { setPwdMsg(null); setOldPwd(''); setNewPwd(''); setShowPwd(true) }}
            style={{ padding: '4px 10px', fontSize: 12, borderRadius: 3, border: '1px solid rgba(0,150,220,0.3)', background: 'rgba(0,80,180,0.12)', color: '#7ab8e0', cursor: 'pointer' }}>
            改密
          </button>
          <button onClick={onLogout}
            style={{ padding: '4px 10px', fontSize: 12, borderRadius: 3, border: `1px solid ${RED}44`, background: `${RED}12`, color: '#ff8080', cursor: 'pointer' }}>
            登出
          </button>
        </div>
      </div>

      {/* 修改密码弹窗（首登 forceChange 时自动弹出） */}
      {showPwd && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget && user.forceChange !== true) setShowPwd(false) }}>
          <div style={{ width: 420, background: '#040e25', border: '1px solid rgba(0,150,220,0.3)', borderRadius: 6, padding: 24 }}>
            <div style={{ color: '#c8e6ff', fontSize: 15, fontWeight: 600, marginBottom: 8 }}>修改密码</div>
            {user.forceChange === true && (
              <div style={{ color: AMBER, fontSize: 12, marginBottom: 14 }}>⚠ 首次登录，请先修改默认密码</div>
            )}
            <input type="password" value={oldPwd} onChange={e => setOldPwd(e.target.value)} placeholder="原密码"
              style={{ width: '100%', padding: '8px 12px', background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3, color: '#c8e6ff', fontSize: 13, outline: 'none', marginBottom: 10, boxSizing: 'border-box' }} />
            <input type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)} placeholder="新密码（至少6位）"
              style={{ width: '100%', padding: '8px 12px', background: 'rgba(0,20,60,0.6)', border: '1px solid rgba(0,150,220,0.25)', borderRadius: 3, color: '#c8e6ff', fontSize: 13, outline: 'none', marginBottom: 12, boxSizing: 'border-box' }} />
            {pwdMsg && <div style={{ color: pwdMsg.ok ? GREEN : RED, fontSize: 12, marginBottom: 10 }}>{pwdMsg.ok ? '✓ ' : '✗ '}{pwdMsg.text}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              {user.forceChange !== true && <button onClick={() => setShowPwd(false)} style={{ padding: '7px 16px', fontSize: 13, borderRadius: 3, border: '1px solid rgba(0,100,180,0.3)', background: 'transparent', color: '#5a8aaa', cursor: 'pointer' }}>取消</button>}
              <button onClick={savePwd} style={{ padding: '7px 18px', fontSize: 13, borderRadius: 3, border: `1px solid ${CYAN}55`, background: `${CYAN}18`, color: CYAN, cursor: 'pointer' }}>保存</button>
            </div>
          </div>
        </div>
      )}

      {/* Body */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Sidebar */}
        <div style={{
          width: 200, flexShrink: 0,
          background: 'rgba(2,8,22,0.95)',
          borderRight: '1px solid rgba(0,80,150,0.2)',
          display: 'flex', flexDirection: 'column',
          padding: '16px 0',
        }}>
          {navItems.map(n => {
            const active = page === n.key
            return (
              <button
                key={n.key}
                onClick={() => setPage(n.key)}
                style={{
                  display: 'flex', flexDirection: 'column',
                  padding: '12px 18px',
                  background: active ? 'rgba(0,170,255,0.08)' : 'transparent',
                  borderLeft: active ? `3px solid ${CYAN}` : '3px solid transparent',
                  borderRight: 'none',
                  borderTop: 'none',
                  borderBottom: 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'all 0.15s',
                  marginBottom: 2,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                  <n.icon size={18} strokeWidth={1.75} color={active ? CYAN : '#5a8aaa'} />
                  <span style={{ color: active ? '#c8e6ff' : '#7ab8e0', fontSize: 13, fontWeight: active ? 600 : 400 }}>{n.label}</span>
                </div>
                <span style={{ color: '#3a5a70', fontSize: 11, paddingLeft: 24 }}>{n.desc}</span>
              </button>
            )
          })}

          {/* Bottom: info */}
          <div style={{ marginTop: 'auto', padding: '16px 18px', borderTop: '1px solid rgba(0,60,120,0.2)' }}>
            <div style={{ color: '#2a4a60', fontSize: 11, lineHeight: 1.8 }}>
              <div>v1.0.0</div>
              <div>数据接入管理系统</div>
              <div style={{ marginTop: 4, color: '#1a3a50' }}>配置持久化到 localStorage</div>
            </div>
          </div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: 'hidden', background: 'rgba(3,10,28,0.98)' }}>
          {page === 'overview'   && <OverviewPage />}
          {page === 'servermonitor' && <ServerMonitorPage />}
          {page === 'review'     && <ServerReviewPage />}
          {page === 'tune'       && <TunePage />}
          {page === 'video'      && <VideoStreamPage />}
          {page === 'media'      && <MediaServerPage />}
          {page === 'mqtt'       && <MqttPage />}
          {page === 'alert'      && <AlertFormatPage />}
          {page === 'airquality' && <AirQualityDataPage />}
          {page === 'gas'        && <GasMonitorPage />}
          {page === 'iotarchive' && <IotArchivePage user={user} />}
          {page === 'sms'        && <SmsWarningPage />}
          {page === 'stats'      && <StatsPage />}
          {page === 'enterprise' && <EnterprisePage />}
          {page === 'smartpush'  && <SmartPushPage />}
          {page === 'workreport' && <WorkReportPage />}
          {page === 'govdata'    && <GovDataPage />}
          {page === 'users'      && <UsersPage currentUserId={user.id} />}
          {page === 'straw'      && <StrawMonitorPage />}
          {page === 'map'        && <MapCenterPage role={user.role} />}
        </div>
      </div>

      <style>{`
        input[type="text"], input[type="password"], input[type="number"], select, textarea {
          background: rgba(0,20,60,0.6) !important;
        }
        input::placeholder, textarea::placeholder { color: #2a4a60 !important; }
        select option { background: #061530; color: #c8e6ff; }
      `}</style>
    </div>
  )
}
