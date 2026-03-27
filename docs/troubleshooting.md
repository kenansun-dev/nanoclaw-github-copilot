# NanoClaw Troubleshooting

## Bot not responding

### Check service is running
```bash
nanoclaw status
nanoclaw logs -f
```

### Check dependencies
```bash
nanoclaw doctor
```

### Chat not registered
Bot ignores messages from unregistered chats.
```bash
nanoclaw chat pending    # see waiting chats
nanoclaw chat add <jid> --name <name>
```

## Teams specific

### "Authorization has been denied for this request"
- `MSTEAMS_TENANT_ID` must be set to the **app's home tenant**, not the bot's tenant
- If using cross-tenant setup, use client secret (not certificate) for outbound auth

### Bot Framework not sending messages
- Check tunnel is running: `curl https://your-tunnel-url/health`
- Previous 401 errors cause Bot Framework to stop sending — re-save messaging endpoint in Azure Portal
- DevTunnel must use `--allow-anonymous` for webhook to receive POST requests

### "Invalid BotId" when uploading manifest
- Azure Bot must have Teams channel enabled (Bot → Channels → Microsoft Teams)
- `botId` in manifest.json must match Azure Bot's App ID

### Certificate auth issues
- Certificate works for inbound JWT validation but may fail for outbound (cross-tenant)
- Use client secret for outbound auth in cross-tenant scenarios
- Thumbprint must exactly match what's uploaded to App Registration

## Telegram specific

### Bot token issues
- Verify token: `curl https://api.telegram.org/bot<TOKEN>/getMe`
- Token must be from @BotFather

## Container issues

### "FATAL: Container runtime failed to start"
- Check Docker: `docker info`
- Ensure user is in docker group: `groups`
- Build image: `nanoclaw sandbox build`

### ESM module errors in container
- Container uses `tsx` for ESM compatibility
- Rebuild image if you see `vscode-jsonrpc` errors

## MCP issues

### Remote MCP OAuth not working
- Known CLI bug (#1967): OAuth not triggered for SDK-passed MCP servers
- Workaround: Use nanoclaw's built-in mcp-auth module or mcporter
