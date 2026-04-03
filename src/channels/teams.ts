import fs from 'fs';
import http from 'http';
import {
  BotFrameworkAdapter,
  TurnContext,
  Activity,
  ConversationReference,
} from 'botbuilder';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { loadConfig } from '../config-loader.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

// ---------------------------------------------------------------------------
// Teams Channel — implements the same Channel interface as Telegram
//
// Design constraints (from kenan):
//   1. All config from env vars — keep the door open for future config file
//   2. Public endpoint URL not hardcoded to any tunnel provider
//   3. Enterprise (single-tenant) Teams supported via MSTEAMS_TENANT_ID
//   4. Zero hardcoded secrets in source
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'MSTEAMS_APP_ID',
  'MSTEAMS_APP_PASSWORD',
  'MSTEAMS_TENANT_ID',
  'MSTEAMS_WEBHOOK_PORT',
  'MSTEAMS_CERT_THUMBPRINT',
  'MSTEAMS_CERT_PRIVATE_KEY_PATH',
] as const;

export interface TeamsChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class TeamsChannel implements Channel {
  name = 'teams';

  private adapter: BotFrameworkAdapter;
  private adapterSettings: Record<string, any> = {};
  private server: http.Server | null = null;
  private opts: TeamsChannelOpts;
  private port: number;

  // Store conversation references for proactive messaging
  private conversationRefs = new Map<string, Partial<ConversationReference>>();

  /** Convert Adaptive Card submit (activity.value) to synthetic slash command text. */
  private async resolveCardSubmit(activity: any): Promise<boolean> {
    if (activity.type !== 'message' || activity.text || !activity.value)
      return false;
    try {
      const { parseTeamsCardSubmit } = await import('../slash-commands.js');
      const syntheticCmd = parseTeamsCardSubmit(activity);
      if (syntheticCmd) {
        activity.text = syntheticCmd;
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  constructor(
    appId: string,
    appPassword: string | undefined,
    tenantId: string | undefined,
    port: number,
    opts: TeamsChannelOpts,
    certThumbprint?: string,
    certPrivateKeyPath?: string,
  ) {
    this.opts = opts;
    this.port = port;

    // Support two auth modes: client secret OR certificate (or both)
    const adapterSettings: Record<string, any> = { appId };
    this.adapterSettings = adapterSettings;

    if (appPassword) {
      adapterSettings.appPassword = appPassword;
      logger.info('Teams: client secret configured');
    }

    if (certThumbprint && certPrivateKeyPath) {
      const resolvedPath = certPrivateKeyPath.replace(
        /^~/,
        process.env.HOME || '/root',
      );
      adapterSettings.certificateThumbprint = certThumbprint;
      adapterSettings.certificatePrivateKey = fs.readFileSync(
        resolvedPath,
        'utf-8',
      );
      logger.info('Teams: certificate configured');
    }

    if (tenantId && tenantId !== 'common') {
      adapterSettings.channelAuthTenant = tenantId;
    }

    this.adapter = new BotFrameworkAdapter(adapterSettings);

    // Catch-all error handler
    this.adapter.onTurnError = async (context: TurnContext, error: Error) => {
      logger.error({ err: error.message }, 'Teams adapter turn error');
      try {
        await context.sendActivity('Sorry, something went wrong.');
      } catch {
        // best-effort
      }
    };
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.server = http.createServer(async (req, res) => {
        // Health check endpoint
        if (req.method === 'GET' && req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', channel: 'teams' }));
          return;
        }

        // Bot Framework messages endpoint
        if (req.method === 'POST' && req.url === '/api/messages') {
          // Read body first - BotFrameworkAdapter needs the raw body
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
          }
          const bodyBuffer = Buffer.concat(chunks);
          const bodyStr = bodyBuffer.toString('utf-8');

          let activity: any;
          try {
            activity = JSON.parse(bodyStr);
          } catch {
            res.writeHead(400);
            res.end('Invalid JSON');
            return;
          }

          logger.debug(
            { activityType: activity.type, from: activity.from?.name },
            'Teams webhook received',
          );

          // BotFrameworkAdapter expects Express-style req.body and res methods
          (req as any).body = activity;
          const expressRes: any = res;
          expressRes.status = (code: number) => {
            res.statusCode = code;
            return expressRes;
          };
          expressRes.send = (body?: string) => {
            if (!res.headersSent) {
              res.end(body || '');
            }
            return expressRes;
          };
          expressRes.end = res.end.bind(res);

          // Process activity: try adapter auth first, fall back to raw mode.
          // Using raw mode bypasses JWT validation (needed for cross-tenant cert auth).
          // TODO: Fix proper JWT validation for cross-tenant certificate auth.
          const useRawMode =
            process.env.MSTEAMS_RAW_MODE === 'true' ||
            (!this.adapterSettings.appPassword &&
              this.adapterSettings.certificateThumbprint);

          if (useRawMode) {
            // Raw mode: skip adapter JWT validation entirely
            logger.debug(
              { activityType: activity.type },
              'Teams: processing in raw mode (no JWT validation)',
            );
            await this.handleIncomingRaw(activity, req);
            res.writeHead(200);
            res.end();
          } else {
            try {
              await this.adapter.processActivity(
                req,
                expressRes,
                async (context: TurnContext) => {
                  await this.handleIncoming(context);
                },
              );
            } catch (err: any) {
              logger.error({ err: err.message }, 'Teams processActivity error');
              if (!res.headersSent) {
                res.writeHead(500);
                res.end('Internal Server Error');
              }
            }
          }
          return;
        }

        res.writeHead(404);
        res.end();
      });

      this.server.listen(this.port, '0.0.0.0', () => {
        logger.info({ port: this.port }, 'Teams webhook server listening');
        console.log(
          `\n  Teams webhook: http://0.0.0.0:${this.port}/api/messages`,
        );
        console.log(
          `  Set your Azure Bot messaging endpoint to: <your-public-url>/api/messages\n`,
        );
        resolve();
      });
    });
  }

