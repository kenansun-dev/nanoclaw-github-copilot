/**
 * MCP Azure AD Token Provider
 *
 * Acquires Azure AD (Entra ID) access tokens for remote MCP servers.
 *
 * Token acquisition priority:
 *   1. Cached valid token (from previous acquisition)
 *   2. Refresh token (if cached from previous device code flow)
 *   3. az cli (`az account get-access-token --resource xxx`)
 *   4. Built-in device code flow (NanoClaw requests and refreshes its own token)
 *
 * Token lifecycle:
 *   - Cached to ~/.nanoclaw/credentials/mcp-tokens.json (per server name)
 *   - Checked before each agent spawn — if expired, refreshed or re-acquired
 *   - Azure CLI tokens are cached until expiry; built-in tokens also keep a refresh token
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

import { logger } from './log-extensions.js';
import { resolveWorkspace } from './workspace.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface McpAzureAuthConfig {
  provider: 'azure';
  resource: string;
  tenantId?: string; // default: 'organizations'
  scope?: string; // default: '{resource}/.default'
}

export interface AuthResult {
  token: string | null;
  /** Non-fatal explanation when a token could not be acquired. */
  loginPrompt?: string;
  /** Method used to acquire the token */
  method?: 'cache' | 'refresh' | 'az-cli' | 'device-code';
}

export type McpAuthPromptHandler = (message: string) => void | Promise<void>;

export function azureTokenNeedsRefresh(
  serverName: string,
  authConfig: McpAzureAuthConfig,
  skewSeconds = TOKEN_REFRESH_SKEW_SECONDS,
): boolean {
  const resource = authConfig.resource;
  const tenantId = authConfig.tenantId || 'organizations';
  const scope = authConfig.scope || `${resource}/.default`;
  const cached = loadTokenCache()[serverName];
  return !(
    cached &&
    cached.resource === resource &&
    cached.tenant_id === tenantId &&
    cached.scope === scope &&
    cached.expires_at > Date.now() / 1000 + skewSeconds
  );
}

interface TokenCacheEntry {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // Unix timestamp (seconds)
  resource: string;
  tenant_id: string;
  scope: string;
}

interface TokenCache {
  [serverName: string]: TokenCacheEntry;
}

// Azure CLI's well-known public client ID (multi-tenant, supports device code)
const AZURE_CLI_CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';

// v2 isolation: derive credentials dir from resolved workspace.
const CREDENTIALS_DIR = path.join(resolveWorkspace(), 'credentials');
const TOKEN_CACHE_FILE = path.join(CREDENTIALS_DIR, 'mcp-tokens.json');
const AUTH_PROMPT_DELIVERY_TIMEOUT_MS = 10_000;
const TOKEN_REFRESH_SKEW_SECONDS = 300;
const tokenAcquisitions = new Map<string, Promise<AuthResult>>();

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Get an access token for a remote MCP server with Azure AD auth.
 * Returns AuthResult with a token, or a non-fatal error prompt if automatic auth fails.
 */
export function getAzureToken(
  serverName: string,
  authConfig: McpAzureAuthConfig,
  onAuthPrompt?: McpAuthPromptHandler,
): Promise<AuthResult> {
  const resource = authConfig.resource;
  const tenantId = authConfig.tenantId || 'organizations';
  const scope = authConfig.scope || `${resource}/.default`;
  const acquisitionKey = JSON.stringify([serverName, resource, tenantId, scope]);
  const existing = tokenAcquisitions.get(acquisitionKey);
  if (existing) return existing;

  const pending = getAzureTokenUncoalesced(serverName, authConfig, onAuthPrompt).finally(() => {
    if (tokenAcquisitions.get(acquisitionKey) === pending) tokenAcquisitions.delete(acquisitionKey);
  });
  tokenAcquisitions.set(acquisitionKey, pending);
  return pending;
}

