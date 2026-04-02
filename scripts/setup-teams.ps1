<#
.SYNOPSIS
    NanoClaw Teams Channel — One-click Azure Bot Setup (PowerShell)
.DESCRIPTION
    Prerequisites:
      1. Azure CLI: winget install Microsoft.AzureCLI
      2. DevTunnel CLI: winget install Microsoft.devtunnel
      3. Logged in: az login; devtunnel login
.PARAMETER BotName
    Bot display name (default: nanoclaw-teams-bot)
.PARAMETER ResourceGroup
    Azure resource group (default: nanoclaw-rg)
.PARAMETER TenantId
    Azure AD tenant ID (auto-detected if not set)
.PARAMETER AppMultiTenant
    Use multi-tenant App Registration
.PARAMETER BotType
    Bot type: SingleTenant (default) or MultiTenant
.PARAMETER Location
    Azure region (default: eastus)
.PARAMETER Port
    Webhook port (default: 3978)
#>
param(
    [string]$BotName = "nanoclaw-teams-bot",
    [string]$ResourceGroup = "nanoclaw-rg",
    [string]$TenantId = "",
    [switch]$AppMultiTenant,
    [string]$BotType = "SingleTenant",
    [string]$Location = "eastus",
    [int]$Port = 3978
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$WorkspaceDir = if ($env:NANOCLAW_WORKSPACE) { $env:NANOCLAW_WORKSPACE } else { "$env:USERPROFILE\.nanoclaw" }
$EnvFile = Join-Path $WorkspaceDir ".env"
$ConfigFile = Join-Path $WorkspaceDir "nanoclaw.json"

Write-Host "=== NanoClaw Teams Setup ===" -ForegroundColor Cyan
Write-Host ""

# ─── Check prerequisites ─────────────────────────────────────────────────────

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    Write-Host "❌ Azure CLI not found." -ForegroundColor Red
    Write-Host "   Install: winget install Microsoft.AzureCLI"
    exit 1
}

if (-not (Get-Command devtunnel -ErrorAction SilentlyContinue)) {
    Write-Host "❌ DevTunnel CLI not found." -ForegroundColor Red
    Write-Host "   Install: winget install Microsoft.devtunnel"
    exit 1
}

try { az account show 2>$null | Out-Null } catch {
    Write-Host "❌ Not logged in to Azure. Run: az login" -ForegroundColor Red
    exit 1
}

$AccountName = az account show --query 'name' -o tsv
Write-Host "✅ Azure CLI: $AccountName" -ForegroundColor Green

try { devtunnel list 2>$null | Out-Null } catch {
    Write-Host "❌ Not logged in to DevTunnel. Run: devtunnel login" -ForegroundColor Red
    exit 1
}
Write-Host "✅ DevTunnel CLI ready" -ForegroundColor Green
Write-Host ""

# Determine tenant
if (-not $TenantId) {
    $TenantId = az account show --query 'tenantId' -o tsv
}
Write-Host "   Tenant: $TenantId"

# App audience
$SignInAudience = if ($AppMultiTenant) { "AzureADMultipleOrgs" } else { "AzureADMyOrg" }
Write-Host "   App: $(if ($AppMultiTenant) { 'Multi-tenant' } else { 'Single-tenant' })"
Write-Host "   Bot Type: $BotType"
Write-Host ""

# ─── Step 1: DevTunnel ───────────────────────────────────────────────────────

Write-Host "🔗 Step 1: Creating DevTunnel..." -ForegroundColor Yellow

$TunnelId = ""
try {
    $tunnels = devtunnel list --output json 2>$null | ConvertFrom-Json
    # Look for existing nanoclaw-tagged tunnel
    foreach ($t in $tunnels) {
        if ($t.description -eq "nanoclaw" -or $t.labels -contains "nanoclaw") {
            $TunnelId = $t.tunnelId
            Write-Host "   Found existing nanoclaw tunnel: $TunnelId"
            break
        }
    }
    # Fallback: use first tunnel if no tagged one found
    if (-not $TunnelId -and $tunnels.Count -gt 0) {
        $TunnelId = $tunnels[0].tunnelId
        Write-Host "   Using existing tunnel: $TunnelId"
    }
} catch {}

if (-not $TunnelId) {
    $result = devtunnel create --description "nanoclaw" --output json 2>$null | ConvertFrom-Json
    $TunnelId = $result.tunnelId
    Write-Host "   Created tunnel: $TunnelId"
}

