/**
 * Broker core (Rpi5 #4) — the heart of the relay's decoupling model.
 *
 * Responsibilities (design §2):
 *   - Route a JWT-validated inbound activity to the NCL stream attached for that
 *     bot, if one is attached.
 *   - If no stream is attached for the bot: BUFFER it with a TTL. On expiry (or
 *     capacity), DROP it and write an audit record + emit a BufferOverflow to
 *     the stream when one later attaches. The inbound never blocks and never
 *     errors for "no NCL" — that is a normal path, not a failure.
 *   - When a stream attaches with replay_buffered, FLUSH non-expired buffered
 *     activities for its bots to it.
 *
 * This file implements InboundSink (called by the north edge) and exposes a
 * stream registry the gRPC server (#3) drives: attachStream / detachStream and
 * a per-attach push callback. It does NOT know about gRPC wire types — the gRPC
 * server adapts proto messages to/from these plain shapes, keeping the broker
 * transport-agnostic and unit-testable.
 */

import type { InboundSink, InboundActivityInput } from './contract.js';

// ─── Stream-facing types (transport-agnostic; gRPC server adapts proto) ──────

/** A delivery the broker pushes toward an attached NCL stream. */
export interface InboundDelivery {
  botId: string;
  /** Relay-assigned id; the stream acks with it, also the buffer key. */
  activityId: string;
  activityJson: Uint8Array;
  serviceUrl: string;
  receivedUnixMs: number;
  /** True if replayed from buffer (NCL was absent), false if delivered live. */
  fromBuffer: boolean;
}

/** Notice that buffered inbound was dropped for a bot (TTL/capacity). */
export interface OverflowNotice {
  botId: string;
  droppedCount: number;
  reason: 'ttl_expired' | 'capacity';
}

/**
 * The broker's view of one attached NCL stream. The gRPC server (#3) constructs
 * this from an accepted Attach call and registers it via attachStream.
 */
export interface AttachedStream {
  /** Relay-assigned session id (proto AttachAck.session_id) for audit. */
  sessionId: string;
  /** Bot ids this stream serves (validated Hello.bot_ids ∩ allowlist). */
  botIds: string[];
  /** Push a live/replayed inbound activity down to NCL. */
  pushInbound: (d: InboundDelivery) => void;
  /** Notify NCL that buffered items were dropped. */
  pushOverflow: (n: OverflowNotice) => void;
}

export interface BrokerOptions {
  /** Inbound buffer TTL per item, ms. Default 60_000. */
  bufferTtlMs?: number;
  /** Max buffered items per bot before capacity-drop (oldest first). Default 100. */
  bufferMaxPerBot?: number;
  /** Audit sink; defaults to logger. Receives one record per drop/route event. */
  audit?: (record: AuditRecord) => void;
  /** Clock injection for tests. Default Date.now. */
  now?: () => number;
  /** Monotonic id generator for activity ids. Default counter+random. */
  genId?: () => string;
}

export interface AuditRecord {
  event: 'routed_live' | 'buffered' | 'flushed' | 'dropped_ttl' | 'dropped_capacity';
  botId: string;
  activityId: string;
  sessionId?: string;
  atUnixMs: number;
}

interface BufferedItem {
  delivery: InboundDelivery;
  expiresAtMs: number;
}

export interface Broker extends InboundSink {
  attachStream(stream: AttachedStream): void;
  detachStream(sessionId: string): void;
  /** Test/inspection: current buffered count for a bot. */
  bufferedCount(botId: string): number;
  /** Stop the TTL sweep timer (shutdown/tests). */
  stop(): void;
}

