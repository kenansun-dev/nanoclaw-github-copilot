/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import { registerMemoryTools } from './memory-tools.js';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESPONSES_DIR = path.join(IPC_DIR, 'responses');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
// v2-only (PR #49): NANOCLAW_IS_DEFAULT_AGENT is the sole signal.
// Legacy NANOCLAW_IS_MAIN env was retired alongside the v1 isMain field.
const isDefaultAgent = process.env.NANOCLAW_IS_DEFAULT_AGENT === '1';
// Operator = default-agent OR owner (host-resolved via isOwner). Drives the
// `list_tasks` read filter so an owner chatting from a non-default-agent
// folder still sees every group's tasks. Falls back to isDefaultAgent when
// the env is absent (older host writing a new snapshot).
const isOperator = process.env.NANOCLAW_IS_OPERATOR === '1' || process.env.NANOCLAW_IS_DEFAULT_AGENT === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z
      .string()
      .optional()
      .describe(
        'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
      ),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z
      .string()
      .describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z
      .string()
      .describe(
        'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
      ),
    context_mode: z
      .enum(['group', 'isolated'])
      .default('group')
      .describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z
      .string()
      .optional()
      .describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
    script: z
      .string()
      .optional()
      .describe(
        'Optional bash script to run before waking the agent. Script must output JSON on the last line of stdout: { "wakeAgent": boolean, "data"?: any }. If wakeAgent is false, the agent is not called. Test your script with bash -c "..." before scheduling.',
      ),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isDefaultAgent && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      script: args.script || undefined,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
        },
      ],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return {
          content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }],
        };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isOperator
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }],
        };
      }

      const formatted = tasks
        .map(
          (t: {
            id: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return {
        content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isDefaultAgent,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} pause requested.`,
        },
      ],
    };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isDefaultAgent,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} resume requested.`,
        },
      ],
    };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isDefaultAgent,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} cancellation requested.`,
        },
      ],
    };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
    script: z.string().optional().describe('New script for the task. Set to empty string to remove the script.'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid cron: "${args.schedule_value}".`,
              },
            ],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isDefaultAgent: String(isDefaultAgent),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.script !== undefined) data.script = args.script;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} update requested.`,
        },
      ],
    };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z
      .string()
      .describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    requiresTrigger: z
      .boolean()
      .optional()
      .describe(
        'Whether messages must start with the trigger word. Default: false (respond to all messages). Set to true for busy groups with many participants where you only want the agent to respond when explicitly mentioned.',
      ),
  },
  async (args) => {
    if (!isDefaultAgent) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can register new groups.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      requiresTrigger: args.requiresTrigger ?? false,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
        },
      ],
    };
  },
);

// Start the stdio transport
// Memory tools (per-group MEMORY.md + daily journals).
// Source of truth: container/shared/memory-tools.ts (build-time copied here).
registerMemoryTools(server);

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
        content: [{ type: 'text' as const, text: `Error: ${response.error ?? 'unknown plugin operation failure'}` }],
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

const transport = new StdioServerTransport();
await server.connect(transport);
