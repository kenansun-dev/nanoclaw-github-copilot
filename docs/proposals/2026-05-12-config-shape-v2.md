# Config Shape v2 — retire `chats[]` / `isMain`, adopt accounts + bindings + allowFrom

**Status:** Draft (proposal)
**Date:** 2026-05-12
**Authors:** Kenan VM Claw, Kenan Rpi5 Claw
**Owner ack:** kenansun (2026-05-12, "今天就做")

## Goal

Retire fork-specific `chats[]` / `isMain` config and replace it with an
OpenClaw-aligned shape:

- `channels.<proto>.accounts.<key>` — multi-bot per protocol
- `accounts.<key>.allowFrom` / `groupAllowFrom` / `groups.<id>.allowFrom`
  — explicit access lists
- top-level `bindings: []` — agent routing
- new DB tables: `agent_groups`, `messaging_groups`, `users`, `user_roles`

## Non-goals

- Implementing `accessGroups` (OpenClaw advanced feature; deferred)
- Removing the `nanoclaw pair` CLI entirely (kept as deprecated alias for ≥2 versions)
- Full v2 schema parity with upstream `nanoclaw` (we adopt the shape, not the
  whole runtime)

## Why

Today `chats[].isMain=true` conflates four concerns:

1. "this chat exists"
2. "this sender is the owner"
3. "this is the chat to send task notifications to"
4. "this chat has DM access"

Any change to one of those ripples through the others. New shape splits
them cleanly across config (declaration) and DB (runtime state).

## Config shape

```jsonc
{
  "channels": {
    "telegram": {
      "enabled": true,
      "accounts": {
        "personal": {
          "botToken": "${TG_PERSONAL}",
          "dmPolicy": "pairing",
          "allowFrom": ["8731187021"],

          "groupPolicy": "allowlist",
          "groupAllowFrom": ["8731187021"],
          "groups": {
            "*":         { "requireMention": true },
            "-1001crew": { "requireMention": false, "allowFrom": ["8731187021", "9999"] }
          }
        },
        "work": {
          "botToken": "${TG_WORK}",
          "allowFrom": ["8731187021"]
        }
      }
    },
    "teams": {
      "enabled": true,
      "accounts": {
        "default": {
          "appId":     "${TEAMS_APP_ID}",
          "appSecret": "${TEAMS_SECRET}",
          "allowFrom": ["29:1abc..."]
        }
      }
    }
  },

  "agents": {
    "list": [
      { "id": "main" },
      { "id": "work-bot" }
    ]
  },

  "bindings": [
    { "agentId": "main",     "match": { "channel": "telegram", "accountId": "personal" } },
    { "agentId": "work-bot", "match": { "channel": "telegram", "accountId": "work"     } },
    { "agentId": "main",     "match": { "channel": "teams"                              } }
  ]
}
```

### Field semantics

| Field | Scope | Meaning |
|---|---|---|
| `accounts.<key>.botToken` | per account | bot credential |
| `accounts.<key>.dmPolicy` | per account | `pairing` (default) / `open` / `strict` |
| `accounts.<key>.allowFrom` | per account | DM whitelist (sender raw id, no `tg:` prefix) |
| `accounts.<key>.groupPolicy` | per account | `allowlist` / `open` |
| `accounts.<key>.groupAllowFrom` | per account | senders allowed in **any** group |
| `accounts.<key>.groups.<id>` | per group | per-group override (`requireMention`, `engageMode`, `allowFrom`, ...) |
| `accounts.<key>.groups.*` | per account | fallback for groups without explicit entry |
| `bindings[].agentId` | top-level | which agent handles matching messages |
| `bindings[].match.channel` | top-level | protocol filter |
| `bindings[].match.accountId` | top-level | optional account filter |

DM is always engaged (no `dms` block, no per-DM config). DM access is
controlled solely by `dmPolicy` + `allowFrom`.

## DB shape (migration 105 — schema delta only)

**Important context:** the upstream v2 migration 001 (`initial-v2-schema`)
already creates `agent_groups`, `messaging_groups`, `users`, `user_roles`,
`messaging_group_agents`, and `agent_group_members`. The fork's runtime
still reads/writes the **legacy** v1 tables (`chats`, `messages`,
`registered_groups`, `scheduled_tasks`) created in `src/db.ts:createSchema()`,
even though both schemas coexist in the DB.

What the v2 config shape needs that 001 doesn't have: a way to distinguish
the same chat under different bot accounts. That requires a single column
addition.

Migration 105 (`105-fork-v2-schema`) does exactly this:

