# JSC One-click Start Script
# Usage: right-click "Run with PowerShell", or run  .\start.ps1  in project root
# Starts backend (port 7170) and frontend (port 5173) in two separate windows.

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
if (-not $root) { $root = Get-Location }

$serverDir = Join-Path $root "server"

Write-Host "================================" -ForegroundColor Cyan
Write-Host " JSC System - One-click Start" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan
Write-Host ""

# 1. Check Docker / ZLMediaKit (optional, for video streaming)
Write-Host "[1/3] Checking ZLMediaKit container..." -ForegroundColor Yellow
$zlm = docker ps --filter "name=zlmediakit" --format "{{.Names}}" 2>$null
if ($zlm) {
    Write-Host "  ZLMediaKit already running: $zlm" -ForegroundColor Green
} else {
    Write-Host "  ZLMediaKit not running, trying to start..." -ForegroundColor DarkGray
    docker start zlmediakit-server 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host "  ZLMediaKit started." -ForegroundColor Green }
    else { Write-Host "  (skip) No ZLMediaKit container - video streaming will be unavailable." -ForegroundColor DarkGray }
}
Write-Host ""

# 2. Start backend in a new window
Write-Host "[2/3] Starting backend (port 7170)..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$serverDir'; Write-Host 'JSC Backend (port 7170)' -ForegroundColor Cyan; npm start"
Write-Host "  Backend window opened." -ForegroundColor Green
Start-Sleep -Seconds 2
Write-Host ""

# 3. Start frontend in a new window
Write-Host "[3/3] Starting frontend (port 5173)..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root'; Write-Host 'JSC Frontend (port 5173)' -ForegroundColor Cyan; pnpm dev --host"
Write-Host "  Frontend window opened." -ForegroundColor Green
Write-Host ""

Write-Host "================================" -ForegroundColor Green
Write-Host " All started." -ForegroundColor Green
Write-Host "  Local:  http://localhost:5173" -ForegroundColor Green
Write-Host "  LAN:    http://<this-PC-IP>:5173  (run ipconfig to see IP)" -ForegroundColor Green
Write-Host "================================" -ForegroundColor Green
Write-Host ""
Write-Host "Note: two new PowerShell windows opened (backend + frontend)." -ForegroundColor DarkGray
Write-Host "Keep them open while using the system. Close them to stop." -ForegroundColor DarkGray
