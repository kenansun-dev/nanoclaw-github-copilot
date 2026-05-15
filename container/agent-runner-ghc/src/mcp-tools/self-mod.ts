/**
 * Self-modification tools (host control + plugin management).
 *
 * Maps to upstream `container/agent-runner/src/mcp-tools/self-mod.ts` slot.
 * Tools: nanoclaw_control, nanoclaw_plugin.
 *
 * `nanoclaw_plugin` is the only tool here that polls for a host response
 * (`<RESPONSES_DIR>/<requestId>.json`); everything else is fire-and-forget.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { getServer, writeIpcFile, MESSAGES_DIR, RESPONSES_DIR, isDefaultAgent } from './server.js';

const server = getServer();

server.tool(
  'nanoclaw_control',
  'Control the NanoClaw host service. Available actions: restart, reload_config, set_config. ' +
    'IMPORTANT: For adding/removing MCP servers, prefer the `nanoclaw mcp add <name> <url>` / `nanoclaw mcp remove <name>` CLI commands — they auto-reload the daemon, no restart needed. ' +
    'Use `reload_config` after manual edits to `nanoclaw.json` or `mcp.json`. ' +
    'Use `set_config` to change a single config field (saves + reloads in one step). ' +
    'Only use `restart` for things that genuinely need it: channel auth tokens, port bindings, sandbox image rebuilds, or nanoclaw itself updates. ' +
    'When in doubt, prefer reload over restart. Only available in main chat.',
  {
    action: z
      .enum(['restart', 'reload_config', 'set_config'])
      .describe(
        'Action to perform: restart (restart nanoclaw service), reload_config (reload nanoclaw.json without restart), set_config (change a config value)',
      ),
    config_path: z.string().optional().describe('Config field path for set_config (e.g. "agents.defaults.model")'),
    config_value: z.string().optional().describe('New value for set_config (JSON string)'),
  },
  async (args) => {
    if (!isDefaultAgent) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Error: nanoclaw_control is only available in the main chat. This chat is not the main chat, so control commands (restart, config changes) are not allowed.',
          },
        ],
      };
    }
    const data = {
      type: 'control',
      action: args.action,
      configPath: args.config_path,
      configValue: args.config_value,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MESSAGES_DIR, data);
    const messages: Record<string, string> = {
      restart:
        'Restart signal sent. NanoClaw will restart — your current session will end. Changes take effect on next message.',
      reload_config: 'Config reload signal sent.',
      set_config: `Config update sent: ${args.config_path} = ${args.config_value}`,
    };
    return {
      content: [{ type: 'text' as const, text: messages[args.action] || 'Control signal sent.' }],
    };
  },
);

server.tool(
  'nanoclaw_plugin',
  'List, install, or uninstall NanoClaw plugins, and manage plugin marketplaces. ' +
    'Plugins are bundles of skills + MCP servers + agents that extend NanoClaw, ' +
    'declared in nanoclaw.json under `plugins.enabled[]`. ' +
    'Source formats supported: `name@marketplace`, `owner/repo[:subdir]`, full git URL, local path. ' +
    'Typical workflow for a marketplace plugin: (1) `marketplace_add` with the marketplace repo (e.g. `owner/marketplace-repo`), ' +
    '(2) `marketplace_browse` to see available plugins, (3) `install` with `source: "plugin-name@marketplace-name"`. ' +
    'Two marketplaces are auto-known and need no add: `copilot-plugins` and `awesome-copilot`. ' +
    'Read-only actions (list, marketplace_list, marketplace_browse) work everywhere; ' +
    'mutating actions (install, uninstall, marketplace_add, marketplace_remove) are restricted to the main chat for safety. ' +
    'After installing a plugin that ships MCP servers, restart the daemon with nanoclaw_control(restart) so the new servers register; ' +
    'pure-skill plugins are picked up on the next agent invocation.',
  {
    action: z
      .enum([
        'list',
        'install',
        'uninstall',
        'marketplace_list',
        'marketplace_add',
        'marketplace_browse',
        'marketplace_remove',
      ])
      .describe(
        'list = enumerate installed plugins. install = add to plugins.enabled[] and fetch (requires source). uninstall = remove from plugins.enabled[] and delete plugin dir (requires name). marketplace_list = show registered marketplaces. marketplace_add = register a new marketplace (requires source; name optional, derived from source). marketplace_browse = list plugins in a registered marketplace (requires name). marketplace_remove = unregister a marketplace (requires name).',
      ),
    name: z
      .string()
      .optional()
      .describe(
        'Plugin or marketplace name (required for uninstall, marketplace_browse, marketplace_remove; optional for install/marketplace_add when derivable from source).',
      ),
    source: z
      .string()
      .optional()
      .describe(
        'Install/registration spec: `name@marketplace`, `owner/repo[:subdir]`, git URL, or local path. Required for install and marketplace_add.',
      ),
  },
  async (args) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const data = {
      type: 'plugin',
      action: args.action,
      name: args.name,
      source: args.source,
      requestId,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MESSAGES_DIR, data);

    // Poll the responses dir for the matching response (host writes
    // <responseDir>/<requestId>.json once handlePluginIpc finishes).
    const responsePath = path.join(RESPONSES_DIR, `${requestId}.json`);
    const start = Date.now();
    const TIMEOUT_MS = 30_000;
    let response: any = null;
    while (Date.now() - start < TIMEOUT_MS) {
      if (fs.existsSync(responsePath)) {
        try {
          response = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
          fs.unlinkSync(responsePath);
          break;
        } catch {
          // Partial write, retry next tick.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (!response) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: nanoclaw_plugin ${args.action} timed out after ${TIMEOUT_MS / 1000}s. The host may not have processed the request \u2014 check IPC watcher logs.`,
          },
        ],
      };
    }

    if (!response.ok) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ${response.error ?? 'unknown plugin operation failure'}`,
          },
        ],
      };
    }

    let text: string;
    switch (args.action) {
      case 'list': {
        const plugins = (response.plugins ?? []) as Array<{
          name: string;
          version?: string;
          description?: string;
          provider?: string;
        }>;
        if (plugins.length === 0) {
          text =
            'No plugins installed. Use `nanoclaw_plugin install` with a source to add one, or list marketplaces with `marketplace_list`.';
        } else {
          text =
            `Installed plugins (${plugins.length}):\n` +
            plugins
              .map(
                (p) =>
                  `  - ${p.name}${p.version ? ` v${p.version}` : ''}${p.provider ? ` (by ${p.provider})` : ''}${p.description ? `\n    ${p.description}` : ''}`,
              )
              .join('\n');
        }
        break;
      }
      case 'install': {
        const installed = response.result?.installed ?? [];
        const skipped = response.result?.skipped ?? [];
        const failed = response.result?.failed ?? [];
        const lines: string[] = [];
        if (installed.length) lines.push(`Installed: ${installed.join(', ')}`);
        if (skipped.length) lines.push(`Already installed (skipped): ${skipped.join(', ')}`);
        if (failed.length) {
          lines.push(
            `Failed:\n${failed.map((f: { name: string; error: string }) => `  - ${f.name}: ${f.error}`).join('\n')}`,
          );
        }
        if (lines.length === 0) lines.push('No changes (entry already declared, no new install).');
        text = `Plugin install complete (added \`${response.name}\` to plugins.enabled[]).\n${lines.join('\n')}\n\nNote: restart the daemon with nanoclaw_control(restart) if this plugin ships MCP servers.`;
        break;
      }
      case 'uninstall': {
        text = `Plugin \`${response.name}\` removed from plugins.enabled[] and deleted from disk.`;
        break;
      }
      case 'marketplace_list': {
        const ms = response.marketplaces ?? [];
        if (ms.length === 0) {
          text =
            'No marketplaces registered. Use `marketplace_add` with `source: "owner/repo"` to register one (or use the auto-known `copilot-plugins` / `awesome-copilot` marketplaces directly).';
        } else {
          text =
            `Registered marketplaces (${ms.length}):\n` + ms.map((m: any) => `  - ${m.name}: ${m.source}`).join('\n');
        }
        break;
      }
      case 'marketplace_add': {
        text = `Registered marketplace \`${response.name}\` (${response.pluginCount} plugins available). Use marketplace_browse to see them, then install with \`source: "<plugin>@${response.name}"\`.`;
        break;
      }
      case 'marketplace_browse': {
        const plugins = (response.plugins ?? []) as Array<{ name: string; version?: string; description?: string }>;
        const header = `Marketplace: ${response.name}${response.description ? ` — ${response.description}` : ''}`;
        if (plugins.length === 0) {
          text = `${header}\n  (no plugins in this marketplace)`;
        } else {
          text =
            `${header}\n` +
            plugins
              .map(
                (p) =>
                  `  📦 ${p.name}${p.version ? ` v${p.version}` : ''}${p.description ? `\n     ${p.description}` : ''}\n     install: source="${p.name}@${response.name}"`,
              )
              .join('\n');
        }
        break;
      }
      case 'marketplace_remove': {
        text = `Unregistered marketplace \`${response.name}\`.`;
        break;
      }
      default:
        text = JSON.stringify(response, null, 2);
    }

    return { content: [{ type: 'text' as const, text }] };
  },
);
