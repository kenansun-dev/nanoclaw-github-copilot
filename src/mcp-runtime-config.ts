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

export async function configuredMcpAzureTokensNeedRefresh(runtimeMcpConfig?: string): Promise<boolean> {
  if (runtimeMcpConfig && fs.existsSync(wsPaths.mcpTokens) && fs.existsSync(runtimeMcpConfig)) {
    const cacheMtime = fs.statSync(wsPaths.mcpTokens).mtimeMs;
    const injectedConfigMtime = fs.statSync(runtimeMcpConfig).mtimeMs;
    if (cacheMtime > injectedConfigMtime) return true;
  }

  const servers = loadMergedMcpServers();
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
  if (Object.keys(servers).length === 0) return undefined;

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
  const runtimePath = path.join(outputDir, 'mcp.json');
  const tempPath = path.join(outputDir, `.mcp-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tempPath, JSON.stringify({ mcpServers: servers }, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(tempPath, runtimePath);
    if (process.platform !== 'win32') fs.chmodSync(runtimePath, 0o600);
  } catch (err) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* best effort */
    }
    throw err;
  }
  return runtimePath;
}
