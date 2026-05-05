/**
 * v2 Channel Adapter for Discord — wraps fork's DiscordChannel.
 *
 * Phase B.4 of v2-merge. Provides a v2-shaped `ChannelAdapter` (see
 * `./adapter.ts`) so the v2 router / channel-registry can drive Discord
 * without touching the fork-native inbound path. The fork's
 * `DiscordChannel` (in `./discord.ts`) is left untouched and continues
 * to work with the v1 dispatcher in `src/index.ts` until B.5 router
 * merge swaps the dispatcher over.
 *
 * Strategy: this file owns the v2 surface; `discord.ts` owns the
 * platform plumbing. We instantiate `DiscordChannel` lazily during
 * `setup()`, intercept its `onMessage` callback to translate fork
 * `NewMessage` into v2 `InboundMessage`, and forward outbound
 * `deliver()` through `sendMessage()`. Both call sites coexist; the
 * fork dispatcher and v2 router can both subscribe (different
 * registry maps) without stepping on each other.
 *
 * Discord uses channel ids as the conversation unit. We keep
 * `supportsThreads = false` here — Discord *threads* (Forum / public
 * threads) are a separate object from `TextChannel`, and the fork
 * `DiscordChannel` flattens them into the parent channel id. When
 * fork later grows real thread support, flip this and start emitting
 * `threadId`.
 */

import { log } from '../log.js';
import { readEnvFile } from '../env.js';
import type { ChannelAdapter, ChannelRegistration, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { DiscordChannel } from './discord.js';
import type { NewMessage, RegisteredGroup } from '../types-extensions.js';

const CHANNEL_TYPE = 'discord';

class DiscordV2Adapter implements ChannelAdapter {
  readonly name = 'discord';
  readonly channelType = CHANNEL_TYPE;
  readonly supportsThreads = false;

  private readonly token: string;
  private inner: DiscordChannel | null = null;
  private setupCfg: ChannelSetup | null = null;

  constructor(token: string) {
    this.token = token;
  }

  async setup(config: ChannelSetup): Promise<void> {
    this.setupCfg = config;

    // Empty registered-groups map: in v2 the router decides routing,
    // not the channel. We still hand the inner channel a callable so
    // its `onMessage` callback fires for every inbound (the inner
    // channel currently gates on `registeredGroups()[chatJid]`; for
    // adapter-mode usage we surface every message and let the v2
    // router gate). Keep returning `undefined` to signal "not gated".
    const passthroughGroups: () => Record<string, RegisteredGroup> = () => ({});

    this.inner = new DiscordChannel(this.token, {
      onMessage: (chatJid: string, message: NewMessage) => {
        // chatJid format from fork: `dc:<channelId>`. Strip prefix to
        // recover the v2 platformId (raw Discord channel id).
        const platformId = chatJid.replace(/^dc:/, '');
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
          // The fork DiscordChannel rewrites bot mentions into the
          // `@AssistantName ...` trigger format before we get here, so
          // we can't recover the original `<@botId>` signal cleanly.
          // Leave undefined and let the router fall back to text-match
          // until B.5 lands a richer signal in NewMessage.
          isMention: undefined,
          isGroup: chatJid.includes(':'), // best-effort; fork stores it via metadata
        };
        void config.onInbound(platformId, null, inbound);
      },
      onChatMetadata: (chatJid, _ts, name, _channel, isGroup) => {
        const platformId = chatJid.replace(/^dc:/, '');
        config.onMetadata(platformId, name, isGroup);
      },
      registeredGroups: passthroughGroups,
    });

    await this.inner.connect();
    log.info('Discord v2 adapter setup complete', {
      channelType: CHANNEL_TYPE,
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
    const jid = `dc:${platformId}`;
    await this.inner.sendMessage(jid, text);
    // Fork's DiscordChannel.sendMessage doesn't return the message id
    // (it only logs). Returning undefined matches v2's contract — the
    // host treats undefined as "no platform id available, mark sent
    // anyway". B.6 cleanup can plumb the real id through if needed.
    return undefined;
  }

  async setTyping(platformId: string, _threadId: string | null): Promise<void> {
    if (!this.inner) return;
    const jid = `dc:${platformId}`;
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

export function makeDiscordV2AdapterRegistration(): ChannelRegistration {
  return {
    factory: () => {
      const env = readEnvFile(['DISCORD_BOT_TOKEN']);
      const token = process.env.DISCORD_BOT_TOKEN || env.DISCORD_BOT_TOKEN || '';
      if (!token) {
        log.warn('Discord v2 adapter: DISCORD_BOT_TOKEN not set, skipping');
        return null;
      }
      return new DiscordV2Adapter(token);
    },
  };
}

// Self-register on import. Call sites must `import './discord-adapter.js'`
// for the registration to fire (matches the v2 channel-registry pattern).
registerChannelAdapter(CHANNEL_TYPE, makeDiscordV2AdapterRegistration());

export { DiscordV2Adapter };
