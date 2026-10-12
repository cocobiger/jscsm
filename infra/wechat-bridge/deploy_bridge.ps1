# deploy_bridge.ps1 —— 微信桥 Windows 侧一键部署（幂等，可重复执行）
#
# 由 226 通过 SMB 投送后远程执行；全程写日志到 C:\wxbridge\deploy.log
# 迁移背景：桥机由 172.16.8.15 改为 172.16.8.16（同机换址），Windows 侧运行时（Python + C:\wxbridge）已丢失
# 路线：保留微信 4.1.13.12，使用 wechatauto-replica（UIA+OCR 混合驱动）
#
# 🔴 本文件必须带 UTF-8 BOM（PS 5.1 对无 BOM 按 GBK 读 → 中文乱码吃掉引号 → 语法错）

$ErrorActionPreference = 'Continue'
$BRIDGE = 'C:\wxbridge'
$PY     = 'C:\Python311\python.exe'
$LOG    = Join-Path $BRIDGE 'deploy.log'
$PYURL  = 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe'
$PYEXE  = Join-Path $env:TEMP 'python-3.11.9-amd64.exe'

New-Item -ItemType Directory -Force -Path $BRIDGE | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $BRIDGE 'deploy') | Out-Null

function Say($m) {
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  $line = "[$ts] $m"
  Write-Host $line
  Add-Content -Path $LOG -Value $line -Encoding UTF8
}

Say '================ deploy_bridge 开始 ================'
Say "主机: $env:COMPUTERNAME  IP: $((Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -like '172.16.*'} | Select-Object -First 1).IPAddress)"
Say "PowerShell: $($PSVersionTable.PSVersion)"

# ── 0. 清掉上一轮的完成标记 ──
Remove-Item (Join-Path $BRIDGE 'deploy.done') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $BRIDGE 'deploy.failed') -Force -ErrorAction SilentlyContinue

# ── 1. Python 3.11 ──
Say '[1/7] 检查 Python...'
$hasPy = $false
if (Test-Path $PY) { $v = & $PY -V 2>&1; Say "  已存在: $v"; $hasPy = $true }
if (-not $hasPy) {
  Say '  未安装，尝试下载官方安装包（静默安装到 C:\Python311）...'
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $PYURL -OutFile $PYEXE -UseBasicParsing -TimeoutSec 600
    Say "  下载完成: $((Get-Item $PYEXE).Length) 字节"
  } catch { Say "  ❌ 下载失败: $($_.Exception.Message)" }
  if (Test-Path $PYEXE) {
    Say '  静默安装中（InstallAllUsers=1 PrependPath=1）...'
    $p = Start-Process -FilePath $PYEXE -ArgumentList @('/quiet','InstallAllUsers=1','PrependPath=1','Include_pip=1','Include_test=0','SimpleInstall=1') -Wait -PassThru
    Say "  安装器退出码: $($p.ExitCode)"
    Remove-Item $PYEXE -Force -ErrorAction SilentlyContinue
  }
}
if (-not (Test-Path $PY)) {
  # 兜底：全盘找一次
  $found = Get-ChildItem 'C:\' -Filter python.exe -Recurse -Depth 3 -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { $PY = $found.FullName; Say "  兜底找到: $PY" }
}
if (-not (Test-Path $PY)) { Say '❌ 无可用 Python，部署中止'; Set-Content (Join-Path $BRIDGE 'deploy.failed') 'no-python'; exit 1 }
Say "  Python OK: $(& $PY -V 2>&1)"

# ── 2. pip 依赖 ──
Say '[2/7] 安装 Python 依赖（flask/requests/pywin32/winsdk/pypinyin + wechatauto-replica）...'
& $PY -m pip install --upgrade pip 2>&1 | ForEach-Object { Say "    $_" }
& $PY -m pip install flask requests pywin32 winsdk pypinyin 2>&1 | ForEach-Object { Say "    $_" }
Say '  --- 安装 wechatauto-replica（微信 4.1.12+ 驱动）---'
& $PY -m pip install wechatauto-replica 2>&1 | ForEach-Object { Say "    $_" }
Say '  --- 依赖自检 ---'
& $PY -c "import flask,requests,win32api,winsdk,pypinyin;print('base deps OK')" 2>&1 | ForEach-Object { Say "    $_" }
try { & $PY -c "import wechatauto;print('wechatauto OK')" 2>&1 | ForEach-Object { Say "    $_" } }
catch { Say '    ⚠️ wechatauto 导入失败（可能需微信已安装/已登录）' }