  /**
   * Handle incoming activity without adapter auth (dev/cross-tenant fallback).
   * WARNING: This bypasses JWT validation. Use only during development.
   */
  private async handleIncomingRaw(activity: any, req: any): Promise<void> {
    const conversationId = activity.conversation?.id || '';
    const chatJid = `teams:${conversationId}`;

    // Handle reaction events
    if (activity.type === 'messageReaction') {
      const reactionsAdded = activity.reactionsAdded || [];
      const sender = activity.from?.name || activity.from?.id || 'unknown';
      for (const reaction of reactionsAdded) {
        const emoji = reaction.type || '';
        const targetMsgId = activity.replyToId || '';
        logger.info(
          { chatJid, sender, emoji, targetMsgId },
          'Teams reaction received',
        );
        // Store as a non-text message so agent sees it in context
        const timestamp = activity.timestamp || new Date().toISOString();
        this.opts.onMessage(chatJid, {
          id: `reaction-${Date.now()}`,
          chat_jid: chatJid,
          content: `[${sender} reacted with ${emoji}]`,
          sender: activity.from?.aadObjectId || activity.from?.id || '',
          sender_name: sender,
          timestamp,
          is_from_me: false,
        });
      }
      return;
    }

    // Handle Adaptive Card submits (no text, activity.value contains form data)
    if (activity.type === 'message' && !activity.text && activity.value) {
      if (!(await this.resolveCardSubmit(activity))) return;
    }

    // Handle FileConsentCard invoke (user accepted file download)
    if (activity.type === 'invoke' && activity.name === 'fileConsent/invoke') {
      const value = activity.value;
      if (value?.action === 'accept' && value?.context?.filePath) {
        const uploadUrl = value.uploadInfo?.uploadUrl;
        const filePath = value.context.filePath;
        if (uploadUrl) {
          try {
            const fs = await import('fs');
            const fileBuffer = fs.default.readFileSync(filePath);
            const uploadRes = await fetch(uploadUrl, {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Range': `bytes 0-${fileBuffer.length - 1}/${fileBuffer.length}`,
              },
              body: fileBuffer,
            });
            if (uploadRes.ok) {
              logger.info(
                { jid: chatJid, file: value.context.filename },
                'Teams file uploaded via FileConsent',
              );
              // Send file info card after successful upload
              await this.adapter.continueConversation(
                this.conversationRefs.get(chatJid) as ConversationReference,
                async (ctx: TurnContext) => {
                  await ctx.sendActivity({
                    attachments: [
                      {
                        contentType:
                          'application/vnd.microsoft.teams.card.file.info',
                        name: value.uploadInfo?.name || value.context.filename,
                        content: {
                          uniqueId: value.uploadInfo?.uniqueId,
                          fileType:
                            value.uploadInfo?.fileType ||
                            value.context.filename?.split('.').pop(),
                        },
                      } as any,
                    ],
                  } as Partial<Activity>);
                },
              );
            } else {
              logger.warn(
                { status: uploadRes.status },
                'Teams file upload failed',
              );
            }
          } catch (err: any) {
            logger.error({ err }, 'Teams FileConsent upload error');
          }
        }
      }
      return;
    }

