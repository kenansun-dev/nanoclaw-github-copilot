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
import { startNorthEdge } from './north-edge.js';
import type { OutboundSender } from './contract.js';
import { makeBroker } from './broker.js';
import { startGrpcServer, type SouthCaller } from './grpc-server.js';
import { makeJwtValidator } from './inbound-jwt.js';
import type { Metadata } from '@grpc/grpc-js';

// ─── Placeholder seams (replaced by the owning subsystems) ───────────────────

/**
 * #2 (VM): real BotFramework JWT validation is wired below via makeJwtValidator
 * (per-bot appId from config.botAppIds). The validator is fail-closed: an
 * unknown bot or invalid token → reject → 401.
 */

/**
 * #4 (Rpi5): broker is now wired (route → attached stream or buffer+TTL+drop+
 * audit). The bootstrap no-op sink is retired.
 */

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
 * #3 (Rpi5): gRPC server is wired below via startGrpcServer. The south-edge AAD
 * token VALIDATION is injected (validateSouthToken); the bootstrap default is
 * fail-closed until real JWKS wiring lands. Token ACQUISITION on the NCL side is
 * the next task.
 */
const rejectAllSouthToken = async (_md: Metadata): Promise<SouthCaller | null> => null;

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

  // Broker core — routes inbound to the attached NCL stream or buffers (TTL).
  const broker = makeBroker();

  // North edge — inbound Teams webhook. Validates the BotFramework JWT per bot
  // (audience = that bot's appId from config.botAppIds); unknown bot or invalid
  // token → 401 (fail-closed).
  const validateInboundJwt = makeJwtValidator({
    resolveAppId: (botId) => config.botAppIds.get(botId),
    channelService: config.channelService,
  });
  const north = startNorthEdge(config.webhookPort, {
    sink: broker,
    validateInboundJwt,
  });

  // South edge — gRPC server (Rpi5 #3) holding the NCL stream. AAD validation is
  // fail-closed until real JWKS wiring; the owner allowlist (config
  // NCL_RELAY_ALLOWLIST) is the CALLER gate, enforced inside validateSouthToken
  // once wired. Per-bot ACL is a next-task concern (bot onboarding), so v1
  // authorizeBots passes the requested bots through unchanged once the caller is
  // already authenticated+allowlisted. The outbound sender (VM #5) is injected;
  // its federation exchange is stubbed until the onboarding task.
  const grpc = await startGrpcServer(config.grpcPort, {
    broker,
    sender: notImplementedSender,
    validateSouthToken: rejectAllSouthToken,
    authorizeBots: (_caller, requestedBotIds) => requestedBotIds,
  });

  const shutdown = (signal: string): void => {
    logger.info('relay shutting down', { signal });
    broker.stop();
    grpc.tryShutdown(() => logger.info('gRPC server closed'));
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
