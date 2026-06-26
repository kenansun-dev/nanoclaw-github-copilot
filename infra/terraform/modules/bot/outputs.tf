output "app_id" {
  description = "This bot's App Registration client (app) id — the Bot Framework msaAppId."
  value       = azuread_application.bot.client_id
}

output "bot_name" {
  description = "Azure Bot resource name."
  value       = azurerm_bot_service_azure_bot.this.name
}

output "messaging_endpoint" {
  description = "Full messaging endpoint registered on the Azure Bot."
  value       = azurerm_bot_service_azure_bot.this.endpoint
}
