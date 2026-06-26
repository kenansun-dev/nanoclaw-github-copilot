/**
 * North edge (VM #2): the inbound HTTP/1.1 listener.
 *
 * Responsibilities:
 *   - GET /healthz            → liveness (App Service Always On / probes).
 *   - POST /api/messages/<bot> → the Teams Bot Service messaging endpoint.
 *       1. validate the BotFramework JWT (auth termination) — see jwt.ts.
 *       2. parse the activity, extract serviceUrl.
 *       3. hand to broker via InboundSink.enqueueInbound(...).
 *       "No NCL attached" is NOT an error here — the broker buffers/drops;
 *       we just ack the webhook 200/202 so Bot Connector isn't blocked.
 *
 * This file is the bootstrap shell. JWT validation (validateInboundJwt) and the
 * activity parse are filled in #2; the broker sink is injected so the north edge
 * never imports broker internals.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { logger } from './logger.js';
import type { InboundSink } from './contract.js';

export interface NorthEdgeDeps {
  sink: InboundSink;
  /**
   * Validates the BotFramework JWT on an inbound request and returns the
   * resolved bot context, or null if invalid (caller responds 401). Injected so
   * the listener shell stays independent of the validation impl (#2).
   */
  validateInboundJwt: (req: IncomingMessage, botId: string, body: Buffer) => Promise<InboundAuthResult | null>;
}

export interface InboundAuthResult {
  /** appId the JWT audience resolved to (cross-check vs <bot> path). */
  appId: string;
}

const MESSAGES_PREFIX = '/api/messages/';
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB — Teams activities are small.

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body?: string): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(body ?? JSON.stringify({ status }));
}

async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  botId: string,
  deps: NorthEdgeDeps,
): Promise<void> {
  if (req.method !== 'POST') {
    send(res, 405);
    return;
  }

  let body: Buffer;
  try {
    body = await readBody(req, MAX_BODY_BYTES);
  } catch {
    send(res, 413);
    return;
  }

  // 1. Auth termination — validate the BotFramework JWT (#2).
  const auth = await deps.validateInboundJwt(req, botId, body);
  if (!auth) {
    logger.warn('inbound rejected: JWT validation failed', { botId });
    send(res, 401);
    return;
  }

  // 2. Parse the activity, extract serviceUrl.
  let activityJson: Uint8Array;
  let serviceUrl: string;
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { serviceUrl?: unknown };
    serviceUrl = typeof parsed.serviceUrl === 'string' ? parsed.serviceUrl : '';
    activityJson = new Uint8Array(body);
  } catch {
    send(res, 400, JSON.stringify({ error: 'invalid activity JSON' }));
    return;
  }

  // 3. Hand to broker. "No NCL attached" does not throw — broker buffers/drops.
  try {
    await deps.sink.enqueueInbound({
      botId,
      activityJson,
      serviceUrl,
      receivedUnixMs: Date.now(),
    });
    // Ack so Bot Connector isn't blocked on NCL presence (decoupling §2).
    send(res, 202);
  } catch (err) {
    logger.error('inbound enqueue failed (internal)', {
      botId,
      err: err instanceof Error ? err.message : String(err),
    });
    send(res, 500);
  }
}

function router(deps: NorthEdgeDeps) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url ?? '';
    if (url === '/healthz' || url === '/') {
      send(res, 200, JSON.stringify({ status: 'ok', edge: 'north' }));
      return;
    }
    if (url.startsWith(MESSAGES_PREFIX)) {
      const botId = decodeURIComponent(url.slice(MESSAGES_PREFIX.length).split(/[/?]/)[0] ?? '');
      if (!botId) {
        send(res, 404, JSON.stringify({ error: 'missing bot id' }));
        return;
      }
      void handleMessages(req, res, botId, deps);
      return;
    }
    send(res, 404);
  };
}

export function startNorthEdge(port: number, deps: NorthEdgeDeps): Server {
  const server = createServer(router(deps));
  server.listen(port, '0.0.0.0', () => {
    logger.info('north edge listening', { port, path: '/api/messages/<bot>' });
  });
  return server;
}
