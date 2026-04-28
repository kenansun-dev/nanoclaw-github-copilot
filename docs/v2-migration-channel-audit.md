# v2-merge Audit X — qwibitai upstream changes since our base

**Author**: rpi5 Claw
**Date**: 2026-04-28
**Scope**: Catalogue what `upstream/feat/migrate-from-v1` has changed since
our last merge-base on `v2-merge`, and decide port / skip / wrap for each
area before B.5 dispatcher cut.

## TL;DR

- merge-base: `934f063` (last shared commit between `v2-merge` and `upstream/feat/migrate-from-v1`)
- 452 commits ahead on upstream side; **18,417 + / 10,614 −** across **177 files**
- Channel-side qwibitai sibling forks (`nanoclaw-telegram`, `nanoclaw-discord`)
  are frozen since 2026-04-02; **no missing channel-side cherry-picks** there
- Real action: catch up on `container/agent-runner/` rewrite + new `src/modules/*`
  + new `src/channels/` adapter pattern (already partly mirrored in our
  `src/channels/{channel-registry,adapters-barrel}.ts`)

## Method

```
BASE=$(git merge-base v2-merge upstream/feat/migrate-from-v1)   # 934f063
git diff --stat $BASE..upstream/feat/migrate-from-v1 -- container/ src/
git diff --name-only $BASE..upstream/feat/migrate-from-v1
```

For sibling forks:
```
git diff --stat $(git merge-base v2-merge telegram/main)..telegram/main -- src/ container/
git diff --stat $(git merge-base v2-merge nanoclaw-discord/main)..nanoclaw-discord/main -- src/ container/
```

## Sibling channel forks (telegram, discord)

| fork | last commit | divergence vs v2-merge |
|------|-------------|------------------------|
| `nanoclaw-telegram` | `1d51678` 2026-04-02 (frozen) | `src/channels/telegram*.ts` (+1574 / −0) — already merged into our v1 fork via earlier sync; nothing new to port |
| `nanoclaw-discord` | `864e3ca` 2026-04-02 (frozen) | `src/channels/discord*.ts` (+1027 / −0) — already merged into our v1 fork; nothing new to port |
| (whatsapp/signal/slack/matrix/gmail) | not merged in our fork | **OUT OF SCOPE per kenan 2026-04-28** — only keep features we already had |

**Conclusion**: no channel-fork cherry-picks needed. Channel surface is
fully reflected in our `src/channels/{telegram,discord}.ts` v1 fork code
which the v2 ChannelAdapter shims wrap.

## Upstream (`feat/migrate-from-v1`) changes — by area

### `container/agent-runner/` (39 files, full rewrite)

| change | port stance | reason |
|--------|-------------|--------|
| `ipc-mcp-stdio.ts` deleted (−508) | **mirror** | We delete our `container/agent-runner-ghc/src/ipc-mcp-stdio.ts` after porting its tools |
| `mcp-tools/{core,agents,interactive,scheduling,self-mod}.ts` added | **port to GHC variant** | New 5-module structure; we replicate in `container/agent-runner-ghc/src/mcp-tools/` keeping GHC-specific quirks |
| `mcp-tools/server.ts` (54L) | **port** | MCP server bootstrap + self-registration loop |
| `mcp-tools/types.ts` (6L) | **port** | `McpToolDefinition` shape |
| `mcp-tools/index.ts` (22L) | **port** | side-effect import barrel |
| `*.instructions.md` files | **port** | agent-facing docs; tool-bound and stable |
| `poll-loop.ts` + `.test.ts` (685L) | **port** | replaces our IPC-dir poll; ties to host `messages-in/out` |
| `providers/{claude,mock,factory,registry,types}.ts` | **adapt** | upstream uses provider abstraction; our GHC fork already has one — verify shape compat, no full port |
| `scheduling/task-script.ts` (121L) | **port** | new scheduling helper, used by `mcp-tools/scheduling.ts` |
| `timezone.{ts,test.ts}` (200L) | **port** | tz utilities; cheap |
| `integration.test.ts` (121L) | **port** | smoke for container loop |
| `index.ts` (−775L net) | **rewrite our GHC variant** | upstream slims down container entrypoint dramatically |

### `src/modules/*` (44 files, new module subsystem)

| module | size | port stance | reason |
|--------|------|-------------|--------|
| `agent-to-agent/` | ~10 files | **port** | Required for "保持现有功能不变"; we rely on agent-to-agent routing today |
| `approvals/` | ~10 files | **port** | OneCLI approvals + primitive; covers our /approve flow |
| `interactive/` | 3 files | **port** | Question-asking semantics |
| `mount-security/` | 1 file | **already done** | We already shipped `src/modules/mount-security/` shim wrapping fork canonical impl (commit `08e4ac9`) |
| `permissions/` | ~6 files | **port** | Channel approval + access checks |
| `scheduling/` | 6 files | **port** | New scheduler driver; integrates with `task-scheduler-fork-bridge.ts` we'll write at B.5 |
| `self-mod/` | 5 files | **port** | Self-modification primitive |
| `typing/` | 1 file | **port** | Typing indicator support |

