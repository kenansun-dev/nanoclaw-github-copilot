# NCL Teams — App Service **Relay** Infra (ARM + az CLI)

Core-only buildout as an ARM template, deployed with `az deployment group create`
— no Terraform install needed. Implements the design in
[`docs/2026-06-26-teams-appservice-relay-design.md`](../../docs/2026-06-26-teams-appservice-relay-design.md).

## What it provisions (core-only)

- App Service plan + Linux Web App (Node 22, Always On, **HTTP/2 for gRPC**)
- A **shared user-assigned MSI** — the single outbound trust anchor
- Log Analytics workspace + a diagnostic setting wiring App Service logs into it
  (so `relay_audit` JSON is KQL-queryable, not just on the file_system log)

Bot identity (App Registration + Azure Bot + FIC against the shared MSI) is
**not** here — NCL CLI onboards it, consuming the `msiPrincipalId` /
`msiClientId` / `appServiceHostname` outputs. Adding a bot = a CLI step.

## One-time setup (owner)

```bash
az login                                   # or: az login --use-device-code
cp azuredeploy.parameters.example.json azuredeploy.parameters.json
# edit: appServiceName (globally unique), tenantId, region via the RG
```

## Deploy

```bash
./deploy.sh            # validate, what-if, then ask "yes" before create
./deploy.sh plan       # validate + what-if only
```

Or by hand:

```bash
az group create -n ncl-teams-rg -l southeastasia
az deployment group create \
  -g ncl-teams-rg \
  --template-file azuredeploy.json \
  --parameters @azuredeploy.parameters.json
```

## Outputs

`appServiceHostname`, `appServiceName`, `msiPrincipalId`, `msiClientId`,
`logAnalyticsWorkspaceId` — feed `msiPrincipalId`/`msiClientId`/`appServiceHostname`
into NCL CLI bot onboarding; `appServiceName` is the zip/GH-Actions deploy target.

## Notes

- SKU `B1` to start; `P1v3` for scale-out (same MSI, identity unaffected).
- Set `restrictToBotConnector: true` to hard-limit inbound to the
  `AzureBotService` service tag.
- Region comes from the resource group (`resourceGroup().location`).