devtunnel port create $TunnelId -p $Port --protocol https 2>$null | Out-Null
devtunnel access create $TunnelId -p $Port --anonymous 2>$null | Out-Null

$TunnelUrl = "https://${TunnelId}-${Port}.asse.devtunnels.ms"
$MessagingEndpoint = "${TunnelUrl}/api/messages"
Write-Host "   ✅ Endpoint: $MessagingEndpoint" -ForegroundColor Green
Write-Host ""

# ─── Step 2: Resource Group ──────────────────────────────────────────────────

Write-Host "📦 Step 2: Ensuring resource group..." -ForegroundColor Yellow
try { az group show --name $ResourceGroup 2>$null | Out-Null; Write-Host "   Already exists." }
catch { az group create --name $ResourceGroup --location $Location --output none; Write-Host "   Created." }
Write-Host ""

# ─── Step 3: App Registration ────────────────────────────────────────────────

Write-Host "🔑 Step 3: App Registration '$BotName'..." -ForegroundColor Yellow
# Check if app already exists
$ExistingAppId = az ad app list --display-name $BotName --query "[0].appId" -o tsv 2>$null
if ($ExistingAppId) {
    $AppId = $ExistingAppId
    Write-Host "   Found existing app: $AppId"
    Write-Host "   Rotating client secret..."
    $AppPassword = az ad app credential reset --id $AppId --years 2 --query "password" -o tsv
    Write-Host "   ✅ Secret rotated." -ForegroundColor Green
} else {
    $AppId = az ad app create --display-name $BotName --sign-in-audience $SignInAudience --query "appId" -o tsv
    Write-Host "   Created app: $AppId"
    Write-Host "   Creating client secret..."
    $AppPassword = az ad app credential reset --id $AppId --years 2 --query "password" -o tsv
    Write-Host "   ✅ Secret created." -ForegroundColor Green
}
Write-Host ""

# ─── Step 4: Azure Bot ──────────────────────────────────────────────────────

Write-Host "🤖 Step 4: Azure Bot..." -ForegroundColor Yellow
$ExistingBot = az bot show --name $BotName --resource-group $ResourceGroup --query "name" -o tsv 2>$null
if ($ExistingBot) {
    Write-Host "   Found existing bot. Updating endpoint..."
    az bot update --name $BotName --resource-group $ResourceGroup --endpoint $MessagingEndpoint --output none 2>$null
    Write-Host "   ✅ Bot updated." -ForegroundColor Green
} else {
    az bot create --name $BotName --resource-group $ResourceGroup --app-type $BotType --appid $AppId --password $AppPassword --endpoint $MessagingEndpoint --sku "F0" --output none 2>$null
    Write-Host "   ✅ Bot created." -ForegroundColor Green
}
Write-Host ""

# ─── Step 5: Enable Teams Channel ───────────────────────────────────────────

Write-Host "📱 Step 5: Enabling Teams channel..." -ForegroundColor Yellow
az bot msteams create --name $BotName --resource-group $ResourceGroup --output none 2>$null
Write-Host "   ✅ Teams channel enabled." -ForegroundColor Green
Write-Host ""

# ─── Step 6: Generate manifest ───────────────────────────────────────────────

Write-Host "📄 Step 6: Generating Teams app manifest..." -ForegroundColor Yellow
$ManifestDir = Join-Path $WorkspaceDir "teams-app"
New-Item -ItemType Directory -Force -Path $ManifestDir | Out-Null

$manifest = @{
    '$schema' = "https://developer.microsoft.com/en-us/json-schemas/teams/v1.17/MicrosoftTeams.schema.json"
    manifestVersion = "1.17"
    version = "1.0.0"
    id = $AppId
    developer = @{ name = "NanoClaw"; websiteUrl = "https://github.com/kenans/nanoclaw-github-copilot"; privacyUrl = "https://github.com/kenans/nanoclaw-github-copilot"; termsOfUseUrl = "https://github.com/kenans/nanoclaw-github-copilot" }
    name = @{ short = $BotName; full = "$BotName AI Assistant" }
    description = @{ short = "AI Assistant powered by NanoClaw"; full = "NanoClaw AI Assistant" }
    icons = @{ outline = "outline.png"; color = "color.png" }
    accentColor = "#4F46E5"
    bots = @(@{
        botId = $AppId
        scopes = @("personal", "team", "groupChat")
        supportsFiles = $false
        isNotificationOnly = $false
        commandLists = @(@{
            scopes = @("personal")
            commands = @(
                @{ title = "chatid"; description = "Get chat registration ID" },
                @{ title = "ping"; description = "Check if bot is online" },
                @{ title = "new"; description = "Start a new conversation" }
            )
        })
    })
    permissions = @("identity", "messageTeamMembers")
    validDomains = @()
}
$manifest | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $ManifestDir "manifest.json")

