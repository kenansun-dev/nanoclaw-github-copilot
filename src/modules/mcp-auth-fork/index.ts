/**
 * MCP auth (fork add-on) — module skeleton.
 *
 * Thin v2-shaped re-export of the fork's existing `src/mcp-auth.ts`
 * (OAuth PRM discovery + device-code flow + token cache for remote
 * MCP servers) and `src/mcporter-integration.ts` (mcporter CLI as
 * MCP proxy daemon). Both modules are orphan in v2-merge today —
 * nothing imports them yet — and exist so wire-up phases (C-step4
 * agent-runner main + B.5 router merge) have a stable v2 module
 * path to depend on.
 *
 * Why a separate "fork add-on" module instead of folding into v2
 * permissions/: v2 `permissions/` governs *who can talk to the
 * agent* (sender / channel access gates). MCP auth governs *who the
 * agent can talk to* (outbound MCP server credentials). Different
 * direction, different lifecycle, different storage path
 * (~/.nanoclaw/credentials/mcp-tokens.json vs the messages db).
 * Keeping them separate avoids conflating the two access surfaces.
 *
 * Wiring plan:
 *   - C-step4 (agent-runner main): before container launch, call
 *     `mcpAuthFork.resolveTokensForMcpServers(servers)` to inject
 *     `Authorization: Bearer <tok>` headers into HTTP-mode MCP
 *     servers. Also expose mcporter as an additional stdio MCP
 *     server when `isMcporterInstalled()` returns true.
 *   - B.5 (router merge) does NOT touch this — MCP auth has nothing
 *     to do with inbound routing.
 *
 * Until wire-up: importing this module is a no-op other than
 * re-export.
 */
import {
  loadMcpConfig,
  loadTokenCache,
  resolveTokensForMcpServers,
  saveTokenCache,
  type McpAuthConfig,
  type McpServerConfig,
} from '../../mcp-auth.js';
import {
  addMcporterServer,
  ensureMcporterConfig,
  isMcporterInstalled,
  listMcporterServers,
  loadMcporterConfig,
  needsAuth as mcporterNeedsAuth,
  runMcporter,
  type McporterConfig,
  type McporterMcpServerConfig,
  type McporterServerEntry,
} from '../../mcporter-integration.js';

export const mcpAuthFork = {
  // mcp-auth (PRM/device-code flow)
  loadMcpConfig,
  loadTokenCache,
  saveTokenCache,
  resolveTokensForMcpServers,
  // mcporter-integration (CLI proxy daemon)
  isMcporterInstalled,
  ensureMcporterConfig,
  loadMcporterConfig,
  addMcporterServer,
  listMcporterServers,
  mcporterNeedsAuth,
  runMcporter,
};

export type {
  McpAuthConfig,
  McpServerConfig,
  McporterConfig,
  McporterMcpServerConfig,
  McporterServerEntry,
};