```sql
-- 1. add the column (idempotent)
ALTER TABLE messaging_groups ADD COLUMN account_key TEXT NOT NULL DEFAULT 'default';

-- 2. rebuild the table to swap UNIQUE(channel_type, platform_id)
--    for UNIQUE(channel_type, account_key, platform_id)
CREATE TABLE messaging_groups_new (...);
INSERT INTO messaging_groups_new SELECT ... FROM messaging_groups;
DROP TABLE messaging_groups;
ALTER TABLE messaging_groups_new RENAME TO messaging_groups;
```

All other v2 tables (agent_groups, users, user_roles, etc.) are reused as-is
from 001. PR-B will start writing to them as part of the reconcile pipeline.

### Final shape after migration 105

For reference, the relevant tables look like this once 001 + 105 are applied:

```sql
agent_groups (
  id PK, name, folder UNIQUE, agent_provider, created_at
)

messaging_groups (
  id PK, channel_type, account_key DEFAULT 'default', platform_id,
  name, is_group, unknown_sender_policy, denied_at, created_at,
  UNIQUE(channel_type, account_key, platform_id)
)

users (
  id PK, kind, display_name, created_at
)

user_roles (
  user_id FK→users, role, agent_group_id FK→agent_groups (NULL=global),
  granted_by, granted_at,
  PK (user_id, role, agent_group_id)
)
```

Constraints (enforced in code in PR-B):

- `user_roles.role IN ('owner', 'admin')`
- `role='owner'` requires `agent_group_id IS NULL` (owner is global)
- `role='admin'` may be global (NULL) or scoped to one agent_group_id
- `messaging_groups.platform_id` is the **raw** id (no `tg:` / `discord:` prefix)
- `messaging_groups.is_group=0` represents a DM


## Config ↔ DB relationship

Config = declaration (what you want).
DB = runtime state (what actually happened).

```
nanoclaw.json (you write)
   │ on startup / config reload
   ▼
[reconcile]  ─────►  DB (runtime)
   │ pair approval                ▲
   ▼                              │ inbound messages
nanoclaw.json (write back ─────── chat / user / session auto-INSERT
allowFrom only)
```

- **From config to DB:** every reconcile, idempotent + transactional
- **From DB to config:** **only** during `pair approve` (writes back the new
  sender id into `accounts.<key>.allowFrom`)
- **Runtime DB grows on its own:** every new chat → INSERT messaging_groups,
  every new sender → INSERT users, every task → INSERT scheduled_tasks

### Reconcile pipeline

On startup or config reload:

1. **parse config** (schema validate, env substitute). Failure → no DB change.
2. **upsert agent_groups** from `agents.list[]`
   - missing in DB → INSERT
   - present in both → UPDATE
   - in DB but not config → mark `archived=1` (do not delete; protects FK refs
     from `sessions`, `scheduled_tasks`)
3. **upsert users + user_roles** from every `accounts.*.allowFrom`
   - INSERT OR IGNORE into `users`
   - sync `user_roles` rows to match config (delete rows that are no longer in
     `commands.ownerAllowFrom`, insert new ones)
4. **load bindings** into in-memory routing table (no DB persistence)
5. **note:** `messaging_groups` is **not** populated from config — it grows
   lazily on first inbound message per chat

## Pair flow

Pair = explicit access approval. Triggered when `dmPolicy: "pairing"`.

### a. DM pair approval (stranger flow)

1. Stranger DMs bot (sender ∉ `allowFrom`)
2. Bot replies with 8-char code (1h expiry, max 3 pending per channel/account)
3. Message is held, **not processed**
4. Owner runs on host:
   ```
   nanoclaw pairing approve <channel> <code> [--account <key>]
   ```
5. Atomic transaction:
   - INSERT OR IGNORE into `users`
   - if first ever approve → INSERT `user_roles (role='owner', agent_group_id=NULL)`
     and write `commands.ownerAllowFrom += [channelType:rawId]`
   - subsequent approves → user only, no role
   - write back `accounts.<key>.allowFrom += [rawId]` (config persists)

### b. Group access (no pair)

Owner edits config directly:

```jsonc
"groupAllowFrom": ["8731187021"]
// or per-group
"groups": { "-1001crew": { "allowFrom": ["8731187021"] } }
```

No pair code, no chat-side flow. Group access never auto-bootstraps owner.

### c. CLI explicit pair (skip code)

```
nanoclaw pairing approve --user telegram:8731187021 --account personal
```

Equivalent to (a) without the code roundtrip — used for pre-paired setups.

