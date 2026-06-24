# Teams Bot Identity: Managed Identity vs Federated Credential

> Status: research / design note. Captures the two outbound-auth paths for
> Bot Framework bots and when each applies. Source of the NCL Teams thread
> (2026-06-21/22, #nanoclaw). Claims marked (unverified) are reasoned from
> Azure docs, not from a live tenant test.

## TL;DR decision rule

- **Bot runtime runs inside Azure compute (App Service / Container App / VM
  with IMDS reachable)** → bind the Azure Bot resource directly to a
  user-assigned managed identity (`msaAppType = UserAssignedMSI`). No secret,
  no federation, no app-registration credential.
- **Bot runtime runs outside Azure (self-hosted host, no `169.254.169.254`
  IMDS)** → must use **App Registration + federated identity credential**
  (workload identity federation). The self-hosted workload presents its own
  OIDC token and exchanges it for an Azure AD token for the bot's app.

Our current NCL/self-built WebApp + Relay design is the **outside-Azure** case,
so it is federation, not direct MSI.

## Path A — Direct UserAssignedMSI binding (Azure-internal)

### What it is
`Microsoft.BotService/botServices` has `properties.msaAppType` ∈
`{ MultiTenant, SingleTenant, UserAssignedMSI }`. With `UserAssignedMSI` the
bot identity *is* a user-assigned managed identity rather than an app
registration + secret.

### Fields on the Bot resource
- `msaAppType = UserAssignedMSI`
- `msaAppId = <MI clientId>`  (used as the MicrosoftAppId)
- `msaAppTenantId = <tenant>`  (single-tenant, required)
- `msaAppMSIResourceId = <full resource id of the MI>`

### Setup (two steps)
1. Attach the user-assigned MI to the compute that runs the bot's **outbound**
   code: App Service / Container App → Identity → User assigned → Add.
   (token is fetched from the local IMDS of that compute — this step is the
   load-bearing one.)
2. Bot app config:
   - `MicrosoftAppType = UserAssignedMSI`
   - `MicrosoftAppId = <MI clientId>`
   - `MicrosoftAppTenantId = <tenant>`
   - **no `MicrosoftAppPassword`**
   SDK `ConfigurationBotFrameworkAuthentication` sees the MSI type and uses
   `ManagedIdentityAppCredentials`.

### How the token is obtained at runtime
On reply, the bot calls Bot Connector (`https://smba.trafficmanager.net/...`)
needing a bearer with audience `https://api.botframework.com`.
- SDK uses `ManagedIdentityCredential` → local IMDS:
  `GET http://169.254.169.254/metadata/identity/oauth2/token
   ?resource=https://api.botframework.com&client_id=<MI clientId>`
  (header `Metadata: true`).
- IMDS returns an access token for the attached MI (no secret, no external
  round-trip).
- SDK uses that bearer to call Connector; Teams validates audience+issuer.

### Hard constraint
Requires IMDS reachable from the outbound code. No Azure compute → no IMDS →
this path is unavailable.

## Path B — App Registration + Federated Identity Credential (self-hosted)

### What federation configures
On **each bot's App Registration**, add a federated identity credential
(workload identity federation) that **replaces the client secret**. It declares
"I trust tokens from external OIDC issuer X". At runtime the self-hosted
workload presents its own OIDC token and exchanges it for the bot app's Azure
AD token. No long-lived key on the bot app.

In our design the trusted issuer is the host's user-assigned managed identity
(the token IMDS issues on the host), exchanged for each bot app's token.

### The 4 fields of a federated credential
- `issuer` — the MI's OIDC issuer URL
- `subject` — the MI principal id / agreed subject
- `audience` — `api://AzureADTokenExchange`
- `name` — label

### Who configures it
Anyone with **write access to that App Registration**: the app **owner**, or a
principal holding **Application Administrator**. Global Admin not required.
Three equivalent routes:
- Portal → App Registration → Certificates & secrets → Federated credentials
- `az ad app federated-credential create --id <appId> --parameters ...`
- Graph `POST /applications/{id}/federatedIdentityCredentials`

### Per-bot service principal — required
Each Teams bot needs its **own App Registration / service principal**, because
`MicrosoftAppId` must be unique (Bot Framework channel registration enforces
it). So:
- N bots = N app registrations = N service principals = N federated
  credentials.
- They **may all trust the same host MI** (same issuer/subject), each attached
  to its own app.

### Caveats (don't get fooled by "configure once")
- Federated credential is **per-app**. Adding a new bot requires adding a new
  credential on its app; nothing is inherited.
- Per-app federated credential cap is ~20 (unverified exact number); one bot =
  one credential is well within it.
- If a bot instead uses Path A (direct MSI, single-tenant), it does NOT use the
  app-registration + federated route at all. But multi-tenant Teams
  distribution generally still goes Path B.

## Side-by-side

| Aspect | Path A: UserAssignedMSI | Path B: AppReg + Federation |
| --- | --- | --- |
| Runtime location | Inside Azure (IMDS) | Anywhere (self-hosted ok) |
| Identity object | User-assigned MI | App registration / SP per bot |
| Secret stored | None | None (federated, not secret) |
| Token source | Local IMDS | OIDC token exchange to AAD |
| Per-bot setup | Bot resource fields | Per-app federated credential |
| MicrosoftAppType | UserAssignedMSI | MultiTenant / SingleTenant |
| Our NCL case | no (not in Azure) | **yes** |

## Open items to verify against a live tenant (unverified)
- Exact per-app federated credential limit.
- Whether the host MI's OIDC issuer URL is directly usable as `issuer` or needs
  an intermediate (the MI must expose a federation-compatible issuer; classic
  user-assigned MI issuance may need a token-exchange shim).
- Whether multi-tenant bots can share one app registration across tenants vs
  one per tenant (channel registration uniqueness interaction).
