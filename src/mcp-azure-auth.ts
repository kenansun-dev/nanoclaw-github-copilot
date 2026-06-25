/**
 * MCP Azure AD Token Provider
 *
 * Acquires Azure AD (Entra ID) access tokens for remote MCP servers.
 *
 * Token acquisition priority:
 *   1. Cached valid token (from previous acquisition)
 *   2. Refresh token (if cached from previous device code flow)
 *   3. az cli (`az account get-access-token --resource xxx`)
 *   4. az login --use-device-code (output returned to caller/LLM)
 *   5. Built-in device code flow (fallback when az not installed)
 *
 * Token lifecycle:
 *   - Cached to ~/.nanoclaw/credentials/mcp-tokens.json (per server name)
 *   - Checked before each agent spawn — if expired, refreshed or re-acquired
 *   - az cli tokens are not cached (az manages its own refresh)
 */

import { execSync, spawn as spawnChild } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
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
  /** If login is needed, this contains the output to show the user (e.g. device code prompt) */
  loginPrompt?: string;
  /** Method used to acquire the token */
  method?: 'cache' | 'refresh' | 'az-cli' | 'az-login' | 'device-code';
}

interface TokenCacheEntry {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // Unix timestamp (seconds)
  resource: string;
  tenant_id: string;
}

interface TokenCache {
  [serverName: string]: TokenCacheEntry;
}

// Azure CLI's well-known public client ID (multi-tenant, supports device code)
const AZURE_CLI_CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';

// v2 isolation: derive credentials dir from resolved workspace.
const CREDENTIALS_DIR = path.join(resolveWorkspace(), 'credentials');
const TOKEN_CACHE_FILE = path.join(CREDENTIALS_DIR, 'mcp-tokens.json');

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Get an access token for a remote MCP server with Azure AD auth.
 * Returns AuthResult with token and optional loginPrompt for LLM to handle.
 */
export async function getAzureToken(serverName: string, authConfig: McpAzureAuthConfig): Promise<AuthResult> {
  const resource = authConfig.resource;
  const tenantId = authConfig.tenantId || 'organizations';
  const scope = authConfig.scope || `${resource}/.default`;

  // 1. Check cache for valid (non-expired) token
  const cache = loadTokenCache();
  const cached = cache[serverName];
  if (cached && cached.expires_at > Date.now() / 1000 + 60) {
    logger.debug({ serverName }, 'Using cached MCP token');
    return { token: cached.access_token, method: 'cache' };
  }

  // 2. Try refresh if we have a refresh token
  if (cached?.refresh_token) {
    logger.info({ serverName }, 'Refreshing MCP token');
    try {
      const refreshed = await refreshToken(cached.refresh_token, tenantId, scope);
      cache[serverName] = {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token || cached.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + (refreshed.expires_in || 3600),
        resource,
        tenant_id: tenantId,
      };
      saveTokenCache(cache);
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
  const azResult = tryAzGetToken(resource);
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
    };
    saveTokenCache(cache);
    logger.info({ serverName }, 'Got MCP token from az cli');
    return { token: azResult.token, method: 'az-cli' };
  }

  // 4. Try az login --use-device-code (az installed but not logged in)
  if (isAzInstalled()) {
    logger.info({ serverName }, 'Attempting az login --use-device-code');
    const azLoginResult = await tryAzLogin(resource, tenantId);
    if (azLoginResult.token) {
      logger.info({ serverName }, 'Got MCP token after az login');
      return {
        token: azLoginResult.token,
        method: 'az-login',
        loginPrompt: azLoginResult.loginPrompt,
      };
    }
    if (azLoginResult.loginPrompt) {
      // az login started but needs user interaction — return prompt for LLM
      return {
        token: null,
        method: 'az-login',
        loginPrompt: azLoginResult.loginPrompt,
      };
    }
  }

  // 5. Fallback: built-in device code flow (no az needed)
  logger.info({ serverName }, 'Starting built-in device code flow');
  try {
    const result = await builtinDeviceCodeFlow(tenantId, scope);
    cache[serverName] = {
      access_token: result.access_token,
      refresh_token: result.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (result.expires_in || 3600),
      resource,
      tenant_id: tenantId,
    };
    saveTokenCache(cache);
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
        `MCP server "${serverName}" requires Azure AD authentication for resource "${resource}". ` +
        `Please install Azure CLI and run: az login --use-device-code`,
    };
  }
}

