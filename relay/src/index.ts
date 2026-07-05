/**
 * Relay bootstrap (VM #1): single Node process, two listeners.
 *
 *   - North edge (HTTP/1.1, WEBSITES_PORT): Teams inbound /api/messages/<bot>.
 *   - gRPC server (HTTP/2, HTTP20_ONLY_PORT): the NCL south-edge Attach stream.
 *
 * Both coexist in one process (App Service gives one h2 port + the normal HTTPS
 * port). This file owns startup/shutdown wiring only; the broker core, gRPC
 * server, JWT validator, outbound sender, federation exchange, and south-edge
 * AAD validator are all wired below with their real implementations.
 */

import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { startNorthEdge } from './north-edge.js';
import { makeBroker } from './broker.js';
import { startGrpcServer } from './grpc-server.js';
import { makeJwtValidator } from './inbound-jwt.js';
import { makeOutboundSender } from './outbound-sender.js';
import { makeFederationExchange } from './federation.js';
import { makeSouthTokenValidator, makeAadTokenVerifier } from './south-auth.js';

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

  // North edge — inbound Teams webhook. Validates the BotFramework JWT per bot;
  // the <bot> path segment IS the appId, so the JWT audience must equal it
  // (resolveAppId = identity). Empty/unknown id or invalid token → 401.
  const validateInboundJwt = makeJwtValidator({
    resolveAppId: (botId) => botId || undefined,
    channelService: config.channelService,
  });
  const north = startNorthEdge(config.webhookPort, {
    sink: broker,
    validateInboundJwt,
  });

  // South edge outbound sender (VM #5): MSI IMDS token → per-bot federation
  // exchange (OutboundReply.bot_id IS the appId) → Connector POST.
  const sender = makeOutboundSender({
    msiClientId: config.msiClientId,
    exchangeForBotToken: makeFederationExchange({
      tenantId: config.tenantId,
    }),
  });

  // gRPC server holding the NCL stream. AAD validation verifies the caller's
  // Entra token (JWKS) then gates it against the owner allowlist (config
  // NCL_RELAY_ALLOWLIST); empty allowlist = deny-all (fail-closed). Per-bot ACL
  // is a next-task concern (bot onboarding), so v1 authorizeBots passes the
  // requested bots through unchanged once the caller is authenticated.
  const validateSouthToken = makeSouthTokenValidator({
    allowlist: config.southEdgeAllowlist,
    verifyToken: makeAadTokenVerifier({ tenantId: config.tenantId }),
  });
  const grpc = await startGrpcServer(config.grpcPort, {
    broker,
    sender,
    validateSouthToken,
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
