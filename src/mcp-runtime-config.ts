import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { getConfig } from './config.js';
import { logger } from './log-extensions.js';
import type { McpAuthPromptHandler } from './mcp-azure-auth.js';
import { paths as wsPaths } from './workspace.js';

/**
 * Merge workspace + nanoclaw.json MCP servers, resolve host-side auth, and
 * write the exact config consumed by either host or sandbox agent runners.
 * Tokens stay in a per-session host file and are mounted read-only in sandbox.
 */
function loadMergedMcpServers(): Record<string, any> {
  const configuredServers = structuredClone(getConfig().mcp?.servers || {});
  let mcpJson: Record<string, any> = {};
  if (fs.existsSync(wsPaths.mcpConfig)) {
    try {
      mcpJson = structuredClone(JSON.parse(fs.readFileSync(wsPaths.mcpConfig, 'utf-8')) as Record<string, any>);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to parse workspace MCP config; continuing with nanoclaw.json servers',
      );
    }
  }

  return {
    ...(mcpJson.mcpServers || mcpJson),
    ...configuredServers,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sourceFingerprint(servers: Record<string, any>): string {
  return crypto.createHash('sha256').update(canonicalJson(servers)).digest('hex');
}

function fingerprintPath(runtimeMcpConfig: string): string {
  return `${runtimeMcpConfig}.source-sha256`;
}

export async function configuredMcpAzureTokensNeedRefresh(runtimeMcpConfig?: string): Promise<boolean> {
  const servers = loadMergedMcpServers();
  if (runtimeMcpConfig) {
    const hasRuntimeConfig = fs.existsSync(runtimeMcpConfig);
    if (!hasRuntimeConfig) {
      if (Object.keys(servers).length > 0) return true;
    } else {
      const hashPath = fingerprintPath(runtimeMcpConfig);
      if (!fs.existsSync(hashPath)) return true;
      try {
        if (fs.readFileSync(hashPath, 'utf-8').trim() !== sourceFingerprint(servers)) return true;
      } catch {
        return true;
      }

      if (fs.existsSync(wsPaths.mcpTokens)) {
        const cacheMtime = fs.statSync(wsPaths.mcpTokens).mtimeMs;
        const injectedConfigMtime = fs.statSync(runtimeMcpConfig).mtimeMs;
        if (cacheMtime > injectedConfigMtime) return true;
      }
    }
  }

  const azureServers = Object.entries(servers).filter(([, server]: [string, any]) => server.auth?.provider === 'azure');
  if (azureServers.length === 0) return false;
  const { azureTokenNeedsRefresh } = await import('./mcp-azure-auth.js');
  return azureServers.some(([name, server]: [string, any]) => azureTokenNeedsRefresh(name, server.auth));
}

export async function prepareMcpRuntimeConfig(
  outputDir: string,
  onAuthPrompt?: McpAuthPromptHandler,
): Promise<string | undefined> {
  const servers = loadMergedMcpServers();
  const runtimePath = path.join(outputDir, 'mcp.json');
  const hashPath = fingerprintPath(runtimePath);
  if (Object.keys(servers).length === 0) {
    for (const stalePath of [runtimePath, hashPath]) {
      try {
        fs.unlinkSync(stalePath);
      } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err;
      }
    }
    return undefined;
  }
  const fingerprint = sourceFingerprint(servers);

  if (Object.values(servers).some((server: any) => server.auth?.provider === 'azure')) {
    try {
      const { resolveAllMcpTokens } = await import('./mcp-azure-auth.js');
      const { headers, errors } = await resolveAllMcpTokens(servers, onAuthPrompt);
      for (const [name, authHeaders] of Object.entries(headers)) {
        if (!servers[name]) continue;
        servers[name].headers = { ...(servers[name].headers || {}), ...authHeaders };
      }
      for (const [name, error] of Object.entries(errors)) {
        const serverHeaders = servers[name]?.headers;
        if (serverHeaders) {
          for (const key of Object.keys(serverHeaders)) {
            if (key.toLowerCase() === 'authorization') delete serverHeaders[key];
          }
        }
        logger.warn({ server: name }, `MCP auth: ${error}`);
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'MCP auth resolution failed; writing merged config without injected token',
      );
    }
  }

  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(outputDir, 0o700);
  const tempPath = path.join(outputDir, `.mcp-${process.pid}-${Date.now()}.tmp`);
  const tempHashPath = path.join(outputDir, `.mcp-source-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tempPath, JSON.stringify({ mcpServers: servers }, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });
    fs.writeFileSync(tempHashPath, `${fingerprint}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tempPath, runtimePath);
    fs.renameSync(tempHashPath, hashPath);
    if (process.platform !== 'win32') fs.chmodSync(runtimePath, 0o600);
  } catch (err) {
    for (const stalePath of [tempPath, tempHashPath]) {
      try {
        fs.unlinkSync(stalePath);
      } catch {
        /* best effort */
      }
    }
    throw err;
  }
  return runtimePath;
}
