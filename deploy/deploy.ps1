# ============================================================
#  deploy.ps1  ——  方案B 前端构建 + 发布脚本 (Windows)
#  做三件事：
#    1. pnpm install + pnpm build  生成 dist/
#    2. 把 dist 发布到 Nginx 托管目录（先备份旧版，支持回滚）
#    3. reload Nginx 使其生效
#
#  用法（项目根目录，普通或管理员 PowerShell）：
#    .\deploy\deploy.ps1
#  仅构建不发布：
#    .\deploy\deploy.ps1 -BuildOnly
#  回滚到上一个发布版本：
#    .\deploy\deploy.ps1 -Rollback
# ============================================================
param(
    [switch]$BuildOnly,
    [switch]$Rollback
)

$ErrorActionPreference = "Stop"

# ---- 按实际环境修改 ----
$ProjectRoot = Split-Path $PSScriptRoot -Parent     # 默认：deploy 的上级 = 项目根
$PublishDir  = "C:\jsc\dist"                         # Nginx root 指向的目录（与 jsc.conf 一致）
$NginxDir    = "C:\jsc\nginx"                         # Nginx 安装目录（含 nginx.exe）
$BackupRoot  = "C:\jsc\releases"                      # 历史发布备份目录
# ------------------------

function Reload-Nginx {
    $nginxExe = Join-Path $NginxDir "nginx.exe"
    if (-not (Test-Path $nginxExe)) {
        Write-Host "  (跳过) 未找到 nginx.exe：$nginxExe，请手动 reload。" -ForegroundColor Yellow
        return
    }
    Push-Location $NginxDir
    try {
        # 先测试配置
        & $nginxExe -t
        if ($LASTEXITCODE -ne 0) { throw "nginx 配置测试失败，已中止 reload。" }
        # 若未运行则启动，否则 reload
        $running = Get-Process nginx -ErrorAction SilentlyContinue
        if ($running) { & $nginxExe -s reload; Write-Host "  Nginx 已 reload。" -ForegroundColor Green }
        else          { Start-Process $nginxExe; Write-Host "  Nginx 已启动。" -ForegroundColor Green }
    } finally { Pop-Location }
}

# ---- 回滚分支 ----
if ($Rollback) {
    if (-not (Test-Path $BackupRoot)) { throw "无备份目录 $BackupRoot，无法回滚。" }
    $last = Get-ChildItem $BackupRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1
    if (-not $last) { throw "无历史发布版本可回滚。" }
    Write-Host "回滚到版本：$($last.Name)" -ForegroundColor Yellow
    if (Test-Path $PublishDir) { Remove-Item $PublishDir -Recurse -Force }
    Copy-Item $last.FullName $PublishDir -Recurse -Force
    Reload-Nginx
    Write-Host "已回滚到 $($last.Name)。" -ForegroundColor Green
    exit 0
}

# ---- 1. 构建 ----
Write-Host "[1/3] 构建前端 (pnpm install + build) ..." -ForegroundColor Cyan
Push-Location $ProjectRoot
try {
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
        throw "未找到 pnpm，请先：npm i -g pnpm"
    }
    pnpm install
    if ($LASTEXITCODE -ne 0) { throw "pnpm install 失败" }
    pnpm build
    if ($LASTEXITCODE -ne 0) { throw "pnpm build 失败" }
} finally { Pop-Location }

$builtDist = Join-Path $ProjectRoot "dist"
if (-not (Test-Path $builtDist)) { throw "构建未产出 dist/，请检查构建日志。" }
Write-Host "  构建完成：$builtDist" -ForegroundColor Green

if ($BuildOnly) {
    Write-Host "BuildOnly 模式：仅构建，未发布。" -ForegroundColor Yellow
    exit 0
}

# ---- 2. 发布（先备份旧版）----
Write-Host "[2/3] 发布到 $PublishDir ..." -ForegroundColor Cyan
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
if (Test-Path $PublishDir) {
    New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null
    $backup = Join-Path $BackupRoot $stamp
    Copy-Item $PublishDir $backup -Recurse -Force
    Write-Host "  旧版已备份到 $backup" -ForegroundColor Green
    # 仅保留最近 5 个历史版本
    Get-ChildItem $BackupRoot -Directory | Sort-Object Name -Descending |
        Select-Object -Skip 5 | ForEach-Object { Remove-Item $_.FullName -Recurse -Force }
    Remove-Item $PublishDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Split-Path $PublishDir -Parent) | Out-Null
Copy-Item $builtDist $PublishDir -Recurse -Force
Write-Host "  已发布新版本。" -ForegroundColor Green

# ---- 3. reload Nginx ----
Write-Host "[3/3] Reload Nginx ..." -ForegroundColor Cyan
Reload-Nginx

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host " 发布完成。" -ForegroundColor Green
Write-Host "  访问：http://<服务器IP>/" -ForegroundColor Green
Write-Host "  回滚：.\deploy\deploy.ps1 -Rollback" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
