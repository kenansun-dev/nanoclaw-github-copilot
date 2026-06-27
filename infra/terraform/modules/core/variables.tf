variable "name_prefix" {
  description = "Prefix for derived resource names (plan, logs)."
  type        = string
  default     = "ncl-teams"
}

variable "resource_group_name" {
  description = "Existing resource group to deploy into."
  type        = string
}

variable "location" {
  description = "Azure region, e.g. eastus / southeastasia."
  type        = string
}

variable "tenant_id" {
  description = "Entra tenant id (for runtime token exchange)."
  type        = string
}

variable "msi_name" {
  description = "Name of the shared user-assigned managed identity."
  type        = string
  default     = "ncl-bot-msi"
}

variable "app_service_name" {
  description = "Globally-unique App Service (web app) name."
  type        = string
}

variable "app_service_sku" {
  description = "App Service plan SKU. B1 to start (no autoscale), P1v3 for scale-out (design §6)."
  type        = string
  default     = "B1"

  validation {
    condition     = contains(["B1", "B2", "B3", "P0v3", "P1v3", "P2v3", "P3v3"], var.app_service_sku)
    error_message = "Use a Basic (B1-B3) or Premium v3 (P0v3-P3v3) SKU; Always On requires non-Free/Shared."
  }
}

variable "always_on" {
  description = "Keep the worker warm (avoids cold-start timeout on first Teams message). Requires Basic+ SKU."
  type        = bool
  default     = true
}

variable "webhook_port" {
  description = "HTTP/1.1 port the relay binds for the inbound /api/messages webhook (mapped to WEBSITES_PORT)."
  type        = number
  default     = 3978
}

variable "grpc_port" {
  description = "HTTP/2 port the relay serves gRPC on for the NCL south edge (mapped to HTTP20_ONLY_PORT)."
  type        = number
  default     = 8585
}

variable "south_edge_allowlist" {
  description = "AAD object ids / appIds allowed on the NCL gRPC south edge (the interceptor checks the owner's token against this, design §5)."
  type        = list(string)
  default     = []
}

variable "bot_app_ids" {
  description = "Map of bot name -> Azure AD app (client) id. Feeds NCL_RELAY_BOT_APPIDS, the single source the relay uses for BOTH inbound JWT audience validation and outbound federation token exchange. Add a bot = one entry here. appId is non-secret (public client id), so it is fine in app_settings."
  type        = map(string)
  default     = {}
}

variable "restrict_to_bot_connector" {
  description = "If true, add an access restriction allowing only the AzureBotService service tag."
  type        = bool
  default     = false
}

variable "log_retention_days" {
  description = "Log Analytics + http log retention in days."
  type        = number
  default     = 30
}

variable "extra_app_settings" {
  description = "Additional app settings merged into the web app (e.g. per-account MSTEAMS_* env)."
  type        = map(string)
  default     = {}
}

variable "tags" {
  description = "Resource tags."
  type        = map(string)
  default     = {}
}
