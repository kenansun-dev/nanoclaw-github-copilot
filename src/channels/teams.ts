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
import { logger } from '../log.js';
import { sendWithRetry } from './send-with-retry.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
  StreamHandle,
} from '../types.js';
import { TeamsStreamingSession, makeAdapterSender } from './teams-streaming.js';

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
  // Teams updateActivity overwrites the existing message in-place with no
  // visible "edited" affordance, so when the agent emits multiple final
  // outputs in a single turn (text → tool call → more text), reusing
  // editMessage silently destroys earlier replies. Always send new
  // messages for separate finals; progressive partials use the native
  // streaming protocol below (see usesNativeStreaming).
  prefersNewMessageForFinal = true;
  // Teams has a first-class streaming protocol (typing activities with
  // `streaminfo` entities + monotonic streamSequence + a single bound
  // streamId). The dispatcher routes partials through `streamMessage()`
  // when this flag is set, sidestepping the historic editMessage path
  // whose `updateActivity` racing produced visible duplicate replies.
  // See src/channels/teams-streaming.ts for the wire-protocol notes.
  usesNativeStreaming = true;

  private adapter: BotFrameworkAdapter;
  private adapterSettings: Record<string, any> = {};
  private server: http.Server | null = null;
  private opts: TeamsChannelOpts;
  private port: number;

  // Store conversation references for proactive messaging
  private conversationRefs = new Map<string, Partial<ConversationReference>>();

  // JIDs that currently have an active native streaming session.
  // Bare `{type:'typing'}` keepalives MUST be suppressed for these jids:
  // once the dispatcher sends `streamType:'informative'`, the Teams server
  // puts the conversation in stream-mode and rejects every subsequent
  // typing activity that does not carry a `streaminfo` entity with
  // `streamType:'streaming'`. The reject surfaces in `onTurnError` and
  // (worse) ends up posted as 'Sorry, something went wrong.' in the chat,
  // interleaved with real partial output. See PR #20 for the matching
  // wire-protocol fix on the dispatcher side; this set covers the
  // cross-channel `setTyping` keepalive path that the dispatcher does not
  // own. Membership is set in `streamMessage()` and cleared by the
  // returned StreamHandle's `end`/`cancel`.
  private streamingActiveJids = new Set<string>();

  // Graph API token cache for fetching reply context
  private graphToken: { token: string; expiresAt: number } | null = null;

  /**
   * Get a Graph API access token using the bot's app credentials.
   * Caches the token until 5 minutes before expiry.
   */
  private async getGraphToken(): Promise<string | null> {
    if (this.graphToken && Date.now() < this.graphToken.expiresAt) {
      return this.graphToken.token;
    }
    const appId = this.adapterSettings.appId;
    const appPassword = this.adapterSettings.appPassword;
    const tenant = this.adapterSettings.channelAuthTenant || 'botframework.com';
    if (!appId || !appPassword) return null;

    try {
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: appId,
        client_secret: appPassword,
        scope: 'https://graph.microsoft.com/.default',
      });
      const res = await fetch(
        `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
        { method: 'POST', body },
      );
      if (!res.ok) {
        logger.debug(
          { status: res.status },
          'Failed to get Graph token for reply context',
        );
        return null;
      }
      const data = (await res.json()) as any;
      this.graphToken = {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in - 300) * 1000, // 5 min buffer
      };
      return data.access_token;
    } catch (err: any) {
      logger.debug({ err: err.message }, 'Graph token fetch failed');
      return null;
    }
  }

  /**
   * Fetch a message's content via Graph API.
   * Works for DM/group chat: GET /chats/{chatId}/messages/{messageId}
   */
  private async fetchReplyViaGraph(
    conversationId: string,
    messageId: string,
  ): Promise<{ content: string; author: string } | null> {
    const token = await this.getGraphToken();
    if (!token) return null;

    try {
      const url = `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        logger.debug(
          { status: res.status, conversationId, messageId },
          'Graph API reply fetch failed',
        );
        return null;
      }
      const msg = (await res.json()) as any;
      const content = msg.body?.content || '';
      // Convert HTML to text, preserving links
      const text =
        msg.body?.contentType === 'html'
          ? content
              .replace(/<a\s+href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, '$2 ($1)')
              .replace(/<br\s*\/?>/gi, '\n')
              .replace(/<[^>]+>/g, '')
              .trim()
          : content;
      const author = msg.from?.user?.displayName || 'Someone';
      return text ? { content: text, author } : null;
    } catch (err: any) {
      logger.debug({ err: err.message }, 'Graph reply fetch error');
      return null;
    }
  }

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
        process.env.HOME || process.env.USERPROFILE || require('os').homedir(),
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

    // Catch-all error handler.
    //
    // Some errors here are benign streaming-wire rejects from the Teams
    // server — most notably the bare-typing-during-stream reject that
    // surfaces as 'Only start streaming and continue streaming types are
    // allowed as a typing activity'. Those are recovered from at the
    // next outbound activity and posting 'Sorry, something went wrong.'
    // for them confuses users (it interleaves with real agent output
    // they will receive seconds later). Filter the known-benign cases to
    // log-only; everything else still surfaces to the user.
    this.adapter.onTurnError = async (context: TurnContext, error: Error) => {
      const msg = String(error?.message ?? error);
      const isBenignStreamingWireReject =
        // bare typing rejected because conversation is in stream-mode
        msg.includes(
          'Only start streaming and continue streaming types are allowed',
        ) ||
        // bare message rejected because conversation is in stream-mode
        msg.includes('Only end streaming type is allowed') ||
        // multiple informative bootstraps rejected
        msg.includes('You can set only one informative message') ||
        // user paused / client disabled streaming mid-flight
        msg.includes('ContentStreamNotAllowed');
      if (isBenignStreamingWireReject) {
        logger.warn(
          { err: msg },
          'Teams adapter turn error (streaming wire, suppressed user notice)',
        );
        return;
      }
      logger.error({ err: msg }, 'Teams adapter turn error');
      try {
        await context.sendActivity('Sorry, something went wrong.');
      } catch {
        // best-effort
      }
    };
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
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
            const invokeResp = await this.handleIncomingRaw(activity, req);
            if (activity.type === 'invoke') {
              // Teams requires a JSON invokeResponse body for invoke activities;
              // otherwise the conversation hangs ("thinking..." forever).
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(invokeResp ?? { status: 200 }));
            } else {
              res.writeHead(200);
              res.end();
            }
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

      // Listen with retry on EADDRINUSE.
      //
      // Why: `nanoclaw restart` runs `systemctl --user restart`, which kills
      // and respawns back-to-back. The OS may still hold the TCP port in
      // TIME_WAIT (or the old socket may not have fully released yet) when
      // the new process calls listen() — listen() emits an EADDRINUSE
      // 'error' event. Without a handler the Promise from connect() never
      // resolves nor rejects, leaving the Teams channel silently dead
      // until the next manual stop+start (which has enough gap to clear
      // the port). Symptom: bot looks alive on Discord/Telegram but Teams
      // never replies. Reported by kenan 2026-04-27.
      //
      // We retry up to 6 times with 500ms backoff (~3s total). After that,
      // reject so the caller can surface the failure.
      const maxAttempts = 6;
      let attempt = 0;
      const tryListen = () => {
        attempt += 1;
        const onError = (err: NodeJS.ErrnoException) => {
          this.server!.removeListener('listening', onListening);
          if (err.code === 'EADDRINUSE' && attempt < maxAttempts) {
            logger.warn(
              { port: this.port, attempt, maxAttempts },
              'Teams webhook port busy (EADDRINUSE), retrying',
            );
            setTimeout(tryListen, 500);
            return;
          }
          logger.error(
            { err, port: this.port, attempt },
            'Teams webhook server failed to start',
          );
          console.error(
            `\n  Teams webhook FAILED on port ${this.port}: ${err.message}\n` +
              `  (Tried ${attempt} time${attempt === 1 ? '' : 's'}.)\n`,
          );
          reject(err);
        };
        const onListening = () => {
          this.server!.removeListener('error', onError);
          logger.info({ port: this.port }, 'Teams webhook server listening');
          console.log(
            `\n  Teams webhook: http://0.0.0.0:${this.port}/api/messages`,
          );
          console.log(
            `  Set your Azure Bot messaging endpoint to: <your-public-url>/api/messages\n`,
          );
          resolve();
        };
        this.server!.once('error', onError);
        this.server!.once('listening', onListening);
        this.server!.listen(this.port, '0.0.0.0');
      };
      tryListen();
    });
  }

  /**
   * Handle incoming activity without adapter auth (dev/cross-tenant fallback).
   * WARNING: This bypasses JWT validation. Use only during development.
   */
  private async handleIncomingRaw(
    activity: any,
    req: any,
  ): Promise<{ status: number; body?: any } | void> {
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
          'Teams reaction received (not dispatched to agent)',
        );
      }
      // Do NOT forward to agent. Reactions/likes are passive ack signals;
      // dispatching them as messages caused the agent to reply on every
      // 👍 / heart, which is noisy and unwanted (kenan 2026-04-27).
      return;
    }

    // Handle Adaptive Card submits (no text, activity.value contains form data)
    if (activity.type === 'message' && !activity.text && activity.value) {
      if (!(await this.resolveCardSubmit(activity))) return;
    }

    // Handle FileConsentCard invoke (user accepted/declined file download)
    if (activity.type === 'invoke' && activity.name === 'fileConsent/invoke') {
      return await this.handleFileConsentInvoke(activity, chatJid);
    }

    // Diagnostic log on every message activity. Helps debug missing-file
    // reports: shows whether Teams forwarded any attachment metadata at all
    // and what content types it sent. Cheap (one info-level line per inbound
    // message). Added 2026-04-21 after kenan reported repo-list.json silent
    // miss with no log trace.
    if (activity.type === 'message') {
      const attCount = activity.attachments?.length || 0;
      const attTypes = (activity.attachments || []).map(
        (a: any) => a.contentType,
      );
      logger.info(
        {
          chatJid,
          textLen: (activity.text || '').length,
          attCount,
          attTypes,
          textFormat: activity.textFormat,
        },
        'Teams message activity received',
      );
    }

    // Handle file attachments (download to group workspace)
    if (
      activity.type === 'message' &&
      activity.attachments &&
      activity.attachments.length > 0
    ) {
      await this.processIncomingAttachments(activity, chatJid);
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
    // Teams sends HTML when textFormat is 'xml' — pass through as-is
    // LLM can understand HTML; stripping loses links and formatting
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

    // Include quoted/replied-to message content so the agent has context
    if (activity.replyToId) {
      try {
        const { getMessageById } = await import('../db.js');
        const quoted = getMessageById(chatJid, activity.replyToId);
        if (quoted?.content) {
          const author = quoted.sender_name || 'Someone';
          const truncated = (quoted.content || '').slice(0, 200);
          content = `[Replying to ${author}: ${truncated}]\n${content}`;
        } else {
          // Fallback: try Graph API for messages not in local DB
          const convId = activity.conversation?.id;
          if (convId) {
            const graphMsg = await this.fetchReplyViaGraph(
              convId,
              activity.replyToId,
            );
            if (graphMsg) {
              const truncated = graphMsg.content.slice(0, 200);
              content = `[Replying to ${graphMsg.author}: ${truncated}]\n${content}`;
            }
          }
        }
      } catch {
        // DB/Graph not available — skip quote context
      }
    }

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

  /**
   * Shared FileConsentCard invoke handler used by BOTH auth paths:
   *   - handleIncomingRaw (raw/cert mode, direct HTTP response)
   *   - handleIncoming    (BotFramework adapter mode, via InvokeResponse activity)
   *
   * Returns { status } — caller in raw mode writes it as JSON body; caller in
   * adapter mode emits it as an InvokeResponse activity via context.sendActivity.
   *
   * History: before 2026-04-21 this logic lived only inside handleIncomingRaw,
   * so the adapter path silently fell through on fileConsent/invoke and Teams
   * received 501 Not Implemented ("something went wrong, please try again").
   * Ported out to fix that. A test pins both wire paths.
   */
  private async handleFileConsentInvoke(
    activity: any,
    chatJid: string,
  ): Promise<{ status: number }> {
    const value = activity.value;
    if (value?.action === 'decline') {
      logger.info({ jid: chatJid }, 'Teams file consent declined by user');
      return { status: 200 };
    }
    if (value?.action === 'accept' && value?.context?.filePath) {
      const uploadUrl = value.uploadInfo?.uploadUrl;
      const filePath = value.context.filePath;
      if (!uploadUrl) {
        logger.warn(
          { jid: chatJid },
          'Teams fileConsent accept without uploadUrl',
        );
        return { status: 200 };
      }
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
          // Respond to the invoke first (so Teams un-pends the conversation),
          // THEN send the file.info card asynchronously — fire-and-forget so
          // we don't block the invoke response path.
          setImmediate(() => {
            const ref = this.conversationRefs.get(chatJid);
            if (!ref) return;
            this.adapter
              .continueConversation(
                ref as ConversationReference,
                async (ctx: TurnContext) => {
                  // FileInfoCard (file chiclet) requires `contentUrl` at the
                  // attachment top level — Teams server-side renders the
                  // chiclet by linking to the SharePoint URL where the file
                  // landed during the PUT upload. Without contentUrl, the
                  // server returns:
                  //   "An exception occurred when converting file info card
                  //    to file chiclet"
                  // and the user sees a Skype "unsupported card" link plus a
                  // "Sorry, something went wrong" toast (kenansun, 2026-04-22).
                  //
                  // Teams sends `contentUrl` in the fileConsent/invoke
                  // payload's `value.uploadInfo.contentUrl` — same SharePoint
                  // URL the bot just PUT to. Reuse it.
                  // See https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4#example-of-file-info-card
                  await ctx.sendActivity({
                    attachments: [
                      {
                        contentType:
                          'application/vnd.microsoft.teams.card.file.info',
                        contentUrl: value.uploadInfo?.contentUrl,
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
              )
              .catch((err: any) =>
                logger.warn(
                  { err: err.message },
                  'Teams file.info card send failed',
                ),
              );
          });
          return { status: 200 };
        } else {
          const errText = await uploadRes.text().catch(() => '');
          logger.warn(
            { status: uploadRes.status, errText },
            'Teams file upload failed',
          );
          return { status: 502 };
        }
      } catch (err: any) {
        logger.error({ err: err.message }, 'Teams FileConsent upload error');
        return { status: 500 };
      }
    }
    return { status: 200 };
  }

  /**
   * Shared inbound attachment processor used by BOTH auth paths:
   *   - handleIncomingRaw (raw/cert mode)
   *   - handleIncoming    (adapter mode via BotFrameworkAdapter)
   *
   * Mutates `activity.text` in place to append a `[Document: ...]` note
   * with local saved path so the agent can read the downloaded file.
   *
   * History: before 2026-04-21 this logic lived only inside handleIncomingRaw,
   * so the adapter path silently dropped inbound file attachments — user
   * drags a file into Teams → bot only sees text (often empty) → replies
   * "I can't see attachments". Ported out to fix. Same split-brain pattern
   * as fileConsent/invoke (both fixed in the same PR).
   */
  private async processIncomingAttachments(
    activity: any,
    chatJid: string,
  ): Promise<void> {
    for (const att of activity.attachments) {
      // Skip Adaptive Cards and other non-file attachments
      if (
        att.contentType === 'application/vnd.microsoft.card.adaptive' ||
        att.contentType === 'application/vnd.microsoft.card.hero' ||
        (!att.contentUrl && !att.content?.downloadUrl)
      ) {
        logger.debug(
          {
            chatJid,
            contentType: att.contentType,
            hasContentUrl: !!att.contentUrl,
            hasDownloadUrl: !!att.content?.downloadUrl,
          },
          'Teams attachment skipped (card or no download URL)',
        );
        continue;
      }

      // Teams file attachments: real download URL is often
      // att.content.downloadUrl (pre-authenticated SharePoint URL, no bearer).
      // att.contentUrl is a non-authenticated reference. Prefer downloadUrl.
      const isTeamsFileInfo =
        att.contentType ===
        'application/vnd.microsoft.teams.file.download.info';
      const effectiveUrl = isTeamsFileInfo
        ? att.content?.downloadUrl
        : att.contentUrl;
      if (!effectiveUrl) continue;

      const fileName = (att.name || 'attachment')
        .replace(/[\/\\:*?"<>|]/g, '_')
        .replace(/\.\./g, '_');
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

          // Teams attachments almost always require bot/graph auth to download.
          // Real contentUrls are on sharepoint.com, 1drv.ms, graph.microsoft.com,
          // skype.com, or botframework.com. Always try to attach a bearer token.
          // Pre-authenticated SharePoint downloadUrls (isTeamsFileInfo) DON'T
          // need a token and will actually fail if one is attached.
          const headers: Record<string, string> = {};
          if (!isTeamsFileInfo) {
            try {
              const token = await (
                this.adapter as any
              ).credentialsFactory?.createCredentials?.();
              if (token?.token) {
                headers['Authorization'] = `Bearer ${token.token}`;
              }
            } catch {
              /* proceed without auth — will likely 401 for private files */
            }
          }
          const res = await fetch(effectiveUrl, { headers });
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
            // Surface failure to agent so it can apologize / ask user to retry
            // (instead of silently dropping → agent hallucinates "I can't see files").
            const failNote = `[Document: ${fileName}] (download failed: HTTP ${res.status})`;
            if (activity.text) {
              activity.text += `\n${failNote}`;
            } else {
              activity.text = failNote;
            }
          }
        } catch (err: any) {
          logger.error(
            { err, file: fileName },
            'Failed to download Teams file',
          );
          // Surface error too — agent needs to know a file came in even if we
          // couldn't persist it.
          const errNote = `[Document: ${fileName}] (download error)`;
          if (activity.text) {
            activity.text += `\n${errNote}`;
          } else {
            activity.text = errNote;
          }
        }
      } else if (!activity.text) {
        // No registered group — still surface the fact that a file came in.
        activity.text = `[Document: ${fileName}]`;
      } else {
        // Group unregistered but text present — append file note so agent sees it.
        activity.text += `\n[Document: ${fileName}]`;
      }
    }
  }

  private async handleIncoming(context: TurnContext): Promise<void> {
    const activity = context.activity;
    const conversationId = activity.conversation?.id || '';
    const chatJid = `teams:${conversationId}`;

    // Handle FileConsentCard invoke BEFORE the messageReaction / message gates
    // below. When a user clicks Allow/Decline on a file consent card, Teams
    // sends activity.type === 'invoke' with name === 'fileConsent/invoke'. The
    // BotFramework adapter expects the handler to emit an InvokeResponse
    // activity (otherwise it returns 501 to Teams → user sees "something went
    // wrong"). Ported from handleIncomingRaw 2026-04-21 (root cause of kenan's
    // 501 repro).
    if (activity.type === 'invoke' && activity.name === 'fileConsent/invoke') {
      const result = await this.handleFileConsentInvoke(activity, chatJid);
      await context.sendActivity({
        type: 'invokeResponse',
        value: { status: result.status },
      } as any);
      return;
    }

    // Handle reaction events
    if (activity.type === 'messageReaction') {
      const reactionsAdded = (activity as any).reactionsAdded || [];
      const sender = activity.from?.name || activity.from?.id || 'unknown';
      for (const reaction of reactionsAdded) {
        const emoji = reaction.type || '';
        logger.info(
          { chatJid, sender, emoji },
          'Teams reaction received (not dispatched to agent)',
        );
      }
      // Do NOT forward to agent (see handleIncomingRaw above for rationale).
      return;
    }

    // Only handle message activities
    // Handle Adaptive Card submits (no text, activity.value)
    if (activity.type === 'message' && !activity.text && activity.value) {
      if (!(await this.resolveCardSubmit(activity))) return;
    }

    // Process incoming file attachments BEFORE the text gate below. Teams
    // sends file drops as activity.attachments[] with contentType
    // 'application/vnd.microsoft.teams.file.download.info'. If we don't
    // handle them, attachments are silently dropped and when there's no
    // accompanying text, the whole activity gets filtered by the gate —
    // agent sees nothing, user sees "I can't see attachments" hallucination.
    // processIncomingAttachments mutates activity.text in place with a
    // [Document: name] note so even text-less file drops survive the gate.
    // Ported from handleIncomingRaw 2026-04-21 (second half of the same
    // split-brain bug as fileConsent/invoke).
    if (
      activity.type === 'message' &&
      activity.attachments &&
      activity.attachments.length > 0
    ) {
      await this.processIncomingAttachments(activity, chatJid);
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

    // Include quoted/replied-to message content so the agent has context
    if (activity.replyToId) {
      try {
        const { getMessageById } = await import('../db.js');
        const quoted = getMessageById(chatJid, activity.replyToId);
        if (quoted?.content) {
          const author = quoted.sender_name || 'Someone';
          const truncated = (quoted.content || '').slice(0, 200);
          content = `[Replying to ${author}: ${truncated}]\n${content}`;
        } else {
          // Fallback: try Graph API for messages not in local DB
          const convId = activity.conversation?.id;
          if (convId) {
            const graphMsg = await this.fetchReplyViaGraph(
              convId,
              activity.replyToId,
            );
            if (graphMsg) {
              const truncated = graphMsg.content.slice(0, 200);
              content = `[Replying to ${graphMsg.author}: ${truncated}]\n${content}`;
            }
          }
        }
      } catch {
        // DB/Graph not available — skip quote context
      }
    }

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
    const sendOnce = () =>
      this.adapter.continueConversation(
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

    try {
      await sendWithRetry(sendOnce, { opName: 'teams.send', jid });
      logger.info({ jid, length: text.length }, 'Teams message sent');
      return lastActivityId;
    } catch (err: any) {
      logger.error(
        { jid, err: err?.message ?? String(err) },
        'Teams sendMessage failed after retries',
      );
      // Best-effort user-visible notice — single attempt, no recursion.
      try {
        await this.adapter.continueConversation(
          ref as ConversationReference,
          async (context: TurnContext) => {
            await context.sendActivity(
              '⚠️ 上条回复未送达 (send failed after 3 retries — check logs)',
            );
          },
        );
      } catch {
        /* swallow */
      }
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
      // Was `logger.debug` — which is silenced in production log levels.
      // That silence combined with index.ts's `outputSentToUser && editMessage`
      // code path meant failed edits (e.g. when the conversation is in a bad
      // state after a prior onTurnError) produced ZERO log output, making
      // outbound messages disappear invisibly. Log at warn so we can see it.
      logger.warn(
        { jid, messageId, err: err.message },
        'Teams editMessage failed, falling back to new sendMessage',
      );
      // Fallback: send as a new message so the user at least sees the reply.
      // Note: this fallback path was the source of the partial+final
      // duplicate bug — streaming partials going through editMessage
      // would race here and double-post. That hot path is now routed
      // through the native streaming protocol (see streamMessage()),
      // so this fallback only triggers for explicit edit calls
      // (proactive message corrections), where a rare duplicate is
      // far less likely to manifest and far cheaper than silent loss.
      try {
        return await this.sendMessage(jid, text);
      } catch (err2: any) {
        logger.error(
          { jid, err: err2.message },
          'Teams editMessage fallback sendMessage also failed',
        );
      }
    }
  }

  /**
   * Open a Teams native streaming session for `jid`.
   *
   * The returned StreamHandle drives Teams' typing+streaminfo wire
   * protocol (see src/channels/teams-streaming.ts) instead of the
   * legacy editMessage-on-partials path. This eliminates the
   * `updateActivity` race that produced duplicate replies (one
   * with the `◌` cursor, one with the final content) when a
   * partial-edit failed and fell back to sendMessage.
   *
   * The dispatcher only calls this when `usesNativeStreaming` is
   * true. We don't expose a non-streaming fallback here; the
   * StreamingSession itself degrades to a single non-streaming
   * `message` activity if Teams reports the channel doesn't
   * support streaming for this conversation.
   */
  async streamMessage(jid: string): Promise<StreamHandle> {
    const ref = this.conversationRefs.get(jid);
    if (!ref) {
      // No conversation ref — we can't reach this chat at all.
      // Return a no-op handle so the dispatcher doesn't crash; the
      // missing-ref case is already logged elsewhere when sendMessage
      // is attempted on the same jid.
      logger.warn(
        { jid },
        'Teams: no conversation reference for streamMessage; returning no-op handle',
      );
      return {
        chunk: async () => {},
        end: async () => {},
        cancel: async () => {},
      };
    }
    const sender = makeAdapterSender({
      adapter: this.adapter as any,
      ref: ref as ConversationReference,
    });
    // Track that this jid is now in stream-mode so the bare-typing
    // keepalive suppresses itself; clear on end/cancel so subsequent
    // non-streaming turns get keepalives back.
    this.markStreamingActive(jid);
    const session = new TeamsStreamingSession(sender, {
      channelId: 'msteams',
    });
    const clearActive = () => this.markStreamingInactive(jid);
    const wrappedEnd = session.end.bind(session);
    const wrappedCancel = session.cancel.bind(session);
    session.end = async (...args: Parameters<typeof wrappedEnd>) => {
      try {
        return await wrappedEnd(...args);
      } finally {
        clearActive();
      }
    };
    session.cancel = async (...args: Parameters<typeof wrappedCancel>) => {
      try {
        return await wrappedCancel(...args);
      } finally {
        clearActive();
      }
    };
    return session;
  }

  /** Test/internal: mark a jid as having an active native streaming
   * session so `setTyping` will suppress bare-typing keepalives.
   * Also tears down any in-flight bare-typing interval so we don't
   * race the dispatcher's own `setTyping(false)` call. Exposed for
   * the streaming dispatcher and unit tests. */
  markStreamingActive(jid: string): void {
    this.streamingActiveJids.add(jid);
    const existing = this.typingIntervals.get(jid);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(jid);
    }
  }

  /** Test/internal: clear streaming-active flag and stop any in-flight
   * keepalive so the next turn starts cleanly. Idempotent. */
  markStreamingInactive(jid: string): void {
    this.streamingActiveJids.delete(jid);
    const existing = this.typingIntervals.get(jid);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(jid);
    }
  }

  /** Test-only accessor: is the bare-typing keepalive currently
   * suppressed for `jid`? */
  isStreamingActiveForTest(jid: string): boolean {
    return this.streamingActiveJids.has(jid);
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
            // 1:1 DM: send FileConsentCard.
            // CRITICAL: Attachment uses `contentType`, not `type`. Using `type`
            // causes adapter error "ContentType of an attachment is not set"
            // — FileConsentCard fails to render, user sees "Sorry, something
            // went wrong", AND the bot conversation hangs because no
            // fileConsent/invoke ever arrives back. Subsequent outbound sends
            // on the same conversation also silently drop.
            const consentCard = {
              contentType: 'application/vnd.microsoft.teams.card.file.consent',
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
    // Suppress bare `{type:'typing'}` while the conversation has an
    // active native streaming session. The Teams server rejects bare
    // typings in stream-mode with 'Only start streaming and continue
    // streaming types are allowed as a typing activity', and the reject
    // surfaces to users as 'Sorry, something went wrong.' (PR #23).
    if (this.streamingActiveJids.has(jid)) return;
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

  // Multi-account: read credentials from accounts[accountId] if available
  let appId = '';
  let appPassword = '';
  let certThumbprint = '';
  let certPrivateKeyPath = '';
  let tenantId = teams.tenantId;
  let port = teams.webhookPort;

  if (opts.accountId && teams.accounts?.[opts.accountId]) {
    const acct = teams.accounts[opts.accountId];
    appId = acct.appId || '';
    appPassword = acct.appPassword || '';
    certThumbprint = acct.certThumbprint || '';
    certPrivateKeyPath = acct.certPrivateKeyPath || '';
    if (acct.tenantId) tenantId = acct.tenantId;
    if (acct.webhookPort) port = acct.webhookPort;
  } else {
    appId = teams.appId || '';
    appPassword = teams.appPassword || '';
    certThumbprint = teams.certThumbprint || '';
    certPrivateKeyPath = teams.certPrivateKeyPath || '';
  }

  // Fallback to .env if credentials not found in nanoclaw.json
  if (!appId) appId = process.env.MSTEAMS_APP_ID || '';
  if (!appPassword)
    appPassword =
      process.env.MSTEAMS_APP_PASSWORD || process.env.MSTEAMS_APP_KEY || '';
  if (!tenantId) tenantId = process.env.MSTEAMS_TENANT_ID;
  if (!certThumbprint)
    certThumbprint = process.env.MSTEAMS_CERT_THUMBPRINT || '';
  if (!certPrivateKeyPath)
    certPrivateKeyPath = process.env.MSTEAMS_CERT_PRIVATE_KEY_PATH || '';
  if (!port)
    port = process.env.MSTEAMS_WEBHOOK_PORT
      ? parseInt(process.env.MSTEAMS_WEBHOOK_PORT, 10)
      : 3978;

  const hasCert = !!(certThumbprint && certPrivateKeyPath);

  if (!appId || (!appPassword && !hasCert)) {
    logger.warn(
      { channel: 'teams' },
      'Channel installed but credentials missing — skipping. Check nanoclaw.json or .env.',
    );
    return null;
  }

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
