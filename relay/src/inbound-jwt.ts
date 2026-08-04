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
 * segment IS the appId (appId-as-routing-key design,
 * docs/2026-06-27-relay-appid-routing-key.md). The inbound JWT must be
 * audienced for that appId. A resolver (bot-id -> appId) keeps the mapping
 * injectable, but the production wiring is the IDENTITY function: the path
 * segment is the appId, self-describing, no configured map. Security is
 * unchanged — only the bot's own Azure registration can mint a Microsoft-signed
 * token with aud=<that appId>, so a forged path segment fails validation.
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
   * Resolve the appId a given bot-id's inbound JWT must be audienced for. In the
   * appId-as-routing-key model this is the IDENTITY function (the bot-id IS the
   * appId). Returns undefined to reject an empty/unknown id. Kept injectable so
   * a future multi-owner entitlement check can wrap it.
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
