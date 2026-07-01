#!/usr/bin/env bash
# NCL Teams App Service — one-command deploy wrapper (ARM + az CLI).
#
# Owner runs this. It is plan-FIRST: it validates the template and shows
# `az deployment group what-if`, then waits for an explicit "yes" before
# creating anything. Nothing is created without confirmation.
#
# Prereqs (owner machine, first run):
#   1. az login            (or: az login --use-device-code)
#   2. cp azuredeploy.parameters.example.json azuredeploy.parameters.json
#      and fill in appServiceName (globally unique), tenantId, etc.
#
# Usage:
#   ./deploy.sh                 # validate + what-if + (confirm) create
#   ./deploy.sh plan            # validate + what-if only, no create
#   ./deploy.sh destroy         # delete the resource group (confirm)
#   ./deploy.sh -auto           # skip the interactive confirm (CI/automation)
#
# Env overrides:
#   RG=ncl-teams-rg LOCATION=southeastasia ./deploy.sh

set -euo pipefail
cd "$(dirname "$0")"

RG="${RG:-ncl-teams-rg}"
LOCATION="${LOCATION:-southeastasia}"
TEMPLATE="azuredeploy.json"
PARAMS="azuredeploy.parameters.json"
DEPLOY_NAME="ncl-teams-relay-$(date +%Y%m%d-%H%M%S)"

MODE="apply"
AUTO=0
for a in "$@"; do
  case "$a" in
    plan) MODE="plan" ;;
    destroy) MODE="destroy" ;;
    -auto|--auto) AUTO=1 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

command -v az >/dev/null || { echo "az CLI not found — install + 'az login' first" >&2; exit 1; }
[ -f "$PARAMS" ] || { echo "missing $PARAMS — cp azuredeploy.parameters.example.json $PARAMS and edit" >&2; exit 1; }

confirm() {
  [ "$AUTO" = 1 ] && return 0
  read -r -p "$1 [yes/N] " ans
  [ "$ans" = "yes" ]
}

if [ "$MODE" = "destroy" ]; then
  echo "Will DELETE resource group: $RG"
  confirm "Destroy everything in $RG?" || { echo "aborted"; exit 0; }
  az group delete -n "$RG" --yes
  exit 0
fi

# Ensure RG exists WITHOUT re-issuing create on an existing one: an
# unconditional `az group create` is treated as a create/update and can trip
# subscription policy (e.g. required Owner tag) even when the RG already
# exists. Only create when missing.
if [ "$(az group exists -n "$RG")" = "true" ]; then
  echo "== resource group $RG exists, reusing (skip create) =="
else
  az group create -n "$RG" -l "$LOCATION" -o none
fi

echo "== what-if (also server-side validates; surfaces real policy/template errors) =="
az deployment group what-if \
  -g "$RG" --template-file "$TEMPLATE" --parameters @"$PARAMS"

[ "$MODE" = "plan" ] && { echo "plan-only, done"; exit 0; }

confirm "Apply this deployment to $RG?" || { echo "aborted"; exit 0; }

echo "== create =="
az deployment group create \
  -n "$DEPLOY_NAME" -g "$RG" \
  --template-file "$TEMPLATE" --parameters @"$PARAMS" \
  --query 'properties.outputs' -o json
