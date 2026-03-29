#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# NanoClaw Teams Channel — One-click Azure Bot Setup
#
# Prerequisites:
#   1. Azure CLI: curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
#   2. DevTunnel CLI: curl -sL https://aka.ms/DevTunnelCliInstall | bash
#   3. Logged in: az login && devtunnel login
#
# Usage:
#   ./scripts/setup-teams.sh [options]
#
# Options:
#   --bot-name NAME          Bot display name (default: nanoclaw-teams-bot)
#   --resource-group RG      Azure resource group (default: nanoclaw-rg)
#   --tenant-id TENANT       Azure AD tenant ID
#   --app-multi-tenant       App Registration allows any Azure AD tenant
#   --bot-type TYPE          Bot type: SingleTenant (default) or MultiTenant
#   --location LOC           Azure region (default: eastus)
#   --port PORT              Webhook port (default: 3978)
# ============================================================

BOT_NAME="${BOT_NAME:-nanoclaw-teams-bot}"
RESOURCE_GROUP="${RESOURCE_GROUP:-nanoclaw-rg}"
LOCATION="${LOCATION:-eastus}"
TENANT_ID=""
WEBHOOK_PORT="${MSTEAMS_WEBHOOK_PORT:-3978}"
APP_MULTI_TENANT=false
BOT_TYPE="SingleTenant"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
WORKSPACE_DIR="${NANOCLAW_WORKSPACE:-$HOME/.nanoclaw}"
ENV_FILE="$WORKSPACE_DIR/.env"
CONFIG_FILE="$WORKSPACE_DIR/nanoclaw.json"

while [[ $# -gt 0 ]]; do
  case $1 in
    --bot-name) BOT_NAME="$2"; shift 2;;
    --resource-group) RESOURCE_GROUP="$2"; shift 2;;
    --tenant-id) TENANT_ID="$2"; shift 2;;
    --app-multi-tenant) APP_MULTI_TENANT=true; shift;;
    --bot-type) BOT_TYPE="$2"; shift 2;;
    --location) LOCATION="$2"; shift 2;;
    --port) WEBHOOK_PORT="$2"; shift 2;;
    *) echo "Unknown option: $1"; exit 1;;
  esac
done

echo "=== NanoClaw Teams Setup ==="
echo ""

# ─── Check prerequisites ─────────────────────────────────────────────────────

if ! command -v az &>/dev/null; then
  echo "❌ Azure CLI not found."
  echo "   Install: curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash"
  echo "   Then:    az login"
  exit 1
fi

if ! command -v devtunnel &>/dev/null; then
  echo "❌ DevTunnel CLI not found."
  echo "   Install: curl -sL https://aka.ms/DevTunnelCliInstall | bash"
  echo "   Then:    devtunnel login"
  exit 1
fi

if ! az account show &>/dev/null 2>&1; then
  echo "❌ Not logged in to Azure."
  echo "   Run: az login"
  exit 1
fi

ACCOUNT_NAME=$(az account show --query 'name' -o tsv)
echo "✅ Azure CLI: $ACCOUNT_NAME"

if ! devtunnel list &>/dev/null 2>&1; then
  echo "❌ Not logged in to DevTunnel."
  echo "   Run: devtunnel login"
  exit 1
fi
echo "✅ DevTunnel CLI ready"
echo ""

# Determine tenant
if [ -z "$TENANT_ID" ]; then
  TENANT_ID=$(az account show --query 'tenantId' -o tsv)
  echo "   Using tenant: $TENANT_ID"
fi

# App type based on multi-tenant flag
# App Registration audience (who can get tokens)
if [ "$APP_MULTI_TENANT" = true ]; then
  SIGN_IN_AUDIENCE="AzureADMultipleOrgs"
  echo "   App: Multi-tenant (any Azure AD user can auth)"
else
  SIGN_IN_AUDIENCE="AzureADMyOrg"
  echo "   App: Single-tenant (only this org)"
fi

# Bot type (how Bot Framework validates tokens) — typically SingleTenant
echo "   Bot Type: $BOT_TYPE"
echo ""

# ─── Step 1: DevTunnel ───────────────────────────────────────────────────────

echo "🔗 Step 1: Creating DevTunnel..."

