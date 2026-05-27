# Teams Multi-Account Bootstrap

Run **two or more Teams bots** out of one nanoclaw deployment with a single
CLI command per bot. Each bot gets its own:

- Azure AD App Registration (`appId` + `appPassword`)
- Azure Bot resource (with Teams channel enabled)
- DevTunnel port (one tunnel, multiple ports)
- nanoclaw HTTP server (`channels.teams.accounts[<id>].webhookPort`)
- Teams app manifest zip (separate sideload per bot)

## TL;DR — add a second bot

```bash
# First bot (default) — same as before
nanoclaw channel add teams --setup --agent main
# → bot named `nanoclaw-andy`, port 3978, writes accounts.default

# Second bot — pass --account <id> and --agent <agentId>
nanoclaw channel add teams --setup --account bot-b --agent coder
# → bot named `nanoclaw-coder-bot-b`, port 3979, writes accounts.bot-b
#   (port auto-allocated as max(in-use)+1)

nanoclaw restart
# Two HTTP servers come up: :3978 → main, :3979 → coder
# Sideload each manifest zip into Teams (one per bot)
```

That's it. The CLI handles tunnel + Azure + manifest + config writes
per account.

## What `--setup --account <id>` does

1. **Resolve a unique `botName`.** For `accountId='default'` it stays
   `nanoclaw-<agentName>` (back-compat). For other accounts it suffixes
   the accountId: `nanoclaw-<agentName>-<accountId>`. Two accounts that
   resolve to the same agent still get distinct Azure resources.

2. **Allocate a webhook port.** Reuses
   `accounts[<id>].webhookPort` if already set, otherwise picks
   `max(in-use ports)+1` starting from 3978. So second bot lands on
   3979, third on 3980, etc. Override with `--webhookPort <n>`.

3. **DevTunnel `setup -p <port>`.** Reuses the single `nanoclaw`
   devtunnel; just adds the new port + anonymous access. One tunnel
   hostname, multiple ports — Azure Bot endpoints look like
   `https://<id>-3978.devtunnels.ms/api/messages` vs
   `https://<id>-3979.devtunnels.ms/api/messages`.

4. **`az ad app create` + secret rotation.** Writes `appId` +
   `appPassword` to `channels.teams.accounts[<id>]`. Skips `.env`
   for non-default accounts (otherwise the second bot's secrets
   would overwrite the first bot's `MSTEAMS_APP_ID` / `MSTEAMS_APP_PASSWORD`
   single-account fallback).

5. **`az bot create` + `az bot msteams create`.** Points the Bot's
   messaging endpoint at the per-port tunnel URL.

6. **Manifest zip per account.** Written to
   `~/.nanoclaw/<botName>-teams-manifest.zip`. Different
   botName per account = different zip per bot.

## Routing different bots to different agents

After setup, bind each Teams account to a specific agent via
`bindings`:

```jsonc
{
  "bindings": [
    { "agentId": "main",   "match": { "channel": "teams", "accountId": "default" } },
    { "agentId": "coder",  "match": { "channel": "teams", "accountId": "bot-b" } }
  ]
}
```

DMs to bot A go to the `main` agent; DMs to bot B go to `coder`.

## Resulting config

```jsonc
{
  "channels": {
    "teams": {
      "enabled": true,
      "accounts": {
        "default": {
          "appId": "11111111-...",
          "appPassword": "<secret>",
          "webhookPort": 3978
        },
        "bot-b": {
          "appId": "22222222-...",
          "appPassword": "<secret>",
          "webhookPort": 3979
        }
      }
    }
  }
}
```

Plus one `~/.nanoclaw/.env` with `MSTEAMS_APP_ID` / `MSTEAMS_APP_PASSWORD`
for the `default` account only (single-account fallback path is
unchanged for upgraders).

## Sub-steps (if you want them piecewise)

The four `--setup-*` sub-flags all honor `--account <id>` now:

```bash
nanoclaw channel add teams --setup-tunnel --account bot-b
nanoclaw channel add teams --setup-app    --account bot-b --agent coder
nanoclaw channel add teams --setup-bot    --account bot-b --agent coder
nanoclaw channel add teams --setup-manifest --account bot-b --agent coder
```

## What's still manual (Microsoft side)

- `az login` (first time only)
- `devtunnel user login` (first time only)
- **Sideloading** each manifest zip into Teams admin / individual user's
  uploaded apps. Teams org policy may require admin approval.
- The user has to add the bot to their personal scope or to a chat/team
  before DMing it.

## Caveats

- DevTunnel free tier allows multiple ports on one tunnel but the
  hostname pattern means each port has a different public URL. Azure
  Bot endpoints must be updated whenever the tunnel hostname changes
  (e.g. tunnel re-created). Re-running `--setup-bot --account <id>`
  refreshes the endpoint.
- Cross-tenant cert auth (`certThumbprint` / `certPrivateKeyPath`)
  works per-account — provide them via `--appPassword` left blank +
  manual edit of `accounts[<id>]` for now. Cert setup is not yet in
  the CLI.
- Removing an account: edit `nanoclaw.json` directly; `nanoclaw channel
  remove teams` disables the entire channel (all accounts).
