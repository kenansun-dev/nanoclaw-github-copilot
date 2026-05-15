/**
 * Shared channel-key ↔ channel-type mapping.
 *
 * v1 jids use a short channel **key** (`tg`, `dc`, `wa`, `teams`, `tui`,
 * `imessage`, ...) followed by `:platform_id`. v2 `messaging_groups.channel_type`
 * stores the long form (`telegram`, `discord`, `whatsapp`, ...).
 *
 * `channelKeyToType` was previously duplicated at `v2-migrate-chats.ts:66`
 * and `v2-reconcile.ts:75`. Lifting to a single module so any future
 * channel addition (e.g. `nostr` ↔ `ns`) updates both directions atomically.
 *
 * `typeToChannelKey` is the inverse, used by `v2-chat-metadata.synthLegacyJid`
 * to bridge v2 rows back to v1-shaped `jid` strings during the cutover
 * dual-read window. Without it, naive `channel_type || ':' || platform_id`
 * misses every Telegram chat (live-DB verified 2026-05-16).
 */

/** v1 short-prefix → v2 channel_type. */
export function channelKeyToType(channelKey: string): string {
  switch (channelKey) {
    case 'tg':
      return 'telegram';
    case 'iMessage':
      return 'imessage';
    case 'telegram':
    case 'teams':
    case 'discord':
    case 'whatsapp':
    case 'slack':
    case 'imessage':
    case 'email':
    case 'matrix':
    case 'tui':
      return channelKey;
    default:
      return channelKey;
  }
}

/** v2 channel_type → v1 short-prefix. Inverse of `channelKeyToType`.
 *  MUST stay in sync — when adding a new channel, update both. */
export function typeToChannelKey(channelType: string): string {
  switch (channelType) {
    case 'telegram':
      return 'tg';
    // imessage stays 'imessage' (v1 used both 'imessage' and 'iMessage';
    // we canonicalize to 'imessage' on read-back).
    default:
      return channelType;
  }
}

/**
 * Compose a v1-shaped jid from v2 (channel_type, platform_id).
 *
 * `platform_id` may legitimately contain colons (Teams thread IDs like
 * `a:1Rw3-...`, daily-prefix Telegram chats like `daily:8731187021`).
 * We never split it — the caller passes the raw column value through.
 */
export function synthLegacyJid(channelType: string, platformId: string): string {
  return `${typeToChannelKey(channelType)}:${platformId}`;
}

/** Split `proto:rest` jid into [channelKey, rawId]. Returns null on malformed.
 *  Splits on the FIRST colon only — preserves multi-colon platform_id. */
export function splitJid(jid: string): [string, string] | null {
  const idx = jid.indexOf(':');
  if (idx <= 0 || idx === jid.length - 1) return null;
  return [jid.slice(0, idx), jid.slice(idx + 1)];
}

/** Decompose a v1 jid into v2 (channel_type, platform_id) for MG lookups. */
export function jidToTypeAndPlatformId(jid: string): { channelType: string; platformId: string } | null {
  const parts = splitJid(jid);
  if (!parts) return null;
  return { channelType: channelKeyToType(parts[0]), platformId: parts[1] };
}