# Check if a tunnel already exists for this port
EXISTING_TUNNEL=$(devtunnel list --output json 2>/dev/null | python3 -c "
import sys, json
try:
    tunnels = json.load(sys.stdin)
    for t in tunnels:
        print(t.get('tunnelId', ''))
        break
except: pass
" 2>/dev/null || echo "")

if [ -n "$EXISTING_TUNNEL" ]; then
  TUNNEL_ID="$EXISTING_TUNNEL"
  echo "   Using existing tunnel: $TUNNEL_ID"
else
  TUNNEL_ID=$(devtunnel create --output json 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('tunnelId', ''))
")
  echo "   Created tunnel: $TUNNEL_ID"
fi

# Ensure port is configured with anonymous access
devtunnel port create "$TUNNEL_ID" -p "$WEBHOOK_PORT" --protocol https 2>/dev/null || true
devtunnel access create "$TUNNEL_ID" -p "$WEBHOOK_PORT" --anonymous 2>/dev/null || true

# Get the tunnel URL
TUNNEL_URL=$(devtunnel show "$TUNNEL_ID" --output json 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
ports = data.get('ports', [])
for p in ports:
    if str(p.get('portNumber', '')) == '$WEBHOOK_PORT':
        print(p.get('portForwardingUris', [''])[0].rstrip('/'))
        break
" 2>/dev/null || echo "")

if [ -z "$TUNNEL_URL" ]; then
  # Construct URL from tunnel ID
  TUNNEL_URL="https://${TUNNEL_ID}-${WEBHOOK_PORT}.asse.devtunnels.ms"
fi

MESSAGING_ENDPOINT="${TUNNEL_URL}/api/messages"
echo "   ✅ Tunnel URL: $TUNNEL_URL"
echo "   ✅ Messaging endpoint: $MESSAGING_ENDPOINT"
echo ""

# ─── Step 2: Resource Group ──────────────────────────────────────────────────

echo "📦 Step 2: Ensuring resource group..."
if az group show --name "$RESOURCE_GROUP" &>/dev/null 2>&1; then
  echo "   '$RESOURCE_GROUP' already exists."
else
  az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none
  echo "   Created '$RESOURCE_GROUP' in $LOCATION."
fi
echo ""

# ─── Step 3: App Registration ────────────────────────────────────────────────

echo "🔑 Step 3: Creating App Registration '$BOT_NAME'..."
APP_ID=$(az ad app create \
  --display-name "$BOT_NAME" \
  --sign-in-audience "$SIGN_IN_AUDIENCE" \
  --query "appId" -o tsv)
echo "   App ID: $APP_ID"

echo "   Creating client secret (2 year expiry)..."
APP_PASSWORD=$(az ad app credential reset \
  --id "$APP_ID" \
  --years 2 \
  --query "password" -o tsv)
echo "   ✅ Secret created."
echo ""

# ─── Step 4: Azure Bot ──────────────────────────────────────────────────────

echo "🤖 Step 4: Creating Azure Bot..."
az bot create \
  --name "$BOT_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --app-type "$BOT_TYPE" \
  --appid "$APP_ID" \
  --password "$APP_PASSWORD" \
  --endpoint "$MESSAGING_ENDPOINT" \
  --sku "F0" \
  --output none 2>/dev/null || echo "   (Bot may already exist)"
echo "   ✅ Bot ready."
echo ""

# ─── Step 5: Enable Teams Channel ───────────────────────────────────────────

echo "📱 Step 5: Enabling Teams channel..."
az bot msteams create \
  --name "$BOT_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --output none 2>/dev/null || echo "   (Teams channel may already be enabled)"
echo "   ✅ Teams channel enabled."
echo ""

# ─── Step 6: Generate manifest ───────────────────────────────────────────────

echo "📄 Step 6: Generating Teams app manifest..."
MANIFEST_DIR="$PROJECT_DIR/teams-app"
mkdir -p "$MANIFEST_DIR"

cat > "$MANIFEST_DIR/manifest.json" << EOFMANIFEST
{
  "\$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.17/MicrosoftTeams.schema.json",
  "manifestVersion": "1.17",
  "version": "1.0.0",
  "id": "$APP_ID",
  "developer": {
    "name": "NanoClaw",
    "websiteUrl": "https://github.com/kenans/nanoclaw-github-copilot",
    "privacyUrl": "https://github.com/kenans/nanoclaw-github-copilot",
    "termsOfUseUrl": "https://github.com/kenans/nanoclaw-github-copilot"
  },
  "name": { "short": "$BOT_NAME", "full": "$BOT_NAME AI Assistant" },
  "description": { "short": "AI Assistant powered by NanoClaw", "full": "NanoClaw AI Assistant - runs agents securely." },
  "icons": { "outline": "outline.png", "color": "color.png" },
  "accentColor": "#4F46E5",
  "bots": [{
    "botId": "$APP_ID",
    "scopes": ["personal", "team", "groupChat"],
    "supportsFiles": false,
    "isNotificationOnly": false,
    "commandLists": [{
      "scopes": ["personal"],
      "commands": [
        { "title": "chatid", "description": "Get this chat registration ID" },
        { "title": "ping", "description": "Check if bot is online" },
        { "title": "new", "description": "Start a new conversation" }
      ]
    }]
  }],
  "permissions": ["identity", "messageTeamMembers"],
  "validDomains": []
}
EOFMANIFEST

# Generate placeholder icons
python3 -c "
import struct, zlib, sys
def make_png(w, h, r, g, b, path):
    def chunk(ctype, data):
        return struct.pack('>I', len(data)) + ctype + data + struct.pack('>I', zlib.crc32(ctype + data) & 0xffffffff)
    raw = b''
    for _ in range(h):
        raw += b'\x00' + bytes([r, g, b]) * w
    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
    idat = chunk(b'IDAT', zlib.compress(raw))
    iend = chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(sig + ihdr + idat + iend)
make_png(192, 192, 79, 70, 229, sys.argv[1])
make_png(32, 32, 255, 255, 255, sys.argv[2])
" "$MANIFEST_DIR/color.png" "$MANIFEST_DIR/outline.png"

(cd "$MANIFEST_DIR" && zip -q "$PROJECT_DIR/teams-app.zip" manifest.json color.png outline.png)
echo "   ✅ Manifest: $PROJECT_DIR/teams-app.zip"
echo ""

# ─── Step 7: Write .env ─────────────────────────────────────────────────────

echo "⚙️  Step 7: Writing credentials to .env..."
mkdir -p "$WORKSPACE_DIR"
{
  echo ""
  echo "# === Teams Channel (auto-generated by setup-teams.sh) ==="
  echo "MSTEAMS_APP_ID=$APP_ID"
  echo "MSTEAMS_APP_PASSWORD=$APP_PASSWORD"
  echo "MSTEAMS_TENANT_ID=$TENANT_ID"
  echo "MSTEAMS_WEBHOOK_PORT=$WEBHOOK_PORT"
  echo ""
  echo "# === Teams Reference Info (not read by code, for your records) ==="
  echo "MSTEAMS_BOT_NAME=$BOT_NAME"
  echo "MSTEAMS_BOT_TYPE=$BOT_TYPE"
  echo "MSTEAMS_APP_AUDIENCE=$SIGN_IN_AUDIENCE"
  echo "MSTEAMS_BOT_ENDPOINT=$MESSAGING_ENDPOINT"
  echo "MSTEAMS_TUNNEL_ID=$TUNNEL_ID"
  echo "MSTEAMS_RESOURCE_GROUP=$RESOURCE_GROUP"
  echo "MSTEAMS_PASSWORD_CREATED=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >> "$ENV_FILE"
echo "   ✅ Credentials written to $ENV_FILE"
echo ""

# ─── Step 8: Update nanoclaw.json ───────────────────────────────────────────

echo "⚙️  Step 8: Updating nanoclaw.json..."
if [ -f "$CONFIG_FILE" ]; then
  python3 -c "
import json, sys
config = json.load(open('$CONFIG_FILE'))
config.setdefault('channels', {})
config['channels']['teams'] = {
    'enabled': True,
    'webhookPort': $WEBHOOK_PORT,
    'authMode': 'secret',
    'tenantId': '$TENANT_ID'
}
json.dump(config, open('$CONFIG_FILE', 'w'), indent=2)
print('   ✅ Teams channel enabled in nanoclaw.json')
"
else
  echo "   ⚠️  nanoclaw.json not found at $CONFIG_FILE — run 'nanoclaw init' first"
fi
echo ""

# ─── Step 9: Start tunnel in background ─────────────────────────────────────

echo "🚀 Step 9: Starting DevTunnel..."
echo "   Run in a separate terminal:"
echo "   devtunnel host $TUNNEL_ID --allow-anonymous"
echo ""

# ─── Done ────────────────────────────────────────────────────────────────────

echo "============================================"
echo "✅ Teams setup complete!"
echo ""
echo "   App ID:     $APP_ID"
echo "   Bot Name:   $BOT_NAME"
echo "   Tenant:     $TENANT_ID"
echo "   App Type:   $SIGN_IN_AUDIENCE"
echo "   Bot Type:   $BOT_TYPE"
echo "   Tunnel:     $TUNNEL_URL"
echo "   Endpoint:   $MESSAGING_ENDPOINT"
echo "   Manifest:   $PROJECT_DIR/teams-app.zip"
echo ""
echo "Next steps:"
echo "  1. Start the tunnel:"
echo "     devtunnel host $TUNNEL_ID --allow-anonymous"
echo ""
echo "  2. Upload teams-app.zip to Teams:"
echo "     Teams → Apps → Manage your apps → Upload a custom app"
echo ""
echo "  3. Start NanoClaw:"
echo "     nanoclaw start"
echo "============================================"
