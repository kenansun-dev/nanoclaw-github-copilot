/**
 * v2 Channel Adapter for Microsoft Teams — wraps fork's TeamsChannel.
 *
 * Phase B.4-extend of v2-merge. Provides a v2-shaped `ChannelAdapter`
 * (see `./adapter.ts`) so the v2 router / channel-registry can drive
 * Teams without touching the fork-native inbound path. The fork's
 * `TeamsChannel` (in `./teams.ts`) is left untouched and continues to
 * work with the v1 dispatcher in `src/index.ts` until B.5 router
 * merge swaps the dispatcher over.
 *
 * Strategy mirrors `discord-adapter.ts` / `telegram-adapter.ts`. The
 * adapter intercepts `onMessage` / `onChatMetadata` callbacks from the
 * inner channel and translates fork `NewMessage` into v2
 * `InboundMessage`. Outbound `deliver()` forwards through fork
 * `sendMessage()` which already handles Teams' native streaming
 * protocol + conversation-reference store.
 *
 * `supportsThreads = false`: fork's `TeamsChannel` collapses Teams
 * "channels in a team" into a single `teams:<conversationId>` jid
 * and does not surface a separate threadId in `NewMessage`. Teams
 * actually supports replies-as-threads (Channel messages → replies),
 * but the fork groups them under the parent conversation. Flip this
 * when fork grows reply-thread support.
 *
 * Auth/transport: Teams is the only fork channel that opens an HTTP
 * server (BotFrameworkAdapter listens on a port for inbound webhook
 * activities). The factory pulls TEAMS_APP_ID / TEAMS_APP_PASSWORD
 * (or cert thumbprint + key path) / TEAMS_TENANT_ID / TEAMS_PORT
 * from the environment, matching how fork wires it via
 * `src/index.ts`.
 */

import { log } from '../log.js';
import { readEnvFile } from '../env.js';
import type {
  ChannelAdapter,
  ChannelRegistration,
  ChannelSetup,
  InboundMessage,
  OutboundMessage,
} from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { TeamsChannel } from './teams.js';
import type { NewMessage, RegisteredGroup } from '../types.js';

const CHANNEL_TYPE = 'teams';
const DEFAULT_PORT = 3978;

interface TeamsAdapterCreds {
  appId: string;
  appPassword?: string;
  tenantId?: string;
  port: number;
  certThumbprint?: string;
  certPrivateKeyPath?: string;
}

class TeamsV2Adapter implements ChannelAdapter {
  readonly name = 'teams';
  readonly channelType = CHANNEL_TYPE;
  readonly supportsThreads = false;

  private readonly creds: TeamsAdapterCreds;
  private inner: TeamsChannel | null = null;
  private setupCfg: ChannelSetup | null = null;

  constructor(creds: TeamsAdapterCreds) {
    this.creds = creds;
  }

  async setup(config: ChannelSetup): Promise<void> {
    this.setupCfg = config;

    // Empty registered-groups map: in v2 the router decides routing.
    // The inner channel's `onMessage` fires for every inbound; the v2
    // router gates downstream.
    const passthroughGroups: () => Record<string, RegisteredGroup> = () => ({});

    this.inner = new TeamsChannel(
      this.creds.appId,
      this.creds.appPassword,
      this.creds.tenantId,
      this.creds.port,
      {
        onMessage: (chatJid: string, message: NewMessage) => {
          const platformId = chatJid.replace(/^teams:/, '');
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
            // Fork TeamsChannel rewrites bot mentions into the
            // trigger format before reaching here, same as
            // Discord/Telegram. Leave undefined; router falls back
            // to text-match until B.5 surfaces a richer signal.
            isMention: undefined,
            isGroup: chatJid.includes(':'),
          };
          void config.onInbound(platformId, null, inbound);
        },
        onChatMetadata: (chatJid, _ts, name, _channel, isGroup) => {
          const platformId = chatJid.replace(/^teams:/, '');
          config.onMetadata(platformId, name, isGroup);
        },
        registeredGroups: passthroughGroups,
      },
      this.creds.certThumbprint,
      this.creds.certPrivateKeyPath,
    );

    await this.inner.connect();
    log.info('Teams v2 adapter setup complete', {
      channelType: CHANNEL_TYPE,
      port: this.creds.port,
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

  async deliver(
    platformId: string,
    _threadId: string | null,
    message: OutboundMessage,
  ): Promise<string | undefined> {
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
    const jid = `teams:${platformId}`;
    const sentId = await this.inner.sendMessage(jid, text);
    return typeof sentId === 'string' ? sentId : undefined;
  }

  async setTyping(platformId: string, _threadId: string | null): Promise<void> {
    if (!this.inner) return;
    const jid = `teams:${platformId}`;
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

export function makeTeamsV2AdapterRegistration(): ChannelRegistration {
  return {
    factory: () => {
      const env = readEnvFile([
        'TEAMS_APP_ID',
        'TEAMS_APP_PASSWORD',
        'TEAMS_TENANT_ID',
        'TEAMS_PORT',
        'TEAMS_CERT_THUMBPRINT',
        'TEAMS_CERT_PRIVATE_KEY_PATH',
      ]);
      const appId = process.env.TEAMS_APP_ID || env.TEAMS_APP_ID || '';
      if (!appId) {
        log.warn('Teams v2 adapter: TEAMS_APP_ID not set, skipping');
        return null;
      }
      const appPassword =
        process.env.TEAMS_APP_PASSWORD || env.TEAMS_APP_PASSWORD || undefined;
      const tenantId =
        process.env.TEAMS_TENANT_ID || env.TEAMS_TENANT_ID || undefined;
      const portRaw =
        process.env.TEAMS_PORT || env.TEAMS_PORT || String(DEFAULT_PORT);
      const port = Number.parseInt(portRaw, 10) || DEFAULT_PORT;
      const certThumbprint =
        process.env.TEAMS_CERT_THUMBPRINT ||
        env.TEAMS_CERT_THUMBPRINT ||
        undefined;
      const certPrivateKeyPath =
        process.env.TEAMS_CERT_PRIVATE_KEY_PATH ||
        env.TEAMS_CERT_PRIVATE_KEY_PATH ||
        undefined;

      // Need *either* an appPassword *or* a cert pair to authenticate
      // outbound. Without one of those Teams will reject the bot at
      // adapter init; warn and skip rather than crash.
      if (!appPassword && !(certThumbprint && certPrivateKeyPath)) {
        log.warn(
          'Teams v2 adapter: neither TEAMS_APP_PASSWORD nor cert pair set, skipping',
        );
        return null;
      }

      return new TeamsV2Adapter({
        appId,
        appPassword,
        tenantId,
        port,
        certThumbprint,
        certPrivateKeyPath,
      });
    },
  };
}

// Self-register on import. Call sites must `import './teams-adapter.js'`
// for the registration to fire (matches the v2 channel-registry pattern).
registerChannelAdapter(CHANNEL_TYPE, makeTeamsV2AdapterRegistration());

export { TeamsV2Adapter };
