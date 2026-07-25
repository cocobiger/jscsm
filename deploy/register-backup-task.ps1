# ============================================================
#  register-backup-task.ps1
#  在本服务器注册「每日自动备份 server\data\」的 Windows 计划任务。
#  在服务器上以【管理员】身份运行一次即可。
#
#  默认：每天 02:00，以 SYSTEM 身份、最高权限运行 backup-data.ps1
#
#  用法（管理员 PowerShell）：
#    .\register-backup-task.ps1
#  自定义时间：
#    .\register-backup-task.ps1 -Time "01:30"
#  立即跑一次验证：
#    .\register-backup-task.ps1 -RunNow
#  卸载任务：
#    .\register-backup-task.ps1 -Unregister
# ============================================================
param(
    [string]$Time = "02:00",       # 每日执行时间 HH:mm
    [switch]$RunNow,               # 注册后立即触发一次
    [switch]$Unregister            # 移除任务
)

$ErrorActionPreference = "Stop"

# ---- 按实际环境修改 ----
$TaskName    = "JscDataBackup"
$BackupScript = "C:\jsc\deploy\backup-data.ps1"   # 备份脚本路径
# ------------------------

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "请以管理员身份运行此脚本（右键 PowerShell → 以管理员身份运行）"
    }
}

Assert-Admin

# ---- 卸载分支 ----
if ($Unregister) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "已移除计划任务：$TaskName" -ForegroundColor Green
    } else {
        Write-Host "计划任务 $TaskName 不存在，无需移除。" -ForegroundColor Yellow
    }
    exit 0
}

if (-not (Test-Path $BackupScript)) {
    throw "未找到备份脚本：$BackupScript`n请确认路径，或修改脚本中的 `$BackupScript。"
}

# 校验时间格式
if ($Time -notmatch '^\d{2}:\d{2}$') { throw "时间格式应为 HH:mm，例如 02:00" }

# ---- 构造任务三要素：动作 / 触发器 / 主体 ----
$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$BackupScript`""

$trigger = New-ScheduledTaskTrigger -Daily -At $Time

# 以 SYSTEM 身份、最高权限运行（无需登录、不弹窗）
$principal = New-ScheduledTaskPrincipal `
    -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopOnIdleEnd `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)

# 已存在则先移除（幂等重装）
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host "任务 $TaskName 已存在，先移除后重建 ..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName    $TaskName `
    -Action      $action `
    -Trigger     $trigger `
    -Principal   $principal `
    -Settings    $settings `
    -Description "每日自动备份 JSC 后端数据目录 server\data\" | Out-Null

Write-Host "已注册计划任务：$TaskName（每天 $Time，SYSTEM 身份）" -ForegroundColor Green

# ---- 可选：立即触发一次验证 ----
if ($RunNow) {
    Write-Host "立即触发一次备份 ..." -ForegroundColor Cyan
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 3
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host ("  上次运行时间 : {0}" -f $info.LastRunTime)
    Write-Host ("  上次运行结果 : {0}  (0 = 成功)" -f $info.LastTaskResult)
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host " 完成。" -ForegroundColor Green
Write-Host "  查看任务 : Get-ScheduledTask -TaskName $TaskName" -ForegroundColor Gray
Write-Host "  运行状态 : Get-ScheduledTaskInfo -TaskName $TaskName" -ForegroundColor Gray
Write-Host "  手动触发 : Start-ScheduledTask -TaskName $TaskName" -ForegroundColor Gray
Write-Host "  移除任务 : .\register-backup-task.ps1 -Unregister" -ForegroundColor Gray
Write-Host "  备份输出 : 见 backup-data.ps1 中的 `$BackupDir（默认 D:\backup\jsc）" -ForegroundColor Gray
Write-Host "============================================" -ForegroundColor Green