export function makeBroker(opts: BrokerOptions = {}): Broker {
  const ttlMs = opts.bufferTtlMs ?? 60_000;
  const maxPerBot = opts.bufferMaxPerBot ?? 100;
  const now = opts.now ?? Date.now;
  const genId = opts.genId ?? defaultGenId();
  const audit = opts.audit ?? defaultAudit;

  // botId -> attached stream (last writer wins; one NCL per bot in v1).
  const streamsByBot = new Map<string, AttachedStream>();
  // sessionId -> stream (for detach).
  const streamsBySession = new Map<string, AttachedStream>();
  // botId -> FIFO of buffered items (only while no stream attached).
  const buffers = new Map<string, BufferedItem[]>();

  function bufferFor(botId: string): BufferedItem[] {
    let b = buffers.get(botId);
    if (!b) {
      b = [];
      buffers.set(botId, b);
    }
    return b;
  }

  async function enqueueInbound(activity: InboundActivityInput): Promise<void> {
    const activityId = genId();
    const delivery: InboundDelivery = {
      botId: activity.botId,
      activityId,
      activityJson: activity.activityJson,
      serviceUrl: activity.serviceUrl,
      receivedUnixMs: activity.receivedUnixMs,
      fromBuffer: false,
    };

    const stream = streamsByBot.get(activity.botId);
    if (stream) {
      stream.pushInbound(delivery);
      audit({ event: 'routed_live', botId: activity.botId, activityId, sessionId: stream.sessionId, atUnixMs: now() });
      return;
    }

    // No NCL attached → buffer with TTL. Capacity drop oldest-first.
    const buf = bufferFor(activity.botId);
    if (buf.length >= maxPerBot) {
      const dropped = buf.shift()!;
      audit({ event: 'dropped_capacity', botId: activity.botId, activityId: dropped.delivery.activityId, atUnixMs: now() });
      notifyOverflowLater(activity.botId, 1, 'capacity');
    }
    buf.push({ delivery, expiresAtMs: now() + ttlMs });
    audit({ event: 'buffered', botId: activity.botId, activityId, atUnixMs: now() });
  }

  // Overflow notices are delivered to a stream when one attaches; if no stream
  // is present we record counts to coalesce into the next attach's notice.
  const pendingOverflow = new Map<string, { count: number; reason: 'ttl_expired' | 'capacity' }>();
  function notifyOverflowLater(botId: string, count: number, reason: 'ttl_expired' | 'capacity'): void {
    const stream = streamsByBot.get(botId);
    if (stream) {
      stream.pushOverflow({ botId, droppedCount: count, reason });
      return;
    }
    const cur = pendingOverflow.get(botId);
    // A later reason wins the label but counts accumulate; ttl vs capacity is
    // best-effort for audit, the count is what matters to NCL.
    pendingOverflow.set(botId, { count: (cur?.count ?? 0) + count, reason });
  }

  function attachStream(stream: AttachedStream): void {
    streamsBySession.set(stream.sessionId, stream);
    for (const botId of stream.botIds) {
      streamsByBot.set(botId, stream);

      // Flush non-expired buffered items for this bot in FIFO order.
      const buf = buffers.get(botId);
      if (buf && buf.length) {
        const nowMs = now();
        const live = buf.filter((it) => it.expiresAtMs > nowMs);
        const expired = buf.length - live.length;
        if (expired > 0) {
          audit({ event: 'dropped_ttl', botId, activityId: '(sweep-on-attach)', atUnixMs: nowMs });
          notifyOverflowLater(botId, expired, 'ttl_expired');
        }
        for (const it of live) {
          stream.pushInbound({ ...it.delivery, fromBuffer: true });
          audit({ event: 'flushed', botId, activityId: it.delivery.activityId, sessionId: stream.sessionId, atUnixMs: nowMs });
        }
        buffers.delete(botId);
      }

      // Deliver any coalesced overflow notice now that a stream exists.
      const pend = pendingOverflow.get(botId);
      if (pend) {
        stream.pushOverflow({ botId, droppedCount: pend.count, reason: pend.reason });
        pendingOverflow.delete(botId);
      }
    }
  }

  function detachStream(sessionId: string): void {
    const stream = streamsBySession.get(sessionId);
    if (!stream) return;
    streamsBySession.delete(sessionId);
    // Only clear botId→stream mappings still pointing at THIS stream (a newer
    // attach for the same bot may have already replaced it).
    for (const botId of stream.botIds) {
      if (streamsByBot.get(botId) === stream) streamsByBot.delete(botId);
    }
  }

  // Periodic TTL sweep so items expire even when no attach happens.
  const sweep = setInterval(() => {
    const nowMs = now();
    for (const [botId, buf] of buffers) {
      const live = buf.filter((it) => it.expiresAtMs > nowMs);
      const expired = buf.length - live.length;
      if (expired > 0) {
        audit({ event: 'dropped_ttl', botId, activityId: '(sweep)', atUnixMs: nowMs });
        notifyOverflowLater(botId, expired, 'ttl_expired');
        if (live.length) buffers.set(botId, live);
        else buffers.delete(botId);
      }
    }
  }, Math.max(1000, Math.floor(ttlMs / 4)));
  sweep.unref?.();

  return {
    enqueueInbound,
    attachStream,
    detachStream,
    bufferedCount: (botId) => buffers.get(botId)?.length ?? 0,
    stop: () => clearInterval(sweep),
  };
}

// ─── defaults ────────────────────────────────────────────────────────────────

function defaultGenId(): () => string {
  let n = 0;
  return () => `act_${Date.now().toString(36)}_${(n++).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function defaultAudit(record: AuditRecord): void {
  // Lazy import avoids a hard logger dep in tests that inject their own audit.
  // Single JSON line → Log Analytics.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ kind: 'relay_audit', ...record }));
}
