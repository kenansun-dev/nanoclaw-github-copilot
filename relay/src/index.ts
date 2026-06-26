/**
 * Relay bootstrap (VM #1): single Node process, two listeners.
 *
 *   - North edge (HTTP/1.1, WEBSITES_PORT): Teams inbound /api/messages/<bot>.
 *   - gRPC server (HTTP/2, HTTP20_ONLY_PORT): the NCL south-edge Attach stream.
 *
 * Both coexist in one process (App Service gives one h2 port + the normal HTTPS
 * port). This file owns startup/shutdown wiring only; the broker core (Rpi5 #4)
 * and gRPC server (Rpi5 #3) plug in via startGrpcServer, and the outbound
 * sender (VM #5) is injected into the broker.
 *
 * Until those land, a no-op broker + stub gRPC starter keep the process
 * bootable so the north edge and config are independently runnable/testable.
 */

import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { startNorthEdge, type InboundAuthResult } from './north-edge.js';
import type { InboundSink, InboundActivityInput, OutboundSender } from './contract.js';
import type { IncomingMessage } from 'node:http';

// ─── Placeholder seams (replaced by the owning subsystems) ───────────────────

/**
 * #2 (VM): real BotFramework JWT validation lands here. The bootstrap default
 * REJECTS everything (fail-closed) so an unconfigured relay never forwards
 * unauthenticated traffic. Replaced before north edge is considered done.
 */
const rejectAllJwt = async (
  _req: IncomingMessage,
  _botId: string,
  _body: Buffer,
): Promise<InboundAuthResult | null> => null;

/**
 * #4 (Rpi5): real broker (route → attached stream or buffer+TTL+drop+audit).
 * Bootstrap default logs and no-ops so the process boots before the broker
 * lands. It does NOT throw on "no NCL" — matches the contract.
 */
const noopSink: InboundSink = {
  async enqueueInbound(activity: InboundActivityInput): Promise<void> {
    logger.warn('broker not wired — inbound dropped (bootstrap no-op sink)', {
      botId: activity.botId,
      bytes: activity.activityJson.byteLength,
    });
  },
};

/**
 * #5 (VM): real outbound sender (MSI IMDS token + Bot Connector POST; per-bot
 * federation exchange stubbed until the onboarding task). Held here so the
 * broker/gRPC layer can be handed an OutboundSender once wired.
 */
const notImplementedSender: OutboundSender = {
  async deliverOutbound(reply) {
    logger.warn('outbound sender not wired (bootstrap stub)', { botId: reply.botId });
    return {
      clientMsgId: reply.clientMsgId,
      ok: false,
      connectorStatus: 0,
      error: 'outbound sender not implemented (bootstrap stub)',
      retryable: false,
    };
  },
};

/**
 * #3 (Rpi5): real gRPC server starts the Attach bidi stream + AAD metadata
 * interceptor + allowlist. Bootstrap default just logs that it's not wired so
 * the process still boots with only the north edge live.
 */
async function startGrpcServerStub(port: number, _sender: OutboundSender): Promise<void> {
  logger.warn('gRPC server not wired — south edge inactive (bootstrap stub)', { port });
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info('relay starting', {
    webhookPort: config.webhookPort,
    grpcPort: config.grpcPort,
    allowlistSize: config.southEdgeAllowlist.length,
    msiClientId: config.msiClientId ? 'set' : 'unset',
    tenantId: config.tenantId ? 'set' : 'unset',
  });

  // North edge — inbound Teams webhook. JWT validator is fail-closed until #2.
  const north = startNorthEdge(config.webhookPort, {
    sink: noopSink,
    validateInboundJwt: rejectAllJwt,
  });

  // South edge — gRPC server (Rpi5 #3) holding the NCL stream. Stubbed until wired.
  await startGrpcServerStub(config.grpcPort, notImplementedSender);

  const shutdown = (signal: string): void => {
    logger.info('relay shutting down', { signal });
    north.close(() => {
      logger.info('north edge closed');
      process.exit(0);
    });
    // Hard exit guard if close hangs.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('relay failed to start', { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
