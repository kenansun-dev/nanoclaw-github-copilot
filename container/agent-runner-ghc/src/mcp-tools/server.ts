/**
 * MCP server bootstrap + shared GHC IPC helpers.
 *
 * Each tool module imports `getServer()` and calls `server.tool(...)`
 * at module-scope (matches the GHC current shape, plays well with
 * `memory-tools.ts` whose API expects an `McpServer`). The barrel
 * (`./index.ts`) imports every tool module for side effects and then
 * calls `startMcpServer()`.
 *
 * Shared GHC environment + IPC writes live here so all tool modules can
 * use them without re-deriving paths from env vars.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// IPC paths (preserved from ipc-mcp-stdio.ts)
// ---------------------------------------------------------------------------

export const IPC_DIR = process.env.NANOCLAW_IPC_DIR
  ? path.dirname(process.env.NANOCLAW_IPC_DIR) // points to input/, go up one level
  : '/workspace/ipc';
export const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
export const TASKS_DIR = path.join(IPC_DIR, 'tasks');
export const RESPONSES_DIR = path.join(IPC_DIR, 'responses');

// ---------------------------------------------------------------------------
// Per-process context (preserved from ipc-mcp-stdio.ts)
// ---------------------------------------------------------------------------

export const chatJid = process.env.NANOCLAW_CHAT_JID!;
export const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
// v2-only (PR #49): NANOCLAW_IS_DEFAULT_AGENT is the sole signal.
// Legacy NANOCLAW_IS_MAIN env was retired alongside the v1 isMain field.
export const isDefaultAgent = process.env.NANOCLAW_IS_DEFAULT_AGENT === '1';

// Operator = default-agent OR owner (host-resolved via isOwner, since only
// the host has DB access to user_roles). Drives the `list_tasks` read
// filter so an owner chatting from a non-default-agent folder still sees
// every group's tasks — parity with the owner view `/tasks` grants and the
// owner-override the write-path IPC gates already apply. Falls back to
// isDefaultAgent when the env is absent (older host writing new snapshot).
export const isOperator = process.env.NANOCLAW_IS_OPERATOR === '1' || process.env.NANOCLAW_IS_DEFAULT_AGENT === '1';

// Channel-qualified user id of the user whose latest message triggered
// this turn (e.g. `telegram:8731187021`). Stamped onto IPC payloads so
// the host can apply isOwner privilege gates without re-deriving identity.
// Empty env => undefined (HR list #3, 2026-05-16 isOwner phase 1).
export const triggeringUserId: string | undefined = process.env.NANOCLAW_TRIGGERING_USER_ID || undefined;

// ---------------------------------------------------------------------------
// Atomic IPC file write (preserved verbatim)
// ---------------------------------------------------------------------------

export function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

// ---------------------------------------------------------------------------
// Shared singleton McpServer + bootstrap
// ---------------------------------------------------------------------------

let _server: McpServer | null = null;

/** Get (and lazily create) the shared MCP server instance. */
export function getServer(): McpServer {
  if (!_server) {
    _server = new McpServer({ name: 'nanoclaw', version: '1.0.0' });
  }
  return _server;
}

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

/** Connect the shared server over stdio. */
export async function startMcpServer(): Promise<void> {
  const server = getServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('MCP server started');
}
