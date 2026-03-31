<#
.SYNOPSIS
    NanoClaw one-line installer for Windows
.DESCRIPTION
    Installs NanoClaw globally via npm and runs nanoclaw init.
    Supports installing from a local .tgz package or npm registry.
.PARAMETER Package
    Path to local .tgz package file. If not specified, installs from npm registry.
.EXAMPLE
    .\install.ps1
    .\install.ps1 -Package .\nanoclaw-github-copilot-1.2.19.tgz
    # Or one-liner:
    irm https://raw.githubusercontent.com/kenans/nanoclaw-github-copilot/main/install.ps1 | iex
#>
param(
    [string]$Package = ""
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=== NanoClaw Installer ===" -ForegroundColor Cyan
Write-Host ""

# ─── Check Node.js ────────────────────────────────────────────────────────────

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "❌ Node.js not found." -ForegroundColor Red
    Write-Host ""
    Write-Host "Install Node.js 20+:" -ForegroundColor Yellow
    Write-Host "  winget install OpenJS.NodeJS"
    Write-Host "  # or download from https://nodejs.org"
    Write-Host ""
    exit 1
}

$nodeVersion = (node --version).TrimStart('v')
$major = [int]($nodeVersion.Split('.')[0])
if ($major -lt 20) {
    Write-Host "❌ Node.js $nodeVersion found, but 20+ required." -ForegroundColor Red
    Write-Host "  Update: winget upgrade OpenJS.NodeJS"
    exit 1
}
Write-Host "✅ Node.js $nodeVersion" -ForegroundColor Green

# ─── Check npm ────────────────────────────────────────────────────────────────

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "❌ npm not found." -ForegroundColor Red
    exit 1
}
$npmVersion = npm --version
Write-Host "✅ npm $npmVersion" -ForegroundColor Green

# ─── Check Docker (optional) ─────────────────────────────────────────────────

if (Get-Command docker -ErrorAction SilentlyContinue) {
    try {
        docker info 2>$null | Out-Null
        Write-Host "✅ Docker available (sandbox mode supported)" -ForegroundColor Green
    } catch {
        Write-Host "⚠️  Docker installed but not running (host mode only)" -ForegroundColor Yellow
    }
} else {
    Write-Host "⚠️  Docker not found — host mode only (no sandbox)" -ForegroundColor Yellow
    Write-Host "   Install Docker Desktop: winget install Docker.DockerDesktop"
}

Write-Host ""

# ─── Install NanoClaw ─────────────────────────────────────────────────────────

Write-Host "📦 Installing NanoClaw..." -ForegroundColor Yellow

if ($Package -and (Test-Path $Package)) {
    Write-Host "   From local package: $Package"
    npm install -g $Package
} elseif ($Package) {
    Write-Host "❌ Package file not found: $Package" -ForegroundColor Red
    exit 1
} else {
    Write-Host "   From npm registry..."
    npm install -g nanoclaw-github-copilot
}

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Installation failed." -ForegroundColor Red
    exit 1
}

Write-Host "✅ NanoClaw installed" -ForegroundColor Green
Write-Host ""

# ─── Initialize workspace ────────────────────────────────────────────────────

$workspace = Join-Path $env:USERPROFILE ".nanoclaw"
if (-not (Test-Path (Join-Path $workspace "nanoclaw.json"))) {
    Write-Host "📁 Initializing workspace..." -ForegroundColor Yellow
    nanoclaw init
} else {
    Write-Host "📁 Workspace already exists at $workspace" -ForegroundColor Green
}

Write-Host ""

# ─── Done ────────────────────────────────────────────────────────────────────

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "✅ NanoClaw installed!" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Edit config:    notepad $workspace\nanoclaw.json"
Write-Host "  2. Add credentials: notepad $workspace\.env"
Write-Host "  3. Check setup:    nanoclaw doctor"
Write-Host ""

if (Get-Command docker -ErrorAction SilentlyContinue) {
    try {
        docker info 2>$null | Out-Null
        Write-Host "[*] Building agent container..." -ForegroundColor Yellow
        nanoclaw sandbox build
        if ($LASTEXITCODE -eq 0) {
            Write-Host "[OK] Container built" -ForegroundColor Green
        } else {
            Write-Host "[WARN] Container build failed. Retry: nanoclaw sandbox build" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "[WARN] Docker not running. Skip container build." -ForegroundColor Yellow
    }
} else {
    Write-Host "[INFO] Docker not found. Using host mode (no container)." -ForegroundColor Cyan
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
# --- Auth check ---
Write-Host ""
Write-Host "[*] Checking authentication..." -ForegroundColor Yellow
$authResult = nanoclaw auth status 2>&1
if ($authResult -match "Not authenticated") {
    Write-Host "[!] GitHub Copilot not authenticated." -ForegroundColor Yellow
    Write-Host "    Running: nanoclaw auth login" -ForegroundColor Yellow
    nanoclaw auth login
} else {
    Write-Host "[OK] Authenticated" -ForegroundColor Green
}

# --- Channel check ---
Write-Host ""
$config = Get-Content "$workspace\nanoclaw.json" -Raw | ConvertFrom-Json -ErrorAction SilentlyContinue
$hasChannel = $false
if ($config.channels) {
    if ($config.channels.telegram.enabled -or $config.channels.teams.enabled) { $hasChannel = $true }
}
if (-not $hasChannel) {
    Write-Host "[!] No channels configured." -ForegroundColor Yellow
    Write-Host "    Edit: notepad $workspace\nanoclaw.json" -ForegroundColor Yellow
    Write-Host "    Enable telegram or teams, then add bot token to .env" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor Yellow
Write-Host "    1. Edit config:     notepad $workspace\nanoclaw.json"
Write-Host "    2. Add credentials: notepad $workspace\.env"
Write-Host "    3. Check setup:     nanoclaw doctor"
Write-Host ""
Write-Host "  Sandbox mode: nanoclaw sandbox build && nanoclaw start"
Write-Host "  Host mode:    set mode to host in nanoclaw.json, then nanoclaw start"
Write-Host "============================================" -ForegroundColor Cyan
