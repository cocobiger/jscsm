# 重启 WeChatBridge Bot —— RDP 客户端 PowerShell 一键执行
# 用法：在 RDP 客户端的 PowerShell 里粘贴执行下面这一行（不需要另存为文件）
#   powershell -ExecutionPolicy Bypass -Command "& {iex (New-Object Net.WebClient).DownloadString('file:///tsclient/WX/restart_bot.ps1')}"

Write-Host '=== WeChatBridge Bot 重启 ===' -ForegroundColor Cyan
Write-Host ''

# 1. 精确杀掉旧 bot（通过命令行包含 wechat_bot_server.py 识别）
Write-Host '[1/3] 查找并杀掉旧 bot...' -ForegroundColor Yellow
$killed = 0
try {
  $oldBot = Get-WmiObject Win32_Process -Filter "Name='python.exe'" `
    | Where-Object { $_.CommandLine -and $_.CommandLine -like '*wechat_bot_server*' }
  if ($oldBot) {
    foreach ($p in $oldBot) {
      Write-Host "  发现 PID=$($p.ProcessId)"
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
      $killed++
    }
    Write-Host "  已杀掉 $killed 个旧 bot 进程"
  } else {
    Write-Host '  未发现旧 bot 进程（首次启动？）'
  }
} catch {
  Write-Host "  杀进程失败: $_" -ForegroundColor Red
}
Start-Sleep -Seconds 2

# 2. 启动新 bot（独立窗口可见，方便排错）
Write-Host ''
Write-Host '[2/3] 启动新 bot (新窗口)...' -ForegroundColor Yellow
try {
  $proc = Start-Process -FilePath 'C:\Python311\python.exe' `
    -ArgumentList 'C:\wxbridge\wechat_bot_server.py' `
    -WorkingDirectory 'C:\wxbridge' `
    -WindowStyle Normal `
    -PassThru
  Write-Host "  启动成功 PID=$($proc.Id)"
} catch {
  Write-Host "  启动失败: $_" -ForegroundColor Red
}

# 3. 等待 bot 就绪（wechatauto 加载 + wechat 连接最多 15 秒）+ 健康检查
Write-Host ''
Write-Host '[3/3] 等待 bot 就绪（最多 15 秒）...' -ForegroundColor Yellow
$ready = $false
for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep -Seconds 1
  try {
    $h = Invoke-RestMethod -Uri 'http://127.0.0.1:18888/health' -TimeoutSec 2
    if ($h.ok -and $h.wx -eq 'connected') {
      $ready = $true
      break
    }
  } catch { }
}

if ($ready) {
  Write-Host ''
  Write-Host '=== bot 就绪！健康检查 ===' -ForegroundColor Green
  $h = Invoke-RestMethod -Uri 'http://127.0.0.1:18888/health' -TimeoutSec 3
  Write-Host "  wechat_version: $($h.wechat_version)"
  Write-Host "  sessions:       $($h.sessions)"
  Write-Host "  wx:             $($h.wx)"
  Write-Host ''
  Write-Host '现在我（Linux 端）会立即测试 /send 文件传输助手...' -ForegroundColor Cyan
} else {
  Write-Host ''
  Write-Host '! 15 秒内未就绪，请截图 PowerShell 窗口报错给我' -ForegroundColor Red
  Write-Host '  微信窗口可能需要手动切到前台（任务栏点击微信图标）' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '完成。按任意键关闭此窗口...'
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')