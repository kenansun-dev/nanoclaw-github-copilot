#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# NanoClaw Teams Channel — One-click Azure Bot Setup
#
# Prerequisites:
#   1. Azure CLI installed: curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
#   2. Logged in: az login
#
# Usage:
#   ./scripts/setup-teams.sh [--bot-name NAME] [--resource-group RG] [--tenant-id TENANT]
# ============================================================

BOT_NAME="${BOT_NAME:-nanoclaw-teams-bot}"
RESOURCE_GROUP="${RESOURCE_GROUP:-nanoclaw-rg}"
LOCATION="${LOCATION:-eastus}"
TENANT_ID=""
WEBHOOK_PORT="${MSTEAMS_WEBHOOK_PORT:-3978}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env"

while [[ $# -gt 0 ]]; do
  case $1 in
    --bot-name) BOT_NAME="$2"; shift 2;;
    --resource-group) RESOURCE_GROUP="$2"; shift 2;;
    --tenant-id) TENANT_ID="$2"; shift 2;;
    --location) LOCATION="$2"; shift 2;;
    --port) WEBHOOK_PORT="$2"; shift 2;;
    *) echo "Unknown option: $1"; exit 1;;
  esac
done

echo "=== NanoClaw Teams Setup ==="
echo ""

# Check prerequisites
if ! command -v az &>/dev/null; then
  echo "❌ Azure CLI not found."
  echo "   Install: curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash"
  echo "   Then:    az login"
  exit 1
fi

if ! az account show &>/dev/null 2>&1; then
  echo "❌ Not logged in to Azure."
  echo "   Run: az login"
  exit 1
fi

ACCOUNT_NAME=$(az account show --query 'name' -o tsv)
echo "✅ Logged in: $ACCOUNT_NAME"
echo ""

# Step 1: Resource Group
echo "📦 Step 1: Ensuring resource group..."
if az group show --name "$RESOURCE_GROUP" &>/dev/null 2>&1; then
  echo "   '$RESOURCE_GROUP' already exists."
else
  az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none
  echo "   Created '$RESOURCE_GROUP' in $LOCATION."
fi

# Step 2: App Registration
echo ""
echo "🔑 Step 2: Creating App Registration '$BOT_NAME'..."
APP_ID=$(az ad app create \
  --display-name "$BOT_NAME" \
  --sign-in-audience "AzureADMultipleOrgs" \
  --query "appId" -o tsv)
echo "   App ID: $APP_ID"

echo "   Creating client secret (2 year expiry)..."
APP_PASSWORD=$(az ad app credential reset \
  --id "$APP_ID" \
  --years 2 \
  --query "password" -o tsv)
echo "   ✅ Secret created."

# Step 3: Azure Bot
echo ""
echo "🤖 Step 3: Creating Azure Bot..."
az bot create \
  --name "$BOT_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --app-type "MultiTenant" \
  --appid "$APP_ID" \
  --password "$APP_PASSWORD" \
  --sku "F0" \
  --output none 2>/dev/null || echo "   (Bot may already exist)"
echo "   ✅ Bot ready."

# Step 4: Enable Teams Channel
echo ""
echo "📱 Step 4: Enabling Teams channel..."
az bot msteams create \
  --name "$BOT_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --output none 2>/dev/null || echo "   (Teams channel may already be enabled)"
echo "   ✅ Teams channel enabled."

# Step 5: Generate manifest
echo ""
echo "📄 Step 5: Generating Teams app manifest..."
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
  "name": { "short": "NanoClaw", "full": "NanoClaw AI Assistant" },
  "description": { "short": "AI Assistant powered by GitHub Copilot", "full": "NanoClaw AI Assistant - runs agents in secure containers." },
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
        { "title": "ping", "description": "Check if bot is online" }
      ]
    }]
  }],
  "permissions": ["identity", "messageTeamMembers"],
  "validDomains": []
}
EOFMANIFEST

# Generate placeholder icons with python
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

# Create zip
(cd "$MANIFEST_DIR" && zip -q "$PROJECT_DIR/teams-app.zip" manifest.json color.png outline.png)
echo "   ✅ Manifest: $PROJECT_DIR/teams-app.zip"

# Step 6: Write .env
echo ""
echo "⚙️  Step 6: Writing config to .env..."
{
  echo ""
  echo "# === Teams Channel (auto-generated by setup-teams.sh) ==="
  echo "MSTEAMS_APP_ID=$APP_ID"
  echo "MSTEAMS_APP_PASSWORD=$APP_PASSWORD"
  [ -n "$TENANT_ID" ] && echo "MSTEAMS_TENANT_ID=$TENANT_ID"
  echo "MSTEAMS_WEBHOOK_PORT=$WEBHOOK_PORT"
} >> "$ENV_FILE"
echo "   ✅ Config appended to $ENV_FILE"

# Done
echo ""
echo "============================================"
echo "✅ Teams setup complete!"
echo ""
echo "   App ID:     $APP_ID"
echo "   Bot Name:   $BOT_NAME"
echo "   Manifest:   $PROJECT_DIR/teams-app.zip"
echo "   Config:     $ENV_FILE"
echo ""
echo "Next steps:"
echo "  1. Expose port $WEBHOOK_PORT publicly:"
echo "     tailscale funnel $WEBHOOK_PORT"
echo "     # or: ngrok http $WEBHOOK_PORT"
echo ""
echo "  2. Set messaging endpoint in Azure Portal:"
echo "     Bot → Configuration → Messaging endpoint:"
echo "     https://<your-public-url>/api/messages"
echo ""
echo "  3. Upload teams-app.zip to Teams:"
echo "     Teams → Apps → Manage your apps → Upload a custom app"
echo ""
echo "  4. Start NanoClaw: npm run dev"
echo "============================================"
