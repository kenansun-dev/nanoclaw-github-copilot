#!/usr/bin/env bash
# NCL Teams App Service — one-command deploy wrapper.
#
# Owner runs this. It is plan-FIRST: it shows `terraform plan` and waits for an
# explicit "yes" before touching Azure. Nothing is created without confirmation.
#
# Prereqs (owner machine, first run):
#   1. az login            (or `az login --use-device-code`)
#   2. terraform >= 1.6 on PATH
#   3. cp terraform.tfvars.example terraform.tfvars  &&  fill in values
#
# Usage:
#   ./deploy.sh                 # init + plan + (confirm) apply
#   ./deploy.sh plan            # init + plan only, no apply
#   ./deploy.sh destroy         # plan-destroy + (confirm) destroy
#   ./deploy.sh -auto           # skip the interactive confirm (CI/automation)

set -euo pipefail
cd "$(dirname "$0")"

ACTION="apply"
AUTO=0
for arg in "$@"; do
  case "$arg" in
    plan)    ACTION="plan" ;;
    apply)   ACTION="apply" ;;
    destroy) ACTION="destroy" ;;
    -auto|--auto) AUTO=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if ! command -v terraform >/dev/null 2>&1; then
  echo "ERROR: terraform not on PATH (need >= 1.6)." >&2
  exit 1
fi
if [ ! -f terraform.tfvars ]; then
  echo "ERROR: terraform.tfvars missing. Run:" >&2
  echo "       cp terraform.tfvars.example terraform.tfvars  && edit it" >&2
  exit 1
fi
if ! az account show >/dev/null 2>&1; then
  echo "ERROR: not logged in to Azure. Run: az login" >&2
  exit 1
fi

echo "==> terraform init"
terraform init -input=false

confirm() {
  [ "$AUTO" -eq 1 ] && return 0
  printf '\n%s ' "$1"
  read -r reply
  [ "$reply" = "yes" ]
}

case "$ACTION" in
  plan)
    terraform plan -input=false
    ;;
  apply)
    terraform plan -input=false -out=tfplan
    if confirm "Apply this plan? Type 'yes' to create/modify Azure resources:"; then
      terraform apply -input=false tfplan
      echo
      echo "==> Outputs:"
      terraform output
    else
      echo "Aborted — no changes applied."
      rm -f tfplan
    fi
    ;;
  destroy)
    terraform plan -destroy -input=false
    if confirm "DESTROY all the above resources? Type 'yes' to confirm:"; then
      terraform destroy -input=false -auto-approve
    else
      echo "Aborted — nothing destroyed."
    fi
    ;;
esac
