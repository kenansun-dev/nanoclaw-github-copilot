/**
 * Teams relay SOUTH-edge client (Rpi5, task 2 — 2026-07-01).
 *
 * When a Teams channel is configured with `transport: 'proxy'`, NCL does NOT
 * bind a local inbound webhook. Instead it dials OUT to the Azure App Service
 * relay's south edge over a single long-lived bidirectional gRPC stream
 * (`TeamsRelay.Attach`, see proto/teams_relay.proto) and:
 *
 *   - sends a `Hello` first frame declaring which bot ids (appIds) it serves;
 *   - receives JWT-validated inbound Teams activities (`InboundActivity`) the
 *     relay routes to it, hands each to `onInbound`, and acks;
 *   - sends `OutboundReply` frames up the stream for the relay to deliver to
 *     Teams via the MSI→per-bot federation exchange (no token ever rides here);
 *   - answers/keeps a heartbeat, and reconnects with backoff on drain/close.
 *
 * Auth: the owner's personal AAD bearer token is presented in the call
 * metadata (`authorization: Bearer <jwt>`), read from the env var named by
 * `TeamsProxyConfig.auth.credentialEnv`. The token itself is NEVER stored in
 * nanoclaw.json — only the env-var name is. The relay validates the token's
 * oid/appid/upn against its NCL_RELAY_ALLOWLIST before accepting the stream
 * (relay/src/south-auth.ts). We do not re-derive any auth meaning locally.
 *
 * The proto is loaded dynamically via @grpc/proto-loader (wire-compatible with
 * the relay's ts-proto static stubs) so the host build needs no codegen step.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { logger } from '../log-extensions.js';

/** Resolve proto/teams_relay.proto relative to this module (src → dist mirror). */
function resolveProtoPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // At runtime this file is dist/channels/teams-relay-client.js; the proto is
  // shipped to dist/proto/teams_relay.proto (see scripts/copy-proto). In dev
  // (ts-node/vitest) it is src/channels/… and the proto lives at ../../proto.
  const candidates = [
    path.resolve(here, '../proto/teams_relay.proto'), // dist/proto
    path.resolve(here, '../../proto/teams_relay.proto'), // repo root proto/
  ];
  return candidates.find((p) => existsSafe(p)) ?? candidates[candidates.length - 1];
}

