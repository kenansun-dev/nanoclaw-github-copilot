import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:net';
import {
  Server,
  ServerCredentials,
  credentials,
  Metadata,
  makeGenericClientConstructor,
  type ClientDuplexStream,
} from '@grpc/grpc-js';
import { startNorthEdge } from './north-edge.js';
import { makeBroker } from './broker.js';
import { makeAttachHandler } from './grpc-server.js';
import { makeOutboundSender } from './outbound-sender.js';
import { makeFederationExchange } from './federation.js';
import { TeamsRelayService, type FromNcl, type ToNcl } from './gen/teams_relay.js';
import type { Server as HttpServer } from 'node:http';

/**
 * Full relay pipeline e2e (Rpi5, after VM #2/#5 landed). Wires the REAL broker,
 * gRPC server, and outbound sender. Two cases:
 *
 *   Teams POST → north JWT termination (mock-pass) → broker.enqueueInbound →
 *   south stream (attached) receives InboundActivity → NCL replies →
 *   OutboundReply → outbound sender → ... → OutboundAck back down the stream.
 *
 *   1. No federation exchange injected → sender's fail-safe default throws
 *      NOT_IMPLEMENTED → OutboundAck(ok=false, retryable=true). Proves the
 *      internal chain routes an outbound error back correctly.
 *   2. REAL makeFederationExchange injected (postForm mocked to return a bot
 *      token) + Connector POST mocked 200 → OutboundAck(ok=true). Proves the
 *      production token path IMDS-assertion → federation exchange → Connector
 *      is wired end to end (only the two external trust roots — the token
 *      endpoint and the Connector — are mocked).
 *
 * The north JWT signature check is mock-passed throughout (external trust root).
 */

const ClientCtor = makeGenericClientConstructor(TeamsRelayService, 'TeamsRelay');

let grpcServers: Server[] = [];
let httpServers: HttpServer[] = [];
let openStreams: ClientDuplexStream<FromNcl, ToNcl>[] = [];

afterEach(() => {
  for (const s of openStreams) {
    s.on('error', () => {});
    try {
      s.cancel();
    } catch {
      /* closed */
    }
  }
  openStreams = [];
  for (const s of grpcServers) s.forceShutdown();
  grpcServers = [];
  for (const s of httpServers) s.close();
  httpServers = [];
});

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

/**
 * Drive the full pipeline once with the given outbound sender and return the
 * collected south-stream frames (+ the broker so the caller can stop it). Wires
 * REAL broker + gRPC server + north edge; only the JWT signature is mock-passed.
 */
async function runPipeline(
  sender: ReturnType<typeof makeOutboundSender>,
): Promise<{ frames: ToNcl[]; broker: ReturnType<typeof makeBroker> }> {
  const broker = makeBroker();

  // gRPC server with mock-pass south AAD auth + passthrough bot authorization.
  const grpcPort = await freePort();
  const grpc = new Server();
  grpc.addService(TeamsRelayService, {
    attach: makeAttachHandler({
      broker,
      sender,
      validateSouthToken: async () => ({ objectId: 'oid-owner', principal: 'owner@tenant' }),
      authorizeBots: (_c, ids) => ids,
      genSessionId: () => 'sess-e2e',
    }),
  });
  await new Promise<void>((resolve, reject) =>
    grpc.bindAsync(`127.0.0.1:${grpcPort}`, ServerCredentials.createInsecure(), (e) => (e ? reject(e) : resolve())),
  );
  grpcServers.push(grpc);

  // North edge with mock-pass JWT (real validator needs live Connector JWKS).
  const httpPort = await freePort();
  const north = startNorthEdge(httpPort, {
    sink: broker,
    validateInboundJwt: async (_req, _botId, _body) => ({ appId: 'app-prod' }),
  });
  httpServers.push(north);

  // 1. NCL dials in, sends Hello for botProd.
  const client = new ClientCtor(`127.0.0.1:${grpcPort}`, credentials.createInsecure());
  const stream = (client as any).attach(new Metadata()) as ClientDuplexStream<FromNcl, ToNcl>;
  openStreams.push(stream);

  const frames: ToNcl[] = [];
  stream.on('data', (m: ToNcl) => frames.push(m));

  await new Promise<void>((resolve) => {
    stream.write(
      { hello: { botIds: ['botProd'], nclInstance: 'rpi5', protocolVersion: 1, replayBuffered: false } } as FromNcl,
      () => setTimeout(resolve, 60),
    );
  });
  // AttachAck received.
  expect(frames.find((f) => f.attachAck)?.attachAck?.acceptedBotIds).toEqual(['botProd']);

  // 2. Teams POST hits the north edge → broker → pushed down the stream.
  const activity = JSON.stringify({
    type: 'message',
    serviceUrl: 'https://smba.example/',
    conversation: { id: 'c1' },
    id: 'incoming-1',
  });
  const postRes = await fetch(`http://127.0.0.1:${httpPort}/api/messages/botProd`, {
    method: 'POST',
    headers: { authorization: 'Bearer mock', 'content-type': 'application/json' },
    body: activity,
  });
  expect(postRes.status).toBe(202);

  // 3. The inbound activity arrives on the south stream.
  await new Promise((r) => setTimeout(r, 80));
  const inbound = frames.find((f) => f.inbound);
  expect(inbound?.inbound?.botId).toBe('botProd');
  expect(JSON.parse(new TextDecoder().decode(inbound!.inbound!.activityJson)).id).toBe('incoming-1');

  // 4. NCL replies; outbound sender runs.
  await new Promise<void>((resolve) => {
    stream.write(
      {
        reply: {
          botId: 'botProd',
          inReplyTo: inbound!.inbound!.activityId,
          activityJson: new TextEncoder().encode(
            JSON.stringify({ type: 'message', text: 'hi back', conversation: { id: 'c1' }, replyToId: 'incoming-1' }),
          ),
          serviceUrl: 'https://smba.example/',
          clientMsgId: 'cm-1',
        },
      } as FromNcl,
      () => setTimeout(resolve, 80),
    );
  });

  return { frames, broker };
}

