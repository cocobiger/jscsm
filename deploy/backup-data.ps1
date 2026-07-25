# ============================================================
#  backup-data.ps1  ——  后端数据目录定期备份
#  备份 server\data\（含全部 JSON + config.json），打包到指定目录，
#  保留最近 N 份。建议配 Windows 任务计划，每日执行。
#
#  用法：
#    .\deploy\backup-data.ps1
#  配任务计划（管理员，每天 02:00）：
#    schtasks /create /tn "JscDataBackup" /tr "powershell -ExecutionPolicy Bypass -File C:\jsc\deploy\backup-data.ps1" /sc daily /st 02:00 /ru SYSTEM
# ============================================================
$ErrorActionPreference = "Stop"

# ---- 按实际环境修改 ----
$DataDir    = "C:\jsc\server\data"      # 后端数据目录
$BackupDir  = "D:\backup\jsc"           # 备份输出目录（建议独立磁盘）
$KeepCount  = 30                         # 保留最近多少份
# ------------------------

if (-not (Test-Path $DataDir)) { throw "数据目录不存在：$DataDir" }
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$out   = Join-Path $BackupDir "jsc-data-$stamp.zip"

Compress-Archive -Path "$DataDir\*" -DestinationPath $out -Force
Write-Host "已备份：$out" -ForegroundColor Green

# 清理超出保留份数的旧备份
Get-ChildItem $BackupDir -Filter "jsc-data-*.zip" | Sort-Object Name -Descending |
    Select-Object -Skip $KeepCount | ForEach-Object {
        Remove-Item $_.FullName -Force
        Write-Host "已清理旧备份：$($_.Name)" -ForegroundColor DarkGray
    }
