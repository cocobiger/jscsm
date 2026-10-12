# watchdog.ps1 — 用户会话内常驻守护：检测 wechat_bot_server 未运行则拉起
# 由 schtasks ONLOGON 启动（与微信同会话 Session 2）
$ErrorActionPreference = 'Continue'
$BotScript = 'C:\wxbridge\wechat_bot_server.py'
$Python = 'C:\Python311\python.exe'
$LogFile = 'C:\wxbridge\watchdog.log'

function W($msg) {
    Add-Content -Path $LogFile -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
}

W "watchdog started (session=$([System.Diagnostics.Process]::GetCurrentProcess().SessionId))"

while ($true) {
    try {
        $running = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -match 'wechat_bot_server' }
        if (-not $running) {
            W "bot not running, restarting..."
            Start-Process -FilePath $Python -ArgumentList $BotScript -WorkingDirectory 'C:\wxbridge' -WindowStyle Hidden
            Start-Sleep -Seconds 5
        }
    } catch {
        W "watchdog error: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds 15
}