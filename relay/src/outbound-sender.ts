/**
 * South-edge outbound sender (VM #5).
 *
 * Implements OutboundSender: takes a reply NCL produced and delivers it to Teams
 * via the Bot Connector. Two steps:
 *
 *   1. Acquire a bearer token for the bot.
 *        - The App Service carries a shared user-assigned MSI. We pull an IMDS
 *          token for `resource=api://AzureADTokenExchange` (the federation
 *          assertion audience). This part needs no per-bot data and works today.
 *        - The PER-BOT FEDERATION EXCHANGE (IMDS assertion → that bot's
 *          appId token, design §6) requires the bot's appId, which comes from
 *          BOT ONBOARDING — the NEXT task. So exchangeForBotToken is a STUB that
 *          throws NOT_IMPLEMENTED here; #5 deliberately does not reach e2e to
 *          Teams yet, and does not do onboarding's job.
 *   2. POST the activity to the Connector serviceUrl with that bearer.
 *
 * Connector failures are encoded in OutboundResult (with a retryable hint), not
 * thrown — only unexpected internal errors throw (per the contract).
 */

import type { OutboundSender, OutboundReplyInput, OutboundResult } from './contract.js';
import { logger } from './logger.js';

const IMDS_TOKEN_URL = 'http://169.254.169.254/metadata/identity/oauth2/token';
const IMDS_API_VERSION = '2019-08-01';
/** Federation assertion audience (design §6 step 1). */
const TOKEN_EXCHANGE_RESOURCE = 'api://AzureADTokenExchange';

export interface OutboundSenderDeps {
  /** Shared MSI client id (config.msiClientId). Required to target the UAMI. */
  msiClientId: string | undefined;
  /**
   * Pulls an IMDS token for the given resource using the shared MSI. Injectable
   * for tests; defaults to the real IMDS fetch. Returns the access_token.
   */
  fetchImdsToken?: (resource: string, clientId: string) => Promise<string>;
  /**
   * Exchange the MSI IMDS assertion for a given bot appId's Bot Connector token
   * (design §6 federation). Default throws NOT_IMPLEMENTED; production injects
   * makeFederationExchange (reads appId from config.botAppIds). A thrown error
   * carrying `retryable===false` (FederationConfigError) is surfaced as a
   * non-retryable ack.
   */
  exchangeForBotToken?: (botId: string, imdsAssertion: string) => Promise<string>;
  /** HTTP POST to the Connector; injectable for tests. */
  httpPost?: (url: string, token: string, bodyJson: Uint8Array) => Promise<{ status: number }>;
}

/** Maps a Connector HTTP status to the retryable hint NCL uses (proto OutboundAck). */
export function isRetryableConnectorStatus(status: number): boolean {
  // 429 + 5xx are transient; 401/403/4xx are not (re-auth or bad request).
  return status === 429 || (status >= 500 && status <= 599);
}

