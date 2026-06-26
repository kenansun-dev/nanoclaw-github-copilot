/**
 * gRPC server (Rpi5 #3) — owns the Attach bidi stream between the relay and the
 * local NCL host, plus the south-edge AAD auth seam.
 *
 * Flow per accepted stream:
 *   1. AAD auth: the owner's AAD token rides in call metadata ("authorization:
 *      Bearer <jwt>"). validateSouthToken (injected) verifies it and returns the
 *      caller identity; the broker allowlist (object id / UPN) gates acceptance.
 *      Rejected → stream closed UNAUTHENTICATED before any activity flows (§5).
 *   2. First client frame MUST be Hello (bot ids). We intersect with the
 *      allowlist-permitted set, AttachAck back accepted/rejected + session id,
 *      and register an AttachedStream with the broker.
 *   3. Thereafter: broker pushes InboundActivity/BufferOverflow/Drain down;
 *      client pushes OutboundReply (→ OutboundSender.deliverOutbound → OutboundAck)
 *      / InboundAck / Heartbeat up.
 *
 * Token ACQUISITION on the NCL side is the next task; here we only VALIDATE +
 * allowlist. validateSouthToken is injected so JWKS wiring is testable/stubbable
 * the same way the north edge injects its JWT validator.
 */

import { Server, ServerCredentials, type ServerDuplexStream, type Metadata, status } from '@grpc/grpc-js';
import { TeamsRelayService, type FromNcl, type ToNcl } from './gen/teams_relay.js';
import type { Broker, AttachedStream, InboundDelivery, OverflowNotice } from './broker.js';
import type { OutboundSender } from './contract.js';
import { logger } from './logger.js';

export const SOUTH_PROTOCOL_VERSION = 1;
const HEARTBEAT_INTERVAL_MS = 30_000;

/** Caller identity extracted from a validated south-edge AAD token. */
export interface SouthCaller {
  /** AAD object id (oid) — the stable allowlist key. */
  objectId: string;
  /** UPN / appId, for audit + secondary allowlist matching. */
  principal: string;
}

export interface GrpcServerDeps {
  broker: Broker;
  sender: OutboundSender;
  /**
   * Validate the south-edge AAD token from call metadata. Returns the caller on
   * success, or null to reject (UNAUTHENTICATED). Injected so JWKS validation is
   * stubbable; the bootstrap default is fail-closed.
   */
  validateSouthToken: (md: Metadata) => Promise<SouthCaller | null>;
  /**
   * Allowlist gate: is this caller permitted, and which bot ids may it serve?
   * Returns the permitted subset (empty → reject the stream). Sourced from
   * NCL_RELAY_ALLOWLIST (config); kept injectable for tests.
   */
  authorizeBots: (caller: SouthCaller, requestedBotIds: string[]) => string[];
  /** Session id generator (proto AttachAck.session_id). Default random. */
  genSessionId?: () => string;
}

