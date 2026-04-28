/**
 * Shadow inbound bridge — translates fork `(chatJid, NewMessage)` into a
 * v2 `InboundEvent` and fires `routeInbound()` in fire-and-forget mode.
 *
 * Used by `NANOCLAW_V2_DISPATCHER=2` (shadow) — the fork v1 dispatch
 * path stays authoritative; this runs in parallel to exercise the v2
 * router on real traffic without changing user-visible behaviour.
 *
 * Why a separate module: keeping the JID-prefix → channelType map and
 * the NewMessage → InboundEvent shape conversion in one file means the
 * future "real swap" (B.5.6+) flips one import, not surgery in
 * `src/index.ts`. Tests mock `routeInbound` here, not in index.ts.
 */
import type { NewMessage } from './types.js';
import type { InboundEvent } from './channels/adapter.js';
import { log } from './log.js';

/**
 * JID prefix → v2 channelType. Mirrors the prefixes the fork channels
 * mint in `chatJid` (see src/channels/{discord,telegram,teams,tui}.ts).
 * Order matters only insofar as we match the longest prefix first;
 * current prefixes don't overlap so insertion order is fine.
 */
const PREFIX_MAP: ReadonlyArray<[string, string]> = [
  ['dc:', 'discord'],
  ['tg:', 'telegram'],
  ['teams:', 'teams'],
  ['tui:', 'tui'],
];

export interface JidParts {
  channelType: string;
  platformId: string;
}

/**
 * Split a fork `chatJid` into its v2 `channelType` + raw `platformId`.
 * Returns `null` when no known prefix matches — caller should skip
 * the shadow route (don't synthesize a fake channelType).
 */
export function parseChatJid(chatJid: string): JidParts | null {
  for (const [prefix, channelType] of PREFIX_MAP) {
    if (chatJid.startsWith(prefix)) {
      return { channelType, platformId: chatJid.slice(prefix.length) };
    }
  }
  return null;
}

/**
 * Translate a fork `NewMessage` into a v2 `InboundEvent`. Returns
 * `null` when the chatJid prefix is unknown (router would refuse it
 * anyway). Content shape matches `discord-adapter.ts` so router-side
 * `safeParseContent` extracts the text consistently.
 */
export function toInboundEvent(
  chatJid: string,
  msg: NewMessage,
): InboundEvent | null {
  const parts = parseChatJid(chatJid);
  if (!parts) return null;
  const content = JSON.stringify({
    text: msg.content,
    sender: msg.sender,
    senderName: msg.sender_name,
    replyToMessageId: msg.reply_to_message_id,
    replyToSender: msg.reply_to_sender_name,
  });
  return {
    channelType: parts.channelType,
    platformId: parts.platformId,
    threadId: msg.thread_id ?? null,
    message: {
      id: msg.id,
      kind: 'chat',
      content,
      timestamp: msg.timestamp,
      isMention: undefined,
      isGroup: parts.channelType !== 'tui',
    },
  };
}

/**
 * Dependency-injectable router function — defaults to lazy-importing
 * `./router.js` so tests can substitute a mock without ESM hoisting.
 */
export type ShadowRouter = (event: InboundEvent) => Promise<void>;

let routerOverride: ShadowRouter | null = null;

/** Test-only: install a mock router. Pass `null` to restore default. */
export function __setShadowRouterForTests(fn: ShadowRouter | null): void {
  routerOverride = fn;
}

/**
 * Fire-and-forget shadow route. NEVER throws — errors are logged and
 * swallowed so the fork v1 path is unaffected.
 *
 * Ignores outbound (`is_from_me`) messages — the v2 router treats
 * those as own-bot echoes and they shouldn't drive routing. Same for
 * unknown-prefix chatJids.
 */
export function shadowRoute(chatJid: string, msg: NewMessage): void {
  if (msg.is_from_me) return;
  const event = toInboundEvent(chatJid, msg);
  if (!event) {
    log.debug('shadow-route: unknown chatJid prefix, skipping', { chatJid });
    return;
  }
  const route =
    routerOverride ??
    (async (e: InboundEvent) => {
      const mod = await import('./router.js');
      await mod.routeInbound(e);
    });
  void Promise.resolve()
    .then(() => route(event))
    .catch((err) =>
      log.warn('shadow-route: routeInbound failed (swallowed)', {
        err,
        chatJid,
      }),
    );
}
