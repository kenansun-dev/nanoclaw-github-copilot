/**
 * MCP OAuth Authentication via PRM Auto-Discovery + Device Code Flow
 *
 * Independent module for authenticating remote MCP servers.
 * Follows MCP spec (RFC 9728 Protected Resource Metadata) to auto-discover
 * OAuth endpoints, then uses device code flow for headless auth.
 *
 * Token lifecycle:
 *   1. Pre-flight: attempt unauthenticated request to MCP server
 *   2. On 401: parse WWW-Authenticate for resource_metadata URL
 *   3. Fetch PRM → discover authorization server
 *   4. Fetch Authorization Server Metadata → get endpoints
 *   5. Device code flow → user logs in via browser
 *   6. Cache tokens to ~/.nanoclaw/credentials/mcp-tokens.json
 *   7. Inject tokens into MCP server headers before container launch
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import http from 'http';

import { logger } from './log-extensions.js';
import { resolveWorkspace } from './workspace.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface McpServerConfig {
  type?: string;
  url?: string;
  headers?: Record<string, string>;
  tools?: string[];
}

export interface McpAuthConfig {
  servers: Record<string, McpServerConfig>;
}

interface TokenCacheEntry {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // Unix timestamp (seconds)
  scope?: string;
  token_endpoint: string;
  client_id?: string;
}

interface TokenCache {
  [serverName: string]: TokenCacheEntry;
}

interface PrmMetadata {
  resource: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

interface AuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  device_authorization_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  grant_types_supported?: string[];
  response_types_supported?: string[];
  code_challenge_methods_supported?: string[];
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

// ─── Paths ───────────────────────────────────────────────────────────────────

// v2 isolation: resolve workspace at module load via resolveWorkspace().
const NANOCLAW_DIR = resolveWorkspace();
const CREDENTIALS_DIR = path.join(NANOCLAW_DIR, 'credentials');
const TOKEN_CACHE_PATH = path.join(CREDENTIALS_DIR, 'mcp-tokens.json');
const MCP_CONFIG_PATH = path.join(NANOCLAW_DIR, 'mcp.json');

// ─── HTTP Helpers ────────────────────────────────────────────────────────────

function httpRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeout?: number;
  } = {},
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const makeRequest = isHttps ? https.request : http.request;

    const req = makeRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: options.timeout || 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const responseHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') responseHeaders[key] = value;
            else if (Array.isArray(value))
              responseHeaders[key] = value.join(', ');
          }
          resolve({
            status: res.statusCode || 0,
            headers: responseHeaders,
            body: data,
          });
        });
      },
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timeout: ${url}`));
    });

    if (options.body) req.write(options.body);
    req.end();
  });
}

// ─── PRM Discovery ───────────────────────────────────────────────────────────

/**
 * Parse WWW-Authenticate header to extract resource_metadata URL and scope.
 */
function parseWwwAuthenticate(header: string): {
  resourceMetadataUrl?: string;
  scope?: string;
} {
  const result: { resourceMetadataUrl?: string; scope?: string } = {};

  const rmMatch = header.match(/resource_metadata="([^"]+)"/);
  if (rmMatch) result.resourceMetadataUrl = rmMatch[1];

  const scopeMatch = header.match(/scope="([^"]+)"/);
  if (scopeMatch) result.scope = scopeMatch[1];

  return result;
}

/**
 * Attempt to connect to MCP server and discover auth requirements via PRM.
 * Returns null if server doesn't require auth or PRM is not available.
 */
