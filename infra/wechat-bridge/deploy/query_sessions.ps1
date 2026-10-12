# query_sessions.ps1 —— 查 VM 交互式会话与微信进程（避免命令行引号问题）
Write-Output '=== quser（交互式会话）==='
$q = quser 2>&1
if ($q) { $q | ForEach-Object { Write-Output "  $_" } } else { Write-Output '  （无会话或无返回）' }
Write-Output '=== explorer/Weixin 进程 ==='
Get-Process explorer,Weixin,WeChat -ErrorAction SilentlyContinue |
  Select-Object Id,ProcessName,SessionId | Format-Table -AutoSize | Out-String | ForEach-Object { Write-Output "  $_" }
Write-Output '=== 全部会话 ==='
(Get-Process -ErrorAction SilentlyContinue | Group-Object SessionId | Select-Object Name,Count | Format-Table -AutoSize | Out-String).Trim() -split "`n" | ForEach-Object { Write-Output "  $_" }
Write-Output '=== 本机 18888 与微信版本 ==='
try {
  $h = Invoke-WebRequest 'http://127.0.0.1:18888/health' -UseBasicParsing -TimeoutSec 8
  Write-Output ("  /health " + $h.StatusCode + " " + $h.Content.Substring(0,[Math]::Min(260,$h.Content.Length)))
} catch { Write-Output "  /health 失败: $($_.Exception.Message)" }
