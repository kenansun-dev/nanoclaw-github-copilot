# --- root module: NCL Teams App Service infra -----------------------------
# Core-only: App Service + shared MSI + Log Analytics. Per-bot identity
# (App Registration / Bot Service / FIC) is NOT created here — it is onboarded
# by NCL CLI against this App Service's MSI principal + hostname outputs.
# The only seam: buildout exports msi_principal_id/msi_client_id + hostname.

terraform {
  required_version = ">= 1.6"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 3.110, < 5.0"
    }
  }

  # Remote state is opt-in: uncomment + fill backend.tf to use an azurerm
  # backend. Default is local state (fine for a single operator bootstrap).
}

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
  tenant_id       = var.tenant_id
}

# Optionally create the resource group (set create_resource_group=false to use
# an existing one).
resource "azurerm_resource_group" "this" {
  count    = var.create_resource_group ? 1 : 0
  name     = var.resource_group_name
  location = var.location
  tags     = var.tags
}

locals {
  resource_group_name = var.create_resource_group ? azurerm_resource_group.this[0].name : var.resource_group_name
}

module "core" {
  source = "./modules/core"

  name_prefix               = var.name_prefix
  resource_group_name       = local.resource_group_name
  location                  = var.location
  tenant_id                 = var.tenant_id
  app_service_name          = var.app_service_name
  app_service_sku           = var.app_service_sku
  always_on                 = var.always_on
  webhook_port              = var.webhook_port
  grpc_port                 = var.grpc_port
  south_edge_allowlist      = var.south_edge_allowlist
  restrict_to_bot_connector = var.restrict_to_bot_connector
  extra_app_settings        = var.extra_app_settings
  tags                      = var.tags
}