export async function discoverAuthRequirements(serverUrl: string): Promise<{
  prmMetadata: PrmMetadata;
  authServerMetadata: AuthServerMetadata;
  scope?: string;
} | null> {
  try {
    // Step 1: Make unauthenticated request to MCP server
    const response = await httpRequest(serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
      timeout: 10000,
    });

    if (response.status !== 401 && response.status !== 403) {
      logger.debug(
        `MCP server ${serverUrl} returned ${response.status}, no auth needed`,
      );
      return null;
    }

    // Step 2: Parse WWW-Authenticate header
    const wwwAuth = response.headers['www-authenticate'] || '';
    const { resourceMetadataUrl, scope } = parseWwwAuthenticate(wwwAuth);

    let prmUrl: string;
    if (resourceMetadataUrl) {
      prmUrl = resourceMetadataUrl;
    } else {
      // Fallback: construct well-known URL
      const parsed = new URL(serverUrl);
      prmUrl = `${parsed.origin}/.well-known/oauth-protected-resource${parsed.pathname}`;
    }

    // Step 3: Fetch Protected Resource Metadata
    logger.info(`Fetching PRM from: ${prmUrl}`);
    const prmResponse = await httpRequest(prmUrl, { timeout: 10000 });
    if (prmResponse.status !== 200) {
      logger.warn(`PRM endpoint returned ${prmResponse.status}`);
      // Try root well-known as fallback
      const parsed = new URL(serverUrl);
      const rootPrmUrl = `${parsed.origin}/.well-known/oauth-protected-resource`;
      const rootPrmResponse = await httpRequest(rootPrmUrl, { timeout: 10000 });
      if (rootPrmResponse.status !== 200) {
        logger.warn(
          `Root PRM endpoint also returned ${rootPrmResponse.status}`,
        );
        return null;
      }
      Object.assign(prmResponse, rootPrmResponse);
    }

    const prmMetadata: PrmMetadata = JSON.parse(prmResponse.body);
    if (
      !prmMetadata.authorization_servers ||
      prmMetadata.authorization_servers.length === 0
    ) {
      logger.warn('PRM metadata has no authorization_servers');
      return null;
    }

    // Step 4: Fetch Authorization Server Metadata
    const authServerUrl = prmMetadata.authorization_servers[0];
    const authMetaUrl = `${authServerUrl}/.well-known/oauth-authorization-server`;
    logger.info(`Fetching auth server metadata from: ${authMetaUrl}`);

    let authServerMetadata: AuthServerMetadata;
    const authMetaResponse = await httpRequest(authMetaUrl, { timeout: 10000 });
    if (authMetaResponse.status === 200) {
      authServerMetadata = JSON.parse(authMetaResponse.body);
    } else {
      // Fallback: try OpenID Connect discovery
      const oidcUrl = `${authServerUrl}/.well-known/openid-configuration`;
      const oidcResponse = await httpRequest(oidcUrl, { timeout: 10000 });
      if (oidcResponse.status !== 200) {
        logger.warn('Could not fetch auth server metadata');
        return null;
      }
      authServerMetadata = JSON.parse(oidcResponse.body);
    }

    return { prmMetadata, authServerMetadata, scope };
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      `PRM discovery failed for ${serverUrl}`,
    );
    return null;
  }
}

// ─── Device Code Flow ────────────────────────────────────────────────────────

/**
 * Initiate device code flow with the authorization server.
 */
export async function initiateDeviceCodeFlow(
  deviceAuthEndpoint: string,
  clientId: string,
  scope: string,
): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({
    client_id: clientId,
    scope,
  }).toString();

  const response = await httpRequest(deviceAuthEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    timeout: 15000,
  });

  if (response.status !== 200) {
    throw new Error(
      `Device code request failed (${response.status}): ${response.body}`,
    );
  }

  return JSON.parse(response.body);
}

/**
 * Poll token endpoint waiting for user to complete device code auth.
 * Returns token response or throws on timeout/error.
 */
