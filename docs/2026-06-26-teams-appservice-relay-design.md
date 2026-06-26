# NCL Teams — App Service **Relay** Design (corrected)

> Status: design proposal, 2026-06-26. **Supersedes**
> `2026-06-22-teams-appservice-infra-design.md`, which converged on the WRONG
> topology (NCL hosted *inside* App Service). This version restores the
> original intent from `teams-bot-identity-federation.md` ("NCL/self-built
> WebApp + **Relay**, NCL is the *outside-Azure* case"): **App Service is a
> thin relay/broker; NCL runs on the owner's local machine and dials out.**
>
> Owner-confirmed model (2026-06-26 #nanoclaw thread). Claims marked
> **(unverified)** are reasoned from Azure docs, not a live tenant test.

## 0. What changed vs the 2026-06-22 doc (read this first)

| | 2026-06-22 (wrong) | This doc (correct) |
| --- | --- | --- |
| Where NCL runs | inside App Service | **owner's local machine** |
| App Service role | hosts NCL's in-proc listener | **thin relay**: inbound auth termination + outbound federation + broker to NCL |
| NCL ↔ Azure link | n/a (same process) | **NCL dials OUT to relay over gRPC** |
| Replaces | devtunnel by hosting NCL | **devtunnel** by being the fixed public ingress; NCL stays home |
| `resolveTeamsPort` | needed | **deleted** (NCL never binds App Service's PORT) |

The 2026-06-22 §9 "no separate relay exists → App Service runs the in-proc
listener" conclusion was the specific error. There **is** a separate relay —
that's the whole point.

## 1. Topology

```
   Teams client
        │ user message
        ▼
   Azure Bot Service (per-bot resource, msaAppId = per-bot appId)
        │ HTTPS POST  →  per-bot messaging endpoint
        ▼
 ┌──────────────────────────────────────────────────────────────┐
 │  App Service (Linux, Node)  —  THE RELAY                       │
 │                                                                │
 │  Inbound terminus:  POST /api/messages/<bot>                   │
 │    • validate BotFramework JWT (issuer=Bot Connector,          │
 │      audience = that bot's appId)  ← auth termination          │
 │    • look up the gRPC stream for <bot>                         │
 │        – stream connected  → forward activity down             │
 │        – not connected     → buffer (TTL), drop on expiry,     │
 │                              audit-log the miss                │
 │                                                                │
 │  gRPC server (HTTP/2):  NCL dials IN and holds a bidi stream   │
 │    • per-call AAD-token auth (metadata interceptor) + allowlist│
 │                                                                │
 │  Outbound to Teams:  MSI → per-bot federated token →           │
 │    Bot Connector (smba.trafficmanager.net)                     │
 └──────────────────────────────────────────────────────────────┘
        ▲  gRPC bidi stream (NCL-initiated, outbound from home)
        │  metadata: AAD token (owner identity), checked vs allowlist
        ▼
   Local NCL (owner's machine, NO public ingress)
     • teams channel in "relay jump" mode: dials the relay,
       registers which bot(s) it serves, receives activities,
       sends replies back up the same stream
```

Two independent edges meet **only** at the relay:
- **North edge** — Teams Bot Service → relay `/api/messages/<bot>` (inbound).
- **South edge** — local NCL → relay gRPC (NCL-initiated, outbound).

## 2. Decoupling model (owner-specified, load-bearing)

The two edges are **time-decoupled**. The relay does not require both sides up.

- **Inbound arrives, matching NCL stream connected** → forward immediately.
- **Inbound arrives, no matching NCL stream** → **buffer with a TTL**; on
  expiry **drop + audit-log** the miss. (Bounded per-bot queue; see §6 for
  caps.) Never block the Bot Connector response on NCL presence — ack the
  webhook, queue, move on.
- **NCL connects but Teams is broken/misconfigured** → harmless; the stream
  just sits idle, no e2e traffic. NCL presence ≠ Teams health.
- Therefore the relay is a **per-bot broker + short-lived inbound buffer**, NOT
  a synchronous proxy. A bot is "live e2e" only when *both* edges are up; each
  edge's health is independent and separately observable.

This is the key difference from a tunnel: devtunnel is a dumb pipe that needs
both ends simultaneously; the relay is a stateful broker that tolerates either
side being down and degrades to "no e2e" instead of "error".

## 3. Transport: gRPC (decided 2026-06-26)

**gRPC over WS — decided gRPC.** Owner's instinct (raw WS is more work than it
looks) confirmed.

- Azure App Service **Linux natively supports gRPC bidirectional streaming over
  HTTP/2**, GA 2023-11. Config: HTTP version 2.0, enable the HTTP 2.0 proxy
  ("gRPC only"), app setting `HTTP20_ONLY_PORT=<port>`. gRPC must be over HTTPS.
  **Client certs are NOT supported with HTTP/2 on App Service — and we don't
  need them**, auth is an AAD token in gRPC metadata, not transport cert. The
  one documented caveat doesn't bite us.
- Why gRPC beats hand-rolled WS here:
  - **Typed contract** (`.proto`) — both sides compile the same messages; no
    ad-hoc JSON framing/versioning.
  - **Native bidi streaming** — NCL opens one long-lived stream; relay pushes
    inbound activities down, NCL pushes replies up, full-duplex.
  - **Metadata interceptor** = clean auth seam (AAD token + allowlist), §5.
  - Library handles framing / keepalive / reconnect / backpressure — the exact
    surface that makes raw WS bug-prone.

### `.proto` contract
Drafted by Rpi5 (he owns the NCL gRPC client + first push). Server (relay)
implements against it. Shape (to be pinned in the proto, listed here so the
doc and proto stay in sync):
- A `TeamsRelay` service with a **bidirectional stream** RPC, e.g.
  `rpc Attach(stream FromNcl) returns (stream ToNcl)`.
- `FromNcl`: a registration/hello (which bot ids this NCL serves) + outbound
  replies (activity payloads) + acks.
- `ToNcl`: inbound activities (the validated Teams activity) + control
  (heartbeat, buffer-overflow notice, server shutdown drain).
- Auth rides in **call metadata** (AAD token), validated by a server
  interceptor before the stream is accepted (§5).

> This section is descriptive; the proto file Rpi5 pushes is the source of
> truth. Update this list if the proto diverges.

## 4. Inbound: per-bot endpoint + auth termination

- Each bot has its own messaging endpoint on the relay:
  `https://<relay>.azurewebsites.net/api/messages/<bot>`. The Azure Bot
  resource's endpoint points here (not at NCL).
- The relay **terminates inbound auth**: validates the BotFramework JWT
  (issuer = Bot Connector, audience = that bot's appId) on every POST. Invalid
  → 401, never reaches the buffer or NCL.
- After auth, the relay maps `<bot>` → its per-bot stream/queue. Routing key is
  the URL `<bot>` segment (and can be cross-checked against
  `activity.recipient.id` = `28:<appId>`). One relay, N bots, N endpoints.

## 5. South-edge auth: owner AAD account + allowlist

The NCL↔relay link is authenticated by the **owner's own AAD identity**, not a
bot credential:

- NCL presents an **AAD token** (the owner's identity) in gRPC call metadata
  when it dials in.
- The relay's gRPC **interceptor validates** the token (issuer = the tenant,
  audience = the relay's own app id / api scope) and checks the caller's
  object id / UPN against a **pre-configured allowlist**. Not on the allowlist
  → stream rejected before any activity flows.
- **Open item for owner (does NOT block proto/doc):** how NCL acquires that
  AAD token —
  - (a) **device-code / cached interactive** — owner signs in once on the NCL
    machine, token cached + refreshed. Simplest, ties to a human identity.
  - (b) **a dedicated SP / app** NCL authenticates as, allowlisted by its
    appId. More "service" shaped, no human in the loop.
  Owner leans on which? §8 tracks this.

## 6. Outbound: MSI → per-bot federation (unchanged, this part was right)

This is the one piece the 2026-06-22 doc got right and we keep:
- The relay's App Service carries a **shared user-assigned MSI**.
- Each bot is its **own App Registration** with **one federated identity
  credential** whose subject is the shared MSI (`api://AzureADTokenExchange`).
- On outbound reply for bot `<name>`: relay pulls an IMDS token for the MSI
  (`resource=api://AzureADTokenExchange`), exchanges it (confidential-client
  federated set: `grant_type=client_credentials`, `client_id=<bot appId>`,
  `scope=https://api.botframework.com/.default`,
  `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`,
  `client_assertion=<IMDS token>`) for that bot's token, calls Bot Connector.
- **Onboard a new bot = declare a new federation**: new App Registration + 1
  FIC (subject = shared MSI) + Azure Bot + Teams channel. One FIC per app keeps
  us under the 20-FIC-per-app cap (no stacking).

## 7. What this means for the existing PR #64 code

- **Keep (was always relay-layer infra, direction was fine):** shared MSI,
  per-bot App Registration + FIC, Azure Bot + Teams channel, Log Analytics.
- **Rework:** the App Service plan + web app stay as *resources*, but their
  semantics flip from "host NCL" to "host the relay service". App settings drop
  `WEBSITES_PORT/listen_port` (NCL-listener pointers) and gain relay config +
  `HTTP20_ONLY_PORT` for gRPC.
- **Delete:** `resolveTeamsPort` and the "NCL listener binds App Service PORT"
  assumption — NCL is not in App Service.
- **New (not in #64):** the relay application itself (inbound JWT validation +
  per-bot buffer + gRPC server + outbound federation); NCL-side "teams channel
  via relay jump" mode (gRPC client dialing out + AAD-token auth); the `.proto`.

## 8. Open items
- [ ] **South-edge AAD token acquisition** (§5): device-code/cached vs
      dedicated SP — owner to pick. Does not block proto/doc.
- [ ] gRPC keepalive / reconnect tuning + buffer TTL + per-bot queue cap (§2).
- [ ] Relay process model: one gRPC server + one HTTP listener in the same Node
      app (App Service gives one `HTTP20_ONLY_PORT` for gRPC + the normal HTTPS
      port for `/api/messages`) — confirm both can coexist on App Service
      **(unverified)**.
- [ ] Buffer durability: in-memory (lost on relay restart) vs backed — v1
      in-memory + audit is acceptable per owner (drop-on-expiry already the
      contract).
- [ ] B1 vs P1v3 starting tier; Always On (still applies — relay must be warm).

## 9. Division of labor (2026-06-26)
- **Rpi5:** `.proto` draft (owns it, pushes first) → NCL-side relay-jump mode
  (gRPC client + AAD auth) → revert `resolveTeamsPort` → deploy path.
- **VM:** this doc → relay service (inbound JWT + buffer + gRPC server +
  outbound federation) → Terraform rework (web app: NCL-host → relay-host).
- Shared first: lock the `.proto` (Rpi5 drafts, VM reviews) before server/client
  implementation diverge.
