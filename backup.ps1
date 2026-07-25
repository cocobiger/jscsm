# JSC System Backup Script
# Usage: run in project root -  .\backup.ps1
# Packs source + server/data + config (excludes node_modules), output: jsc-backup-<date>.zip

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
if (-not $root) { $root = Get-Location }
Set-Location $root

$date = Get-Date -Format "yyyyMMdd-HHmm"
$backupName = "jsc-backup-$date"
$tempDir = Join-Path $env:TEMP $backupName
$outZip = Join-Path $root "$backupName.zip"

Write-Host "Backup start: $root" -ForegroundColor Cyan

# 1. clean temp dir
if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
New-Item -ItemType Directory -Path $tempDir | Out-Null

# 2. exclude these dirs / files
$xd = @(
    (Join-Path $root "node_modules"),
    (Join-Path $root "dist"),
    (Join-Path $root ".git"),
    (Join-Path $root "server\node_modules"),
    (Join-Path $root "server\data\logs")
)
$xf = @("*.tmp", "*.tmp.*")

# 3. copy (robocopy excludes node_modules etc). robocopy exit codes 0-7 are success.
Write-Host "Copying files (excluding node_modules)..." -ForegroundColor Yellow
robocopy $root $tempDir /E /XD $xd /XF $xf /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with code $LASTEXITCODE" }

# 4. zip
Write-Host "Compressing..." -ForegroundColor Yellow
if (Test-Path $outZip) { Remove-Item $outZip -Force }
Compress-Archive -Path "$tempDir\*" -DestinationPath $outZip -Force

# 5. clean temp
Remove-Item $tempDir -Recurse -Force

# 6. report
$size = [math]::Round((Get-Item $outZip).Length / 1MB, 2)
Write-Host ""
Write-Host "[OK] Backup done." -ForegroundColor Green
Write-Host "  File: $outZip" -ForegroundColor Green
Write-Host "  Size: $size MB" -ForegroundColor Green
Write-Host ""
Write-Host "Restore guide: docs\restore-deploy.md (or docs\backup-restore)" -ForegroundColor Cyan
Write-Host "No node_modules included. On new server: pnpm install, then cd server and npm install." -ForegroundColor DarkGray
