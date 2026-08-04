/**
 * Per-bot federation token exchange (VM, follow-up to #5).
 *
 * design §6 step 2: the shared UAMI's IMDS assertion (audience
 * `api://AzureADTokenExchange`) is exchanged for a SPECIFIC bot appId's Bot
 * Connector token, via the OAuth2 client-credentials grant with a federated
 * client assertion (FIC). This replaces the NOT_IMPLEMENTED stub in
 * outbound-sender.
 *
 * appId is NOT configured: per the appId-as-routing-key design
 * (docs/2026-06-27-relay-appid-routing-key.md), the relay's bot id IS the appId.
 * OutboundReply.bot_id (= the appId, one of the stream's Hello.bot_ids) flows
 * straight into the exchange — no map lookup, no NCL_RELAY_BOT_APPIDS. The only
 * config this still needs is the tenant id (for the token endpoint).
 */

import { logger } from './logger.js';

/** Entra v2 token endpoint for a tenant. */
const tokenEndpoint = (tenantId: string): string =>
  `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;

/** Bot Connector resource — the audience the outbound POST token must carry. */
const BOT_CONNECTOR_SCOPE = 'https://api.botframework.com/.default';

/** Federated client assertion type (RFC 7521 / Entra FIC). */
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/**
 * Error tagged non-retryable: a missing appId or tenant cannot be fixed by NCL
 * retrying the same reply. The outbound sender reads `.retryable === false` to
 * map this to a non-retryable OutboundAck.
 */
export class FederationConfigError extends Error {
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = 'FederationConfigError';
  }
}

export interface FederationExchangeDeps {
  /** Entra tenant id (config.tenantId). */
  tenantId: string | undefined;
  /**
   * POST an application/x-www-form-urlencoded body to the token endpoint and
   * return the parsed JSON. Injectable for tests; defaults to a real fetch.
   */
  postForm?: (url: string, form: URLSearchParams) => Promise<{ status: number; json: unknown }>;
}

async function realPostForm(url: string, form: URLSearchParams): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  let json: unknown = undefined;
  try {
    json = await res.json();
  } catch {
    /* leave undefined; caller treats a missing access_token as failure */
  }
  return { status: res.status, json };
}

/**
 * Build the `exchangeForBotToken(appId, imdsAssertion)` the outbound sender
 * injects. The incoming id IS the appId (routing key). On success returns the
 * Bot Connector access_token. Throws FederationConfigError (non-retryable) for a
 * missing appId/tenant, and a plain Error (retryable) for a transient token
 * endpoint failure.
 */
export function makeFederationExchange(
  deps: FederationExchangeDeps,
): (appId: string, imdsAssertion: string) => Promise<string> {
  const postForm = deps.postForm ?? realPostForm;

  return async function exchangeForBotToken(appId: string, imdsAssertion: string): Promise<string> {
    if (!appId) {
      throw new FederationConfigError('outbound reply missing bot id (appId) — cannot exchange federation token');
    }
    if (!deps.tenantId) {
      throw new FederationConfigError('relay misconfigured: AZURE_TENANT_ID unset (cannot exchange federation token)');
    }

    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: appId,
      scope: BOT_CONNECTOR_SCOPE,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: imdsAssertion,
    });

    const { status, json } = await postForm(tokenEndpoint(deps.tenantId), form);
    const body = (json ?? {}) as { access_token?: string; error?: string; error_description?: string };

    if (status >= 200 && status < 300 && body.access_token) {
      return body.access_token;
    }

    const detail = body.error_description || body.error || `HTTP ${status}`;
    // 4xx from Entra (bad assertion/registration) is generally not fixed by a
    // blind retry, but we keep token-endpoint failures retryable EXCEPT the
    // structural config errors above — NCL can retry once onboarding/FIC is set.
    logger.warn('federation token exchange failed', { appId, status, detail });
    throw new Error(`federation exchange failed for appId "${appId}": ${detail}`);
  };
}
