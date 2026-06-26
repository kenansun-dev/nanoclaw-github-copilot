# --- modules/bot: per-Teams-bot resources ---------------------------------
# Instantiated once per bot via for_each in the root module. Each bot is its
# own App Registration (Bot Framework requires one appId per bot) carrying ONE
# federated identity credential whose subject is the shared MSI (design §3).
# Zero long-lived secrets: the MSI presents its IMDS token and exchanges it for
# each bot app's token at runtime.

terraform {
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
}

# Per-bot App Registration (the bot SP).
resource "azuread_application" "bot" {
  display_name     = "ncl-teams-bot-${var.bot_name}"
  sign_in_audience = "AzureADMultipleOrgs" # MultiTenant — Teams distribution
}

resource "azuread_service_principal" "bot" {
  client_id = azuread_application.bot.client_id
}

# The load-bearing piece: ONE federated identity credential per app, subject =
# the shared MSI principal id. "One FIC per app" stays strictly under the
# 20-FIC-per-app cap (design §6) — never stack multiple FICs on one app.
resource "azuread_application_federated_identity_credential" "msi" {
  application_id = azuread_application.bot.id
  display_name   = "msi-fed"
  description    = "Trusts the shared NCL bot MSI to mint this bot's token."
  audiences      = ["api://AzureADTokenExchange"]
  issuer         = "https://login.microsoftonline.com/${var.tenant_id}/v2.0"
  subject        = var.msi_principal_id
}

# Azure Bot resource — MultiTenant, msaAppId = this bot's appId. Messaging
# endpoint points at the shared App Service's in-proc listener. v1 = one App
# Service per bot, so the path is the default /api/messages (design §4).
resource "azurerm_bot_service_azure_bot" "this" {
  name                = "ncl-bot-${var.bot_name}"
  resource_group_name = var.resource_group_name
  location            = "global"
  sku                 = var.bot_sku
  microsoft_app_id    = azuread_application.bot.client_id
  microsoft_app_type  = "MultiTenant"

  endpoint = "https://${var.app_service_hostname}/api/messages${var.messaging_path_suffix}"

  tags = var.tags
}

resource "azurerm_bot_channel_ms_teams" "this" {
  bot_name            = azurerm_bot_service_azure_bot.this.name
  resource_group_name = var.resource_group_name
  location            = "global"
}
