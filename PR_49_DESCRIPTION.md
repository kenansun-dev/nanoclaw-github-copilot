# PR #49 — v2 config schema + runtime migration (PR-B + PR-C)

Closes the schema-only proposal by wiring the runtime to v2 routing AND retiring v1 legacy paths in a single PR.

## Goals
- Replace singular "main agent" + `chats[]` with structured `bindings` + `messaging_groups` + `agent_groups`
- Per-user `user_roles` with owner role for slash/CLI gating
- Stranger DMs hold for pairing; owner approves via code
- Single PR to keep migration coherent; ship behind `NANOCLAW_V2_DISPATCHER=2`

## Commits

(fetched from `git log --oneline d9ca8a9^..HEAD` — branch base = PR-A landing)

```
<PR-C cleanup commit>     refactor: retire isMain + legacy chats[] routing; finalize PR description (fixup #49 PR-C)
fd34227                   feat(pairing): revoke codes + harden CLI surface (fixup #49 step 8)
26a9dbc                   feat(pairing): persist hold-for-pairing + code redemption (fixup #49 step 7)
e586342                   fix(router): correct jid parse for Teams + audit nits (fixup #49 step 6.5)
463936e                   feat(router): switch inbound dispatch to v2 access gating + resolveBinding (fixup #49 step 6)
5ae8cab                   feat(bindings): loader + resolveBinding with 3-layer precedence (fixup #49 step 5)
03da9b9                   fixup #49: harden migrateChatsToV2 (Rpi5 audit flags 1–3)
409394c                   fixup #49: v2 chats[] → accounts/users/groups migrator (config + DB sides)
622cb3d                   fixup #49: v2 boot guard — defuse legacy sessions table before migration 001
318598b                   feat(db): port upstream migrations 014/015 (container_configs scaffold)
c466357                   fixup #49: v2 reconcile pipeline (agent_groups + users + user_roles)
eaddb64                   fixup #49: v2 config-shape — extend account schema with access-control fields
fd32577                   fixup #49: PRAGMA foreign_keys must be toggled outside the migration tx
d9ca8a9                   daily 2026-05-12 #3: PR-A v2 config-shape proposal + messaging_groups.account_key (migration 105)
```

## DB Migrations
- 014 container_configs (upstream port)
- 015 cli_scope (upstream port)
- 105 fork-v2-schema (account_key, etc.)
- 106 pending_messages + pairing_codes

## Runtime changes
- v2-boot-guard before migration 001 (renames legacy `sessions` to `sessions_legacy_v1`)
- v2-migrate-chats: `chats[]` → groups/allowFrom/owner + DB-side `chats` → `messaging_groups` + `registered_groups` → `agent_groups`
- bindings-loader: 3-layer precedence (peer > accountKey > '*')
- v2-access: opt-in gate; DM cascade (allowFrom → dmPolicy) + group cascade + requireMention + owner bypass
- router: `resolveBinding` + access gate + fail-open fallback with audit
- pairing: hold-for-pairing persist + 8-char Crockford base32 codes + 24h TTL + opportunistic sweep + tx redeem

## CLI / slash surface
- `nanoclaw pair approve <code>` / `pair pending` (alias `list-pending`) / `pair revoke <code>`
- `/pair-approve`, `/pair-pending`, `/pair-revoke` (owner-only via `user_roles`)

## Cleanup (PR-C)
- `isMain` retired as a routing concept: zod field marked `@deprecated`, kept parseable for v1-compat (mount perms + share-main DM collapse + migrator input only)
- `nanoclaw pair` direct/interactive flows no longer prompt for "main"; `--main`/`--no-main` flags warn and are ignored
- TUI binds via `TUI_AGENT_ID` env (defaults to `agents.list[0].id`); legacy share-main DM session folder retained until PR-D
- Legacy top-level `chats[]` still parsed for backwards compat but warns once at startup: routing goes through bindings/agent_groups exclusively

## Test count: 1373 (baseline) → 1373 (PR-C is cleanup; no behavioral surface change)

## Backwards compat
- Old `nanoclaw.json` loads via zod-permissive parse; `chats[]` ignored for routing, migrate with `nanoclaw migrate-v2`
- Accounts without v2 fields fall through to legacy permissive (no behavior change)
- Migration 106 idempotent (`IF NOT EXISTS`)
- `isMain` on `ChatEntry` / `RegisteredGroup` still honored by `db.ts` + `session-routing.ts` for the share-main DM collapse; deletion deferred to PR-D after migrator runs in the wild

## Acceptance
- `npm test` green (1373 baseline → 1373 after PR-C)
- Manual: start with old config → boot succeeds → migrator runs → bindings resolved → DM gating opt-in works
- Manual: stranger DM → hold → owner runs `/pair-approve` → replay happens
