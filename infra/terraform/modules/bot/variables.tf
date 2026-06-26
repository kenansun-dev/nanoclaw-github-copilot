variable "bot_name" {
  description = "Short bot identifier (used in resource names, e.g. 'prod')."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$", var.bot_name))
    error_message = "bot_name must be lowercase alphanumeric/hyphen, 3-32 chars, no leading/trailing hyphen."
  }
}

variable "resource_group_name" {
  description = "Resource group for the bot + teams channel."
  type        = string
}

variable "tenant_id" {
  description = "Entra tenant id (FIC issuer)."
  type        = string
}

variable "msi_principal_id" {
  description = "Shared MSI principal (object) id — the FIC subject (from modules/core)."
  type        = string
}

variable "app_service_hostname" {
  description = "App Service default hostname hosting this bot's messaging endpoint."
  type        = string
}

variable "messaging_path_suffix" {
  description = "Optional suffix after /api/messages. Empty for v1 one-App-Service-per-bot; set per-bot only in the future single-App-Service-N-bots layout (design §4)."
  type        = string
  default     = ""
}

variable "bot_sku" {
  description = "Azure Bot SKU (F0 free or S1 standard)."
  type        = string
  default     = "F0"

  validation {
    condition     = contains(["F0", "S1"], var.bot_sku)
    error_message = "bot_sku must be F0 or S1."
  }
}

variable "tags" {
  description = "Resource tags."
  type        = map(string)
  default     = {}
}
