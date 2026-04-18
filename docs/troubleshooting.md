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

## Reliability & UX behaviors

These behaviors are intentional — if a user reports them, they are working as designed.

### Fast-abort: "stop / cancel / 停" interrupts the agent

When a user sends one of the abort trigger words while an agent is still running for that group, the message is **intercepted before being sent to the LLM** and instead:

1. Kills the active container/process
2. Clears any pending IPC messages
3. Drops queued tasks for that group
4. Replies `⚙️ Agent aborted.` (or per-channel equivalent)

The trigger set is conservative (`src/abort-triggers.ts`):
- English: `stop`, `cancel`, `abort`, `interrupt`, `esc`, `halt`, `/stop`, `/cancel`, `/abort`
- CJK: `停`, `停止`, `取消`, `中止`, `やめて`, `止めて`
- Other: `parar`, `pare`, `arrete`, `arrête`, `stopp`, `anhalten`, `стоп`, `остановись`

Words like `wait` and `exit` are deliberately excluded because they appear in normal conversation. Add or remove triggers in `ABORT_TRIGGERS` if needed.

**Symptom that is NOT a bug**: agent stops mid-reply when user types `stop` — that is exactly the point.

### Busy ack: “📥 收到，第 2 条排队中” on the second piped follow-up

When a user sends a follow-up message while the agent is still processing the previous turn (no output yet), nanoclaw pipes it into the running container. To avoid silent UX:

- 1st piped message → typing indicator only (no chat ack)
- 2nd piped message before agent output → send `📥 收到，正在处理上一条，这是第 2 条。。。`
- 3rd+ piped messages → silent (user already knows we are working)
- Once the agent emits any output → ack window closes for the rest of the turn; resets on next container spawn

Implemented via `GroupQueue.shouldSendBusyAck()` + `notifyAgentOutput()` (see `src/group-queue.ts`). Adjust the threshold by editing the `pipedSinceOutput === 2` check.

**Symptom that is NOT a bug**: bot replies `📥 收到` instead of a real answer when user fires off two messages quickly — expected; the real answer follows once the agent finishes the prior turn.

### Send retry & editMessage fallback

All outbound channel sends (Discord / Telegram / Teams) go through `sendWithRetry` (`src/channels/send-with-retry.ts`):

- Retries on transient failures with backoff `500ms → 2s → 5s` (4 total attempts, ~7.5s worst case)
- **Permanent errors are NOT retried**: 401, 403, 404, `bot was blocked`, `chat not found`, `user is deactivated`, `invalid token`, `message is not modified`
- **429 (rate limit) and 5xx ARE retried**
- Final failure logs at `error` level and (where supported) emits `⚠️ 上条回复未送达` to the user

`editMessage` failures fall back to `sendMessage` (originally added for Teams in `d502dce`, now also covers Telegram). Previously these failures were swallowed at `debug` level — a regression we fixed twice (Teams + Telegram). If a stream/partial reply ever silently disappears, check the channel logs for `editMessage failed, falling back to sendMessage`.

**Tuning**: edit `DEFAULT_BACKOFF_MS` in `send-with-retry.ts`. Do not retry forever — messaging platforms have stricter rate limits than the agent's reply rate, so a stuck send queue causes worse UX than a clear delivery-failed message.
