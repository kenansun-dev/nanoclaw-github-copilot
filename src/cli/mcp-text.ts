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
  status?: 'connected' | 'auth-pending' | 'error' | 'unknown';
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

/** Render options. `ascii: true` swaps Unicode glyphs (✓ ! ✗ ? ─) for
 *  ASCII-safe equivalents (`[OK] [!] [X] [?]` / `-`). Channels with
 *  poor Unicode rendering (Teams in code blocks) should pass
 *  `ascii: true`; Telegram + Discord + plain CLI keep the default. */
export interface FormatOptions {
  ascii?: boolean;
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
export function formatMcpList(
  info: McpListInfo,
  opts: FormatOptions = {},
): string {
  const ascii = opts.ascii === true;
  const lines: string[] = [];
  const n = info.servers.length;
  const ruleChar = ascii ? '-' : '─';
  const okGlyph = ascii ? '[OK]' : '✓';
  const authGlyph = ascii ? '[!] ' : '!';
  const errGlyph = ascii ? '[X] ' : '✗';
  const unkGlyph = ascii ? '[?] ' : '?';

  lines.push(`MCP Servers (${n} configured)`);
  lines.push(ruleChar.repeat(42));

  if (n === 0) {
    lines.push('(no servers configured)');
    lines.push('');
    lines.push(
      `Add via:  edit ${info.mcpJsonPath}  or  nanoclaw config set mcp.servers.<name>.url=...`,
    );
  } else {
    const nameW = Math.max(4, ...info.servers.map((s) => s.name.length));
    const typeW = Math.max(4, ...info.servers.map((s) => s.type.length));
    for (const s of info.servers) {
      const glyph =
        s.status === 'connected'
          ? okGlyph
          : s.status === 'auth-pending'
            ? authGlyph
            : s.status === 'error'
              ? errGlyph
              : unkGlyph;
      const name = s.name.padEnd(nameW);
      const type = s.type.padEnd(typeW);
      const tail = s.statusDetail ? `  (${s.statusDetail})` : '';
      lines.push(`${glyph} ${name}  ${type}  ${s.transport}${tail}`);
    }
  }

  lines.push('');
  lines.push(`Source: ${info.configPath} + ${info.mcpJsonPath}`);
  const mc = info.mcporterInstalled
    ? `installed${info.mcporterDaemon === undefined ? '' : ` (daemon: ${info.mcporterDaemon ? 'running' : 'stopped'})`}`
    : 'not installed';
  lines.push(`mcporter: ${mc}`);
  lines.push('');
  lines.push(
    `Legend: ${okGlyph} connected  ${authGlyph} auth-pending  ${errGlyph} error  ${unkGlyph} unknown (run \`/mcp probe\` to check)`,
  );

  return lines.join('\n');
}

/** One-shot helper used by both CLI and slash command. */
export async function getMcpText(
  probe: boolean = false,
  opts: FormatOptions = {},
): Promise<string> {
  const info = await collectMcpList(probe);
  return formatMcpList(info, opts);
}
