#!/usr/bin/env bash
# NCL Teams relay — one-command deploy of the relay *code* to an existing
# App Service (created earlier by infra/terraform). Plan-free; it only pushes
# code, it does not touch Azure resource definitions.
#
# Two modes:
#   1. Build-and-deploy (run from the repo):
#        ./deploy-app.sh -g <resource-group> -n <app-service-name>
#   2. Deploy a prebuilt zip (no repo/build needed — e.g. zip handed to you):
#        ./deploy-app.sh -g <resource-group> -n <app-service-name> -z <zip>
#
# Prereqs: az CLI logged in (az login), and either Node 22 (mode 1) or just
# the zip (mode 2). The App Service is provisioned by infra/terraform first.
set -euo pipefail
cd "$(dirname "$0")"

RG=""; APP=""; ZIP=""
while [ $# -gt 0 ]; do
  case "$1" in
    -g|--resource-group) RG="$2"; shift 2 ;;
    -n|--name)           APP="$2"; shift 2 ;;
    -z|--zip)            ZIP="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$RG" ] || [ -z "$APP" ]; then
  echo "usage: ./deploy-app.sh -g <resource-group> -n <app-service-name> [-z <prebuilt.zip>]" >&2
  exit 2
fi
if ! command -v az >/dev/null 2>&1; then
  echo "ERROR: az CLI not on PATH." >&2; exit 1
fi
if ! az account show >/dev/null 2>&1; then
  echo "ERROR: not logged in. Run: az login" >&2; exit 1
fi

if [ -z "$ZIP" ]; then
  # Mode 1: build a fresh, portable, prod-only zip here.
  command -v node >/dev/null 2>&1 || { echo "ERROR: node not on PATH (need >=22)." >&2; exit 1; }
  echo "==> build (gen + tsc)"
  npm ci
  npm run build
  echo "==> stage prod-only node_modules"
  STAGE="$(mktemp -d)"
  cp -r dist package.json package-lock.json "$STAGE"/
  ( cd "$STAGE" && npm ci --omit=dev --ignore-scripts )
  ZIP="$(mktemp -d)/ncl-relay.zip"
  ( cd "$STAGE" && zip -rq "$ZIP" dist node_modules package.json )
  echo "==> built zip: $ZIP"
fi

echo "==> deploying $ZIP to App Service '$APP' (rg '$RG')"
# OneDeploy (--type zip) runs its own "wait for site to start" tracker whose
# warmup ping can time out (non-zero exit) even when the app is actually
# serving. Don't trust that exit code; disable the flaky gate and health-probe
# /healthz ourselves as the real success signal.
az webapp deploy \
  --resource-group "$RG" \
  --name "$APP" \
  --src-path "$ZIP" \
  --type zip \
  --track-status false || echo "WARN: az webapp deploy returned non-zero (OneDeploy warmup timer); verifying via /healthz"

echo "==> waiting for https://$APP.azurewebsites.net/healthz to return 200"
healthy=0
for i in $(seq 1 60); do
  code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "https://$APP.azurewebsites.net/healthz" || true)"
  if [ "$code" = "200" ]; then healthy=1; echo "   healthy after $((i*10))s"; break; fi
  sleep 10
done
if [ "$healthy" != "1" ]; then
  echo "ERROR: site did not become healthy within 600s. Pull docker log:" >&2
  echo "  https://$APP.scm.azurewebsites.net/api/logs/docker" >&2
  exit 1
fi

echo "==> done. Verify:"
echo "    az webapp log tail -g $RG -n $APP"
echo "    curl https://$APP.azurewebsites.net/healthz   # expect 200"
