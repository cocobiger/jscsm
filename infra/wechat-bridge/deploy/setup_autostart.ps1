# setup_autostart.ps1 —— 在 VM 上注册桥的开机自启（由 WMI 以 -File 方式调用）
$ErrorActionPreference = 'Continue'
$LOG = 'C:\wxbridge\autostart.log'
function Say($m) {
  $s = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $m"
  Write-Output $s
  Add-Content -Path $LOG -Value $s -Encoding UTF8
}

Say '======= setup_autostart 开始 ======='

Say '[1] 删除旧任务'
schtasks /Delete /TN WeChatBridge /F 2>&1 | ForEach-Object { Say "    $_" }

Say '[2] 创建 ONLOGON 任务（/TR 指向 .cmd，无复杂引号）'
schtasks /Create /TN WeChatBridge /SC ONLOGON /TR "C:\wxbridge\start_bridge.cmd" /F 2>&1 | ForEach-Object { Say "    $_" }

Say '[3] 补设置（电池/超时）'
try {
  $t = Get-ScheduledTask -TaskName WeChatBridge -ErrorAction Stop
  $t.Settings.DisallowStartIfOnBatteries = $false
  $t.Settings.StopIfGoingOnBatteries     = $false
  $t.Settings.StartWhenAvailable         = $true
  $t.Settings.ExecutionTimeLimit         = 'PT0S'
  Set-ScheduledTask -TaskName WeChatBridge -Settings $t.Settings | Out-Null
  Say '    SETTINGS_OK'
} catch { Say "    settings 失败: $($_.Exception.Message)" }

Say '[4] 查询任务'
schtasks /Query /TN WeChatBridge /FO LIST 2>&1 | ForEach-Object { Say "    $_" }

Say '[5] 当前桥进程与监听'
$py = Get-WmiObject Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -like '*wechat_bot_server*' }
if ($py) { $py | ForEach-Object { Say "    python PID=$($_.ProcessId)" } } else { Say '    （无桥进程）' }
$lis = (netstat -ano | Select-String ':18888' | Select-Object -First 1)
Say "    监听: $lis"

Say '======= setup_autostart 结束 ======='
Set-Content -Path 'C:\wxbridge\autostart.done' -Value "ok $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -Encoding UTF8
