# /add-teams

Add Microsoft Teams as a messaging channel to NanoClaw.

## When to use

Run `/add-teams` when the user wants to connect NanoClaw to Microsoft Teams.

## Prerequisites

- Azure CLI (`az`) must be installed
- User must be logged in (`az login`)
- `zip` command must be available

If any prerequisite is missing, guide the user to install/login first.

## Steps

### 1. Check prerequisites

Run these checks and stop if any fail:

```bash
command -v az || echo "MISSING: Install Azure CLI first: curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash"
az account show --query 'name' -o tsv 2>/dev/null || echo "MISSING: Run 'az login' first"
command -v zip || echo "MISSING: Install zip: sudo apt install zip"
```

### 2. Ask the user

Ask for these (all have defaults):
- **Bot name** — default: `nanoclaw-teams-bot`
- **Resource group** — default: `nanoclaw-rg`
- **Location** — default: `eastus`
- **Tenant ID** — default: empty (multi-tenant). If the user says "enterprise" or "single tenant", ask for their tenant ID.
- **Webhook port** — default: `3978`

### 3. Run the setup script

Execute the setup script that handles everything automatically:

```bash
cd <project-root>
./scripts/setup-teams.sh --bot-name <name> --resource-group <rg> [--tenant-id <id>] [--port <port>]
```

The script will:
1. Create Azure Resource Group
2. Create App Registration + client secret
3. Create Azure Bot (Free tier F0)
4. Enable Teams channel on the bot
5. Generate Teams app manifest zip (`teams-app.zip`)
6. Append credentials to `.env`

### 4. Guide the user through remaining manual steps

After the script completes, tell the user:

1. **Expose the webhook port publicly.** Suggest one of:
   - `tailscale funnel 3978` (if they use Tailscale)
   - `ngrok http 3978` (alternative)
   - Direct port forwarding (if they have a public IP)

2. **Set the messaging endpoint in Azure Portal:**
   - Go to the Azure Bot resource → Configuration
   - Set Messaging endpoint to: `https://<their-public-url>/api/messages`
   - Click Apply

3. **Upload the Teams app:**
   - Open Microsoft Teams
   - Go to Apps → Manage your apps → Upload a custom app
   - Select `teams-app.zip` from the project root
   - Install the app

4. **Start NanoClaw:**
   ```bash
   npm run dev
   ```

5. **Test:** Send a message to the bot in Teams. It should respond.

### 5. Register the chat

After the user confirms the bot is working, tell them:
- Send `/chatid` to the bot in Teams to get the chat registration ID
- Then use the NanoClaw main channel to register this chat

## Important notes

- **Never output credentials** (App Password) in plain text to the user. They are written to `.env` automatically.
- The `.env` file is in `.gitignore` — credentials won't be committed.
- For enterprise/single-tenant Teams, the `--tenant-id` flag is required.
- The script is idempotent — running it again will create a new secret but won't duplicate resources.
