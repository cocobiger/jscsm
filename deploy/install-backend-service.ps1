# ============================================================
#  install-backend-service.ps1
#  用 NSSM 把后端 Node 服务注册为 Windows 服务
#  （开机自启 + 崩溃自动重启 + 日志落盘）
#
#  前置：
#    1. 已安装 Node.js (>=18, 推荐22)，且 node 在 PATH 中
#    2. 已下载 NSSM (https://nssm.cc/download)，把 nssm.exe 路径填到下方 $Nssm
#    3. server 目录已执行过 npm install
#
#  用法（管理员 PowerShell）：
#    .\install-backend-service.ps1
#  卸载：
#    .\install-backend-service.ps1 -Uninstall
# ============================================================
param(
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

# ---- 按实际环境修改这几个变量 ----
$ServiceName = "JscBackend"                       # 服务名
$Nssm        = "C:\jsc\tools\nssm.exe"            # nssm.exe 路径
$ServerDir   = "C:\jsc\server"                    # 后端代码目录（含 index.js）
$NodeExe     = (Get-Command node -ErrorAction SilentlyContinue).Source  # 自动定位 node
$LogDir      = "C:\jsc\logs"                       # 服务 stdout/stderr 日志目录
# ----------------------------------

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "请以管理员身份运行此脚本（右键 PowerShell → 以管理员身份运行）"
    }
}

Assert-Admin

if (-not (Test-Path $Nssm)) {
    throw "未找到 nssm.exe：$Nssm`n请从 https://nssm.cc/download 下载后，把 nssm.exe 放到该路径，或修改脚本中的 `$Nssm。"
}

# ---- 卸载分支 ----
if ($Uninstall) {
    Write-Host "正在停止并移除服务 $ServiceName ..." -ForegroundColor Yellow
    & $Nssm stop   $ServiceName 2>$null
    & $Nssm remove $ServiceName confirm 2>$null
    Write-Host "已卸载服务 $ServiceName。" -ForegroundColor Green
    exit 0
}

if (-not $NodeExe)            { throw "未在 PATH 中找到 node，请先安装 Node.js 或把 node 加入 PATH。" }
if (-not (Test-Path "$ServerDir\index.js")) { throw "未找到 $ServerDir\index.js，请确认 `$ServerDir 是否正确。" }
if (-not (Test-Path "$ServerDir\node_modules")) {
    Write-Host "警告：$ServerDir\node_modules 不存在，服务可能无法启动。请先在 server 目录执行 npm install。" -ForegroundColor Yellow
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# 若服务已存在，先移除再重装（幂等）
$existing = & $Nssm status $ServiceName 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "服务 $ServiceName 已存在，先移除后重装 ..." -ForegroundColor Yellow
    & $Nssm stop   $ServiceName 2>$null
    & $Nssm remove $ServiceName confirm 2>$null
    Start-Sleep -Seconds 1
}

Write-Host "正在安装服务 $ServiceName ..." -ForegroundColor Cyan
# 入口：node index.js，工作目录 = server（保证 data/ 落在 server\data）
& $Nssm install $ServiceName $NodeExe "index.js"
& $Nssm set $ServiceName AppDirectory      $ServerDir
& $Nssm set $ServiceName DisplayName        "JSC 生态环境驾驶舱后端"
& $Nssm set $ServiceName Description         "万州区生态环境局驾驶舱 Node 后端 (端口 7170)"
& $Nssm set $ServiceName Start               SERVICE_AUTO_START      # 开机自启

# 崩溃自动重启策略
& $Nssm set $ServiceName AppExit Default Restart
& $Nssm set $ServiceName AppRestartDelay 3000                        # 崩溃后 3 秒重启
& $Nssm set $ServiceName AppThrottle      5000

# 日志落盘 + 滚动（按大小切割，保留历史）
& $Nssm set $ServiceName AppStdout        "$LogDir\backend-out.log"
& $Nssm set $ServiceName AppStderr        "$LogDir\backend-err.log"
& $Nssm set $ServiceName AppRotateFiles   1
& $Nssm set $ServiceName AppRotateOnline  1
& $Nssm set $ServiceName AppRotateBytes   10485760                   # 10MB 切割

Write-Host "正在启动服务 ..." -ForegroundColor Cyan
& $Nssm start $ServiceName
Start-Sleep -Seconds 2
& $Nssm status $ServiceName

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host " 后端服务已安装并启动：$ServiceName" -ForegroundColor Green
Write-Host "  监听端口 : 7170" -ForegroundColor Green
Write-Host "  日志目录 : $LogDir" -ForegroundColor Green
Write-Host "  首次启动会在 server\data\config.json 生成 API Key" -ForegroundColor Green
Write-Host "  查看 Key : type $ServerDir\data\config.json" -ForegroundColor Green
Write-Host "--------------------------------------------" -ForegroundColor Green
Write-Host " 常用命令：" -ForegroundColor Gray
Write-Host "   $Nssm restart $ServiceName" -ForegroundColor Gray
Write-Host "   $Nssm stop    $ServiceName" -ForegroundColor Gray
Write-Host "   .\install-backend-service.ps1 -Uninstall   # 卸载" -ForegroundColor Gray
Write-Host "============================================" -ForegroundColor Green
