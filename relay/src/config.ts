/**
 * Relay configuration — resolved from environment the App Service IaC injects
 * (see infra/terraform/modules/core: WEBSITES_PORT, HTTP20_ONLY_PORT,
 * NCL_RELAY_ALLOWLIST, NCL_BOT_MSI_CLIENT_ID, AZURE_TENANT_ID).
 *
 * Defaults match the Terraform variable defaults so local runs and the
 * provisioned App Service agree.
 */

export interface RelayConfig {
  /** HTTP/1.1 port for the north-edge /api/messages webhook (WEBSITES_PORT). */
  webhookPort: number;
  /** HTTP/2 port for the gRPC south edge (HTTP20_ONLY_PORT). */
  grpcPort: number;
  /**
   * AAD object ids / appIds allowed on the gRPC south edge. The interceptor
   * checks the caller's validated token against this (design §5). Empty list
   * means deny-all (no caller is implicitly trusted).
   */
  southEdgeAllowlist: string[];
  /** Shared MSI client id for the outbound IMDS token pull (design §6 step 1). */
  msiClientId: string | undefined;
  /** Entra tenant id. */
  tenantId: string | undefined;
  /**
   * Channel service for BotFramework JWT validation. Empty = public Azure Bot
   * Service; set for government cloud.
   */
  channelService: string;
}

function parsePort(raw: string | undefined, fallback: number, name: string): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) {
    throw new Error(`Invalid ${name}=${JSON.stringify(raw)} — expected a port 1-65535`);
  }
  return n;
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  return {
    // App Service injects WEBSITES_PORT as the port the platform routes HTTP/1.1
    // to; default 3978 matches the Terraform default.
    webhookPort: parsePort(env.WEBSITES_PORT, 3978, 'WEBSITES_PORT'),
    grpcPort: parsePort(env.HTTP20_ONLY_PORT, 8585, 'HTTP20_ONLY_PORT'),
    southEdgeAllowlist: parseList(env.NCL_RELAY_ALLOWLIST),
    msiClientId: env.NCL_BOT_MSI_CLIENT_ID,
    tenantId: env.AZURE_TENANT_ID,
    channelService: env.NCL_RELAY_CHANNEL_SERVICE ?? '',
  };
}
