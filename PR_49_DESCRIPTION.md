# PR #49 — v2 schema + reuse upstream nanoclaw access (no rewheel)

## Goal

Land the v2 config schema (PR-A/B), retire v1 routing (PR-C), and stop
rewheeling upstream nanoclaw access logic (PR-D). The fork now reads from
the same `agent_group_members` / `user_roles` tables and runs the same
`canAccessAgentGroup` gate that upstream uses, with a thin `pair` flow on
top for device-ownership confirmation.

## What changed

- **PR-A/B (schema + reconcile pipeline)**
  - `nanoclaw.json` v2 shape: `accounts.<channelKey>.<accountId>` with
    `allowFrom` / `groupAllowFrom` / `groups[].{allowFrom, requireMention}`
    + `commands.ownerAllowFrom`.
  - `src/db/v2-reconcile.ts` projects config → DB:
    1. `agents.list[]` → `agent_groups`
    2. allowFrom users → `users` (INSERT OR IGNORE)
    3. `commands.ownerAllowFrom` → `user_roles` (`role='owner'`)
    4. allowFrom users → `agent_group_members` on every live `agent_groups`
    5. (PR-D) `groups.<peerId>.requireMention` → `engage_mode` /
       `engage_pattern` on existing `messaging_group_agents`
- **PR-C (v1 retirement)**
  - `isMain` / legacy top-level `chats[]` no longer routes; warned once
    at startup, parsed only for backwards compat.
- **PR-D (reuse upstream)**
  - Router relies on upstream `setAccessGate` (`canAccessAgentGroup`).
  - Router auto-wires `messaging_group_agents` from `config.bindings[]`
    on lazy `messaging_groups` create — `engage_mode` defaults to
    `'pattern'`/`'.'` for DM, `'mention-sticky'` for group.
  - `src/v2-access.ts`: `isUserConfigAllowed` + `maybeHoldForPairing`
    helpers (pure; wiring into router is PR-E scope).

## What was deleted

- `checkInboundAccess` (the fork's config-driven access gate, ~110 LOC)
- `src/modules/sender-allowlist-extensions/` (fork v2 adapter over
  `src/sender-allowlist.ts`) — the upstream gate handles this now.
- Fork bindings runtime gate (replaced by `canAccessAgentGroup`).

`src/sender-allowlist.ts` itself is preserved — still consumed by other
surfaces.

## What is new

- **Migration 105** (`fork-v2-schema`): adds `account_key` to
  `messaging_groups` so DM/group rows can disambiguate per-account.
- **Migration 106** (`pending-pairing`): `pending_messages` +
  `pairing_codes` tables backing the pair flow.
- **Migration 107** (`agent-groups-archived`): dedicated `archived_at`
  column on `agent_groups` (stops overloading `agent_provider`).
- **`src/db/v2-reconcile.ts`**: config → DB projection pipeline (steps
  1–5; transactional, idempotent, rolls back on failure).
- **`src/router.ts`**: auto-wire of `messaging_group_agents` from
  `config.bindings[]` on lazy `messaging_groups` create.

## What is preserved

- **Pair flow** as device-confirm only — separate from access decisions.
  Stranger DMs are held; owner redeems via `/pair-approve <CODE>` or
  `nanoclaw pair-approve`. Once redeemed, a `user_roles` row with
  `role='paired'` is written and held messages are replayed.
- **`account_key`** on `messaging_groups` and `pairing_codes`.
- **`archived_at`** on `agent_groups` (FK-safe soft-delete).

## Migration story

- New installs: migrations 105/106/107 run idempotently.
- Existing installs: legacy `chats[]` is parsed but not routed; run
  `nanoclaw migrate-v2` to convert into v2 shape. `agents.list[]`
  declarations seed `agent_groups`. The reconcile pipeline writes every
  config-declared user into `agent_group_members` so the upstream access
  gate accepts them without going through the upstream sender-approval
  flow.

## Reused upstream files (no rewheel)

- `src/modules/permissions/access.ts` — `canAccessAgentGroup` is the only
  access decision the router consults.
- `src/db/messaging-groups.ts` — `createMessagingGroupAgent` is the
  shared write surface for the new auto-wire path.
- `src/router.ts` — `setAccessGate` is the single hook into the gate.

## Test count delta

Baseline (post-PR-C): 1366 pass / 0 fail.
After PR-D commits A + B + C: **1377 pass / 0 fail**.
Net +11 (15 new tests in `v2-reconcile.test.ts` + `v2-access.test.ts`,
−4 tests removed with the dead module).

## Known follow-ups (PR-E)

- Migrate `bindings[]` shape into `accounts.<channelKey>.{wireAgent, peer}`
  (proposal §"Bindings"). The auto-wire path will read directly from
  `accounts.*` once that lands.
- Approval opt-in flag — let `accounts.<k>` opt into the upstream
  sender-approval flow (`request_approval`) instead of being silently
  added to `agent_group_members`.
- Consistency check between **config-declared** allowFrom and
  **runtime-approved** members: today the reconcile only inserts; PR-E
  should add a deletion / divergence-warn surface.
- Wire `maybeHoldForPairing` into router (held in `src/v2-access.ts` as a
  pure helper for now to keep PR-D reviewable).
- `requireMention` projection (step 5) only updates **existing**
  `messaging_group_agents` rows. A chat that has never received inbound
  has no mga row yet, so a `requireMention` config change won't apply
  until first inbound triggers router auto-wire. Acceptable for now
  (engage_mode default for groups is `mention-sticky`, matching the
  most common `requireMention=true`); revisit when bindings move under
  `accounts.*` and reconcile gains enough info to pre-create.