    // Handle file attachments (download to group workspace)
    if (
      activity.type === 'message' &&
      activity.attachments &&
      activity.attachments.length > 0
    ) {
      for (const att of activity.attachments) {
        // Skip Adaptive Cards and other non-file attachments
        if (
          att.contentType === 'application/vnd.microsoft.card.adaptive' ||
          att.contentType === 'application/vnd.microsoft.card.hero' ||
          !att.contentUrl
        )
          continue;

        const fileName = att.name || 'attachment';
        const group = this.opts.registeredGroups()[chatJid];
        if (group) {
          try {
            const fs = await import('fs');
            const pathMod = await import('path');
            const { resolveWorkspace } = await import('../workspace.js');
            const uploadsDir = pathMod.default.join(
              resolveWorkspace(),
              'groups',
              group.folder,
              'uploads',
            );
            fs.default.mkdirSync(uploadsDir, { recursive: true });
            const localPath = pathMod.default.join(uploadsDir, fileName);

            // Teams attachment contentUrl is typically a direct download link
            const res = await fetch(att.contentUrl);
            if (res.ok) {
              const buffer = Buffer.from(await res.arrayBuffer());
              fs.default.writeFileSync(localPath, buffer);
              logger.info(
                { jid: chatJid, file: fileName, path: localPath },
                'Teams file downloaded',
              );
              // Append file info to message content
              const fileNote = `[Document: ${fileName}] (saved to ${localPath})`;
              if (activity.text) {
                activity.text += `\n${fileNote}`;
              } else {
                activity.text = fileNote;
              }
            } else {
              logger.warn(
                { jid: chatJid, file: fileName, status: res.status },
                'Teams file download failed',
              );
              if (!activity.text) {
                activity.text = `[Document: ${fileName}] (download failed)`;
              }
            }
          } catch (err: any) {
            logger.error(
              { err, file: fileName },
              'Failed to download Teams file',
            );
            if (!activity.text) {
              activity.text = `[Document: ${fileName}]`;
            }
          }
        } else if (!activity.text) {
          activity.text = `[Document: ${fileName}]`;
        }
      }
    }

    if (activity.type !== 'message' || !activity.text) return;

    // Store a minimal conversation reference for replies
    const ref = {
      channelId: activity.channelId,
      serviceUrl: activity.serviceUrl,
      conversation: activity.conversation,
      bot: activity.recipient,
      user: activity.from,
    };
    this.conversationRefs.set(chatJid, ref as any);

    let content = activity.text;
    const timestamp = activity.timestamp
      ? new Date(activity.timestamp).toISOString()
      : new Date().toISOString();
    const senderName = activity.from?.name || activity.from?.id || 'Unknown';
    const sender = activity.from?.aadObjectId || activity.from?.id || '';
    const msgId = activity.id || Date.now().toString();
    const isGroup =
      activity.conversation?.conversationType === 'groupChat' ||
      activity.conversation?.conversationType === 'channel';
    const chatName = activity.conversation?.name || chatJid;

    // Handle @mention
    if (activity.entities) {
      for (const entity of activity.entities) {
        if (
          entity.type === 'mention' &&
          entity.mentioned?.id === activity.recipient?.id
        ) {
          const mentionText = entity.text || '';
          content = content.replace(mentionText, '').trim();
        }
      }
    }
    if (isGroup && !TRIGGER_PATTERN.test(content)) {
      const wasMentioned = activity.entities?.some(
        (e: any) =>
          e.type === 'mention' && e.mentioned?.id === activity.recipient?.id,
      );
      if (wasMentioned) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'teams', isGroup);

