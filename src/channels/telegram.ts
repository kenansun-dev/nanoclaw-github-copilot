import https from 'https';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { loadConfig } from '../config-loader.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<any> {
  try {
    return await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err: any) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    return await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx: any) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx: any) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // Handle inline keyboard callbacks (e.g., /think level selection)
    this.bot.on('callback_query:data', async (ctx: any) => {
      const data = ctx.callbackQuery.data || '';
      // Parse command:value format
      const colonIdx = data.indexOf(':');
      if (colonIdx > 0) {
        const command = data.substring(0, colonIdx);
        const value = data.substring(colonIdx + 1);
        const chatJid = `tg:${ctx.chat?.id}`;
        const timestamp = new Date().toISOString();
        const senderName = ctx.from?.first_name || 'user';
        // Route as a slash command message
        this.opts.onMessage(chatJid, {
          id: `cb-${Date.now()}`,
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content: `/${command} ${value}`,
          timestamp,
          is_from_me: false,
        });
        // Answer callback to remove loading state
        try {
          await ctx.answerCallbackQuery(`Set ${command} to ${value}`);
        } catch {
          /* */
        }
      }
    });

    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx: any) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Include quoted/replied-to message content so the agent has context
      const replyMsg = ctx.message.reply_to_message;
      const replyText = replyMsg?.text || replyMsg?.caption;
      if (replyText) {
        const replyAuthor =
          replyMsg.from?.first_name || replyMsg.from?.username || 'Someone';
        const truncated =
          replyText.length > 200 ? replyText.slice(0, 200) + '\u2026' : replyText;
        content = `[Replying to ${replyAuthor}: ${truncated}]\n${content}`;
      }

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity: any) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Note: unregistered chats are handled by index.ts (pair instructions)

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', (ctx: any) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx: any) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx: any) =>
      storeNonText(ctx, '[Voice message]'),
    );
    this.bot.on('message:audio', (ctx: any) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', async (ctx: any) => {
      const name = ctx.message.document?.file_name || 'file';
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (group) {
        // Download file to group workspace
        try {
          const fs = await import('fs');
          const path = await import('path');
          const { resolveWorkspace } = await import('../workspace.js');
          const uploadsDir = path.default.join(
            resolveWorkspace(),
            'groups',
            group.folder,
            'uploads',
          );
          fs.default.mkdirSync(uploadsDir, { recursive: true });
          const file = await ctx.getFile();
          const localPath = path.default.join(uploadsDir, name);
          // Download via Telegram API
          const url = `https://api.telegram.org/file/bot${this.bot!.token}/${file.file_path}`;
          const res = await fetch(url);
          const buffer = Buffer.from(await res.arrayBuffer());
          fs.default.writeFileSync(localPath, buffer);
          logger.info(
            { jid: chatJid, file: name, path: localPath },
            'Telegram file downloaded',
          );
          storeNonText(ctx, `[Document: ${name}] (saved to ${localPath})`);
        } catch (err: any) {
          logger.error({ err, file: name }, 'Failed to download Telegram file');
          storeNonText(ctx, `[Document: ${name}] (download failed)`);
        }
      } else {
        storeNonText(ctx, `[Document: ${name}]`);
      }
    });
    this.bot.on('message:sticker', (ctx: any) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx: any) =>
      storeNonText(ctx, '[Location]'),
    );
    this.bot.on('message:contact', (ctx: any) =>
      storeNonText(ctx, '[Contact]'),
    );

    // Handle errors gracefully
    this.bot.catch((err: any) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo: any) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<string | void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const MAX_LENGTH = 4096;
      let lastMsgId: string | undefined;
      if (text.length <= MAX_LENGTH) {
        const sent = await sendTelegramMessage(this.bot.api, numericId, text);
        lastMsgId = sent?.message_id?.toString();
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          const sent = await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
          lastMsgId = sent?.message_id?.toString();
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
      return lastMsgId;
    } catch (err: any) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  async sendFile(
    jid: string,
    filePath: string,
    filename?: string,
  ): Promise<void> {
    if (!this.bot) return;
    const fs = await import('fs');
    const path = await import('path');
    const { InputFile } = await import('grammy');
    try {
      const numericId = jid.replace(/^tg:/, '');
      const name = filename || path.default.basename(filePath);
      await this.bot.api.sendDocument(
        numericId,
        new InputFile(fs.default.createReadStream(filePath), name),
      );
      logger.info({ jid, filename: name }, 'Telegram file sent');
    } catch (err: any) {
      logger.error({ err, jid, filePath }, 'Failed to send Telegram file');
    }
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async sendCard(
    jid: string,
    card: object,
    fallbackText: string,
  ): Promise<void> {
    if (!this.bot) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      const { InlineKeyboard } = await import('grammy');
      // card.choices → inline keyboard buttons
      const cardObj = card as any;
      if (cardObj.choices && Array.isArray(cardObj.choices)) {
        const keyboard = new InlineKeyboard();
        for (const choice of cardObj.choices) {
          keyboard.text(
            choice.title,
            `${cardObj.command || 'action'}:${choice.value}`,
          );
        }
        // Arrange in rows of 3
        const rows: any[][] = [];
        const buttons = cardObj.choices.map((c: any) => ({
          text: c.title,
          callback_data: `${cardObj.command || 'action'}:${c.value}`,
        }));
        for (let i = 0; i < buttons.length; i += 3) {
          rows.push(buttons.slice(i, i + 3));
        }
        await this.bot.api.sendMessage(numericId, fallbackText, {
          reply_markup: { inline_keyboard: rows },
        });
      } else {
        await sendTelegramMessage(this.bot.api, numericId, fallbackText);
      }
    } catch (err: any) {
      logger.error({ jid, err }, 'Failed to send Telegram card');
    }
  }

  async editMessage(
    jid: string,
    messageId: string,
    text: string,
  ): Promise<string | void> {
    if (!this.bot) return;
    const numericId = jid.replace(/^tg:/, '');
    const msgId = parseInt(messageId);
    try {
      await this.bot.api.editMessageText(numericId, msgId, text, {
        parse_mode: 'Markdown',
      });
      return messageId;
    } catch (err: any) {
      if (err?.description?.includes('message is not modified'))
        return messageId;
      // Fallback: try without Markdown
      try {
        await this.bot.api.editMessageText(numericId, msgId, text);
        return messageId;
      } catch (err2: any) {
        if (err2?.description?.includes('message is not modified'))
          return messageId;
        logger.debug(
          { jid, messageId, err: err2 },
          'Failed to edit Telegram message',
        );
      }
    }
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  private typingIntervals = new Map<string, NodeJS.Timeout>();

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot) return;

    // Clear existing interval
    const existing = this.typingIntervals.get(jid);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(jid);
    }

    if (!isTyping) return;

    const numericId = jid.replace(/^tg:/, '');
    const sendAction = async () => {
      try {
        await this.bot!.api.sendChatAction(numericId, 'typing');
      } catch {
        // ignore — bot might be disconnected
      }
    };

    // Send immediately + repeat every 4 seconds (Telegram typing expires after 5s)
    await sendAction();
    this.typingIntervals.set(jid, setInterval(sendAction, 4000));
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const config = loadConfig();
  const tg = config.channels.telegram;
  if (!tg.enabled) return null;

  // Multi-account: read token from accounts[accountId] if available
  let token = '';
  if (opts.accountId && tg.accounts?.[opts.accountId]) {
    token = tg.accounts[opts.accountId].botToken || '';
  } else {
    token = tg.botToken || '';
  }

  if (!token) return null;
  return new TelegramChannel(token, opts);
});
