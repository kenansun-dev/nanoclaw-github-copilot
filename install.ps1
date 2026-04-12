# NanoClaw one-line installer for Windows
# Usage: irm https://raw.githubusercontent.com/kenans/nanoclaw-github-copilot/main/install.ps1 | iex
#
$Package = ""
$Source = "auto"
$REPO = "kenans/nanoclaw-github-copilot"

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=== NanoClaw Installer ===" -ForegroundColor Cyan
Write-Host ""

# ─── Check Node.js ────────────────────────────────────────────────────────────

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "`[*] Node.js not found." -ForegroundColor Red
    Write-Host ""
    Write-Host "Install Node.js 20+:" -ForegroundColor Yellow
    Write-Host "  winget install OpenJS.NodeJS"
    Write-Host "  # or download from https://nodejs.org"
    Write-Host ""
    exit 1
}

$nodeVersion = (node --version).TrimStart('v')
$major = $nodeVersion.Split(".") | Select-Object -First 1
if ($major -lt 20) {
    Write-Host "`[*] Node.js $nodeVersion found, but 20+ required." -ForegroundColor Red
    Write-Host "  Update: winget upgrade OpenJS.NodeJS"
    exit 1
}
Write-Host "`[*] Node.js $nodeVersion" -ForegroundColor Green

# ─── Check npm ────────────────────────────────────────────────────────────────

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "`[*] npm not found." -ForegroundColor Red
    exit 1
}
$npmVersion = npm --version
Write-Host "`[*] npm $npmVersion" -ForegroundColor Green

# ─── Check Docker (optional) ─────────────────────────────────────────────────

if (Get-Command docker -ErrorAction SilentlyContinue) {
    try {
        docker info 2>$null | Out-Null
        Write-Host "`[*] Docker available (sandbox mode supported)" -ForegroundColor Green
    } catch {
        Write-Host "`[*]  Docker installed but not running (host mode only)" -ForegroundColor Yellow
    }
} else {
    Write-Host "`[*]  Docker not found — host mode only (no sandbox)" -ForegroundColor Yellow
    Write-Host "   Install Docker Desktop: winget install Docker.DockerDesktop"
}

Write-Host ""

# ─── Install NanoClaw ─────────────────────────────────────────────────────────

Write-Host "`[*] Installing NanoClaw..." -ForegroundColor Yellow

if ($Package -and (Test-Path $Package)) {
    Write-Host "   From local package: $Package"
    npm install -g $Package
} elseif ($Package) {
    Write-Host "`[X] Package file not found: $Package" -ForegroundColor Red
    exit 1
} elseif ($Source -eq 'npm') {
    Write-Host "   From npm registry..."
    npm install -g nanoclaw-github-copilot
} else {
    # auto or github: try GitHub Release first
    $installed = $false
    try {
        Write-Host "   Checking GitHub Release..."
        $releaseUrl = "https://api.github.com/repos/$REPO/releases/tags/latest"
        $release = Invoke-RestMethod -Uri $releaseUrl -ErrorAction Stop
        $asset = $release.assets | Where-Object { $_.name -like "*.tgz" } | Select-Object -First 1
        if ($asset) {
            $tgzPath = Join-Path $env:TEMP $asset.name
            Write-Host "   Downloading $($asset.name)..." -ForegroundColor Gray
            Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tgzPath
            npm install -g $tgzPath
            $installed = $true
        }
    } catch {
        Write-Host "   GitHub Release not available" -ForegroundColor Gray
    }
    if (-not $installed) {
        if ($Source -eq 'github') {
            Write-Host "`[X] GitHub Release download failed." -ForegroundColor Red
            exit 1
        }
        Write-Host "   Falling back to npm registry..."
        npm install -g nanoclaw-github-copilot
    }
}

if ($LASTEXITCODE -ne 0) {
    Write-Host "`[*] Installation failed." -ForegroundColor Red
    exit 1
}

Write-Host "`[*] NanoClaw installed" -ForegroundColor Green
Write-Host ""

# ─── Initialize + Configure ───────────────────────────────────────────────────

Write-Host ""
Write-Host "`[*] Running nanoclaw init..." -ForegroundColor Yellow