export async function pollForToken(
  tokenEndpoint: string,
  clientId: string,
  deviceCode: string,
  interval: number,
  expiresIn: number,
): Promise<TokenResponse> {
  const deadline = Date.now() + expiresIn * 1000;
  let pollInterval = Math.max(interval, 5) * 1000; // minimum 5 seconds

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      device_code: deviceCode,
    }).toString();

    const response = await httpRequest(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      timeout: 15000,
    });

    if (response.status === 200) {
      return JSON.parse(response.body);
    }

    const error = JSON.parse(response.body);
    if (error.error === 'authorization_pending') {
      continue;
    } else if (error.error === 'slow_down') {
      pollInterval += 5000;
      continue;
    } else {
      throw new Error(
        `Token polling failed: ${error.error} - ${error.error_description || ''}`,
      );
    }
  }

  throw new Error('Device code flow timed out');
}

/**
 * Refresh an expired access token using refresh_token grant.
 */
export async function refreshAccessToken(
  tokenEndpoint: string,
  clientId: string,
  refreshToken: string,
  scope?: string,
): Promise<TokenResponse> {
  const params: Record<string, string> = {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
  };
  if (scope) params.scope = scope;

  const body = new URLSearchParams(params).toString();

  const response = await httpRequest(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    timeout: 15000,
  });

  if (response.status !== 200) {
    throw new Error(
      `Token refresh failed (${response.status}): ${response.body}`,
    );
  }

  return JSON.parse(response.body);
}

// ─── Token Cache ─────────────────────────────────────────────────────────────

export function loadTokenCache(): TokenCache {
  try {
    if (fs.existsSync(TOKEN_CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(TOKEN_CACHE_PATH, 'utf-8'));
    }
  } catch (err) {
    logger.warn(`Failed to load token cache: ${err}`);
  }
  return {};
}

export function saveTokenCache(cache: TokenCache): void {
  fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_CACHE_PATH, JSON.stringify(cache, null, 2), {
    mode: 0o600,
  });
}

function isTokenValid(entry: TokenCacheEntry): boolean {
  // Consider token expired 5 minutes before actual expiry
  return entry.expires_at > Date.now() / 1000 + 300;
}

// ─── Token Injection ─────────────────────────────────────────────────────────

/**
 * Ensure all remote MCP servers have valid tokens.
 * Returns updated MCP config with auth headers injected.
 *
 * @param sendLoginPrompt - callback to send device code login URL to user
 *   (e.g., via Telegram/Discord). Called with (serverName, userCode, verificationUri).
 *   If null, skips servers that need auth.
 */