/**
 * Resolve tokens for all MCP servers that have azure auth configured.
 * Returns a map of server name → headers with Authorization.
 */
export async function resolveAllMcpTokens(
  servers: Record<string, { auth?: McpAzureAuthConfig; headers?: Record<string, string> }>,
): Promise<{
  headers: Record<string, Record<string, string>>;
  errors: Record<string, string>;
}> {
  const headers: Record<string, Record<string, string>> = {};
  const errors: Record<string, string> = {};

  for (const [name, server] of Object.entries(servers)) {
    if (server.auth?.provider !== 'azure') continue;

    const result = await getAzureToken(name, server.auth);
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

function isAzInstalled(): boolean {
  try {
    execSync('az --version', {
      stdio: 'pipe',
      timeout: 5000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function tryAzGetToken(resource: string): { token: string; expiresAt: number | null } | null {
  try {
    // Fetch accessToken + expiresOn together so we can cache with the real TTL.
    const raw = execSync(
      `az account get-access-token --resource ${resource} --query "{token:accessToken,expiresOn:expiresOn}" -o json`,
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

/**
 * Run `az login --use-device-code`, capture output for LLM.
 * If login succeeds, immediately get token. If pending, return the prompt.
 */
async function tryAzLogin(
  resource: string,
  _tenantId: string,
): Promise<{ token: string | null; loginPrompt?: string }> {
  return new Promise((resolve) => {
    let output = '';
    let resolved = false;

    const child = spawnChild('az', ['login', '--use-device-code'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120000, // 2 min timeout
    });

    const onOutput = (data: Buffer) => {
      output += data.toString();

      // Check if device code prompt appeared
      if ((!resolved && output.includes('devicelogin')) || output.includes('device')) {
        // Don't resolve yet — wait for login to complete or timeout
      }
    };

    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);

    child.on('close', (code) => {
      if (resolved) return;
      resolved = true;

      if (code === 0) {
        // Login succeeded — get the token
        const azResult = tryAzGetToken(resource);
        resolve({ token: azResult?.token ?? null, loginPrompt: output.trim() || undefined });
      } else {
        // Login failed or user didn't complete — return prompt for LLM
        resolve({
          token: null,
          loginPrompt: output.trim() || 'az login failed',
        });
      }
    });

    // After 5 seconds, if we have device code output, return it for LLM
    setTimeout(() => {
      if (!resolved && output.includes('http')) {
        resolved = true;
        resolve({ token: null, loginPrompt: output.trim() });
        // Kill the az login process — LLM will guide user, not us
        try {
          child.kill();
        } catch {
          /* */
        }
      }
    }, 10000);
  });
}

// ─── Built-in Device Code Flow (no az needed) ────────────────────────────────

async function builtinDeviceCodeFlow(
  tenantId: string,
  scope: string,
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

  // Print prompt (for CLI/TUI mode)
  logger.info('MCP Auth Required');
  logger.info({ code: deviceResp.user_code, url: deviceResp.verification_uri }, 'MCP device code flow started');
  if (deviceResp.verification_uri_complete) {
  }
  // Poll for token
  const interval = (deviceResp.interval || 5) * 1000;
  const deadline = Date.now() + deviceResp.expires_in * 1000;

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
        await sleep(5000);
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

function saveTokenCache(cache: TokenCache): void {
  try {
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), {
      mode: 0o600,
    });
  } catch (err) {
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
  console.log(`  az CLI:   ${isAzInstalled() ? 'installed' : 'not installed'}`);
  console.log('');

  const result = await getAzureToken(serverName, auth);

  if (result.token) {
    console.log(`✅ Token acquired via ${result.method}`);
    console.log(`   Token: ${result.token.substring(0, 8) + '****'}... (${result.token.length} chars)`);
  } else {
    console.log(`❌ Token not acquired`);
    if (result.loginPrompt) {
      console.log(`\nLogin required:\n${result.loginPrompt}`);
    }
  }
}
