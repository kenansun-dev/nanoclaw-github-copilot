variable "subscription_id" {
  description = "Azure subscription id to deploy into."
  type        = string
}

variable "tenant_id" {
  description = "Entra tenant id."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for derived resource names."
  type        = string
  default     = "ncl-teams"
}

variable "create_resource_group" {
  description = "Create the resource group (false = use existing)."
  type        = bool
  default     = true
}

variable "resource_group_name" {
  description = "Resource group name."
  type        = string
  default     = "ncl-teams-rg"
}

variable "location" {
  description = "Azure region, e.g. eastus / southeastasia."
  type        = string
}

variable "app_service_name" {
  description = "Globally-unique App Service (web app) name."
  type        = string
}

variable "app_service_sku" {
  description = "App Service plan SKU. B1 to start, P1v3 for scale-out (design §6)."
  type        = string
  default     = "B1"
}

variable "always_on" {
  description = "Keep the worker warm (Basic+ SKU required)."
  type        = bool
  default     = true
}

variable "webhook_port" {
  description = "HTTP/1.1 port the relay binds for the inbound /api/messages webhook."
  type        = number
  default     = 3978
}

variable "grpc_port" {
  description = "HTTP/2 port the relay serves gRPC on for the NCL south edge."
  type        = number
  default     = 8585
}

variable "south_edge_allowlist" {
  description = "AAD object ids / appIds allowed on the NCL gRPC south edge (design §5)."
  type        = list(string)
  default     = []
}

variable "restrict_to_bot_connector" {
  description = "Allow only AzureBotService service tag inbound."
  type        = bool
  default     = false
}

variable "extra_app_settings" {
  description = "Additional app settings merged into the web app (per-account MSTEAMS_* env, etc.)."
  type        = map(string)
  default     = {}
}

variable "tags" {
  description = "Resource tags applied to all resources."
  type        = map(string)
  default = {
    project = "ncl-teams"
    managed = "terraform"
  }
}
