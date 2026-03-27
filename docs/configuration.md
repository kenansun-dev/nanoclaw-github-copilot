# NanoClaw Configuration Reference

## nanoclaw.json

Located at `~/.nanoclaw/nanoclaw.json`.

### assistant
```json
"assistant": { "name": "Andy" }
```
- `name`: Bot display name and trigger word (`@Andy`)

### providers
```json
"providers": {
  "github-copilot": { "model": "gpt-4o-mini", "auth": "sso" }
}
```
- `model`: Default model ID
- `auth`: `"sso"` (pre-login), `"token"` (from .env), `"openclaw-profile"` (reuse OpenClaw)

### channels
```json
"channels": {
  "telegram": { "enabled": true, "botToken": "" },
  "teams": { "enabled": true, "appId": "", "appPassword": "", "tenantId": "", "webhookPort": 3978 }
}
```
Credentials can be inline or in `.env`. Inline takes precedence.

### chats
```json
"chats": {
  "tg:123456": { "name": "my-chat", "isMain": true }
}
```
Registered chats. Can also be managed via `nanoclaw chat add/remove`.

### mcp
```json
"mcp": { "servers": { "name": { "type": "local", "command": "...", "tools": ["*"] } } }
```
If `~/.nanoclaw/mcp.json` exists, it's auto-merged. Inline servers override.

### skills
```json
"skills": { "directories": ["./skills"], "disabled": ["skill-name"] }
```

### sandbox
```json
"sandbox": { "runtime": "docker", "image": "nanoclaw-agent:latest", "timeout": 1800000, "maxConcurrent": 5 }
```
- `runtime`: `"docker"` or `"apple-container"`

### security
```json
"security": { "autoApproveChats": false }
```

### Other
- `credentialProxy.port`: Default 3001
- `logLevel`: `"debug"`, `"info"`, `"warn"`, `"error"`
- `timezone`: IANA timezone string

## .env

Located at `~/.nanoclaw/.env`. Contains secrets — never commit.

```env
TELEGRAM_BOT_TOKEN=
MSTEAMS_APP_ID=
MSTEAMS_APP_PASSWORD=
MSTEAMS_TENANT_ID=
COPILOT_GITHUB_TOKEN=
```