# Placeholder icons (1x1 purple/white PNGs)
[byte[]]$colorPng = 137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,2,0,0,0,144,119,83,222,0,0,0,12,73,68,65,84,120,156,99,108,96,96,0,0,0,4,0,1,243,175,16,143,0,0,0,0,73,69,78,68,174,66,96,130
[System.IO.File]::WriteAllBytes((Join-Path $ManifestDir "color.png"), $colorPng)
[System.IO.File]::WriteAllBytes((Join-Path $ManifestDir "outline.png"), $colorPng)

Compress-Archive -Path (Join-Path $ManifestDir "*") -DestinationPath (Join-Path $WorkspaceDir "teams-app.zip") -Force
Write-Host "   ✅ Manifest: $(Join-Path $WorkspaceDir 'teams-app.zip')" -ForegroundColor Green
Write-Host ""

# ─── Step 7: Write .env ─────────────────────────────────────────────────────

Write-Host "⚙️  Step 7: Writing credentials..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path $WorkspaceDir | Out-Null
$envContent = @"

# === Teams Channel (auto-generated by setup-teams.ps1) ===
MSTEAMS_APP_ID=$AppId
MSTEAMS_APP_PASSWORD=$AppPassword
MSTEAMS_TENANT_ID=$TenantId
MSTEAMS_WEBHOOK_PORT=$Port

# === Teams Reference Info ===
MSTEAMS_BOT_NAME=$BotName
MSTEAMS_BOT_TYPE=$BotType
MSTEAMS_APP_AUDIENCE=$SignInAudience
MSTEAMS_BOT_ENDPOINT=$MessagingEndpoint
MSTEAMS_TUNNEL_ID=$TunnelId
MSTEAMS_RESOURCE_GROUP=$ResourceGroup
MSTEAMS_PASSWORD_CREATED=$(Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
"@
Add-Content -Path $EnvFile -Value $envContent
Write-Host "   ✅ Written to $EnvFile" -ForegroundColor Green
Write-Host ""

# ─── Step 8: Update nanoclaw.json ───────────────────────────────────────────

Write-Host "⚙️  Step 8: Updating nanoclaw.json..." -ForegroundColor Yellow
if (Test-Path $ConfigFile) {
    $config = Get-Content $ConfigFile | ConvertFrom-Json
    if (-not $config.channels) { $config | Add-Member -NotePropertyName channels -NotePropertyValue @{} }
    $config.channels | Add-Member -NotePropertyName teams -NotePropertyValue @{
        enabled = $true
        webhookPort = $Port
        authMode = "secret"
        tenantId = $TenantId
    } -Force
    $config | ConvertTo-Json -Depth 10 | Set-Content $ConfigFile
    Write-Host "   ✅ Teams enabled in nanoclaw.json" -ForegroundColor Green
} else {
    Write-Host "   ⚠️  nanoclaw.json not found — run 'nanoclaw init' first" -ForegroundColor Yellow
}
Write-Host ""

# ─── Done ────────────────────────────────────────────────────────────────────

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "✅ Teams setup complete!" -ForegroundColor Green
Write-Host ""
Write-Host "   App ID:     $AppId"
Write-Host "   Bot Name:   $BotName"
Write-Host "   Tenant:     $TenantId"
Write-Host "   App Type:   $SignInAudience"
Write-Host "   Bot Type:   $BotType"
Write-Host "   Endpoint:   $MessagingEndpoint"
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
# Auto-register as service
Write-Host "[*] Registering services..." -ForegroundColor Yellow
try {
    nanoclaw service install --devtunnel $TunnelId
    Write-Host "[OK] NanoClaw + DevTunnel registered as services" -ForegroundColor Green
} catch {
    Write-Host "[WARN] Service registration failed. Manual start:" -ForegroundColor Yellow
    Write-Host "  devtunnel host $TunnelId --allow-anonymous" -ForegroundColor White
    Write-Host "  nanoclaw start" -ForegroundColor White
}

Write-Host ""
Write-Host "  1. Services registered (auto-start on login)"
Write-Host "  2. Upload $WorkspaceDir\teams-app.zip: Teams → Apps → Upload a custom app"
Write-Host "  3. Start NanoClaw: nanoclaw start"
Write-Host "============================================" -ForegroundColor Cyan
