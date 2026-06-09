#Requires -Version 5.1
# Deploy pipeline: Convex dev sync -> Aliyun (ECS) -> Cloudflare Pages.
# No lint, no tests, no prompts beyond what deploy.sh already asks.
# Run from repo root in PowerShell: .\deploy-dual.ps1

$ErrorActionPreference = "Stop"

# Make sure we run from the repo root (where .env.deploy lives)
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

function Step-Header($msg) {
    Write-Host "`n$msg" -ForegroundColor Cyan
}

if (-not (Get-Command bash -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: 'bash' was not found on PATH." -ForegroundColor Red
    Write-Host "Install Git for Windows (https://git-scm.com/download/win), open a fresh PowerShell, and retry." -ForegroundColor Yellow
    exit 1
}

# -l (login) is required so Git Bash initializes its PATH, /tmp, and coreutils
# (dirname, cd, ssh, tar, etc.) when invoked from PowerShell/CMD.
$Bash = "bash"

Step-Header "==> [1/3] Syncing Convex dev..."
bunx convex dev --once

Step-Header "==> [2/3] Deploying SPA to Aliyun (frontend /addin/)..."
& $Bash -l scripts/deploy.sh frontend

Step-Header "==> [3/3] Deploying SPA to Cloudflare Pages..."
& $Bash -l scripts/deploy.sh cloudflare

Write-Host "`n==> All done!" -ForegroundColor Green
