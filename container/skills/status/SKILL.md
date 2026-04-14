---
name: status
description: Quick health check — run `nanoclaw status` and return the output. Use when the user asks for system status or runs /status.
---

# /status — System Status

Run `nanoclaw status` and return the output to the user.

```bash
nanoclaw status
```

This shows: running state, model, agent, auth, channels, chats, tunnel, workspace, and logs path.

If `nanoclaw` CLI is not available (e.g. container mode), gather basic info manually:

```bash
echo "🤖 NanoClaw"
echo "🧠 Model: ${COPILOT_MODEL:-unknown}"
echo "📁 Mode: ${NANOCLAW_HOST_MODE:+host}${NANOCLAW_HOST_MODE:-container}"
echo "📁 Working dir: $(pwd)"
```