## Migration from `chats[]` (one-time, idempotent)

Runs on first startup of v2 binary when `config.chats` exists.

```ts
function migrateChatsToV2(config) {
  for (const [jid, entry] of Object.entries(config.chats ?? {})) {
    const [proto, rawId] = jid.split(':', 2);
    const channelKey = proto === 'tg' ? 'telegram' : proto;
    const account    = pickDefaultAccount(config.channels[channelKey]) ?? 'default';

    ensureAccount(config, channelKey, account);

    const isGroup = (channelKey === 'telegram' && rawId.startsWith('-'))
                 || (channelKey === 'teams'    && rawId.includes('thread'));

    if (isGroup) {
      // Group chat — old fork didn't store the sender, so backfill is lossy.
      // Safe default: open the group, log a warning so owner reviews.
      ensureGroupEntry(config, channelKey, account, rawId);
      config.channels[channelKey].accounts[account].groups[rawId].requireMention = false;
      logBanner(`group ${rawId} migrated with groupPolicy=open; review nanoclaw.json`);
    } else {
      // DM — add to allowFrom; if isMain, bootstrap owner
      pushUnique(config, ['channels', channelKey, 'accounts', account, 'allowFrom'], rawId);
      if (entry.isMain) {
        pushUnique(config, ['commands', 'ownerAllowFrom'], `${channelKey}:${rawId}`);
        // DB side
        db.prepare(`INSERT OR IGNORE INTO users (id, kind, created_at) VALUES (?, ?, ?)`)
          .run(`${channelKey}:${rawId}`, channelKey, now());
        db.prepare(`INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_at)
                    VALUES (?, 'owner', NULL, ?)`)
          .run(`${channelKey}:${rawId}`, now());
      }
    }
  }
  delete config.chats;
  saveConfig(config);
}
```

### Migration safety

- Snapshot to `nanoclaw.json.pre-v2.bak` before writing
- All-or-nothing: config write + DB inserts in a single transaction; failure → restore
- Idempotent: re-run finds no `config.chats`, no-op
- Banner on completion:
  ```
  ✅ Migrated N DM chats → accounts.*.allowFrom
  ⚠️  M group chats migrated with groupPolicy=open. Review nanoclaw.json.
  📋 Backup: ~/.nanoclaw/nanoclaw.json.pre-v2.bak
  ```

### Caveat: group `groupAllowFrom` cannot be auto-backfilled

The old fork never recorded which sender was the trusted user in a group
chat (it only tracked the group jid + isMain). Migration cannot reconstruct
this, so it falls back to `groupPolicy=open` + warning. Owner should review
and tighten manually.

## CLI changes (in PR-B)

| Old | New | Behaviour |
|---|---|---|
| `nanoclaw pair <jid> --main` | `nanoclaw pairing approve --user <id> --account <key>` | new, OpenClaw-aligned |
| `nanoclaw pair <jid>` | (alias, deprecated) | prints warning, dispatches to new |
| (none) | `nanoclaw pairing list` | lists pending pair codes |
| (none) | `nanoclaw pairing approve <channel> <code>` | approves a pending code |

The old `nanoclaw pair` CLI is kept as a thin alias for ≥2 minor versions
before removal.

## Rollout (per MEMORY one-PR-per-day)

- **Day 1 (today):** PR-A — proposal doc + migration 105 (4 tables, schema only). No runtime change.
- **Day 2:** PR-B — reconcile pipeline + router switch + `nanoclaw pairing` CLI + `nanoclaw pair` alias + data migration code.
- **Day 3:** PR-C — TUI owner injection + remove dead `chats[]` reader code.

PR-B depends on PR-A; rebase, do not stack.

## Backward compatibility

- Old `chats[]` config still parses (schema accepts both shapes during
  migration window)
- Old `nanoclaw pair` CLI still works (alias)
- Old DB tables (`chats`, `messages`, `registered_groups`) untouched —
  new `messaging_groups` is additive
- Users not in `allowFrom` after migration → behaviour unchanged for **DM
  isMain users** (auto-added); behaviour **changes** for group senders
  (now must be explicitly listed → migration banner warns + opens groups)

## Open questions

1. Should `messaging_groups.is_dm` be derived from `platform_id` shape, or
   stored explicitly? Current proposal: stored explicitly for clarity.
2. Should `bindings` support regex / glob match? OpenClaw uses literal
   match only; we adopt the same.
3. `accessGroups` (OpenClaw shared-sender-set abstraction) — adopt later or
   never? Current proposal: defer.