    // Note: unregistered chats are handled by index.ts (pair instructions)

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
      'Teams message stored (raw mode)',
    );
  }

  private async handleIncoming(context: TurnContext): Promise<void> {
    const activity = context.activity;
    const conversationId = activity.conversation?.id || '';
    const chatJid = `teams:${conversationId}`;

    // Handle reaction events
    if (activity.type === 'messageReaction') {
      const reactionsAdded = (activity as any).reactionsAdded || [];
      const sender = activity.from?.name || activity.from?.id || 'unknown';
      for (const reaction of reactionsAdded) {
        const emoji = reaction.type || '';
        logger.info({ chatJid, sender, emoji }, 'Teams reaction received');
        const timestamp =
          activity.timestamp?.toISOString?.() || new Date().toISOString();
        this.opts.onMessage(chatJid, {
          id: `reaction-${Date.now()}`,
          chat_jid: chatJid,
          content: `[${sender} reacted with ${emoji}]`,
          sender: activity.from?.aadObjectId || activity.from?.id || '',
          sender_name: sender,
          timestamp,
          is_from_me: false,
        });
      }
      return;
    }

    // Only handle message activities
    // Handle Adaptive Card submits (no text, activity.value)
    if (activity.type === 'message' && !activity.text && activity.value) {
      if (!(await this.resolveCardSubmit(activity))) return;
    }
    if (activity.type !== 'message' || !activity.text) return;

    // Store conversation reference for proactive messaging later
    const ref = TurnContext.getConversationReference(activity);
    this.conversationRefs.set(chatJid, ref);

    let content = activity.text;
    const timestamp = activity.timestamp
      ? new Date(activity.timestamp).toISOString()
      : new Date().toISOString();

    const senderName = activity.from?.name || activity.from?.id || 'Unknown';
    const sender = activity.from?.aadObjectId || activity.from?.id || '';
    const msgId = activity.id || Date.now().toString();

    // Determine chat context
    const isGroup =
      activity.conversation?.conversationType === 'groupChat' ||
      activity.conversation?.conversationType === 'channel';
    const chatName = activity.conversation?.name || chatJid;

    // Handle @mention: strip bot mention text and prepend trigger if needed
    if (activity.entities) {
      for (const entity of activity.entities) {
        if (
          entity.type === 'mention' &&
          entity.mentioned?.id === activity.recipient?.id
        ) {
          // Remove the mention text from content
          const mentionText = (entity as any).text || '';
          content = content.replace(mentionText, '').trim();
        }
      }
    }
    // In group chats, prepend trigger if bot was mentioned but trigger pattern not present
    if (isGroup && !TRIGGER_PATTERN.test(content)) {
      const wasMentioned = activity.entities?.some(
        (e: any) =>
          e.type === 'mention' && e.mentioned?.id === activity.recipient?.id,
      );
      if (wasMentioned) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    // Store chat metadata
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'teams', isGroup);

    // Only deliver to registered groups
    // Note: unregistered chats are handled by index.ts (pair instructions)

    // Deliver message
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
      'Teams message stored',
    );
  }

  async sendMessage(jid: string, text: string): Promise<string | void> {
    const ref = this.conversationRefs.get(jid);
    if (!ref) {
      logger.warn(
        { jid },
        'Teams: no conversation reference for JID, cannot send',
      );
      return;
    }

    let lastActivityId: string | undefined;
    try {
      await this.adapter.continueConversation(
        ref as ConversationReference,
        async (context: TurnContext) => {
          const MAX_LENGTH = 25000;
          if (text.length <= MAX_LENGTH) {
            const res = await context.sendActivity(text);
            lastActivityId = res?.id;
          } else {
            for (let i = 0; i < text.length; i += MAX_LENGTH) {
              const res = await context.sendActivity(
                text.slice(i, i + MAX_LENGTH),
              );
              lastActivityId = res?.id;
            }
          }
        },
      );
      logger.info({ jid, length: text.length }, 'Teams message sent');
      return lastActivityId;
    } catch (err: any) {
      logger.error({ jid, err }, 'Failed to send Teams message');
    }
  }

  async sendCard(
    jid: string,
    card: object,
    fallbackText: string,
  ): Promise<void> {
    const ref = this.conversationRefs.get(jid);
    if (!ref) {
      logger.warn(
        { jid },
        'No conversation reference for Teams card — falling back to text',
      );
      await this.sendMessage(jid, fallbackText);
      return;
    }

    try {
      await this.adapter.continueConversation(
        ref as ConversationReference,
        async (context: TurnContext) => {
          await context.sendActivity({
            attachments: [
              {
                contentType: 'application/vnd.microsoft.card.adaptive',
                content: card,
              },
            ],
          } as Partial<Activity>);
        },
      );
      logger.info({ jid }, 'Teams Adaptive Card sent');
    } catch (err: any) {
      logger.error(
        { jid, err },
        'Failed to send Teams card — falling back to text',
      );
      await this.sendMessage(jid, fallbackText);
    }
  }

  isConnected(): boolean {
    return this.server !== null && this.server.listening;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('teams:');
  }

  async editMessage(
    jid: string,
    messageId: string,
    text: string,
  ): Promise<string | void> {
    const ref = this.conversationRefs.get(jid);
    if (!ref) return;
    try {
      await this.adapter.continueConversation(
        ref as ConversationReference,
        async (context: TurnContext) => {
          await context.updateActivity({
            id: messageId,
            type: 'message',
            text,
          } as Partial<Activity>);
        },
      );
      return messageId;
    } catch (err: any) {
      logger.debug({ jid, messageId, err }, 'Failed to edit Teams message');
    }
  }

  async sendFile(
    jid: string,
    filePath: string,
    filename?: string,
  ): Promise<void> {
    const ref = this.conversationRefs.get(jid);
    if (!ref) {
      logger.warn({ jid }, 'Teams: no conversation ref for sendFile');
      return;
    }

    const fs = await import('fs');
    const pathMod = await import('path');
    if (!fs.default.existsSync(filePath)) {
      logger.warn({ jid, filePath }, 'Teams sendFile: file not found');
      return;
    }

    const name = filename || pathMod.default.basename(filePath);
    const stat = fs.default.statSync(filePath);

    try {
      await this.adapter.continueConversation(
        ref as ConversationReference,
        async (context: TurnContext) => {
          // Use FileConsentCard for 1:1 chats
          const isGroup =
            (ref as any).conversation?.conversationType === 'groupChat' ||
            (ref as any).conversation?.conversationType === 'channel';

          if (!isGroup) {
            // 1:1 DM: send FileConsentCard
            const consentCard = {
              type: 'application/vnd.microsoft.teams.card.file.consent',
              name,
              content: {
                description: `File from NanoClaw: ${name}`,
                sizeInBytes: stat.size,
                acceptContext: { filePath, filename: name },
                declineContext: { filePath },
              },
            };
            await context.sendActivity({
              attachments: [consentCard as any],
            } as Partial<Activity>);
            logger.info(
              { jid, filename: name },
              'Teams FileConsentCard sent (DM)',
            );
          } else {
            // Group/channel: send as text with file info
            // Full SharePoint upload requires Graph API + more permissions
            await context.sendActivity(
              `📎 File ready: **${name}** (${(stat.size / 1024).toFixed(1)} KB). ` +
                `File is available on the server at: ${filePath}`,
            );
            logger.info(
              { jid, filename: name },
              'Teams file notification sent (group)',
            );
          }
        },
      );
    } catch (err: any) {
      logger.error({ jid, err, filePath }, 'Teams sendFile failed');
    }
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
      logger.info('Teams webhook server stopped');
    }
  }

  private typingIntervals = new Map<string, NodeJS.Timeout>();

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    // Clear existing interval
    const existing = this.typingIntervals.get(jid);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(jid);
    }

    if (!isTyping) return;
    const ref = this.conversationRefs.get(jid);
    if (!ref) return;

    const sendAction = async () => {
      try {
        await this.adapter.continueConversation(
          ref as ConversationReference,
          async (context: TurnContext) => {
            await context.sendActivity({ type: 'typing' } as Partial<Activity>);
          },
        );
      } catch {
        // ignore
      }
    };

    // Send immediately + repeat every 3 seconds (Teams typing expires after ~3s)
    await sendAction();
    this.typingIntervals.set(jid, setInterval(sendAction, 3000));
  }
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------
registerChannel('teams', (opts: ChannelOpts) => {
  const config = loadConfig();
  const teams = config.channels.teams;

  if (!teams.enabled) return null;

  const appId = teams.appId || '';
  const appPassword = teams.appPassword || '';
  const certThumbprint = teams.certThumbprint || '';
  const certPrivateKeyPath = teams.certPrivateKeyPath || '';
  const hasCert = !!(certThumbprint && certPrivateKeyPath);

  if (!appId || (!appPassword && !hasCert)) {
    logger.warn(
      { channel: 'teams' },
      'Channel installed but credentials missing — skipping. Check nanoclaw.json or .env.',
    );
    return null;
  }

  const tenantId = teams.tenantId;
  const port = teams.webhookPort;
  const authMode = hasCert ? 'certificate' : 'secret';

  logger.info(
    {
      appId: appId.substring(0, 8) + '...',
      tenantId: tenantId || 'common',
      port,
      authMode,
    },
    'Teams channel initializing',
  );

  return new TeamsChannel(
    appId,
    appPassword || undefined,
    tenantId,
    port,
    opts,
    hasCert ? certThumbprint : undefined,
    hasCert ? certPrivateKeyPath : undefined,
  );
});
