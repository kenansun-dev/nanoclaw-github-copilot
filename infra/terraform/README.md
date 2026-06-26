# NCL Teams — App Service Infra (Terraform)

Greenfield IaC for the Teams App Service hosting topology. Implements the
design in [`docs/2026-06-22-teams-appservice-infra-design.md`](../../docs/2026-06-22-teams-appservice-infra-design.md).

## What it provisions

- **`modules/core`** (one-time, shared): App Service plan + Linux Web App
  (Node 22, Always On), a **shared user-assigned MSI** (the single trust
  anchor), and Log Analytics.
- **`modules/bot`** (per-bot, `for_each`): per-bot App Registration + **one
  federated identity credential** (subject = the shared MSI), Azure Bot
  resource, and the Teams channel. Adding a bot = one entry in `var.bots`.

No long-lived bot secrets: each bot's token is minted at runtime by the MSI
presenting its IMDS token and exchanging it via the per-bot FIC (design §3).

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

1. Deploy NCL code to the App Service (`app_service_name` output) via zip /
   GH Actions — owned by the runtime-adaptation work.
2. Each bot's `app_id` + `messaging_endpoint` are in `terraform output bots`.
3. Smoke: send a Teams message, confirm a reply (validates IMDS → FIC →
   Bot Connector).

## Notes

- **SKU**: `B1` to start (no autoscale); bump to `P1v3` for rules-based
  scale-out. Scale-out keeps the same MSI, so identity is unaffected (§6).
- **20-FIC cap**: we use exactly one FIC per app, so the per-app/identity cap
  of 20 is never approached. Do **not** stack FICs on one app (§6).
- **Provider versions** are pinned in `.terraform.lock.hcl` (azurerm 4.x,
  azuread 3.x). Commit the lock file; `terraform init` reuses it.
- State is **local by default**. For shared/remote state, add a `backend.tf`
  with an `azurerm` backend and re-run `terraform init`.
