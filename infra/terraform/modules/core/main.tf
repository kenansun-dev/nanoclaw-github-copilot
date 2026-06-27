# --- modules/core: one-time shared infrastructure -------------------------
# Service Plan + Linux Web App (App Service) + shared User-Assigned MSI +
# Log Analytics. This is the single trust anchor that all per-bot App
# Registrations federate against (see modules/bot). Replicate this whole
# module only when a bot needs hard identity isolation (design §5).

terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 3.110, < 5.0"
    }
  }
}

# Shared User-Assigned MSI — must OUTLIVE App Service redeploys and be a stable
# `subject` across N per-bot FICs. System-assigned would die with the web app
# and invalidate every FIC (design §2).
resource "azurerm_user_assigned_identity" "bot" {
  name                = var.msi_name
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags
}

resource "azurerm_log_analytics_workspace" "this" {
  name                = "${var.name_prefix}-logs"
  resource_group_name = var.resource_group_name
  location            = var.location
  sku                 = "PerGB2018"
  retention_in_days   = var.log_retention_days
  tags                = var.tags
}

resource "azurerm_service_plan" "this" {
  name                = "${var.name_prefix}-plan"
  resource_group_name = var.resource_group_name
  location            = var.location
  os_type             = "Linux"
  sku_name            = var.app_service_sku
  tags                = var.tags
}

resource "azurerm_linux_web_app" "this" {
  name                = var.app_service_name
  resource_group_name = var.resource_group_name
  location            = var.location
  service_plan_id     = azurerm_service_plan.this.id
  https_only          = true
  tags                = var.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.bot.id]
  }

  site_config {
    # Always On: keep the RELAY warm so Bot Connector's first POST doesn't hit a
    # cold/sleeping worker and time out the first Teams message (§6). Not
    # supported on Free/Shared tiers; guarded by var validation.
    always_on = var.always_on

    # gRPC south edge needs HTTP/2. App Service serves h2 to the port named by
    # HTTP20_ONLY_PORT (app_settings below) while the normal HTTPS port keeps
    # serving HTTP/1.1 for the /api/messages webhook — both coexist in one Node
    # process (design §3/§8).
    http2_enabled = true

    application_stack {
      node_version = "22-lts"
    }

    # The relay's inbound /api/messages POSTs come from the Bot Connector
    # (Microsoft cloud), so the endpoint must be publicly reachable HTTPS. The
    # relay TERMINATES inbound auth (validates the BotFramework JWT per request),
    # so "public" means reachable, not open (design §4). Optionally hard-limit
    # ingress to the AzureBotService service tag.
    dynamic "ip_restriction" {
      for_each = var.restrict_to_bot_connector ? [1] : []
      content {
        service_tag = "AzureBotService"
        action      = "Allow"
        priority    = 100
        name        = "allow-bot-connector"
      }
    }
  }

  app_settings = merge(
    {
      # HTTP/1.1 port the relay binds for the inbound /api/messages webhook.
      WEBSITES_PORT = tostring(var.webhook_port)
      # Port the relay serves gRPC (HTTP/2) on for the NCL south edge. App
      # Service routes h2 traffic here; see http2_enabled above (design §3).
      HTTP20_ONLY_PORT = tostring(var.grpc_port)
      # Shared MSI client id — the relay uses it for the outbound IMDS token
      # pull before the per-bot federation exchange (design §6 step 1).
      NCL_BOT_MSI_CLIENT_ID = azurerm_user_assigned_identity.bot.client_id
      AZURE_TENANT_ID       = var.tenant_id
      # Allowlist of AAD object ids / appIds permitted on the NCL south edge
      # (the gRPC interceptor checks the owner's token against this, design §5).
      NCL_RELAY_ALLOWLIST = join(",", var.south_edge_allowlist)
      # No NCL_RELAY_BOT_APPIDS: appId is never configured. It is intrinsic to
      # inbound (the BotFramework JWT `aud` == the bot's appId == the
      # /api/messages/<appId> path segment) and carried as the routing key into
      # outbound federation. See docs/2026-06-27-relay-appid-routing-key.md.
    },
    var.extra_app_settings,
  )

  logs {
    application_logs {
      file_system_level = "Information"
    }
    http_logs {
      file_system {
        retention_in_days = var.log_retention_days
        retention_in_mb   = 35
      }
    }
  }
}
