/**
 * Sender allowlist (fork add-on) — module wire-up.
 *
 * v2-shaped layer over the fork's `src/sender-allowlist.ts` (per-chat
 * allow/deny + trigger/drop mode loaded from `data/sender_allowlist.json`
 * or `nanoclaw.json security.allowedSenders`). Importing this module
 * registers a router access-gate that runs alongside v2 permissions.
 *
 * Layering: v2 `src/modules/permissions/` is the primary gate; this
 * module is a secondary fork-only gate. Either denying short-circuits
 * the inbound to a block.
 *
 * Per kenan 23:20 policy "全收 v2 features" we keep the fork allowlist
 * as a strict additional layer rather than replacing v2 permissions.
 */
import {
  isSenderAllowed,
  loadSenderAllowlist,
} from '../../sender-allowlist.js';
import type { AccessGateResult } from '../../router.js';
import { log } from '../../log.js';
import type { MessagingGroup } from '../../types.js';
import type { InboundEvent } from '../../channels/adapter.js';

export const senderAllowlistFork = {
  isSenderAllowed,
  loadSenderAllowlist,
};

/**
 * Build a router AccessGateFn that consults the fork allowlist. Returned
 * as a plain function so the caller (index.ts dispatcher wire — L3) can
 * compose it with v2 permissions' gate (router has a single accessGate
 * slot; the composer ANDs them so either denial blocks).
 */
export function makeSenderAllowlistGate() {
  return (
    event: InboundEvent,
    userId: string | null,
    mg: MessagingGroup,
    _agentGroupId: string,
  ): AccessGateResult => {
    // chatJid identifier the fork allowlist keys on. Fork's
    // sender-allowlist.json uses channel-native ids (whatsapp jid /
    // telegram chat id / discord channel id); MessagingGroup.platform_id
    // is the v2 normalized form of the same value.
    const chatJid = mg.platform_id;
    // Sender id = user id when v2 resolved one, otherwise event.platformId
    // (the raw sender platform id from the inbound).
    const sender = userId ?? event.platformId;
    let cfg;
    try {
      cfg = loadSenderAllowlist();
    } catch (err) {
      log.warn('sender-allowlist gate: load failed, allowing', {
        err,
        chatJid,
      });
      return { allowed: true };
    }
    if (isSenderAllowed(chatJid, sender, cfg)) {
      return { allowed: true };
    }
    if (cfg.logDenied) {
      log.info('sender-allowlist gate: denied', {
        chatJid,
        sender,
        channelType: mg.channel_type,
      });
    }
    return { allowed: false, reason: 'sender-allowlist denied' };
  };
}
