/**
 * Shared MCP tool types for the GHC agent-runner.
 *
 * Mirrors `container/agent-runner/src/mcp-tools/types.ts` from upstream
 * `feat/migrate-from-v1` so future syncs stay easy. The GHC variant keeps
 * its own `server.ts` that uses the high-level `McpServer` builder
 * (instead of upstream's low-level `Server` + manual request handlers)
 * because our `memory-tools.ts` is built against `McpServer.tool(...)`.
 */
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface McpToolDefinition {
  tool: Tool;
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}
