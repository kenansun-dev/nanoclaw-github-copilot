# NanoClaw Teams Relay

Thin Azure App Service relay between **Teams Bot Service** and a **local
NanoClaw host**. Single Node process, two listeners. NCL is NOT hosted here —
it runs on the owner's machine and dials in over gRPC.

Design: [`docs/2026-06-26-teams-appservice-relay-design.md`](../docs/2026-06-26-teams-appservice-relay-design.md).
Wire contract: [`proto/teams_relay.proto`](../proto/teams_relay.proto).

## Process shape

```
 Teams ──HTTP/1.1──▶ north edge  (WEBSITES_PORT)   /api/messages/<bot>
                       │ validate BotFramework JWT (auth termination)
                       ▼
                     broker core  (per-bot route + buffer + TTL + drop + audit)
                       ▲
 NCL  ──gRPC/HTTP2──▶ gRPC server (HTTP20_ONLY_PORT)  Attach bidi stream
                       │ AAD metadata interceptor + allowlist
                       ▼
                     south edge   (MSI IMDS token → Bot Connector POST)
```

## Subsystems & ownership (2026-06-26)

| # | Component | Owner | Status |
| --- | --- | --- | --- |
| 1 | app skeleton + dual-listener bootstrap + config | VM | **done** (this commit) |
| 2 | north edge: `/api/messages/<bot>` + BotFramework JWT termination | VM | listener done; JWT validation TODO |
| 3 | gRPC server: `Attach` stream + AAD interceptor + allowlist | Rpi5 | TODO |
| 4 | broker core: route + buffer + TTL + drop + audit | Rpi5 | TODO |
| 5 | south edge: MSI IMDS token + Bot Connector POST | VM | TODO (per-bot federation exchange stubbed → next task) |
| 6 | ts-proto codegen (shared with NCL client) | Rpi5 | TODO |

The three subsystems meet only at [`src/contract.ts`](src/contract.ts):
`InboundSink.enqueueInbound` (north → broker) and
`OutboundSender.deliverOutbound` (gRPC → south).

## Config (env, injected by the App Service IaC)

| Env | Default | Meaning |
| --- | --- | --- |
| `WEBSITES_PORT` | 3978 | HTTP/1.1 north-edge webhook port |
| `HTTP20_ONLY_PORT` | 8585 | HTTP/2 gRPC south-edge port |
| `NCL_RELAY_ALLOWLIST` | (empty) | comma list of AAD object-ids/appIds allowed on the gRPC south edge |
| `NCL_BOT_MSI_CLIENT_ID` | — | shared MSI client id for the outbound IMDS pull |
| `AZURE_TENANT_ID` | — | Entra tenant id |

## Run

```bash
npm install
npm run build && npm start    # or: npm run dev (tsc --watch)
npm test                      # vitest
```

Bootstrap defaults are **fail-closed**: the JWT validator rejects all inbound
until #2 lands, and the broker/gRPC/outbound seams are no-op/stub so the process
boots with only the north edge live for independent testing.
