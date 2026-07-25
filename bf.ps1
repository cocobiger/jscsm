# 系统备份脚本 - 在项目根目录运行
# 用法：右键"使用 PowerShell 运行"，或在项目根目录执行 .\备份系统.ps1
# 作用：打包源码+运行数据+配置（排除 node_modules），生成带时间戳的 zip

$ErrorActionPreference = "Stop"

# 项目根目录（脚本所在目录）
$root = $PSScriptRoot
if (-not $root) { $root = Get-Location }
Set-Location $root

$date = Get-Date -Format "yyyyMMdd-HHmm"
$backupName = "jsc-backup-$date"
$tempDir = Join-Path $env:TEMP $backupName
$outZip = Join-Path $root "$backupName.zip"

Write-Host "开始备份：$root" -ForegroundColor Cyan

# 1. 清理旧的临时目录
if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
New-Item -ItemType Directory -Path $tempDir | Out-Null

# 2. 要排除的目录/文件
$excludeDirs = @("node_modules", "dist", ".git")
$excludePatterns = @("*.tmp", "*.tmp.*")

# 3. 复制需要备份的内容（robocopy 排除 node_modules 等）
Write-Host "正在复制文件（排除 node_modules）..." -ForegroundColor Yellow
$xd = $excludeDirs | ForEach-Object { Join-Path $root $_ }
# server/node_modules 也排除
$xd += Join-Path $root "server\node_modules"
$xd += Join-Path $root "server\data\logs"

robocopy $root $tempDir /E /XD $xd /XF $excludePatterns /NFL /NDL /NJH /NJS /NP | Out-Null

# 4. 打包成 zip
Write-Host "正在压缩..." -ForegroundColor Yellow
if (Test-Path $outZip) { Remove-Item $outZip -Force }
Compress-Archive -Path "$tempDir\*" -DestinationPath $outZip -Force

# 5. 清理临时目录
Remove-Item $tempDir -Recurse -Force

# 6. 报告
$size = [math]::Round((Get-Item $outZip).Length / 1MB, 2)
Write-Host ""
Write-Host "✓ 备份完成！" -ForegroundColor Green
Write-Host "  文件：$outZip" -ForegroundColor Green
Write-Host "  大小：$size MB" -ForegroundColor Green
Write-Host ""
Write-Host "提示：还原步骤见 docs\系统还原部署文档.md" -ForegroundColor Cyan
Write-Host "      此包不含 node_modules，新服务器解压后运行 pnpm install + (cd server; npm install) 即可。" -ForegroundColor DarkGray
