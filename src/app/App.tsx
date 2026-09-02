import { useState, useEffect, useCallback, useRef } from 'react'
import { TopBar } from './components/TopBar'
import { LeftPanel } from './components/LeftPanel'
import { CenterPanel } from './components/CenterPanel'
import { RightPanel } from './components/RightPanel'
import { AdminPanel } from './components/admin/AdminPanel'
import { LoginPage } from './components/LoginPage'
import { DashboardProvider, useDashboard } from './context/DashboardContext'
import { fetchMe, logout as doLogout, type CurrentUser } from './lib/auth'
import { setUnauthorizedHandler, clearToken } from './lib/apiFetch'
import type { MapTab } from './components/MapView'
import type { AlertItem } from './components/AlertPanel'
import { useDisplayScale } from './hooks/useDisplayScale'
import { DronePopupHost } from './components/drvPopup/DronePopupHost'

function Dashboard({ onOpenAdmin, layout = 'default' }: { onOpenAdmin: () => void; layout?: 'default' | 'wide' }) {
  const [activeTab, setActiveTab] = useState<MapTab>('default')
  const [selectedAlert, setSelectedAlert] = useState<AlertItem | null>(null)
  const { externalAlerts } = useDashboard()

  const handleAlertSelect = (alert: AlertItem) => {
    setSelectedAlert(prev => prev?.id === alert.id ? null : alert)
  }

  // T20 复核直达 deep-link：微信卡片携带 ?openAlert=<warning.id> 进入驾驶舱 →
  //   自动在右侧列表匹配（单条 id 或聚合组 memberIds）→ 地图定位 + 列表高亮选中。
  //   告警同步为 10s 轮询，首轮最长等 10s（500ms×20）；消费后清 URL 防刷新重复。
  const alertsRef = useRef(externalAlerts)
  alertsRef.current = externalAlerts
  const deepLinkDone = useRef(false)
  useEffect(() => {
    if (deepLinkDone.current) return
    const openAlertId = new URLSearchParams(location.search).get('openAlert')
    if (!openAlertId) return
    const findAlert = () => {
      const list = alertsRef.current
      return list.find(a => a.id === openAlertId || (a.isAggregate && a.memberIds?.includes(openAlertId))) || null
    }
    const consume = (a: AlertItem) => {
      deepLinkDone.current = true
      setSelectedAlert(a)
      history.replaceState(null, '', location.pathname) // 清 ?openAlert=，防 F5 重复定位
    }
    const hit = findAlert()
    if (hit) { consume(hit); return }
    const timer = setInterval(() => {
      const a = findAlert()
      if (a) { clearInterval(timer); consume(a) }
    }, 500)
    setTimeout(() => clearInterval(timer), 10000) // 超时未匹配（列表外旧告警）静默放弃
    return () => clearInterval(timer)
  }, [])

  // 超宽屏(layout='wide')：侧栏用百分比(随更宽画布自适应加宽)，地图占更多横向空间
  const gridCols = layout === 'wide'
    ? 'minmax(340px, 15%) 1fr minmax(460px, 19%)'
    : 'clamp(300px, 16vw, 420px) 1fr clamp(400px, 21vw, 540px)'

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',           // 无人机弹窗等 overlay 以驾驶舱画布为定位基准（随 DisplayScaler 等比缩放）
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        background: 'radial-gradient(circle at 1px 1px, rgba(0,150,220,0.06) 1px, transparent 0) #030a18',
        backgroundSize: '40px 40px',
        fontFamily: "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif",
      }}
    >
      <TopBar onOpenAdmin={onOpenAdmin} />

      <div
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: gridCols,
          // 关键：行高必须钉死为容器高度。默认 grid-auto-rows: auto 会被 cell 内容撑高
          // （LeftPanel 四段 grow 总高超 996 时行被撑到 1481px，底部段溢出可视区被裁）
          gridTemplateRows: 'minmax(0, 1fr)',
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        <LeftPanel />
        <CenterPanel
          activeTab={activeTab}
          onTabChange={setActiveTab}
          selectedAlert={selectedAlert}
          onLocate={(a) => setSelectedAlert(a)}
        />
        <RightPanel
          activeTab={activeTab}
          onSelectAlert={handleAlertSelect}
          selectedAlertId={selectedAlert?.id ?? null}
        />
      </div>

      {/* 无人机起飞自动弹窗（v2：纯状态机调度 2 窗+3 队 · 满窗折叠最新腾位 · 队列点击拉起 · 与相机 role 列表解耦） */}
      <DronePopupHost />

      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { display: none; }
        scrollbar-width: none;
        h1, h2, h3, h4 {
          font-family: 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif;
        }
        button { outline: none; }
        @keyframes pulse-glow {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  )
}

export default function App() {
  const [showAdmin, setShowAdmin] = useState(false)
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [checking, setChecking] = useState(true)
  const display = useDisplayScale() // 分辨率检测 + 自适应（始终调用，早于任何提前 return）

  // 启动时用已存 token 校验会话
  useEffect(() => {
    fetchMe().then(u => { setUser(u); setChecking(false) })
  }, [])

  // 401 时清除登录态，跳回登录页
  const handleUnauthorized = useCallback(() => {
    clearToken()
    setUser(null)
    setShowAdmin(false)
  }, [])
  useEffect(() => { setUnauthorizedHandler(handleUnauthorized) }, [handleUnauthorized])

  const handleLogout = useCallback(async () => {
    await doLogout()
    setUser(null)
    setShowAdmin(false)
  }, [])

  if (checking) {
    return (
      <div style={{
        width: '100vw', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#030c1e', color: '#5a8aaa', fontSize: 14,
        fontFamily: "'Noto Sans SC', sans-serif",
      }}>
        加载中…
      </div>
    )
  }

  if (!user) {
    return <LoginPage onSuccess={setUser} />
  }

  return (
    <DashboardProvider>
      {showAdmin ? (
        <AdminPanel onClose={() => setShowAdmin(false)} user={user} onLogout={handleLogout} />
      ) : (
        <DisplayScaler display={display}>
          <Dashboard onOpenAdmin={() => setShowAdmin(true)} layout={display.layout} />
        </DisplayScaler>
      )}
    </DashboardProvider>
  )
}

// 分辨率自适应缩放容器：以配置的设计画布(默认1920×1080)为基准，按检测到的 scale 等比缩放并居中
function DisplayScaler({ children, display }: { children: React.ReactNode; display: ReturnType<typeof useDisplayScale> }) {
  const { config, screen, scale } = display
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        overflow: 'hidden',
        background: '#03060f',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: config.baseWidth,
          height: config.baseHeight,
          flexShrink: 0,
          transform: `scale(${scale})`,
          transformOrigin: 'center center',
          background: '#050c1a',
        }}
      >
        {children}
      </div>
      {/* 调试信息：物理分辨率 / 视口 / DPR / 缩放系数（不影响布局） */}
      {screen.dpr > 1 || import.meta.env.DEV ? (
        <div
          style={{
            position: 'fixed',
            left: 6,
            bottom: 4,
            fontSize: 11,
            color: 'rgba(120,160,200,0.35)',
            fontFamily: 'monospace',
            pointerEvents: 'none',
            zIndex: 9999,
          }}
        >
          {screen.screenWidth}×{screen.screenHeight} | 视口 {screen.innerWidth}×{screen.innerHeight} | DPR {screen.dpr} | ×{scale.toFixed(2)}
        </div>
      ) : null}
    </div>
  )
}
