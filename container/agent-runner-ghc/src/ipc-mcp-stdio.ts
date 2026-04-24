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

const IPC_DIR = process.env.NANOCLAW_IPC_DIR
  ? path.dirname(process.env.NANOCLAW_IPC_DIR)  // NANOCLAW_IPC_DIR points to input/, go up one level
  : '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESPONSES_DIR = path.join(IPC_DIR, 'responses');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

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
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
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
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
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
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
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
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
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
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
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
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
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
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// Start the stdio transport
// React to a message with an emoji
server.tool(
  'react',
  'React to a message with an emoji. Use this to acknowledge messages, show appreciation, or express emotions without a full text reply. Teams supports: like, heart, laugh, surprised, sad, angry.',
  {
    emoji: z.string().describe('Emoji name or character (e.g. "like", "heart", "laugh", "👍", "❤️")'),
    messageId: z.string().optional().describe('Message ID to react to (defaults to the last received message)'),
  },
  async (args) => {
    const data = {
      type: 'react',
      chatJid,
      emoji: args.emoji,
      messageId: args.messageId,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return {
      content: [{ type: 'text' as const, text: `Reacted with ${args.emoji}` }],
    };
  },
);

server.tool(
  'send_file',
  'Send a file to the user or group. The file must exist in your working directory or uploads directory.',
  {
    file_path: z.string().describe('Absolute path to the file to send'),
    filename: z.string().optional().describe('Display filename (defaults to the file basename)'),
  },
  async (args) => {
    const data = {
      type: 'send_file',
      chatJid,
      filePath: args.file_path,
      filename: args.filename,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MESSAGES_DIR, data);
    return {
      content: [{ type: 'text' as const, text: `File sent: ${args.filename || args.file_path}` }],
    };
  },
);

server.tool(
  'nanoclaw_control',
  'Control the NanoClaw host service. Available actions: restart, reload_config, set_config. ' +
    'IMPORTANT: For adding/removing MCP servers, prefer the `nanoclaw mcp add <name> <url>` / `nanoclaw mcp remove <name>` CLI commands — they auto-reload the daemon, no restart needed. ' +
    'Use `reload_config` after manual edits to `nanoclaw.json` or `mcp.json`. ' +
    'Use `set_config` to change a single config field (saves + reloads in one step). ' +
    'Only use `restart` for things that genuinely need it: channel auth tokens, port bindings, sandbox image rebuilds, or nanoclaw itself updates. ' +
    'When in doubt, prefer reload over restart. Only available in main chat.',
  {
    action: z.enum(['restart', 'reload_config', 'set_config']).describe(
      'Action to perform: restart (restart nanoclaw service), reload_config (reload nanoclaw.json without restart), set_config (change a config value)',
    ),
    config_path: z
      .string()
      .optional()
      .describe('Config field path for set_config (e.g. "agents.defaults.model")'),
    config_value: z
      .string()
      .optional()
      .describe('New value for set_config (JSON string)'),
  },
  async (args) => {
    // Only main group can use control commands
    if (!isMain) {
      return {
        content: [
          { type: 'text' as const, text: 'Error: nanoclaw_control is only available in the main chat. This chat is not the main chat, so control commands (restart, config changes) are not allowed.' },
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
      restart: 'Restart signal sent. NanoClaw will restart — your current session will end. Changes take effect on next message.',
      reload_config: 'Config reload signal sent.',
      set_config: `Config update sent: ${args.config_path} = ${args.config_value}`,
    };
    return {
      content: [
        { type: 'text' as const, text: messages[args.action] || 'Control signal sent.' },
      ],
    };
  },
);

// Memory tools (per-group MEMORY.md + daily journals).
// Source of truth: container/shared/memory-tools.ts (build-time copied here).
registerMemoryTools(server);

server.tool(
  'nanoclaw_plugin',
  'List, install, or uninstall NanoClaw plugins. Plugins are bundles of skills + ' +
    'MCP servers + agents that extend NanoClaw, declared in nanoclaw.json under ' +
    '`plugins.enabled[]`. Source formats supported: `name@marketplace`, ' +
    '`owner/repo[:subdir]`, full git URL, local path. ' +
    'Read-only actions (list, marketplace_list) work everywhere; install/uninstall ' +
    'are restricted to the main chat for safety. After install, restart the daemon ' +
    'with nanoclaw_control(restart) for new MCP servers to load; pure-skill plugins ' +
    'are picked up on the next agent invocation.',
  {
    action: z
      .enum(['list', 'install', 'uninstall', 'marketplace_list'])
      .describe(
        'list = enumerate installed plugins. install = add to plugins.enabled[] and fetch (requires source). uninstall = remove from plugins.enabled[] and delete plugin dir (requires name). marketplace_list = show registered marketplaces.',
      ),
    name: z
      .string()
      .optional()
      .describe('Plugin name (required for install when source is a URL/path with no obvious name; required for uninstall).'),
    source: z
      .string()
      .optional()
      .describe('Install spec: `name@marketplace`, `owner/repo[:subdir]`, git URL, or local path.'),
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
          text = 'No plugins installed. Use `nanoclaw_plugin install` with a source to add one, or list marketplaces with `marketplace_list`.';
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
            `Failed:\n${failed
              .map((f: { name: string; error: string }) => `  - ${f.name}: ${f.error}`)
              .join('\n')}`,
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
          text = 'No marketplaces registered. Use `nanoclaw plugin marketplace add <source>` (CLI) to register one.';
        } else {
          text =
            `Registered marketplaces (${ms.length}):\n` +
            ms.map((m: any) => `  - ${m.name}: ${m.source}`).join('\n');
        }
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
