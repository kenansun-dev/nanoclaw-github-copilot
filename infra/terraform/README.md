# NCL Teams — App Service **Relay** Infra (Terraform)

Greenfield IaC for the Teams **relay** hosting topology. Implements the design
in [`docs/2026-06-26-teams-appservice-relay-design.md`](../../docs/2026-06-26-teams-appservice-relay-design.md).
The App Service runs a **thin relay** (inbound Teams JWT termination + per-bot
inbound buffer + gRPC south-edge server + outbound MSI federation); **NCL runs
on the owner's local machine and dials in over gRPC** — it is NOT hosted here.

## What it provisions

- **`modules/core`** (one-time, shared): App Service plan + Linux Web App
  (Node 22, Always On, **HTTP/2 for gRPC**) hosting the relay, a **shared
  user-assigned MSI** (the single outbound trust anchor), and Log Analytics.
- **`modules/bot`** (per-bot, `for_each`): per-bot App Registration + **one
  federated identity credential** (subject = the shared MSI), Azure Bot
  resource, and the Teams channel. Adding a bot = one entry in `var.bots`.

No long-lived bot secrets: each bot's outbound token is minted at runtime by
the relay's MSI presenting its IMDS token and exchanging it via the per-bot FIC
(design §6).

## One-time setup (owner)

```bash
az login                                   # or: az login --use-device-code
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars: subscription_id, tenant_id, location,
#   app_service_name (globally unique), bots = { prod = {} }
```

## Deploy (one command, plan-first)

```bash
./deploy.sh            # init + plan, then asks "yes" before apply
./deploy.sh plan       # plan only, no apply
./deploy.sh destroy    # plan-destroy, then asks before destroying
```

`deploy.sh` never touches Azure without an explicit `yes`. The first run is
expected to be done by the owner under `az login`; once verified, the same
config can run from automation with `./deploy.sh -auto`.

## After `apply`

1. Deploy the **relay service** code to the App Service (`app_service_name`
   output) via zip / GH Actions — the relay terminates inbound Teams JWT, holds
   the per-bot inbound buffer, runs the gRPC south-edge server, and does the
   outbound MSI→federation exchange. NCL itself runs on the owner's machine and
   dials in (design `2026-06-26-teams-appservice-relay-design.md`).
2. Each bot's `app_id` + `messaging_endpoint` are in `terraform output bots`
   (the endpoint points at the relay, not NCL).
3. Smoke: send a Teams message, confirm a reply (validates inbound JWT → relay
   buffer/forward → NCL over gRPC → outbound IMDS→FIC→Bot Connector).

## Notes

- **SKU**: `B1` to start (no autoscale); bump to `P1v3` for rules-based
  scale-out. Scale-out keeps the same MSI, so identity is unaffected (§6).
- **20-FIC cap**: we use exactly one FIC per app, so the per-app/identity cap
  of 20 is never approached. Do **not** stack FICs on one app (§6).
- **Provider versions** are pinned in `.terraform.lock.hcl` (azurerm 4.x,
  azuread 3.x). Commit the lock file; `terraform init` reuses it.
- State is **local by default**. For shared/remote state, add a `backend.tf`
  with an `azurerm` backend and re-run `terraform init`.