export async function resolveTokensForMcpServers(
  mcpConfig: Record<string, McpServerConfig>,
  sendLoginPrompt?: (
    serverName: string,
    userCode: string,
    verificationUri: string,
  ) => Promise<void>,
): Promise<Record<string, McpServerConfig>> {
  const cache = loadTokenCache();
  const result: Record<string, McpServerConfig> = {};
  let cacheChanged = false;

  for (const [name, server] of Object.entries(mcpConfig)) {
    // Only process remote HTTP/SSE servers without existing auth
    if (
      !server.url ||
      (server.type !== 'http' && server.type !== 'sse') ||
      server.headers?.Authorization
    ) {
      result[name] = server;
      continue;
    }

    // Check cached token
    const cached = cache[name];
    if (cached && isTokenValid(cached)) {
      logger.info(`Using cached token for MCP server: ${name}`);
      result[name] = {
        ...server,
        headers: {
          ...server.headers,
          Authorization: `Bearer ${cached.access_token}`,
        },
      };
      continue;
    }

    // Try refresh
    if (cached?.refresh_token && cached.client_id) {
      try {
        logger.info(`Refreshing token for MCP server: ${name}`);
        const refreshed = await refreshAccessToken(
          cached.token_endpoint,
          cached.client_id,
          cached.refresh_token,
          cached.scope,
        );
        cache[name] = {
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token || cached.refresh_token,
          expires_at:
            Math.floor(Date.now() / 1000) + (refreshed.expires_in || 3600),
          scope: refreshed.scope || cached.scope,
          token_endpoint: cached.token_endpoint,
          client_id: cached.client_id,
        };
        cacheChanged = true;
        result[name] = {
          ...server,
          headers: {
            ...server.headers,
            Authorization: `Bearer ${refreshed.access_token}`,
          },
        };
        continue;
      } catch (err) {
        logger.warn(`Token refresh failed for ${name}: ${err}`);
        // Fall through to full auth flow
      }
    }

    // Full PRM discovery + device code flow
    if (!sendLoginPrompt) {
      logger.info(`No login prompt callback, skipping auth for: ${name}`);
      result[name] = server;
      continue;
    }

    try {
      const discovery = await discoverAuthRequirements(server.url);
      if (!discovery) {
        result[name] = server;
        continue;
      }

      const { authServerMetadata, scope } = discovery;

      // Check device code support
      const supportsDeviceCode =
        authServerMetadata.device_authorization_endpoint &&
        (authServerMetadata.grant_types_supported?.includes(
          'urn:ietf:params:oauth:grant-type:device_code',
        ) ??
          true);

      if (!supportsDeviceCode) {
        logger.warn(
          `MCP server ${name}: auth server does not support device code flow`,
        );
        result[name] = server;
        continue;
      }

      // Use Azure CLI's well-known public client ID for device code flow.
      // This is a Microsoft-registered multi-tenant app that supports device code grant.
      // If the auth server requires a specific tenant, replace 'common' in the endpoint URL.
      const AZURE_CLI_CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';
      const clientId = AZURE_CLI_CLIENT_ID;

      // Fix tenant in device auth endpoint: Azure AD 'common' endpoint often rejects
      // tenant-specific scopes. Use 'organizations' as a safer default that lets
      // the user's login determine the tenant.
      let deviceAuthEndpoint =
        authServerMetadata.device_authorization_endpoint!;

      // Replace 'common' with 'organizations' for work/school account scopes
      if (deviceAuthEndpoint.includes('/common/')) {
        deviceAuthEndpoint = deviceAuthEndpoint.replace(
          '/common/',
          '/organizations/',
        );
      }

      const deviceCodeResponse = await initiateDeviceCodeFlow(
        authServerMetadata.device_authorization_endpoint!,
        clientId,
        scope || 'openid profile',
      );

      // Send login prompt to user
      await sendLoginPrompt(
        name,
        deviceCodeResponse.user_code,
        deviceCodeResponse.verification_uri_complete ||
          deviceCodeResponse.verification_uri,
      );

      // Fix tenant in token endpoint as well
      let tokenEndpoint = authServerMetadata.token_endpoint;
      if (tokenEndpoint.includes('/common/')) {
        tokenEndpoint = tokenEndpoint.replace('/common/', '/organizations/');
      }

      // Poll for token
      const tokenResponse = await pollForToken(
        tokenEndpoint,
        clientId,
        deviceCodeResponse.device_code,
        deviceCodeResponse.interval,
        deviceCodeResponse.expires_in,
      );

      cache[name] = {
        access_token: tokenResponse.access_token,
        refresh_token: tokenResponse.refresh_token,
        expires_at:
          Math.floor(Date.now() / 1000) + (tokenResponse.expires_in || 3600),
        scope: tokenResponse.scope || scope,
        token_endpoint: tokenEndpoint,
        client_id: clientId,
      };
      cacheChanged = true;

      result[name] = {
        ...server,
        headers: {
          ...server.headers,
          Authorization: `Bearer ${tokenResponse.access_token}`,
        },
      };

      logger.info(`Successfully authenticated MCP server: ${name}`);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        `Auth flow failed for MCP server: ${name}`,
      );
      result[name] = server;
    }
  }

  if (cacheChanged) {
    saveTokenCache(cache);
  }

  return result;
}

/**
 * Load MCP config from ~/.nanoclaw/mcp.json
 */
export function loadMcpConfig(): Record<string, McpServerConfig> {
  try {
    if (fs.existsSync(MCP_CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, 'utf-8'));
      return config.mcpServers || config;
    }
  } catch (err) {
    logger.warn(`Failed to load MCP config: ${err}`);
  }
  return {};
}
