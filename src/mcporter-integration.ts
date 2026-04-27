/**
 * mcporter Integration for nanoclaw-github-copilot
 *
 * Uses mcporter CLI to manage MCP server connections, auth, and tool calls.
 * mcporter handles OAuth/PRM discovery, token management, and server lifecycle.
 *
 * How it works:
 * 1. User configures MCP servers in mcporter config (mcporter config add)
 * 2. User authenticates via mcporter (mcporter auth <server>)
 * 3. nanoclaw uses mcporter as an MCP proxy:
 *    - mcporter daemon keeps connections alive
 *    - nanoclaw connects to mcporter via stdio as an MCP server
 *    - mcporter aggregates all configured remote MCP tools
 *
 * Integration approach:
 * - mcporter runs as a local stdio MCP server in the container
 * - nanoclaw passes it as an mcpServer to the GHC CLI session
 * - Auth is handled by mcporter on the host side (pre-container)
 */

import { execSync, spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { logger } from './log.js';

// ─── Paths ───────────────────────────────────────────────────────────────────

const NANOCLAW_DIR = path.join(os.homedir(), '.nanoclaw');
const MCPORTER_CONFIG_DIR = path.join(NANOCLAW_DIR, 'mcporter');
const MCPORTER_CONFIG_PATH = path.join(MCPORTER_CONFIG_DIR, 'mcporter.json');

// ─── Types ───────────────────────────────────────────────────────────────────

export interface McporterServerEntry {
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  lifecycle?: string;
}

export interface McporterConfig {
  servers: Record<string, McporterServerEntry>;
}

export interface McporterMcpServerConfig {
  type: 'local';
  command: string;
  args: string[];
  env?: Record<string, string>;
  tools: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Check if mcporter CLI is installed.
 */
export function isMcporterInstalled(): boolean {
  try {
    execSync('mcporter --help', { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    // Try npx
    try {
      execSync('npx mcporter --help', { stdio: 'pipe', timeout: 10000 });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Get the mcporter command (direct or via npx).
 */
function getMcporterCommand(): { command: string; prefix: string[] } {
  try {
    execSync('which mcporter', { stdio: 'pipe' });
    return { command: 'mcporter', prefix: [] };
  } catch {
    return { command: 'npx', prefix: ['mcporter'] };
  }
}

/**
 * Run a mcporter CLI command and return stdout.
 */
export function runMcporter(
  args: string[],
  options: { timeout?: number; cwd?: string } = {},
): string {
  const { command, prefix } = getMcporterCommand();
  const fullArgs = [...prefix, ...args, '--config', MCPORTER_CONFIG_PATH];
  const result = execSync(`${command} ${fullArgs.join(' ')}`, {
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: options.timeout || 30000,
    cwd: options.cwd,
    encoding: 'utf-8',
  });
  return result.trim();
}

// ─── Config Management ───────────────────────────────────────────────────────

/**
 * Initialize mcporter config directory and file if not exists.
 */
export function ensureMcporterConfig(): void {
  fs.mkdirSync(MCPORTER_CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(MCPORTER_CONFIG_PATH)) {
    fs.writeFileSync(
      MCPORTER_CONFIG_PATH,
      JSON.stringify({ servers: {} }, null, 2),
      { mode: 0o600 },
    );
    logger.info('Created mcporter config at: ' + MCPORTER_CONFIG_PATH);
  }
}

/**
 * Load mcporter config.
 */
export function loadMcporterConfig(): McporterConfig {
  ensureMcporterConfig();
  try {
    return JSON.parse(fs.readFileSync(MCPORTER_CONFIG_PATH, 'utf-8'));
  } catch {
    return { servers: {} };
  }
}

/**
 * Add a server to mcporter config.
 */
export function addMcporterServer(
  name: string,
  entry: McporterServerEntry,
): void {
  ensureMcporterConfig();
  try {
    runMcporter([
      'config',
      'add',
      name,
      entry.url || '',
      ...(entry.lifecycle ? ['--lifecycle', entry.lifecycle] : []),
    ]);
    logger.info(`Added mcporter server: ${name}`);
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      `Failed to add mcporter server: ${name}`,
    );
    throw err;
  }
}

/**
 * List configured mcporter servers.
 */
export function listMcporterServers(): string[] {
  try {
    const output = runMcporter(['list', '--json']);
    const parsed = JSON.parse(output);
    return Array.isArray(parsed)
      ? parsed.map((s: { name?: string }) => s.name || '')
      : Object.keys(parsed);
  } catch {
    return [];
  }
}

// ─── Auth ────────────────────────────────────────────────────────────────────

/**
 * Check if a server needs authentication.
 * Returns true if the server requires auth but hasn't been authenticated yet.
 */
export function needsAuth(serverName: string): boolean {
  try {
    // Try listing tools - if it fails with auth error, needs auth
    runMcporter(['list', serverName, '--json'], { timeout: 15000 });
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return (
      msg.includes('401') ||
      msg.includes('unauthorized') ||
      msg.includes('auth') ||
      msg.includes('OAuth')
    );
  }
}

/**
 * Initiate mcporter auth flow for a server.
 * This will attempt OAuth via mcporter which handles PRM discovery.
 *
 * In headless mode, mcporter may output a device code / URL that needs
 * to be forwarded to the user.
 *
 * @param serverName - mcporter server name
 * @param onAuthPrompt - callback to forward auth instructions to user
 * @returns true if auth succeeded
 */
export async function authenticateServer(
  serverName: string,
  onAuthPrompt?: (message: string) => Promise<void>,
): Promise<boolean> {
  return new Promise((resolve) => {
    const { command, prefix } = getMcporterCommand();
    const args = [
      ...prefix,
      'auth',
      serverName,
      '--config',
      MCPORTER_CONFIG_PATH,
    ];

    logger.info(`Starting mcporter auth for: ${serverName}`);

    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120000,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', async (data: Buffer) => {
      const text = data.toString();
      stdout += text;

      // Look for device code / URL patterns to forward to user
      if (onAuthPrompt) {
        // mcporter typically outputs auth instructions to stdout
        const urlMatch = text.match(
          /https?:\/\/[^\s]+(?:device|login|authorize)[^\s]*/i,
        );
        const codeMatch = text.match(/code[:\s]+([A-Z0-9-]{6,})/i);

        if (urlMatch || codeMatch) {
          await onAuthPrompt(
            `🔐 MCP server "${serverName}" requires login:\n${text.trim()}`,
          );
        }
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        logger.info(`mcporter auth succeeded for: ${serverName}`);
        resolve(true);
      } else {
        logger.warn(
          `mcporter auth failed for ${serverName}: ${stderr || stdout}`,
        );
        resolve(false);
      }
    });

    proc.on('error', (err) => {
      logger.error(
        { err: err.message },
        `mcporter auth process error for: ${serverName}`,
      );
      resolve(false);
    });
  });
}

// ─── Daemon ──────────────────────────────────────────────────────────────────

/**
 * Start mcporter daemon to keep MCP server connections alive.
 */
export function startDaemon(): boolean {
  try {
    runMcporter(['daemon', 'start'], { timeout: 10000 });
    logger.info('mcporter daemon started');
    return true;
  } catch (err) {
    logger.warn(
      `mcporter daemon start failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Check if mcporter daemon is running.
 */
export function isDaemonRunning(): boolean {
  try {
    const output = runMcporter(['daemon', 'status']);
    return output.toLowerCase().includes('running');
  } catch {
    return false;
  }
}

/**
 * Stop mcporter daemon.
 */
export function stopDaemon(): void {
  try {
    runMcporter(['daemon', 'stop']);
    logger.info('mcporter daemon stopped');
  } catch {
    // ignore
  }
}

// ─── MCP Server Config for nanoclaw ──────────────────────────────────────────

/**
 * Generate an MCP server config entry that uses mcporter as a local stdio proxy.
 * This can be added to the session's mcpServers so the GHC CLI connects
 * to mcporter and gets all configured remote MCP tools through it.
 */
export function getMcporterMcpConfig(): McporterMcpServerConfig | null {
  if (!isMcporterInstalled()) {
    logger.debug('mcporter not installed, skipping');
    return null;
  }

  const config = loadMcporterConfig();
  if (Object.keys(config.servers).length === 0) {
    logger.debug('No mcporter servers configured, skipping');
    return null;
  }

  const { command, prefix } = getMcporterCommand();

  return {
    type: 'local',
    command,
    args: [
      ...prefix,
      'daemon',
      'start',
      '--foreground',
      '--config',
      MCPORTER_CONFIG_PATH,
    ],
    tools: ['*'],
  };
}

/**
 * Sync servers from ~/.nanoclaw/mcp.json into mcporter config.
 * This allows users to keep using mcp.json for server definitions
 * while mcporter handles auth and connections.
 */
export function syncFromMcpJson(): void {
  const mcpJsonPath = path.join(NANOCLAW_DIR, 'mcp.json');
  if (!fs.existsSync(mcpJsonPath)) return;

  try {
    const mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
    const servers = mcpConfig.mcpServers || mcpConfig;
    const existingServers = listMcporterServers();

    for (const [name, server] of Object.entries(servers)) {
      const s = server as { type?: string; url?: string };
      // Only sync remote HTTP/SSE servers (mcporter handles auth for these)
      if (s.type === 'http' || s.type === 'sse') {
        if (!existingServers.includes(name) && s.url) {
          try {
            addMcporterServer(name, { url: s.url, lifecycle: 'keep-alive' });
            logger.info(`Synced MCP server to mcporter: ${name}`);
          } catch {
            // ignore individual sync failures
          }
        }
      }
    }
  } catch (err) {
    logger.warn(
      `Failed to sync mcp.json to mcporter: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── High-level Integration ──────────────────────────────────────────────────

/**
 * Initialize mcporter integration:
 * 1. Ensure mcporter config exists
 * 2. Sync remote servers from mcp.json
 * 3. Start daemon if servers are configured
 *
 * Call this on nanoclaw startup.
 */
export async function initializeMcporter(
  onAuthPrompt?: (serverName: string, message: string) => Promise<void>,
): Promise<void> {
  if (!isMcporterInstalled()) {
    logger.info(
      'mcporter not installed. Install with: npm install -g mcporter',
    );
    return;
  }

  ensureMcporterConfig();
  syncFromMcpJson();

  const servers = listMcporterServers();
  if (servers.length === 0) {
    logger.debug('No mcporter servers configured');
    return;
  }

  // Check auth for each server
  for (const server of servers) {
    if (needsAuth(server)) {
      logger.info(`Server ${server} needs auth`);
      if (onAuthPrompt) {
        const success = await authenticateServer(server, (msg) =>
          onAuthPrompt(server, msg),
        );
        if (!success) {
          logger.warn(`Auth failed for ${server}, skipping`);
        }
      }
    }
  }

  // Start daemon
  if (!isDaemonRunning()) {
    startDaemon();
  }
}
