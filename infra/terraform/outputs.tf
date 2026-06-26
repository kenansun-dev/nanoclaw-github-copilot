output "app_service_hostname" {
  description = "App Service default hostname (bot messaging endpoint base)."
  value       = module.core.app_service_default_hostname
}

output "app_service_name" {
  description = "App Service (web app) name — target for zip/GH-Actions deploy."
  value       = module.core.app_service_name
}

output "msi_principal_id" {
  description = "Shared MSI principal id (FIC subject)."
  value       = module.core.msi_principal_id
}

output "msi_client_id" {
  description = "Shared MSI client id (runtime IMDS token requests)."
  value       = module.core.msi_client_id
}

output "bots" {
  description = "Per-bot appId + messaging endpoint map."
  value = {
    for k, m in module.bot : k => {
      app_id             = m.app_id
      bot_name           = m.bot_name
      messaging_endpoint = m.messaging_endpoint
    }
  }
}
