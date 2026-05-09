/**
 * v2 Channel Adapter for Telegram — wraps fork's TelegramChannel.
 *
 * Phase B.4-extend of v2-merge. Provides a v2-shaped `ChannelAdapter`
 * (see `./adapter.ts`) so the v2 router / channel-registry can drive
 * Telegram without touching the fork-native inbound path. The fork's
 * `TelegramChannel` (in `./telegram.ts`) is left untouched and
 * continues to work with the v1 dispatcher in `src/index.ts` until B.5
 * router merge swaps the dispatcher over.
 *
 * Strategy mirrors `discord-adapter.ts`: this file owns the v2
 * surface; `telegram.ts` owns the platform plumbing. We instantiate
 * `TelegramChannel` lazily during `setup()`, intercept its
 * `onMessage` callback to translate fork `NewMessage` into v2
 * `InboundMessage`, and forward outbound `deliver()` through
 * `sendMessage()`. Both call sites coexist; the fork dispatcher and
 * v2 router can both subscribe.
 *
 * `supportsThreads = false` for now: fork's `TelegramChannel` does not
 * surface forum-supergroup topic ids in its `NewMessage` shape (and
 * the outbound `sendMessage` doesn't accept one either). When fork
 * grows topic support, flip this and start emitting/honouring
 * `threadId`. Tracked alongside the same gap on Discord (B.4).
 */

import { log } from '../log.js';
import { readEnvFile } from '../env.js';
import type { ChannelAdapter, ChannelRegistration, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { TelegramChannel } from './telegram.js';
import type { NewMessage, RegisteredGroup } from '../types-extensions.js';

const CHANNEL_TYPE = 'telegram';

/**
 * Strip the `tg:` (or `tg:<accountId>:`) prefix from a fork chatJid
 * and return the raw Telegram chat id. Mirrors the inverse of
 * `TelegramChannel.chatJid()`.
 */
function chatJidToPlatformId(chatJid: string): string {
  const parts = chatJid.split(':');
  // `tg:<id>` → ['tg','id']; `tg:<account>:<id>` → ['tg','account','id']
  return parts[parts.length - 1] ?? chatJid;
}

class TelegramV2Adapter implements ChannelAdapter {
  readonly name = 'telegram';
  readonly channelType = CHANNEL_TYPE;
  readonly supportsThreads = false;

  private readonly token: string;
  private readonly accountId: string | undefined;
  private inner: TelegramChannel | null = null;
  private setupCfg: ChannelSetup | null = null;

  constructor(token: string, accountId?: string) {
    this.token = token;
    this.accountId = accountId;
  }

  async setup(config: ChannelSetup): Promise<void> {
    this.setupCfg = config;

    // Empty registered-groups map: in v2 the router decides routing,
    // not the channel. We still hand the inner channel a callable so
    // its `onMessage` callback fires for every inbound; the v2 router
    // gates downstream.
    const passthroughGroups: () => Record<string, RegisteredGroup> = () => ({});

    this.inner = new TelegramChannel(
      this.token,
      {
        onMessage: (chatJid: string, message: NewMessage) => {
          const platformId = chatJidToPlatformId(chatJid);
          const inbound: InboundMessage = {
            id: message.id,
            kind: 'chat',
            content: {
              text: message.content,
              sender: message.sender,
              senderName: message.sender_name,
              replyToMessageId: message.reply_to_message_id,
              replyToSender: message.reply_to_sender_name,
            },
            timestamp: message.timestamp,
            // Fork's TelegramChannel rewrites @ASSISTANT mentions into
            // the trigger format before reaching here, so we can't
            // recover the raw @-handle signal cleanly. Leave undefined
            // and let the router fall back to text-match until B.5
            // surfaces a richer signal in NewMessage.
            isMention: undefined,
            isGroup: chatJid.includes(':'),
          };
          void config.onInbound(platformId, null, inbound);
        },
        onChatMetadata: (chatJid, _ts, name, _channel, isGroup) => {
          const platformId = chatJidToPlatformId(chatJid);
          config.onMetadata(platformId, name, isGroup);
        },
        registeredGroups: passthroughGroups,
      },
      this.accountId,
    );

    await this.inner.connect();
    log.info('Telegram v2 adapter setup complete', {
      channelType: CHANNEL_TYPE,
      accountId: this.accountId ?? null,
    });
  }

  async teardown(): Promise<void> {
    if (this.inner) {
      await this.inner.disconnect();
      this.inner = null;
    }
    this.setupCfg = null;
  }

  isConnected(): boolean {
    return this.inner ? this.inner.isConnected() : false;
  }

  async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
    if (!this.inner) {
      log.warn('deliver called before setup', { channelType: CHANNEL_TYPE });
      return undefined;
    }
    const text = extractDeliverableText(message);
    if (!text) {
      log.debug('deliver: no text payload, skipping', {
        channelType: CHANNEL_TYPE,
        kind: message.kind,
      });
      return undefined;
    }
    const jid = this.accountId ? `tg:${this.accountId}:${platformId}` : `tg:${platformId}`;
    const sentId = await this.inner.sendMessage(jid, text);
    return typeof sentId === 'string' ? sentId : undefined;
  }

  async setTyping(platformId: string, _threadId: string | null): Promise<void> {
    if (!this.inner) return;
    const jid = this.accountId ? `tg:${this.accountId}:${platformId}` : `tg:${platformId}`;
    await this.inner.setTyping(jid, true);
  }
}

function extractDeliverableText(message: OutboundMessage): string | null {
  const c = message.content;
  if (typeof c === 'string') return c;
  if (c && typeof c === 'object') {
    const obj = c as Record<string, unknown>;
    const text = obj.text ?? obj.content ?? obj.body;
    if (typeof text === 'string') return text;
  }
  return null;
}

export function makeTelegramV2AdapterRegistration(): ChannelRegistration {
  return {
    factory: () => {
      const env = readEnvFile(['TELEGRAM_BOT_TOKEN']);
      const token = process.env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || '';
      if (!token) {
        log.warn('Telegram v2 adapter: TELEGRAM_BOT_TOKEN not set, skipping');
        return null;
      }
      return new TelegramV2Adapter(token);
    },
  };
}

// Self-register on import. Call sites must `import './telegram-adapter.js'`
// for the registration to fire (matches the v2 channel-registry pattern).
registerChannelAdapter(CHANNEL_TYPE, makeTelegramV2AdapterRegistration());

export { TelegramV2Adapter, chatJidToPlatformId };
