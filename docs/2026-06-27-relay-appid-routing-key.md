# Relay appId-as-routing-key — zero-config bot identity (design note)

**Status**: agreed (kenan + VM + Rpi5, 2026-06-27). Lands in PR #64 alongside the
proto/code/infra changes it describes.

## Problem

The relay needs a bot's **appId** in exactly one place that matters: the
outbound MSI→per-bot federation token exchange (`federation.ts`) must mint a Bot
Connector token for *that bot's* appId. Inbound JWT validation also currently
audiences against a per-bot appId.

The first cut sourced appId from a configured map (`NCL_RELAY_BOT_APPIDS`,
`bot-id=appid,...`). kenan's objection chain ruled out every place to *store*
that map:

- file system (`/home`) — survives restart but not App Service recreate / Azure
  Files swap;
- Storage Table / Cosmos — "don't want a storage resource";
- self-service south-edge mgmt API + persistence — out of scope for now;
- app_settings / env — accepted as fallback, but then kenan asked the better
  question: **can the appId not be configured at all?**

## Key realization

Walk the three paths and appId is only ever *needed*, never *independently
chosen*:

| Path | Needs appId? | Source today | Source after |
|------|--------------|--------------|--------------|
| South auth (who may attach) | No — gates on AAD `oid/upn` allowlist | n/a | n/a |
| Inbound routing (which NCL) | No — routes on `/api/messages/<bot>` path segment | path segment | path segment |
| Inbound JWT audience | Yes | configured map | **the path segment itself** |
| Outbound federation exchange | Yes | configured map | **`OutboundReply.bot_id` itself** |

Inbound already carries the appId intrinsically: the BotFramework JWT `aud`
claim *is* the bot's appId, and `recipient.id` echoes it. Routing never used
appId — it used the path segment. So if we **make the routing key equal the
appId** (`botId == appId`), the configured map disappears: appId flows inline as
the routing key instead of being stored.

## Design: `botId` is the appId

1. **Messaging endpoint** becomes `/api/messages/<appId>` (was `/api/messages` +
   empty suffix). Each bot's Azure Bot Service messaging endpoint is registered
   with its own appId in the path. Infra: `azuread_application.bot.client_id` is
   in the bot module already, so this is a one-line endpoint change, no
   cross-module wiring.

2. **Inbound JWT validation** pins `aud == <path segment>` — self-describing, no
   external map. Security is unchanged: only the bot's own Azure registration can
   mint a Microsoft-signed token with `aud=<that appId>`, so a forged path
   segment fails signature/audience validation. (Replaces
   `resolveAppId(botId) -> configured map` with `resolveAppId = identity`.)

3. **Hello** declares appIds: a south NCL's `Hello.bot_ids` are the appIds it
   serves. The broker routes inbound `/api/messages/<appId>` to the stream that
   declared that appId.

4. **Outbound** uses `reply.bot_id` (= appId) directly in the federation
   exchange. `federation.ts` drops the `botAppIds` map lookup and treats the
   incoming id as the appId.

### Net change

- **Code**: `inbound-jwt` resolver → identity; `federation` → no map lookup;
  `config.botAppIds` removed.
- **Proto**: comment semantics — `bot_ids` / `bot_id` / path segment are appIds.
  No wire-shape change (still `repeated string` / `string`), so codegen is
  stable; this note + comment edits pin the meaning.
- **Infra (Rpi5)**: delete `NCL_RELAY_BOT_APPIDS` app_setting + the hand-filled
  `bot_app_ids` variable (`d0e4d96e` reverted); bot module endpoint →
  `/api/messages/<appId>`. The core↔bot dependency cycle Rpi5 worried about
  **disappears** because core no longer reads any bot appId.

Result: appId is **never configured**. It is intrinsic to inbound (JWT `aud`),
carried as the routing key (path / Hello / reply), and reused for the outbound
exchange.

## Load-bearing assumption: single owner

This zero-config model assumes **one owner** — the south-edge allowlist is
effectively just kenan. Then no one can attach a stream that declares an appId
they don't control, because attaching at all requires being on the allowlist,
and the allowlist is the trust root (admin-managed, not self-service).

**Multi-owner is future work.** With multiple allowlisted owners, owner A could
declare owner B's appId in `Hello.bot_ids` and hijack B's inbound routing. That
is the *only* scenario that needs a `user(oid) → permitted appIds` entitlement
table. Until then: default to single-owner, zero config.

(South-edge auth itself — verify AAD token + allowlist gate — already shipped in
this PR via `south-auth.ts`; that part is owner-identity, orthogonal to this
appId change.)

## Out of scope (explicitly deferred)

- Self-service onboarding API (`RegisterBot` frame) — dropped per kenan.
- Any persistence resource (file / Table / Cosmos / Key Vault) — dropped.
- Multi-owner entitlement (oid → appIds) — future, only if a second owner is
  added.