async function realImdsToken(resource: string, clientId: string): Promise<string> {
  const url = `${IMDS_TOKEN_URL}?api-version=${IMDS_API_VERSION}&resource=${encodeURIComponent(resource)}&client_id=${encodeURIComponent(clientId)}`;
  const res = await fetch(url, { headers: { Metadata: 'true' } });
  if (!res.ok) {
    throw new Error(`IMDS token request failed: ${res.status}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('IMDS response missing access_token');
  return json.access_token;
}

async function realHttpPost(url: string, token: string, bodyJson: Uint8Array): Promise<{ status: number }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: bodyJson,
  });
  return { status: res.status };
}

const notImplementedExchange = async (botId: string): Promise<string> => {
  throw new Error(`NOT_IMPLEMENTED: per-bot federation token exchange for "${botId}" lands with bot onboarding (next task)`);
};

export function makeOutboundSender(deps: OutboundSenderDeps): OutboundSender {
  const fetchImdsToken = deps.fetchImdsToken ?? realImdsToken;
  const exchangeForBotToken = deps.exchangeForBotToken ?? notImplementedExchange;
  const httpPost = deps.httpPost ?? realHttpPost;

  return {
    async deliverOutbound(reply: OutboundReplyInput): Promise<OutboundResult> {
      const fail = (status: number, error: string): OutboundResult => ({
        clientMsgId: reply.clientMsgId,
        ok: false,
        connectorStatus: status,
        error,
        retryable: isRetryableConnectorStatus(status),
      });

      if (!deps.msiClientId) {
        // Misconfiguration, not a Connector failure — non-retryable, surfaced.
        return {
          clientMsgId: reply.clientMsgId,
          ok: false,
          connectorStatus: 0,
          error: 'relay misconfigured: NCL_BOT_MSI_CLIENT_ID unset',
          retryable: false,
        };
      }
      if (!reply.serviceUrl) {
        return {
          clientMsgId: reply.clientMsgId,
          ok: false,
          connectorStatus: 0,
          error: 'outbound reply missing serviceUrl',
          retryable: false,
        };
      }

      // 1. MSI IMDS assertion (works today) → per-bot Connector token.
      let botToken: string;
      try {
        const imdsAssertion = await fetchImdsToken(TOKEN_EXCHANGE_RESOURCE, deps.msiClientId);
        botToken = await exchangeForBotToken(reply.botId, imdsAssertion);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // A FederationConfigError (missing appId/tenant) is non-retryable —
        // retrying won't conjure a registration. Other token failures are
        // transient (re-auth may succeed). Read the flag without importing the
        // class so the sender stays decoupled from the exchange impl.
        const retryable = (err as { retryable?: boolean })?.retryable !== false;
        logger.warn('outbound token acquisition failed', { botId: reply.botId, err: msg, retryable });
        return {
          clientMsgId: reply.clientMsgId,
          ok: false,
          connectorStatus: 0,
          error: msg,
          retryable,
        };
      }

      // 2. POST to the Connector.
      const url = buildConnectorUrl(reply.serviceUrl, reply.activityJson);
      let status: number;
      try {
        ({ status } = await httpPost(url, botToken, reply.activityJson));
      } catch (err) {
        // Network-level failure reaching the Connector — transient, retryable.
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('outbound Connector POST threw', { botId: reply.botId, err: msg });
        return { clientMsgId: reply.clientMsgId, ok: false, connectorStatus: 0, error: msg, retryable: true };
      }

      if (status >= 200 && status < 300) {
        return { clientMsgId: reply.clientMsgId, ok: true, connectorStatus: status, retryable: false };
      }
      return fail(status, `Connector returned ${status}`);
    },
  };
}

/**
 * Build the Connector POST URL. The serviceUrl is the conversation base; the
 * full reply path is `<serviceUrl>/v3/conversations/.../activities/...`. For v1
 * the activity JSON already carries conversation + (optional) replyToId; we POST
 * to the conversations activities endpoint derived from serviceUrl. Kept small
 * and pure for testing; refined when the activity shape is exercised e2e.
 */
export function buildConnectorUrl(serviceUrl: string, activityJson: Uint8Array): string {
  const base = serviceUrl.endsWith('/') ? serviceUrl.slice(0, -1) : serviceUrl;
  let conversationId = '';
  let replyToId = '';
  try {
    const a = JSON.parse(Buffer.from(activityJson).toString('utf8')) as {
      conversation?: { id?: string };
      replyToId?: string;
    };
    conversationId = a.conversation?.id ?? '';
    replyToId = a.replyToId ?? '';
  } catch {
    /* leave empty; caller still gets a base path */
  }
  const convSeg = encodeURIComponent(conversationId);
  return replyToId
    ? `${base}/v3/conversations/${convSeg}/activities/${encodeURIComponent(replyToId)}`
    : `${base}/v3/conversations/${convSeg}/activities`;
}