### `src/channels/` (10 files, adapter pattern)

| file | upstream change | our state |
|------|-----------------|-----------|
| `adapter.ts` (+178) | new abstract adapter | **already wrapped** in `src/channels/adapters-barrel.ts` + `discord-adapter.ts` + `teams-adapter.ts` + `telegram-adapter.ts` (we shipped these) |
| `ask-question.ts` (+46) | new | **port** (small) |
| `channel-registry.{ts,test.ts}` (+342) | new | **already done** (we have `src/channels/channel-registry.{ts,test.ts}`) |
| `chat-sdk-bridge.{ts,test.ts}` (+690) | new | **port** — large, integrates with `@modelcontextprotocol/chat-sdk` migration upstream did |
| `cli.ts` (+276) | new channel CLI runner | **defer** (not part of "保持现有功能"; staging doesn't need CLI channel) |
| `registry.ts` (−28) | deleted | **mirror** delete after we port channel-registry |
| `index.ts` (+21 / −0 net) | barrel re-export | **port edits** |

### `src/db/` (22 files, schema rewrite)

| change | port stance |
|--------|-------------|
| migrations 001..013 + module migrations | **port** — new migration runner with schema versioning. Our v2-merge B.1 already shipped fork migrations 100..104; need to thread through the new index |
| `db-v2.test.ts` (+) | **port** smoke |
| `connection.ts`, `index.ts`, `schema.ts` rewrites | **port** |
| `messaging-groups.ts`, `dropped-messages.ts`, `agent-groups.ts` | **port** |
| `session-db.test.ts` | **port** |

### Top-level `src/` rewrites

| file | change | port stance |
|------|--------|-------------|
| `router.ts` | +500L diff | **already in progress** — VM did landscape audit `3c2f44f`; B.5 will land hooks |
| `session-manager.ts` (+398) | new | **port** |
| `state-sqlite.ts` (+182) | new | **port** |
| `webhook-server.ts` (+134) | new | **port** |
| `command-gate.ts` (+) | new | **port** — wires into our `access-gate-registry.ts` skeleton |
| `response-registry.ts` (+45) | new | **port** |
| `platform-id.ts` (+23) | new | **port** (cheap) |
| `claude-md-compose.ts` (+) | new | **port** |
| `container-config.ts` (+) | new | **port** |
| `task-scheduler.ts` (−284 / replaced) | upstream removed | We **bridge** via `task-scheduler-fork-bridge.ts` at B.5 |
| `sender-allowlist.ts` (−128) | upstream removed | **already replaced** by `src/modules/sender-allowlist-fork/` (commit `551cad4`) |
| `remote-control.ts` (−224) | upstream removed | **deferred** — Q3 audit `f4ac768` confirmed our fork keeps it; need decision after B.5 lands |

## Cherry-pick / port plan (ordered by dep)

1. `src/db/` migration index + schema rewrite (foundation)
2. `src/modules/{interactive,typing,mount-security,permissions}/` (low-coupling primitives)
3. `src/modules/{approvals,agent-to-agent,scheduling,self-mod}/` (mid-coupling)
4. `src/channels/{ask-question,chat-sdk-bridge}.ts` + `index.ts` edits
5. `container/agent-runner-ghc/src/mcp-tools/*` 5-module port + `server.ts` + `types.ts` + `index.ts` + `poll-loop.ts`
6. `container/agent-runner-ghc/src/{providers,scheduling,timezone}/` adapt
7. Top-level `src/{session-manager,state-sqlite,webhook-server,command-gate,response-registry,platform-id,claude-md-compose,container-config}.ts` port
8. B.5 dispatcher cut (6 imports flip + `task-scheduler-fork-bridge.ts` skeleton + smoke)

## Out of scope (kenan 2026-04-28)

- Adding new channel forks (whatsapp, signal, slack, matrix, gmail) — keep current capability, do **not** widen surface
- Channel CLI runner (`src/channels/cli.ts`) — not in current capability
- Dashboard / chat-sdk widgets unrelated to message routing

## Risks

- **chat-sdk-bridge** (+690L) is the heaviest single port; if upstream pulled in `@modelcontextprotocol/chat-sdk` SDK lock changes, we may face dep conflicts with our GHC `@anthropic-ai/...` lock
- New scheduling module assumes new task-state schema; our fork `scheduled_tasks` table structure is custom — bridge layer must reconcile
- `session-manager.ts` upstream replaces `session-cleanup.ts` (−25L); behaviour change must be smoke-tested

## Open questions for kenan

1. Bring our `remote-control.ts` (fork-only) along, or punt to post-staging?
2. `chat-sdk-bridge.ts` port: full or thin (only the surface our agent loop touches)?
3. Migration ordering on staging boot: run 001..013 + 100..104 fresh on a copy of `~/.nanoclaw/db.sqlite`, or seed from migration-agnostic table dump?