async function getAzureTokenUncoalesced(
  serverName: string,
  authConfig: McpAzureAuthConfig,
  onAuthPrompt?: McpAuthPromptHandler,
): Promise<AuthResult> {
  const resource = authConfig.resource;
  const tenantId = authConfig.tenantId || 'organizations';
  const scope = authConfig.scope || `${resource}/.default`;

  // 1. Check cache for valid (non-expired) token
  const cache = loadTokenCache();
  const cached = cache[serverName];
  const cacheMatchesConfig = cached?.resource === resource && cached?.tenant_id === tenantId && cached?.scope === scope;
  if (cached && cacheMatchesConfig && cached.expires_at > Date.now() / 1000 + TOKEN_REFRESH_SKEW_SECONDS) {
    logger.debug({ serverName }, 'Using cached MCP token');
    return { token: cached.access_token, method: 'cache' };
  }

  // 2. Try refresh if we have a refresh token
  if (cached?.refresh_token && cacheMatchesConfig) {
    logger.info({ serverName }, 'Refreshing MCP token');
    try {
      const refreshed = await refreshToken(cached.refresh_token, tenantId, scope);
      cache[serverName] = {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token || cached.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + (refreshed.expires_in || 3600),
        resource,
        tenant_id: tenantId,
        scope,
      };
      saveTokenEntry(serverName, cache[serverName]);
      logger.info({ serverName }, 'MCP token refreshed');
      return { token: refreshed.access_token, method: 'refresh' };
    } catch (err) {
      logger.warn(
        { serverName, err: err instanceof Error ? err.message : String(err) },
        'MCP token refresh failed, will re-acquire',
      );
    }
  }

  // 3. Try az account get-access-token (already logged in)
  const azResult = tryAzGetToken(resource, tenantId);
  if (azResult) {
    // Cache the az-cli token so subsequent tasks reuse it instead of spawning
    // `az account get-access-token` on every MCP call. On Windows `az` is a
    // `.cmd` wrapper that flashes a console window + adds ~8s latency per call,
    // so an uncached az path made every scheduled task re-pay that cost (root
    // cause of kenan's "terminal flashes + slow replies", 2026-06-25). az
    // tokens carry no refresh_token, so on expiry we simply re-run az (which is
    // cheap when az session is still valid) — the empty refresh_token means the
    // refresh branch above is skipped and we fall straight through to here.
    cache[serverName] = {
      access_token: azResult.token,
      // Use az's real expiresOn when parseable; otherwise fall back to a
      // conservative 50 min (az access tokens are typically 60–90 min, so a
      // shorter TTL just means we re-acquire a bit early — never serve stale).
      expires_at: azResult.expiresAt ?? Math.floor(Date.now() / 1000) + 50 * 60,
      resource,
      tenant_id: tenantId,
      scope,
    };
    saveTokenEntry(serverName, cache[serverName]);
    logger.info({ serverName }, 'Got MCP token from az cli');
    return { token: azResult.token, method: 'az-cli' };
  }

  // 4. No usable Azure CLI session: use NanoClaw's own device-code flow.
  // Do NOT spawn `az login` here. Windows commonly exposes Azure CLI as
  // `az.cmd`: shell probes find it, while direct spawn('az') emits ENOENT.
  // The old unhandled ChildProcess error terminated the whole daemon. The
  // built-in flow already acquires, caches, and refreshes the same user token.
  if (!onAuthPrompt) {
    return {
      token: null,
      loginPrompt:
        `MCP server "${serverName}" needs interactive Azure authorization. ` +
        `Ask an owner in a private chat, or run: nanoclaw mcp auth ${serverName}`,
    };
  }

  logger.info({ serverName }, 'Starting built-in device code flow');
  try {
    const result = await builtinDeviceCodeFlow(tenantId, scope, async (device) => {
      const prompt =
        `🔑 MCP server "${serverName}" needs Azure sign-in.\n` +
        `Open ${device.verificationUri} and enter code ${device.userCode}.\n` +
        `NanoClaw is waiting and will continue automatically; you do not need to run az login.`;
      logger.info({ serverName, url: device.verificationUri }, 'MCP device code flow started');
      await withTimeout(
        Promise.resolve(onAuthPrompt(prompt)),
        AUTH_PROMPT_DELIVERY_TIMEOUT_MS,
        'MCP auth prompt delivery timed out',
      );
    });
    cache[serverName] = {
      access_token: result.access_token,
      refresh_token: result.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (result.expires_in || 3600),
      resource,
      tenant_id: tenantId,
      scope,
    };
    saveTokenEntry(serverName, cache[serverName]);
    logger.info({ serverName }, 'MCP token acquired via built-in device code flow');
    return { token: result.access_token, method: 'device-code' };
  } catch (err) {
    logger.error(
      { serverName, err: err instanceof Error ? err.message : String(err) },
      'Built-in device code flow failed',
    );
    return {
      token: null,
      loginPrompt:
        `MCP server "${serverName}" could not complete automatic Azure device-code authentication ` +
        `for resource "${resource}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Resolve tokens for all MCP servers that have azure auth configured.
 * Returns a map of server name → headers with Authorization.
 */
export async function resolveAllMcpTokens(
  servers: Record<string, { auth?: McpAzureAuthConfig; headers?: Record<string, string> }>,
  onAuthPrompt?: McpAuthPromptHandler,
): Promise<{
  headers: Record<string, Record<string, string>>;
  errors: Record<string, string>;
}> {
  const headers: Record<string, Record<string, string>> = {};
  const errors: Record<string, string> = {};

  for (const [name, server] of Object.entries(servers)) {
    if (server.auth?.provider !== 'azure') continue;

    const result = await getAzureToken(name, server.auth, onAuthPrompt);
    if (result.token) {
      headers[name] = {
        ...(server.headers || {}),
        Authorization: `Bearer ${result.token}`,
      };
    } else if (result.loginPrompt) {
      errors[name] = result.loginPrompt;
    }
  }

  return { headers, errors };
}

// ─── az cli helpers ──────────────────────────────────────────────────────────

function tryAzGetToken(resource: string, tenantId: string): { token: string; expiresAt: number | null } | null {
  // Azure CLI is commonly a shell-only az.cmd wrapper on Windows. Runtime
  // authentication must not depend on shell execution, so Windows uses the
  // built-in device-code flow unless a cached token already exists.
  if (process.platform === 'win32') return null;

  try {
    // Fetch accessToken + expiresOn together so we can cache with the real TTL.
    // argv execution avoids shell interpolation of resource/tenant values.
    const raw = execFileSync(
      'az',
      [
        'account',
        'get-access-token',
        '--resource',
        resource,
        '--tenant',
        tenantId,
        '--query',
        '{token:accessToken,expiresOn:expiresOn}',
        '-o',
        'json',
      ],
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
        windowsHide: true,
      },
    ).trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { token?: string; expiresOn?: string };
    const token = parsed.token?.trim();
    if (!token || token.length <= 10) return null;
    return { token, expiresAt: parseAzExpiresOn(parsed.expiresOn) };
  } catch {
    return null;
  }
}

/**
 * Parse az CLI's `expiresOn` into a Unix epoch (seconds), or null if unusable.
 *
 * az emits expiresOn as a LOCAL-time string without timezone, e.g.
 * "2026-06-25 23:59:00.000000" (classic az) or an ISO-8601 with offset on
 * newer Azure CLI. `Date.parse` reads the no-offset form as machine-local
 * time, which matches az's intent, so we let it. We subtract a 60s safety
 * skew and reject anything in the past / unparseable so a bad value never
 * yields a stale-but-"valid" cache entry (caller falls back to a fixed TTL).
 */
function parseAzExpiresOn(expiresOn: string | undefined): number | null {
  if (!expiresOn) return null;
  const ms = Date.parse(expiresOn);
  if (Number.isNaN(ms)) return null;
  const epoch = Math.floor(ms / 1000) - 60;
  if (epoch <= Math.floor(Date.now() / 1000)) return null;
  return epoch;
}

// Built-in Device Code Flow (no az needed)

interface DeviceCodePrompt {
  userCode: string;
  verificationUri: string;
}

async function builtinDeviceCodeFlow(
  tenantId: string,
  scope: string,
  onPrompt?: (prompt: DeviceCodePrompt) => void | Promise<void>,
): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}> {
  const deviceAuthUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/devicecode`;
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  // Request device code
  const deviceResp = await httpPost(deviceAuthUrl, {
    client_id: AZURE_CLI_CLIENT_ID,
    scope: `${scope} offline_access`,
  });

  if (!deviceResp.device_code) {
    throw new Error(`Device code request failed: ${JSON.stringify(deviceResp)}`);
  }

  const deadline = Date.now() + Number(deviceResp.expires_in || 900) * 1000;
  await onPrompt?.({
    userCode: String(deviceResp.user_code),
    verificationUri: String(deviceResp.verification_uri),
  });

  // Poll for token. RFC 8628 slow_down permanently increases the interval
  // for all subsequent requests; it is not a one-off extra sleep.
  let interval = Number(deviceResp.interval || 5) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);

    try {
      const tokenResp = await httpPost(tokenUrl, {
        client_id: AZURE_CLI_CLIENT_ID,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceResp.device_code,
      });

      if (tokenResp.access_token) {
        logger.info('MCP auth authorized');
        return {
          access_token: tokenResp.access_token,
          refresh_token: tokenResp.refresh_token,
          expires_in: tokenResp.expires_in,
        };
      }

      if (tokenResp.error === 'authorization_pending') continue;
      if (tokenResp.error === 'slow_down') {
        interval += 5000;
        continue;
      }
      if (tokenResp.error === 'authorization_declined') throw new Error('User declined');
      if (tokenResp.error === 'expired_token') throw new Error('Device code expired');
      throw new Error(`${tokenResp.error}: ${tokenResp.error_description}`);
    } catch (err) {
      if (err instanceof Error && err.message.includes('pending')) continue;
      throw err;
    }
  }

  throw new Error('Device code flow timed out');
}