function existsSafe(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** An inbound Teams activity delivered by the relay. */
export interface RelayInbound {
  botId: string;
  /** Relay-assigned delivery id; ack with this exact value. */
  activityId: string;
  /** Parsed Bot Framework activity JSON. */
  activity: any;
  /** Connector serviceUrl for this conversation (echoed by the relay). */
  serviceUrl: string;
  receivedUnixMs: number;
  fromBuffer: boolean;
}

/** An outbound reply to hand up the stream for the relay to deliver. */
export interface RelayOutbound {
  botId: string;
  /** Relay-assigned InboundActivity.activityId this answers; '' for proactive. */
  inReplyTo?: string;
  /** Bot Framework activity JSON to deliver. */
  activity: any;
  /** Connector serviceUrl to POST to. */
  serviceUrl: string;
  /** Idempotency key so a redelivered reply is not double-sent. */
  clientMsgId: string;
}

export interface TeamsRelayClientOpts {
  /** gRPC dial target, e.g. "relay-host:443". */
  southEndpoint: string;
  /** Bot ids (appIds) this NCL serves — becomes Hello.bot_ids. */
  botIds: string[];
  /** Owner AAD bearer token for south-edge metadata auth. */
  credential: string;
  /** Free-form instance label for relay audit. */
  nclInstance: string;
  /** Called for each inbound activity the relay routes to us. */
  onInbound: (inbound: RelayInbound) => Promise<void> | void;
  /** Use an insecure channel (dev/local only). Default false (TLS). */
  insecure?: boolean;
  /** Min/max reconnect backoff ms. Defaults 1000 / 30000. */
  backoffMinMs?: number;
  backoffMaxMs?: number;
}

const PROTO_PACKAGE = 'nanoclaw.teamsrelay.v1';
const PROTOCOL_VERSION = 1;

/**
 * Long-lived south client. `start()` dials + attaches and auto-reconnects until
 * `stop()`. Emits 'attached' (with accepted/rejected bot ids), 'inbound-error',
 * and 'closed' for observability/tests.
 */
export class TeamsRelayClient extends EventEmitter {
  private opts: Required<Pick<TeamsRelayClientOpts, 'backoffMinMs' | 'backoffMaxMs' | 'insecure'>> &
    TeamsRelayClientOpts;
  private client: any | null = null;
  private call: grpc.ClientDuplexStream<any, any> | null = null;
  private stopped = false;
  private backoff: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private ServiceCtor: any;

  constructor(opts: TeamsRelayClientOpts) {
    super();
    this.opts = {
      insecure: false,
      backoffMinMs: 1000,
      backoffMaxMs: 30000,
      ...opts,
    };
    this.backoff = this.opts.backoffMinMs;
  }

  /** Load the proto service constructor once. Exposed for tests. */
  loadService(): any {
    if (this.ServiceCtor) return this.ServiceCtor;
    const def = protoLoader.loadSync(resolveProtoPath(), {
      keepCase: false, // camelCase, matches ts-proto snakeToCamel on the relay
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const pkg = grpc.loadPackageDefinition(def) as any;
    const svc = PROTO_PACKAGE.split('.').reduce((acc, seg) => acc?.[seg], pkg)?.TeamsRelay;
    if (!svc) throw new Error(`TeamsRelay service not found in proto package ${PROTO_PACKAGE}`);
    this.ServiceCtor = svc;
    return svc;
  }

  private buildCredentials(): grpc.ChannelCredentials {
    if (this.opts.insecure) return grpc.credentials.createInsecure();
    // TLS transport + per-call metadata carrying the owner AAD bearer token.
    const channelCreds = grpc.credentials.createSsl();
    const callCreds = grpc.credentials.createFromMetadataGenerator((_params, cb) => {
      const md = new grpc.Metadata();
      md.set('authorization', `Bearer ${this.opts.credential}`);
      cb(null, md);
    });
    return grpc.credentials.combineChannelCredentials(channelCreds, callCreds);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    let Service: any;
    try {
      Service = this.loadService();
    } catch (err: any) {
      logger.error({ err: err?.message }, 'teams-relay: proto load failed');
      this.scheduleReconnect();
      return;
    }

    // For insecure channels the token still goes in metadata explicitly (the
    // combined-cred path only fires on secure channels).
    this.client = new Service(this.opts.southEndpoint, this.buildCredentials());

    const metadata = new grpc.Metadata();
    if (this.opts.insecure) metadata.set('authorization', `Bearer ${this.opts.credential}`);

    const call: grpc.ClientDuplexStream<any, any> = this.client.attach(metadata);
    this.call = call;

    call.on('data', (msg: any) => this.onToNcl(msg));
    call.on('error', (err: any) => {
      logger.warn({ err: err?.message, code: err?.code }, 'teams-relay: stream error');
      this.teardownCall();
      this.scheduleReconnect();
    });
    call.on('end', () => {
      logger.info('teams-relay: stream ended by server');
      this.teardownCall();
      this.scheduleReconnect();
    });

    // Hello MUST be the first frame.
    this.send({
      hello: {
        botIds: this.opts.botIds,
        nclInstance: this.opts.nclInstance,
        protocolVersion: PROTOCOL_VERSION,
        replayBuffered: true,
      },
    });
    logger.info({ endpoint: this.opts.southEndpoint, botIds: this.opts.botIds.length }, 'teams-relay: attaching');
  }

  private onToNcl(msg: any): void {
    // proto-loader with oneofs:true sets msg.kind to the active field name.
    if (msg.attachAck) {
      this.backoff = this.opts.backoffMinMs; // successful attach resets backoff
      const ack = msg.attachAck;
      if (ack.rejected?.length) {
        logger.warn({ rejected: ack.rejected }, 'teams-relay: some bot ids rejected');
      }
      logger.info({ accepted: ack.acceptedBotIds, sessionId: ack.sessionId }, 'teams-relay: attached');
      this.startHeartbeat(ack.heartbeatIntervalMs);
      this.emit('attached', {
        acceptedBotIds: ack.acceptedBotIds ?? [],
        rejected: ack.rejected ?? [],
        sessionId: ack.sessionId,
      });
      return;
    }
    if (msg.inbound) {
      this.handleInbound(msg.inbound);
      return;
    }
    if (msg.outboundAck) {
      const a = msg.outboundAck;
      if (!a.ok) {
        logger.warn(
          { clientMsgId: a.clientMsgId, status: a.connectorStatus, retryable: a.retryable, err: a.error },
          'teams-relay: outbound delivery failed',
        );
      }
      this.emit('outbound-ack', a);
      return;
    }
    if (msg.heartbeat) {
      return; // server liveness ping; nothing to do
    }
    if (msg.overflow) {
      logger.warn(
        { botId: msg.overflow.botId, dropped: msg.overflow.droppedCount, reason: msg.overflow.reason },
        'teams-relay: inbound buffer overflow',
      );
      this.emit('overflow', msg.overflow);
      return;
    }
    if (msg.drain) {
      logger.info(
        { deadline: msg.drain.drainDeadlineUnixMs, reason: msg.drain.reason, buffered: msg.drain.bufferedCount },
        'teams-relay: server draining, will reconnect',
      );
      this.emit('drain', msg.drain);
      // Server will close; our 'end'/'error' handler triggers reconnect.
      return;
    }
  }

  private async handleInbound(inbound: any): Promise<void> {
    let activity: any = {};
    try {
      const raw = inbound.activityJson;
      const text = Buffer.isBuffer(raw) ? raw.toString('utf-8') : String(raw ?? '');
      activity = text ? JSON.parse(text) : {};
    } catch (err: any) {
      logger.error({ err: err?.message, activityId: inbound.activityId }, 'teams-relay: inbound JSON parse failed');
      // Still ack so the relay stops buffering a poison item.
      this.ack(inbound.activityId, inbound.botId);
      return;
    }

    try {
      await this.opts.onInbound({
        botId: inbound.botId,
        activityId: inbound.activityId,
        activity,
        serviceUrl: inbound.serviceUrl,
        receivedUnixMs: Number(inbound.receivedUnixMs ?? 0),
        fromBuffer: Boolean(inbound.fromBuffer),
      });
    } catch (err: any) {
      logger.error({ err: err?.message, activityId: inbound.activityId }, 'teams-relay: onInbound handler threw');
      this.emit('inbound-error', err);
    } finally {
      // Ack after handing off (at-least-once; handler must be idempotent).
      this.ack(inbound.activityId, inbound.botId);
    }
  }

  /** Send an outbound reply up the stream. No-op (returns false) if detached. */
  sendReply(reply: RelayOutbound): boolean {
    return this.send({
      reply: {
        botId: reply.botId,
        inReplyTo: reply.inReplyTo ?? '',
        activityJson: Buffer.from(JSON.stringify(reply.activity), 'utf-8'),
        serviceUrl: reply.serviceUrl,
        clientMsgId: reply.clientMsgId,
      },
    });
  }

  private ack(activityId: string, botId: string): void {
    this.send({ ack: { activityId, botId } });
  }

  private send(frame: any): boolean {
    if (!this.call || this.stopped) return false;
    try {
      this.call.write(frame);
      return true;
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'teams-relay: write failed');
      return false;
    }
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    if (!intervalMs || intervalMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      this.send({ heartbeat: { sentUnixMs: Date.now() } });
    }, intervalMs);
    // Do not keep the event loop alive solely for heartbeats.
    this.heartbeatTimer.unref?.();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.opts.backoffMaxMs);
    logger.info({ delayMs: delay }, 'teams-relay: reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private teardownCall(): void {
    this.clearHeartbeat();
    if (this.call) {
      try {
        this.call.removeAllListeners();
      } catch {
        // ignore
      }
      this.call = null;
    }
    if (this.client) {
      try {
        (this.client as any).close?.();
      } catch {
        // ignore
      }
      this.client = null;
    }
  }

  /** Stop reconnecting and close the stream. */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.call) {
      try {
        this.call.end();
      } catch {
        // ignore
      }
    }
    this.teardownCall();
    this.emit('closed');
  }
}
