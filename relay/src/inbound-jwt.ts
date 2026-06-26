/**
 * North-edge inbound auth termination (VM #2).
 *
 * Validates the BotFramework JWT on an inbound Teams POST using
 * `botframework-connector`'s JwtTokenValidation.authenticateRequest — the same
 * primitive the full BotFrameworkAdapter uses, but used directly so the relay
 * only TERMINATES auth and forwards bytes (it is not a bot, it has no turn
 * logic).
 *
 * Per-bot: the relay hosts N bots, each with its own appId. The <bot> path
 * segment selects which appId the inbound JWT must be audienced for. appIds are
 * supplied by a resolver (bot-id -> appId) so the source (env now, bot
 * onboarding later) stays out of this file.
 *
 * The JWT carries no client secret — channel-token validation is signature +
 * issuer + audience against the Bot Connector's published JWKS. So we use a
 * SimpleCredentialProvider with just the appId and an empty password; password
 * is irrelevant to inbound channel-token validation.
 */

import { JwtTokenValidation, SimpleCredentialProvider } from 'botframework-connector';
import type { IncomingMessage } from 'node:http';
import type { InboundAuthResult } from './north-edge.js';
import { logger } from './logger.js';

export interface JwtValidatorDeps {
  /**
   * Resolve the appId a given bot-id's inbound JWT must be audienced for.
   * Returns undefined for an unknown bot (→ reject). Sourced from config/env in
   * v1; bot onboarding owns the real registry next task.
   */
  resolveAppId: (botId: string) => string | undefined;
  /**
   * Channel service string for JwtTokenValidation. Empty string = public Azure
   * Bot Service (the default). Government cloud would set this.
   */
  channelService?: string;
}

/**
 * Build the north edge's validateInboundJwt(req, botId, body) from a per-bot
 * appId resolver. Returns null (reject → 401) on any validation failure; the
 * resolved appId on success.
 */
export function makeJwtValidator(
  deps: JwtValidatorDeps,
): (req: IncomingMessage, botId: string, body: Buffer) => Promise<InboundAuthResult | null> {
  const channelService = deps.channelService ?? '';

  return async function validateInboundJwt(
    req: IncomingMessage,
    botId: string,
    body: Buffer,
  ): Promise<InboundAuthResult | null> {
    const appId = deps.resolveAppId(botId);
    if (!appId) {
      logger.warn('inbound JWT: unknown bot id (no appId)', { botId });
      return null;
    }

    const authHeader = req.headers['authorization'] ?? req.headers['Authorization' as 'authorization'] ?? '';
    if (!authHeader) {
      logger.warn('inbound JWT: missing authorization header', { botId });
      return null;
    }

    // authenticateRequest needs the activity (for serviceUrl/channelId checks).
    let activity: { serviceUrl?: string; channelId?: string };
    try {
      activity = JSON.parse(body.toString('utf8'));
    } catch {
      logger.warn('inbound JWT: body is not JSON', { botId });
      return null;
    }

    const credentials = new SimpleCredentialProvider(appId, '');
    try {
      const identity = await JwtTokenValidation.authenticateRequest(
        activity as never,
        Array.isArray(authHeader) ? authHeader[0] : authHeader,
        credentials,
        channelService,
      );
      if (!identity || !identity.isAuthenticated) {
        logger.warn('inbound JWT: not authenticated', { botId });
        return null;
      }
      return { appId };
    } catch (err) {
      logger.warn('inbound JWT: validation threw', {
        botId,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };
}
