/**
 * MCP tools barrel — imports each tool module for its side-effect
 * `server.tool(...)` registrations, then starts the MCP server over stdio.
 *
 * Adding a new tool module: create the file, register tools at module
 * scope via `getServer().tool(...)`, and append the import here. No
 * central list.
 *
 * Slot mapping vs upstream `container/agent-runner/src/mcp-tools/`:
 *   - core      → core.ts          (send_message, react, send_file, register_group)
 *   - scheduling → scheduling.ts   (schedule_task, list_tasks, pause/resume/cancel/update_task)
 *   - self-mod   → self-mod.ts     (nanoclaw_control, nanoclaw_plugin)
 *   - memory     → memory.ts       (GHC-only; wraps existing memory-tools.ts)
 *   - agents     → (not used in GHC; upstream agent-team tools live host-side here)
 *   - interactive → (not used in GHC; no interactive prompts wired yet)
 */
import './core.js';
import './scheduling.js';
import './self-mod.js';
import './memory.js';
import { startMcpServer } from './server.js';

startMcpServer().catch((err) => {
  console.error(`[mcp-tools] startup error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
