> ⚠️ **SUPERSEDED 2026-06-26 by `2026-06-26-teams-appservice-relay-design.md`.**
> This doc converged on the WRONG topology — it places NCL *inside* App Service.
> The owner-confirmed design is the opposite: **App Service is a thin RELAY**;
> **NCL runs on the owner's local machine and dials out** (gRPC). The original
> intent was in `teams-bot-identity-federation.md` ("NCL + Relay, NCL is the
> *outside-Azure* case"); the §9 "no separate relay exists" conclusion below is
> the specific error. Kept for history. **Do not implement from this file.**
> The MSI + per-bot federation parts (§2/§3/§6) remain correct and carry over.

# NCL Teams — App Service Service & Infra Design

> Status: design proposal for review (VM author, 2026-06-22). Builds on
> `teams-bot-identity-federation.md`. This pins the **hosting topology**:
> outbound bot code runs inside an Azure **App Service** that carries a shared
> user-assigned MSI; each Teams bot is its own App Registration whose
> federated credential trusts that one MSI. Claims marked **(unverified)** are
> reasoned from Azure docs, not from a live tenant test.

## 0. Decision recap (why App Service + MSI + per-bot federation)

From the identity thread we converged on a **hybrid of Path A/B**:

- Bot **outbound code runs inside Azure** (App Service → IMDS reachable), so we
  get a managed identity for free — no secret to store.
- But Bot Framework forces **one appId per bot** (channel registration
  uniqueness), and Teams distribution is multi-tenant, so we still need a
  **per-bot App Registration (SP)**.
- Federation bridges them: each per-bot SP carries **one federated identity
  credential whose subject is the shared App Service MSI**. The MSI presents
  its IMDS token, exchanges it for each bot app's token. Zero long-lived keys.

One-time vs per-bot boundary:
- **One-time:** App Service built+deployed, MSI attached, Relay wired.
- **Per-bot:** new App Registration + 1 FIC (subject = the shared MSI oid) +
  Azure Bot resource + Teams channel.

## 1. Service topology

```
                Teams client
                     │  (user message)
                     ▼
        Azure Bot Service (per-bot resource)
        msaAppId = <per-bot appId>
                     │  POST messaging endpoint (HTTPS, public)
                     ▼
   ┌─────────────────────────────────────────────┐
   │  App Service (Linux, single plan)            │
   │  • System/User-assigned MSI attached          │
   │  • Hosts NCL "Relay/adapter" web process       │
   │  • Inbound: BotFramework adapter validates JWT │
   │  • Outbound: per-bot token via MSI→SP federation│
   └─────────────────────────────────────────────┘
                     │  (outbound reply)
                     │  1. IMDS: MSI token aud=api://AzureADTokenExchange
                     │  2. exchange → per-bot app token aud=api://botframework
                     ▼
        Bot Connector (smba.trafficmanager.net)
                     │
                     ▼
                Teams channel
```

Key property: **one App Service hosts all bots' outbound code**; the MSI is the
single trust anchor; per-bot identity is selected at runtime by which appId the
code requests a token for.

## 2. Components & sizing

| Component | Choice | Notes |
| --- | --- | --- |
| Compute | App Service, Linux, **Node 22** | matches NCL runtime |
| Plan | **B1 to start**, scale to P1v3 | B-tier ok for low bot count; see scale caveat |
| Identity | **User-assigned MSI** (1, shared) | reusable, survives App Service rebuild |
| Inbound auth | BotFramework JWT validation | adapter checks issuer+audience |
| Outbound auth | MSI → per-bot SP federation | §3 |
| Per-bot SP | 1 App Registration each | FIC subject = shared MSI oid |
| Bot resource | 1 `Microsoft.BotService` each | `msaAppType=MultiTenant`, msaAppId=bot appId |
| Secrets store | **none for bot auth**; Key Vault only if other secrets | federation removes bot secret |
| Networking | public HTTPS inbound (Bot Connector reaches it) | §4 |
| Logs | App Service diagnostic logs → Log Analytics | per-bot correlation by appId |

User-assigned (not system-assigned) MSI on purpose: it must **outlive App
Service redeploys** and be referenceable as a stable `subject` across N per-bot
FICs. A system-assigned identity dies with the resource and would invalidate
every FIC.

## 3. Identity wiring (the load-bearing part)

### One-time
```bash
# shared MSI
az identity create -g <rg> -n ncl-bot-msi
MSI_OID=$(az identity show -g <rg> -n ncl-bot-msi --query principalId -o tsv)
MSI_CID=$(az identity show -g <rg> -n ncl-bot-msi --query clientId   -o tsv)
TENANT=$(az account show --query tenantId -o tsv)

# attach to App Service
az webapp identity assign -g <rg> -n <appservice> \
  --identities $(az identity show -g <rg> -n ncl-bot-msi --query id -o tsv)
```

### Per-bot (repeat per Teams bot)
```bash
# 1. new app registration (the bot SP)
APP_ID=$(az ad app create --display-name "ncl-teams-bot-<name>" --query appId -o tsv)

# 2. FIC trusting the shared MSI
cat > fic.json <<EOF
{ "name": "msi-fed",
  "issuer": "https://login.microsoftonline.com/${TENANT}/v2.0",
  "subject": "${MSI_OID}",
  "audiences": ["api://AzureADTokenExchange"] }
EOF
az ad app federated-credential create --id $APP_ID --parameters @fic.json

# 3. Azure Bot resource + Teams channel
az bot create -g <rg> -n ncl-bot-<name> --app-type MultiTenant \
  --appid $APP_ID --endpoint "https://<appservice>.azurewebsites.net/api/messages/<name>"
az bot msteams create -g <rg> -n ncl-bot-<name>
```

Runtime (in App Service code), per outbound reply for bot `<name>`:
1. IMDS → MSI token, `resource=api://AzureADTokenExchange`, `client_id=$MSI_CID`.
2. POST that JWT as `client_assertion` to
   `https://login.microsoftonline.com/{TENANT}/oauth2/v2.0/token` with the
   **full confidential-client federated set** (rpi5 review: the two grant
   params are required, not implied):
   - `grant_type=client_credentials`
   - `client_id=<that bot's appId>`
   - `scope=https://api.botframework.com/.default`
   - `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`
   - `client_assertion=<the MSI IMDS token from step 1>`
   Omitting `grant_type` or `client_assertion_type` → `invalid_request` /
   `unsupported_grant_type`.
3. Use returned token as bearer to Bot Connector.

**RESOLVED (rpi5 review 2026-06-22):** "Managed identity as a federated
identity credential" went **GA 2025-05-08** (single- and multi-tenant), so it
is no longer preview-gated. The assertion works **provided step 1 pulls the
IMDS token with `resource=api://AzureADTokenExchange`** (NOT the plain
`aud=management` token) — which §3 step 1 already does. `subject` = the MSI's
**principalId (object id)** is correct (Learn: subject must match the token
`sub` claim; for a MI that is its principal id). So this is no longer the
highest-risk item — it's sound. Source: devblogs.microsoft.com/identity
/access-cloud-resources-across-tenants-without-secrets-ga.

**Hard constraint surfaced by review — 20-FIC cap is real, not a footnote.**
Max **20 federated credentials per app/UAMI** (confirmed in the same Learn
doc). Our "one FIC per bot, all trusting the shared MSI" puts N FICs on N
separate apps (1 each — fine), BUT if we ever invert to "one app, many FICs"
or stack FICs on the MSI side, **bot #21 hits a wall**. Mitigation must be
first-class (see §6): either keep strictly one-FIC-per-app (safe), or for
>20 bots move to a **shared-subject / multi-app** layout. This is a design
constraint, not a caveat.

## 4. Networking & inbound

- Bot Connector calls the messaging endpoint from Microsoft's cloud → endpoint
  **must be publicly reachable HTTPS**. App Service default
  `*.azurewebsites.net` TLS satisfies this with no extra cert.
- Inbound is authenticated by the **BotFramework JWT** on each request (adapter
  validates issuer = Bot Connector, audience = that bot's appId). So "public"
  ≠ "open": unauthenticated POSTs are rejected by the adapter.
- If we later want network isolation, options: App Service **access
  restrictions** allowing only Bot Connector service tag, or Private Endpoint +
  a public ingress shim. Not needed for v1.
- **Multi-bot routing — RESOLVED (rpi5 line-review 2026-06-22).** The current
  adapter is **one listener, one fixed `/api/messages`, one appId per process**
  (`teams.ts:280`, `:98`). Today's multi-bot story is **N `TeamsChannel`
  instances each on its own `webhookPort`** (`:1207`) — an N-ports model that
  **does not map onto App Service**, which hands the process a single `PORT`.
  So the v1 decision is **(a) one App Service per bot**: existing per-account
  env runs **literally unchanged** (one bot, one port, one appId). No per-bot
  path, no surgery.
  - When bot count makes N plans expensive, migrate to **(b) one App Service,
    N bots**: demux on **`activity.recipient.id`** (the addressed bot's
    `28:<appId>`), which the listener already `JSON.parse`s at `:289` *before*
    the adapter — so the right credential set is picked pre-auth on a single
    `/api/messages` path. **Do NOT** route by per-bot URL path or by parsing
    the unvalidated JWT `aud`. `recipient.id` is already the dispatch key used
    at `:467/:487`.
  - This **dissolves the old §4 "per-bot path" question entirely** — closed.

## 5. Isolation boundary (explicit risk)

All bots share **one MSI on one App Service**, so:
- Any process on that App Service can request a token for **any** of the per-bot
  appIds it has FICs for. There is **no host-level identity isolation between
  bots** on the same plan.
- Acceptable when all bots are first-party / same trust domain (our case).
- If a bot must be strongly isolated (different customer, blast-radius concern),
  it needs its **own App Service + own MSI**, not co-tenancy. Design supports
  this by treating "App Service + MSI" as a unit you can replicate.

## 6. Scale caveats

- **B-tier App Service has no autoscale**; bursty Teams traffic may need P-tier
  for rules-based scale-out. Multiple instances all share the same MSI, so
  scale-out does **not** break identity. Start B1, watch CPU/queue.
- Per-app/UAMI **FIC cap = 20 (CONFIRMED, rpi5 review)**. Our default layout
  (1 app per bot, 1 FIC each) never hits it. The wall appears only if FICs are
  stacked on a single app/identity. **Rule: >20 bots ⇒ do NOT consolidate FICs;
  keep one-app-one-FIC, or split across multiple shared-MSI groups.**
- Cold start: keep "Always On" enabled so Bot Connector doesn't hit a sleeping
  instance and time out the first message.

## 7. IaC shape — Terraform (DECIDED 2026-06-22)

**Decision: Terraform, not Bicep.** rpi5's rule was conditional on existing
house standard; I grepped the NCL repo — **there is zero existing IaC** (no
`*.bicep`, no `*.tf`, no compose; only `container/Dockerfile*` + GH Actions CI,
dev runs via devtunnel). So this is **greenfield** → Terraform wins: the Entra
objects we need are first-class, no ARM/Graph seam:
- `azuread_application` — the per-bot app registration
- `azuread_application_federated_identity_credential` — the FIC, native
- `azurerm_user_assigned_identity`, `azurerm_service_plan`,
  `azurerm_linux_web_app` — the one-time core
- `azurerm_bot_service_azure_bot` + `azurerm_bot_channel_ms_teams` — per bot

One `plan`/`state`, no Bicep-can't-build-Graph-objects workaround. Module split:
- `modules/core` (one-time): plan + web app (Always On + UAMI) + Log Analytics.
- `modules/bot` (per-bot, `for_each` over a bot map): app + FIC + bot + teams
  channel. Adding a bot = one entry in the bot map, `terraform apply`.

(If NCL later adopts Bicep as house standard for other reasons, the fallback is
Bicep for ARM + thin `az ad app federated-credential create` glue — but with no
incumbent, that seam is pure downside.)

## 8. Provisioning runbook (end state)

1. `terraform apply -target=module.core` → App Service plan + web app + MSI
   live (§7 decided Terraform, not Bicep).
2. Deploy NCL code to App Service (zip deploy / GH Actions).
3. Per bot: run the §3 per-bot script (app create → FIC → bot create → teams).
4. Smoke: send a Teams message, confirm reply (validates IMDS→FIC→Connector).

## 9. Open items for rpi5 review
- [x] ~~MI-as-FIC: is the IMDS token directly a valid `client_assertion`?~~ →
      **RESOLVED** (GA'd, sound; §3).
- [x] ~~Bicep vs Terraform~~ → **Terraform** (greenfield, no incumbent IaC; §7).
- [x] ~~Per-bot path vs single endpoint + appId routing~~ → **v1 = one App
      Service per bot** (existing per-account env, zero code change). Future
      multi-bot-single-App-Service demuxes on `activity.recipient.id`, not
      path/JWT (§4, rpi5 review).
- [ ] Same-tenant only (cross-tenant fallback lives in the identity note).
- [ ] B1 vs P1v3 starting tier; Always On confirmed.
- [x] ~~Relay folding~~ → **No separate relay exists.** rpi5 source check:
      `src/channels/teams.ts:396` does its own `this.server.listen(...)` with
      `/api/messages` + health; `src/webhook-server.ts` is a lazy in-proc HTTP
      router. The only "relay" today is the **dev devtunnel ingress**. App
      Service's public hostname simply *replaces the devtunnel* — the Azure Bot
      messaging endpoint points straight at the in-process listener. "Fold
      relay into App Service" is the natural shape, not a refactor. Action:
      App Service runs the existing in-proc listener as-is; only the public
      ingress (devtunnel → `*.azurewebsites.net`) changes.

## 10. Review status
- rpi5 reviewed 2026-06-22 (against channel msg + NCL repo source + Azure docs).
- Point 1 (MI-as-FIC): de-risked, GA'd, sound (§3).
- Point 2 (IaC): closed → Terraform, greenfield confirmed (§7).
- Point 3 (relay): closed → no separate relay, ingress swap only (§9).
- Remaining hard constraint to honor in IaC: **20-FIC cap** (§6).
