/**
 * mcp-text.ts — shared formatter for `/mcp` slash command + `nanoclaw mcp` CLI.
 *
 * Lists MCP servers configured for the agent (merged from nanoclaw.json +
 * mcp.json) with type, transport details, and best-effort connection status.
 *
 * Mirrors `claude mcp` / `gh copilot mcp list` output shape so users get a
 * familiar view across CC, GHC, and nanoclaw chat surfaces.
 *
 * Design rules (same as status-text.ts):
 *   - **No execSync, no network on the hot path.** File-only read so chat
 *     latency is <50ms. mcporter probing (if any) is opt-in via the
 *     `probe` flag and bounded by a short timeout.
 *   - **No throws.** Missing / malformed config degrades to "no servers
 *     configured" rather than blowing up — `/mcp` is itself a diagnostic.
 *   - **Returns a string.** Caller decides stdout vs chat.
 */

export interface McpServerInfo {
  name: string;
  type: string; // 'stdio' | 'http' | 'sse' | 'unknown'
  transport: string; // human-readable: "node script.js", "https://...", etc.
  source: 'nanoclaw.json' | 'mcp.json' | 'merged';
  status?: 'connected' | 'auth-pending' | 'error' | 'local' | 'unknown';
  statusDetail?: string;
}

export interface McpListInfo {
  servers: McpServerInfo[];
  configPath: string;
  mcpJsonPath: string;
  mcporterInstalled: boolean;
  mcporterDaemon?: boolean;
}

/**
 * Collect MCP server list — fast file-only read.
 *
 * @param probe — when true, runs `mcporter list --json` to enrich status
 *   for servers known to mcporter. Adds ~100ms-2s; off by default.
 */
export async function collectMcpList(
  probe: boolean = false,
): Promise<McpListInfo> {
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
      status: 'unknown',
    });
  }

  let mcporterInstalled = false;
  let mcporterDaemon: boolean | undefined;
  if (probe) {
    try {
      const m = await import('../mcporter-integration.js');
      mcporterInstalled = m.isMcporterInstalled();
      if (mcporterInstalled) {
        try {
          mcporterDaemon = m.isDaemonRunning();
        } catch {
          mcporterDaemon = false;
        }
        let known: string[] = [];
        try {
          known = m.listMcporterServers();
        } catch {
          known = [];
        }
        const knownSet = new Set(known);
        for (const s of servers) {
          if (knownSet.has(s.name)) {
            try {
              const needs = m.needsAuth(s.name);
              s.status = needs ? 'auth-pending' : 'connected';
            } catch {
              s.status = 'error';
              s.statusDetail = 'probe failed';
            }
          } else {
            // Configured locally but not registered with mcporter — no live
            // signal possible (server is started by the agent runtime, not
            // managed by mcporter). Distinct from 'unknown' so users can
            // tell apart "didn't probe" vs "can't probe".
            s.status = 'local';
          }
        }
      }
    } catch {
      // mcporter-integration not loadable — leave defaults
    }
  } else {
    try {
      const m = await import('../mcporter-integration.js');
      mcporterInstalled = m.isMcporterInstalled();
    } catch {
      mcporterInstalled = false;
    }
  }

  return {
    servers,
    configPath: paths.config,
    mcpJsonPath: paths.mcpConfig,
    mcporterInstalled,
    mcporterDaemon,
  };
}

/**
 * Format an McpListInfo as a plain-text block for chat / CLI display.
 *
 * Output shape (CC `/mcp` style):
 *
 *   MCP Servers (3 configured)
 *   ──────────────────────────────────────
 *   ✓ github         http   https://api.githubcopilot.com/mcp/
 *   ? memory         stdio  npx -y @modelcontextprotocol/server-memory
 *   ! linear         http   https://mcp.linear.app/sse  (auth-pending)
 *
 *   Source: ~/.nanoclaw/nanoclaw.json + ~/.nanoclaw/mcp.json
 *   mcporter: installed (daemon: running)
 */
export interface FormatOptions {
  /** Wrap body in a triple-backtick code fence so chat surfaces (Telegram /
   *  Discord) render monospace and preserve column alignment. CLI passes
   *  false. Default: true. */
  codeFence?: boolean;
  /** When false, suppress the status glyph column entirely (no point
   *  showing all `?` when status wasn't probed). Default: true. */
  showStatus?: boolean;
}

export function formatMcpList(
  info: McpListInfo,
  opts: FormatOptions = {},
): string {
  const codeFence = opts.codeFence ?? true;
  const showStatus = opts.showStatus ?? true;
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
      const glyph = !showStatus
        ? ''
        : s.status === 'connected'
          ? '✓'
          : s.status === 'auth-pending'
            ? '!'
            : s.status === 'error'
              ? '✗'
              : s.status === 'local'
                ? '○'
                : '?';
      const name = s.name.padEnd(nameW);
      const type = s.type.padEnd(typeW);
      const tail = s.statusDetail ? `  (${s.statusDetail})` : '';
      const prefix = showStatus ? `${glyph} ` : '';
      body.push(`${prefix}${name}  ${type}  ${s.transport}${tail}`);
    }
  }

  body.push('');
  body.push(`Source: ${info.configPath} + ${info.mcpJsonPath}`);
  const mc = info.mcporterInstalled
    ? `installed${info.mcporterDaemon === undefined ? '' : ` (daemon: ${info.mcporterDaemon ? 'running' : 'stopped'})`}`
    : 'not installed';
  body.push(`mcporter: ${mc}`);
  if (showStatus) {
    body.push('');
    body.push(
      'Legend: ✓ connected  ! auth-pending  ✗ error  ○ local (not mcporter-managed)',
    );
  }

  const text = body.join('\n');
  return codeFence ? '```\n' + text + '\n```' : text;
}

/** One-shot helper used by both CLI and slash command.
 *
 * @param probe — query mcporter for live status (default true; ~100ms-2s).
 *   Set to false for the fast no-probe view (omits status glyph column).
 * @param codeFence — wrap output in ``` fence for chat rendering. Default true.
 */
export async function getMcpText(
  probe: boolean = true,
  codeFence: boolean = true,
): Promise<string> {
  const info = await collectMcpList(probe);
  return formatMcpList(info, { codeFence, showStatus: probe });
}