# ── 3. 防火墙放行 18888 ──
Say '[3/7] 防火墙放行 TCP 18888...'
$r = netsh advfirewall firewall show rule name="wechat-bridge-18888-in" 2>&1
if ($r -match 'No rules match|没有与指定条件匹配') {
  netsh advfirewall firewall add rule name="wechat-bridge-18888-in" dir=in action=allow protocol=TCP localport=18888 | ForEach-Object { Say "    $_" }
} else { Say '  规则已存在，跳过' }

# ── 4. 停掉旧进程 ──
Say '[4/7] 停掉旧桥进程...'
Get-WmiObject Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*wechat_bot_server*' } |
  ForEach-Object { Say "  kill PID=$($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-Process python -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $PY } | ForEach-Object {
  Say "  kill python PID=$($_.Id)"; Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}

# ── 5. 启动桥服务（进程外一次性 worker 模式）──
Say '[5/7] 启动桥服务（WXBRIDGE_SEND_MODE=worker）...'
$env:WXBRIDGE_SEND_MODE = 'worker'
$env:PYTHONIOENCODING = 'utf-8'
$out = Join-Path $BRIDGE 'service_stdout.log'
$err = Join-Path $BRIDGE 'service_stderr.log'
Start-Process -FilePath $PY -ArgumentList @((Join-Path $BRIDGE 'wechat_bot_server.py'),'--port','18888') `
  -WorkingDirectory $BRIDGE -WindowStyle Normal -RedirectStandardOutput $out -RedirectStandardError $err
Start-Sleep -Seconds 8
$listen = (netstat -ano | Select-String ':18888' | Select-Object -First 2) -join ' | '
Say "  监听: $listen"
try {
  $h = Invoke-WebRequest -Uri 'http://127.0.0.1:18888/health' -UseBasicParsing -TimeoutSec 10
  Say "  /health: HTTP $($h.StatusCode)  body: $($h.Content.Substring(0,[Math]::Min(300,$h.Content.Length)))"
} catch { Say "  ⚠️ /health 失败: $($_.Exception.Message)" }

# ── 6. 开机自启（计划任务 ONLOGON，不带 /RU /RL /IT —— 见 REF 的坑）──
Say '[6/7] 注册开机自启计划任务 WeChatBridge...'
$act  = "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Normal -Command `"`$env:WXBRIDGE_SEND_MODE='worker'; `$env:PYTHONIOENCODING='utf-8'; Start-Process -FilePath '$PY' -ArgumentList '$BRIDGE\wechat_bot_server.py','--port','18888' -WorkingDirectory '$BRIDGE' -WindowStyle Normal`""
schtasks /Delete /TN WeChatBridge /F 2>&1 | Out-Null
schtasks /Create /TN WeChatBridge /SC ONLOGON /TR $act /F 2>&1 | ForEach-Object { Say "    $_" }
try {
  $t = Get-ScheduledTask -TaskName WeChatBridge -ErrorAction Stop
  $t.Settings.DisallowStartIfOnBatteries = $false
  $t.Settings.StopIfGoingOnBatteries = $false
  $t.Settings.StartWhenAvailable = $true
  $t.Settings.ExecutionTimeLimit = 'PT0S'
  Set-ScheduledTask -TaskName WeChatBridge -Settings $t.Settings | Out-Null
  Say '  已补 DisallowStartIfOnBatteries=false / StopIfGoingOnBatteries=false / StartWhenAvailable=true'
} catch { Say "  计划任务设置补写失败: $($_.Exception.Message)" }

# ── 7. 汇总 ──
Say '[7/7] 自检汇总'
Say "  C:\wxbridge 内容: $((Get-ChildItem $BRIDGE -Name) -join ', ')"
if (Test-Path $err) { Say "  stderr 尾部: $((Get-Content $err -Tail 6 -ErrorAction SilentlyContinue) -join ' | ')" }
Say '  ⚠️ 还需人工：微信扫码登录小号 + 把目标群在「最近会话」打开一次 + 关闭微信自动更新'
Say '================ deploy_bridge 结束 ================'
Set-Content (Join-Path $BRIDGE 'deploy.done') "ok $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
