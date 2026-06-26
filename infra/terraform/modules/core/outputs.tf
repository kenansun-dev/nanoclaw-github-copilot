output "msi_principal_id" {
  description = "Object (principal) id of the shared MSI — used as the FIC subject (design §3)."
  value       = azurerm_user_assigned_identity.bot.principal_id
}

output "msi_client_id" {
  description = "Client id of the shared MSI — used for IMDS token requests at runtime."
  value       = azurerm_user_assigned_identity.bot.client_id
}

output "msi_id" {
  description = "Full resource id of the shared MSI."
  value       = azurerm_user_assigned_identity.bot.id
}

output "app_service_name" {
  description = "App Service (web app) name."
  value       = azurerm_linux_web_app.this.name
}

output "app_service_default_hostname" {
  description = "Default *.azurewebsites.net hostname (bot messaging endpoint base)."
  value       = azurerm_linux_web_app.this.default_hostname
}

output "app_service_id" {
  description = "App Service resource id."
  value       = azurerm_linux_web_app.this.id
}

output "log_analytics_workspace_id" {
  description = "Log Analytics workspace id."
  value       = azurerm_log_analytics_workspace.this.id
}