// ─── Token Refresh ───────────────────────────────────────────────────────────

async function refreshToken(
  refreshTokenStr: string,
  tenantId: string,
  scope: string,
): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}> {
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const resp = await httpPost(tokenUrl, {
    client_id: AZURE_CLI_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshTokenStr,
    scope: `${scope} offline_access`,
  });

  if (!resp.access_token) {
    throw new Error(`Token refresh failed: ${resp.error}: ${resp.error_description}`);
  }

  return {
    access_token: resp.access_token,
    refresh_token: resp.refresh_token,
    expires_in: resp.expires_in,
  };
}

// ─── Token Cache ─────────────────────────────────────────────────────────────

function loadTokenCache(): TokenCache {
  try {
    if (fs.existsSync(TOKEN_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, 'utf-8'));
    }
  } catch {
    /* ignore */
  }
  return {};
}

function saveTokenEntry(serverName: string, entry: TokenCacheEntry): void {
  const latest = loadTokenCache();
  latest[serverName] = entry;
  saveTokenCache(latest);
}

function saveTokenCache(cache: TokenCache): void {
  const tempFile = `${TOKEN_CACHE_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tempFile, JSON.stringify(cache, null, 2), { mode: 0o600 });
    fs.renameSync(tempFile, TOKEN_CACHE_FILE);
    fs.chmodSync(TOKEN_CACHE_FILE, 0o600);
  } catch (err) {
    try {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    } catch {
      /* best effort */
    }
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to save MCP token cache');
  }
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function httpPost(url: string, params: Record<string, string>): Promise<any> {
  const body = new URLSearchParams(params).toString();
  const parsed = new URL(url);
  const lib = parsed.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid JSON: ${data.substring(0, 200)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('HTTP timeout'));
    });
    req.write(body);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ─── CLI test command ────────────────────────────────────────────────────────

/**
 * Test token acquisition for a server. Called by `nanoclaw mcp auth <server>`.
 */
export async function testMcpAuth(serverName: string): Promise<void> {
  const { loadConfig } = await import('./config-loader.js');
  const config = loadConfig();
  const server = config.mcp?.servers?.[serverName];

  if (!server) {
    console.error(`MCP server "${serverName}" not found in config`);
    process.exit(1);
  }

  const auth = (server as any).auth as McpAzureAuthConfig | undefined;
  if (!auth || auth.provider !== 'azure') {
    console.error(`MCP server "${serverName}" has no azure auth configured`);
    console.error('Add auth config: { "auth": { "provider": "azure", "resource": "https://..." } }');
    process.exit(1);
  }

  console.log(`\nTesting auth for MCP server: ${serverName}`);
  console.log(`  Resource: ${auth.resource}`);
  console.log(`  Tenant:   ${auth.tenantId || 'organizations'}`);
  console.log('');

  const result = await getAzureToken(serverName, auth, (prompt) => console.log(`\n${prompt}\n`));

  if (result.token) {
    console.log(`✅ Token acquired via ${result.method}`);
    console.log(`   Token: ${result.token.substring(0, 8) + '****'}... (${result.token.length} chars)`);
  } else {
    process.exitCode = 1;
    console.log(`❌ Token not acquired`);
    if (result.loginPrompt) {
      console.log(`\nLogin required:\n${result.loginPrompt}`);
    }
  }
}