# Start nanoclaw init in a new process with TTY (irm|iex has no stdin)
try {
    Start-Process -FilePath "nanoclaw" -ArgumentList "init" -Wait -NoNewWindow
} catch {
    Write-Host "`[WARN] Could not run nanoclaw init." -ForegroundColor Yellow
    Write-Host "  Run manually: nanoclaw init" -ForegroundColor Yellow
}

# ─── Done ────────────────────────────────────────────────────────────────────

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "`[*] NanoClaw installed!" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Edit config:    notepad $workspace\nanoclaw.json"
Write-Host "  2. Add credentials: notepad $workspace\.env"
Write-Host "  3. Check setup:    nanoclaw doctor"
Write-Host ""

$dockerOk = $false
if (Get-Command docker -ErrorAction SilentlyContinue) {
    try {
        docker info 2>$null | Out-Null
        Write-Host "`[*] Building agent container..." -ForegroundColor Yellow
        nanoclaw sandbox build
        if ($LASTEXITCODE -eq 0) {
            Write-Host "`[OK] Container built" -ForegroundColor Green
            $dockerOk = $true
        } else {
            Write-Host "`[WARN] Container build failed." -ForegroundColor Yellow
        }
    } catch {
        Write-Host "`[WARN] Docker installed but not running." -ForegroundColor Yellow
    }
} else {
    Write-Host "`[*] Docker not found. Skipping container build." -ForegroundColor Gray
}

# Auto-fallback to host mode if Docker unavailable or build failed
if (-not $dockerOk) {
    Write-Host "`[*] Setting host mode (no Docker required)..." -ForegroundColor Yellow
    $configPath = Join-Path $workspace "nanoclaw.json"
    if (Test-Path $configPath) {
        $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
        if ($cfg.agents -and $cfg.agents.defaults) {
            if ($cfg.agents.defaults.PSObject.Properties.Match('mode').Count -gt 0) {
                $cfg.agents.defaults.mode = "host"
            } else {
                $cfg.agents.defaults | Add-Member -NotePropertyName mode -NotePropertyValue "host"
            }
            $cfg | ConvertTo-Json -Depth 10 | Set-Content $configPath
            Write-Host "`[OK] Config set to host mode" -ForegroundColor Green
        }
    }
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
# --- Auth check ---
Write-Host ""
Write-Host "`[*] Checking authentication..." -ForegroundColor Yellow
$authResult = nanoclaw auth status 2>&1
if ($authResult -match "Not authenticated") {
    Write-Host "`[WARN] GitHub Copilot not authenticated." -ForegroundColor Yellow
    Write-Host "    Running: $copilotCheck = Get-Command copilot -ErrorAction SilentlyContinue
    if (-not $copilotCheck) {
        Write-Host "`[WARN] GitHub Copilot CLI not found." -ForegroundColor Yellow
        $installCli = Read-Host "    Install it now? (Y/n)"
        if ($installCli -ne 'n') {
            Write-Host "    Installing @github/copilot..." -ForegroundColor Yellow
            npm install -g @github/copilot
        }
    }
    nanoclaw auth login" -ForegroundColor Yellow
    $copilotCheck = Get-Command copilot -ErrorAction SilentlyContinue
    if (-not $copilotCheck) {
        Write-Host "`[WARN] GitHub Copilot CLI not found." -ForegroundColor Yellow
        $installCli = Read-Host "    Install it now? (Y/n)"
        if ($installCli -ne 'n') {
            Write-Host "    Installing @github/copilot..." -ForegroundColor Yellow
            npm install -g @github/copilot
        }
    }
    nanoclaw auth login
} else {
    Write-Host "`[OK] Authenticated" -ForegroundColor Green
}

# --- Channel check ---
Write-Host ""
$config = Get-Content "$workspace\nanoclaw.json" -Raw | ConvertFrom-Json -ErrorAction SilentlyContinue
$hasChannel = $false
if ($config.channels) {
    if ($config.channels.telegram.enabled -or $config.channels.teams.enabled) { $hasChannel = $true }
}
if (-not $hasChannel) {
    Write-Host "`[WARN] No channels configured." -ForegroundColor Yellow
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
Write-Host "  Configure channels: nanoclaw init" -ForegroundColor Yellow
Write-Host "  Start:              nanoclaw start" -ForegroundColor Yellow
Write-Host "============================================" -ForegroundColor Cyan