describe('relay e2e: full pipeline', () => {
  it('outbound reply → retryable ack when no federation exchange is injected', async () => {
    // Real outbound sender; IMDS token mocked to succeed, no federation exchange
    // injected → sender's fail-safe default throws NOT_IMPLEMENTED.
    const sender = makeOutboundSender({
      msiClientId: 'msi-shared',
      fetchImdsToken: async () => 'imds-assertion-token',
      // exchangeForBotToken omitted → fail-safe default throws NOT_IMPLEMENTED.
    });

    const { frames, broker } = await runPipeline(sender);

    // OutboundAck: not ok (fail-safe), but retryable=true — internal chain proven.
    const ack = frames.find((f) => f.outboundAck);
    expect(ack?.outboundAck?.clientMsgId).toBe('cm-1');
    expect(ack?.outboundAck?.ok).toBe(false);
    expect(ack?.outboundAck?.retryable).toBe(true);
    expect(ack?.outboundAck?.error).toContain('NOT_IMPLEMENTED');

    broker.stop();
  });

  it('outbound reply → ok ack with REAL federation exchange (token endpoint + Connector mocked)', async () => {
    // The production token path: IMDS assertion → REAL makeFederationExchange
    // (postForm mocked to return a bot token) → Connector POST (mocked 200).
    // Only the two external trust roots are mocked; the exchange logic is real.
    let exchangedAppId = '';
    let connectorToken = '';
    const sender = makeOutboundSender({
      msiClientId: 'msi-shared',
      fetchImdsToken: async () => 'imds-assertion-token',
      exchangeForBotToken: makeFederationExchange({
        tenantId: 'tenant-1',
        postForm: async (_url, form) => {
          exchangedAppId = form.get('client_id') ?? '';
          // Assert the real exchange built a proper FIC client-credentials body.
          expect(form.get('grant_type')).toBe('client_credentials');
          expect(form.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
          expect(form.get('client_assertion')).toBe('imds-assertion-token');
          return { status: 200, json: { access_token: 'bot-connector-token' } };
        },
      }),
      httpPost: async (_url, token) => {
        connectorToken = token;
        return { status: 200 };
      },
    });

    const { frames, broker } = await runPipeline(sender);

    const ack = frames.find((f) => f.outboundAck);
    expect(ack?.outboundAck?.clientMsgId).toBe('cm-1');
    expect(ack?.outboundAck?.ok).toBe(true);
    expect(ack?.outboundAck?.connectorStatus).toBe(200);
    // The bot_id from the reply (= appId, routing key) flowed into the exchange.
    expect(exchangedAppId).toBe('botProd');
    // The federated Connector token reached the Connector POST.
    expect(connectorToken).toBe('bot-connector-token');

    broker.stop();
  });
});
