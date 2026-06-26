/**
 * Relay internal seam — the contract between the three relay subsystems so they
 * can be built + reviewed independently (division of labor 2026-06-26).
 *
 *   North edge (inbound, VM #2): Teams POST -> JWT validate -> calls
 *       InboundSink.enqueueInbound(...). Does NOT know about streams/buffers.
 *   Broker core (Rpi5 #4): implements InboundSink. Routes a validated activity
 *       to the attached NCL gRPC stream, or buffers (TTL + drop + audit) when no
 *       stream is attached for that bot.
 *   gRPC server (Rpi5 #3): owns the Attach bidi stream. Pushes inbound
 *       activities down; receives OutboundReply up; hands replies to
 *       OutboundSender.deliverOutbound(...).
 *   South edge (outbound, VM #5): implements OutboundSender. MSI IMDS token +
 *       Bot Connector POST. The per-bot federation exchange is stubbed until the
 *       next task (bot onboarding) — see exchangeForBotToken note in §6/doc.
 *
 * Types here are hand-mirrored from proto/teams_relay.proto so the seam is
 * stable before ts-proto codegen lands; once codegen is wired (Rpi5 #6) the
 * activity/reply payload fields are the same wire shape. Keep this file in sync
 * with the proto if fields change.
 */

// ─── Boundary value types (mirror proto messages) ───────────────────────────

/** A Teams activity that already passed inbound BotFramework JWT validation. */
export interface InboundActivityInput {
  /** Per-bot routing key (the <bot> segment of /api/messages/<bot>). */
  botId: string;
  /**
   * Bot Framework activity JSON (UTF-8 bytes). Opaque to the relay except for
   * serviceUrl; forwarded verbatim to NCL.
   */
  activityJson: Uint8Array;
  /** serviceUrl extracted from the activity (Bot Connector base URL). */
  serviceUrl: string;
  /** Unix ms the relay received this from Teams. */
  receivedUnixMs: number;
}

/** An NCL-produced reply to deliver outbound to Teams via Bot Connector. */
export interface OutboundReplyInput {
  /** Which bot this reply is from (one of the stream's Hello.bot_ids). */
  botId: string;
  /** Relay-assigned InboundActivity.activity_id this answers; empty if proactive. */
  inReplyTo: string;
  /** Bot Framework activity JSON (UTF-8 bytes). */
  activityJson: Uint8Array;
  /** Bot Connector base URL (serviceUrl) to POST to. */
  serviceUrl: string;
  /** Idempotency key (echoed back in the result). */
  clientMsgId: string;
}

/** Result of an outbound delivery attempt. Maps to proto OutboundAck. */
export interface OutboundResult {
  clientMsgId: string;
  ok: boolean;
  /** Connector HTTP status when ok=false (0 if N/A). */
  connectorStatus: number;
  /** Human-readable failure detail when ok=false. */
  error?: string;
  /** Relay-mapped retry hint: 429/5xx -> true, 401/4xx -> false. */
  retryable: boolean;
}

// ─── Seam interfaces ─────────────────────────────────────────────────────────

/**
 * Implemented by the broker core (Rpi5 #4); called by the north/inbound edge
 * (VM #2) after JWT validation. Never throws for "no NCL attached" — that is a
 * normal buffer/drop path, not an error. Throws only on internal failure.
 */
export interface InboundSink {
  enqueueInbound(activity: InboundActivityInput): Promise<void>;
}

/**
 * Implemented by the south/outbound edge (VM #5); called by the gRPC server
 * (Rpi5 #3) when an OutboundReply arrives up the stream. Resolves with a result
 * the gRPC layer turns into a proto OutboundAck. Should not throw for ordinary
 * Connector failures — encode them in OutboundResult so the ack/retry hint
 * reaches NCL; throw only on unexpected internal error.
 */
export interface OutboundSender {
  deliverOutbound(reply: OutboundReplyInput): Promise<OutboundResult>;
}
