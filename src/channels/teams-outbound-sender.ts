/**
 * Teams outbound sender abstraction (Rpi5, 2026-07-03).
 *
 * === Why this module exists — the layering contract ===
 *
 * Kenan's hard requirement: the proxy/relay is a *pure transport channel*
 * that is **Teams-message-agnostic**. All Teams protocol semantics
 * (streaming state machine, locally-minted streamId, typing keepalives,
 * informative/streaming/final activity shapes) live ABOVE this seam and do
 * not know or care which transport carries the bytes.
 *
 * Three layers, top to bottom:
 *
 *   L3  Teams semantics       — `TeamsStreamingSession` (teams-streaming.ts)
 *                               + bare-typing keepalive. Mints streamId,
 *                               builds every activity. Transport-blind.
 *          │  emits Partial<TeamsActivity> via …
 *          ▼
 *   L2  OutboundSender        — THIS FILE. A uniform `ActivitySender`
 *          │                    contract with two interchangeable factories:
 *          │                      • makeAdapterSender  → tunnel (direct BFA)
 *          │                      • makeRelaySender    → proxy  (via relay)
 *          │  hands opaque activity JSON to …
 *          ▼
 *   L1  Transport             — tunnel: BotFrameworkAdapter.continueConversation
 *                               proxy:  TeamsRelayClient.sendReply → gRPC
 *                                       OutboundReply frame (activityJson is
 *                                       opaque bytes; relay never parses it).
 *
 * The `ActivitySender` type is the single seam. Because streamId is minted
 * locally at `TeamsStreamingSession` construction (2026-05-29 Bug-1 fix) and
 * the whole streaming state machine lives at L3, the proxy path needs NO
 * protocol change: each streaming frame (informative → streaming → final) is
 * just one more activity handed to the sender. The relay forwards it verbatim.
 *
 * See:
 *   - src/channels/teams-streaming.ts     (L3, `ActivitySender`, makeAdapterSender)
 *   - src/channels/teams-relay-client.ts  (L1 proxy, RelayOutbound/sendReply)
 *   - proto/teams_relay.proto             (OutboundReply.activity_json = opaque)
 */

import { randomUUID } from 'node:crypto';
import type { ActivitySender, TeamsActivity } from './teams-streaming.js';
import type { RelayOutbound, TeamsRelayClient } from './teams-relay-client.js';
import { logger } from '../log-extensions.js';

/**
 * Build an `ActivitySender` that pushes each activity up the south-edge relay
 * stream as an opaque `OutboundReply` frame.
 *
 * The relay treats `activity.*` as opaque JSON — it does not read streamId,
 * streamType, or any Teams field. The Teams streaming state machine at L3 is
 * therefore fully preserved across the proxy without a proto change.
 *
 * Return value: `ActivitySender` contracts a `Promise<string | undefined>`
 * carrying the connector-assigned activity id. Over the relay we do not get a
 * connector id back (OutboundAck intentionally carries only delivery status —
 * see teams_relay.proto), so we return `activity.id` when the caller has
 * pre-set one (streaming frames set it to the locally-minted streamId) and
 * `undefined` otherwise. Nothing downstream depends on a connector id because
 * streamId is minted locally; returning undefined is the honest signal.
 *
 * @param opts.client       Attached relay client (its `sendReply` is used).
 * @param opts.botId        Bot appId this reply is for (Hello.bot_ids member).
 * @param opts.serviceUrl   Connector serviceUrl for the conversation.
 * @param opts.inReplyTo    Relay-assigned inbound activityId this answers
 *                          (omit / '' for proactive sends).
 */
export function makeRelaySender(opts: {
  client: Pick<TeamsRelayClient, 'sendReply'>;
  botId: string;
  serviceUrl: string;
  inReplyTo?: string;
}): ActivitySender {
  return async (activity: Partial<TeamsActivity>) => {
    // Fresh idempotency key per frame so a redelivered reply (reconnect
    // mid-stream) is de-duped by the relay rather than double-posted.
    const frame: RelayOutbound = {
      botId: opts.botId,
      inReplyTo: opts.inReplyTo ?? '',
      activity,
      serviceUrl: opts.serviceUrl,
      clientMsgId: randomUUID(),
    };
    const ok = opts.client.sendReply(frame);
    if (!ok) {
      // Detached stream: surface as a soft failure. The L3 caller's
      // send-with-retry / degrade path handles this the same way it
      // handles a tunnel send throwing.
      logger.warn(
        { botId: opts.botId, type: (activity as any)?.type },
        'teams-outbound: relay sendReply returned false (stream detached)',
      );
      throw new Error('teams relay stream detached; reply not sent');
    }
    // No connector id over the relay; echo a locally-set id if present.
    return (activity as any)?.id;
  };
}
