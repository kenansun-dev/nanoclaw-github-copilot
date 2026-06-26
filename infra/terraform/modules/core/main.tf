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
    # Always On: keep the instance warm so Bot Connector's first POST doesn't
    # hit a cold/sleeping worker and time out the first Teams message (§6).
    # Not supported on Free/Shared tiers; guarded by var validation.
    always_on = var.always_on

    application_stack {
      node_version = "22-lts"
    }

    # Inbound is authenticated per-request by the BotFramework JWT (adapter
    # validates issuer = Bot Connector, audience = bot appId). "Public" here
    # means reachable, not open (design §4). Network access-restrictions can be
    # layered later via var.bot_connector_service_tag_only.
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
      # The in-proc NCL listener must bind process.env.PORT on App Service
      # (single injected port). Verified against src/channels/teams.ts listen
      # path by the runtime-adaptation work.
      WEBSITES_PORT = tostring(var.listen_port)
      # Expose the shared MSI client id to the runtime so IMDS token requests
      # can target it explicitly (client_id=$MSI_CID, design §3 step 1).
      NCL_BOT_MSI_CLIENT_ID = azurerm_user_assigned_identity.bot.client_id
      AZURE_TENANT_ID       = var.tenant_id
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
