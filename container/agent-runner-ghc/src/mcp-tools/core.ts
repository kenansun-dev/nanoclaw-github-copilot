/**
 * Core IPC tools (no host round-trip).
 *
 * Maps to upstream `container/agent-runner/src/mcp-tools/core.ts` slot.
 * Tools: send_message, react, send_file, register_group.
 *
 * These all write a single IPC file (via writeIpcFile) and return
 * immediately — there is no response polling. The host watcher picks
 * up the file and acts on it asynchronously.
 */
import { z } from 'zod';
import {
  getServer,
  writeIpcFile,
  MESSAGES_DIR,
  TASKS_DIR,
  chatJid,
  groupFolder,
  isDefaultAgent,
} from './server.js';

const server = getServer();

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
  'react',
  'React to a message with an emoji. Use this to acknowledge messages, show appreciation, or express emotions without a full text reply. Teams supports: like, heart, laugh, surprised, sad, angry.',
  {
    emoji: z.string().describe('Emoji name or character (e.g. "like", "heart", "laugh", "👍", "❤️")'),
    messageId: z
      .string()
      .optional()
      .describe('Message ID to react to (defaults to the last received message)'),
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
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z
      .string()
      .describe(
        'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
      ),
    name: z.string().describe('Display name for the group'),
    folder: z
      .string()
      .describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isDefaultAgent) {
      return {
        content: [
          { type: 'text' as const, text: 'Only the main group can register new groups.' },
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
