/**
 * mcp-text.ts — shared formatter for `/mcp` slash command + `nanoclaw mcp` CLI.
 *
 * Lists MCP servers configured for the agent (merged from nanoclaw.json +
 * mcp.json) with type and transport details.
 *
 * Mirrors `claude mcp` / `gh copilot mcp list` output shape so users get a
 * familiar view across CC, GHC, and nanoclaw chat surfaces.
 *
 * Design rules (same as status-text.ts):
 *   - **No execSync, no network on the hot path.** File-only read so chat
 *     latency is <50ms.
 *   - **No throws.** Missing / malformed config degrades to "no servers
 *     configured" rather than blowing up — `/mcp` is itself a diagnostic.
 *   - **Returns a string.** Caller decides stdout vs chat.
 *
 * Note: live connection / auth status was previously probed via the
 * `mcporter` CLI. mcporter is no longer wired into the runtime (CC + GHC
 * runners receive `mcpServers` directly through the SDK; remote-server auth
 * is handled by `src/mcp-azure-auth.ts` for Azure AD providers). The probe
 * surface was removed in 2026-05-05.
 */

export interface McpServerInfo {
  name: string;
  type: string; // 'stdio' | 'http' | 'sse' | 'unknown'
  transport: string; // human-readable: "node script.js", "https://...", etc.
  source: 'nanoclaw.json' | 'mcp.json' | 'merged';
}

export interface McpListInfo {
  servers: McpServerInfo[];
  configPath: string;
  mcpJsonPath: string;
}

/**
 * Collect MCP server list — fast file-only read.
 */
export async function collectMcpList(): Promise<McpListInfo> {
  const { loadConfig } = await import('../config-loader.js');
  const { paths } = await import('../workspace.js');

  const servers: McpServerInfo[] = [];
  let cfg: any;
  try {
    cfg = loadConfig();
  } catch {
    cfg = { mcp: { servers: {} } };
  }

  const cfgServers = (cfg?.mcp?.servers ?? {}) as Record<string, any>;
  for (const [name, entry] of Object.entries(cfgServers)) {
    const e = (entry || {}) as any;
    let type = e.type || (e.url ? 'http' : e.command ? 'stdio' : 'unknown');
    let transport: string;
    if (e.url) {
      transport = String(e.url);
    } else if (e.command) {
      const args = Array.isArray(e.args) ? e.args.join(' ') : '';
      transport = `${e.command}${args ? ' ' + args : ''}`;
    } else {
      transport = '(no transport)';
    }
    servers.push({
      name,
      type,
      transport,
      source: 'merged',
    });
  }

  return {
    servers,
    configPath: paths.config,
    mcpJsonPath: paths.mcpConfig,
  };
}

/**
 * Format an McpListInfo as a plain-text block for chat / CLI display.
 *
 * Output shape (CC `/mcp` style):
 *
 *   MCP Servers (3 configured)
 *   ──────────────────────────────────────
 *   github         http   https://api.githubcopilot.com/mcp/
 *   memory         stdio  npx -y @modelcontextprotocol/server-memory
 *   linear         http   https://mcp.linear.app/sse
 *
 *   Source: ~/.nanoclaw/nanoclaw.json + ~/.nanoclaw/mcp.json
 */
export interface FormatOptions {
  /** Wrap body in a triple-backtick code fence so chat surfaces (Telegram /
   *  Discord) render monospace and preserve column alignment. CLI passes
   *  false. Default: true. */
  codeFence?: boolean;
}

export function formatMcpList(info: McpListInfo, opts: FormatOptions = {}): string {
  const codeFence = opts.codeFence ?? true;
  const body: string[] = [];
  const n = info.servers.length;
  body.push(`MCP Servers (${n} configured)`);
  body.push('─'.repeat(42));

  if (n === 0) {
    body.push('(no servers configured)');
    body.push('');
    body.push(`Add via: edit ${info.mcpJsonPath}`);
  } else {
    const nameW = Math.max(4, ...info.servers.map((s) => s.name.length));
    const typeW = Math.max(4, ...info.servers.map((s) => s.type.length));
    for (const s of info.servers) {
      const name = s.name.padEnd(nameW);
      const type = s.type.padEnd(typeW);
      body.push(`${name}  ${type}  ${s.transport}`);
    }
  }

  body.push('');
  body.push(`Source: ${info.configPath} + ${info.mcpJsonPath}`);

  const text = body.join('\n');
  return codeFence ? '```\n' + text + '\n```' : text;
}

/** One-shot helper used by both CLI and slash command.
 *
 * @param codeFence — wrap output in ``` fence for chat rendering. Default true.
 */
export async function getMcpText(codeFence: boolean = true): Promise<string> {
  const info = await collectMcpList();
  return formatMcpList(info, { codeFence });
}
