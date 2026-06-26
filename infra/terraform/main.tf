# --- root module: NCL Teams App Service infra -----------------------------
# Wires modules/core (one-time shared) + modules/bot (per-bot for_each).
# Adding a bot = one entry in var.bots, then `terraform apply` (design §7/§8).

terraform {
  required_version = ">= 1.6"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 3.110, < 5.0"
    }
    azuread = {
      source  = "hashicorp/azuread"
      version = ">= 2.47, < 4.0"
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

provider "azuread" {
  tenant_id = var.tenant_id
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
  listen_port               = var.listen_port
  restrict_to_bot_connector = var.restrict_to_bot_connector
  extra_app_settings        = var.extra_app_settings
  tags                      = var.tags
}

module "bot" {
  source   = "./modules/bot"
  for_each = var.bots

  bot_name              = each.key
  resource_group_name   = local.resource_group_name
  tenant_id             = var.tenant_id
  msi_principal_id      = module.core.msi_principal_id
  app_service_hostname  = module.core.app_service_default_hostname
  messaging_path_suffix = try(each.value.messaging_path_suffix, "")
  bot_sku               = try(each.value.bot_sku, "F0")
  tags                  = var.tags
}