export function makeAttachHandler(deps: GrpcServerDeps) {
  const genSessionId = deps.genSessionId ?? (() => `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);

  return async function attach(call: ServerDuplexStream<FromNcl, ToNcl>): Promise<void> {
    // 1. South-edge AAD auth (metadata), before any frame is processed.
    const caller = await deps.validateSouthToken(call.metadata).catch(() => null);
    if (!caller) {
      call.emit('error', { code: status.UNAUTHENTICATED, details: 'south-edge AAD token invalid or missing' });
      return;
    }

    let registered: AttachedStream | null = null;
    let sessionId = '';

    const closeStream = (): void => {
      if (registered) {
        deps.broker.detachStream(registered.sessionId);
        registered = null;
      }
    };

    call.on('data', (msg: FromNcl) => {
      void handleFrame(msg);
    });
    call.on('end', () => {
      closeStream();
      call.end();
    });
    call.on('error', (err) => {
      logger.warn('south stream error', { sessionId, err: err instanceof Error ? err.message : String(err) });
      closeStream();
    });
    call.on('cancelled', () => {
      logger.info('south stream cancelled', { sessionId });
      closeStream();
    });

    async function handleFrame(msg: FromNcl): Promise<void> {
      // Hello must come first and exactly once.
      if (msg.hello) {
        if (registered) {
          call.emit('error', { code: status.FAILED_PRECONDITION, details: 'duplicate Hello' });
          return;
        }
        const permitted = deps.authorizeBots(caller!, msg.hello.botIds);
        sessionId = genSessionId();
        const rejected = msg.hello.botIds
          .filter((b) => !permitted.includes(b))
          .map((b) => ({ botId: b, reason: 'not on allowlist' }));

        if (permitted.length === 0) {
          // Nothing this caller may serve → ack the rejection then close.
          send(call, { attachAck: { acceptedBotIds: [], rejected, serverProtocolVersion: SOUTH_PROTOCOL_VERSION, heartbeatIntervalMs: 0, sessionId } });
          call.end();
          return;
        }

        const stream: AttachedStream = {
          sessionId,
          botIds: permitted,
          pushInbound: (d: InboundDelivery) =>
            send(call, {
              inbound: {
                botId: d.botId,
                activityId: d.activityId,
                activityJson: d.activityJson,
                serviceUrl: d.serviceUrl,
                receivedUnixMs: d.receivedUnixMs,
                fromBuffer: d.fromBuffer,
              },
            }),
          pushOverflow: (n: OverflowNotice) =>
            send(call, { overflow: { botId: n.botId, droppedCount: n.droppedCount, reason: n.reason } }),
        };
        registered = stream;
        deps.broker.attachStream(stream);
        send(call, {
          attachAck: {
            acceptedBotIds: permitted,
            rejected,
            serverProtocolVersion: SOUTH_PROTOCOL_VERSION,
            heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
            sessionId,
          },
        });
        logger.info('south stream attached', { sessionId, principal: caller!.principal, bots: permitted.length });
        return;
      }

      // All other frames require an established (Hello'd) stream.
      if (!registered) {
        call.emit('error', { code: status.FAILED_PRECONDITION, details: 'first frame must be Hello' });
        return;
      }

      if (msg.reply) {
        const r = msg.reply;
        const result = await deps.sender
          .deliverOutbound({
            botId: r.botId,
            inReplyTo: r.inReplyTo,
            activityJson: r.activityJson,
            serviceUrl: r.serviceUrl,
            clientMsgId: r.clientMsgId,
          })
          .catch((err) => ({
            clientMsgId: r.clientMsgId,
            ok: false,
            connectorStatus: 0,
            error: err instanceof Error ? err.message : String(err),
            retryable: true, // unexpected internal error — let NCL retry
          }));
        send(call, {
          outboundAck: {
            clientMsgId: result.clientMsgId,
            ok: result.ok,
            connectorStatus: result.connectorStatus,
            error: result.error ?? '',
            retryable: result.retryable,
          },
        });
        return;
      }

      if (msg.heartbeat) {
        send(call, { heartbeat: { sentUnixMs: Date.now() } });
        return;
      }
      // msg.ack — inbound ack; v1 has at-most-once delivery so we just log it.
      if (msg.ack) {
        logger.debug('inbound ack', { sessionId, activityId: msg.ack.activityId });
      }
    }
  };
}

function send(call: ServerDuplexStream<FromNcl, ToNcl>, msg: ToNcl): void {
  try {
    call.write(msg);
  } catch (err) {
    logger.warn('south stream write failed', { err: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Start the gRPC server. Signature matches the bootstrap stub
 * (startGrpcServer(port, sender)) but takes full deps so auth/broker are wired.
 */
export function startGrpcServer(port: number, deps: GrpcServerDeps): Promise<Server> {
  const server = new Server();
  server.addService(TeamsRelayService, { attach: makeAttachHandler(deps) });
  return new Promise((resolve, reject) => {
    // App Service terminates TLS at its h2 proxy and forwards cleartext h2c to
    // HTTP20_ONLY_PORT, so the in-process server binds insecure on localhost.
    server.bindAsync(`0.0.0.0:${port}`, ServerCredentials.createInsecure(), (err, boundPort) => {
      if (err) return reject(err);
      logger.info('gRPC server listening', { port: boundPort });
      resolve(server);
    });
  });
}
