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
import { TeamsRelayService, type FromNcl, type ToNcl } from './gen/teams_relay.js';
import type { Server as HttpServer } from 'node:http';

/**
 * Full relay pipeline e2e (Rpi5, after VM #2/#5 landed). Wires the REAL broker,
 * gRPC server, and outbound sender (only the per-bot federation exchange and the
 * north JWT signature check are mocked — those are external trust roots, not
 * relay logic). Proves the internal chain:
 *
 *   Teams POST → north JWT termination (mock-pass) → broker.enqueueInbound →
 *   south stream (attached) receives InboundActivity → NCL replies →
 *   OutboundReply → outbound sender → exchangeForBotToken NOT_IMPLEMENTED stub →
 *   OutboundAck(ok=false, retryable=true) back down the stream.
 *
 * The outbound stops at the federation stub by design (onboarding = next task);
 * reaching a retryable ack proves the relay's internal wiring is complete.
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

describe('relay e2e: full pipeline', () => {
  it('Teams POST → broker → south stream → outbound reply → retryable ack at federation stub', async () => {
    const broker = makeBroker();

    // Real outbound sender; IMDS token mocked to succeed, federation exchange
    // left as the real NOT_IMPLEMENTED stub.
    const sender = makeOutboundSender({
      msiClientId: 'msi-shared',
      fetchImdsToken: async () => 'imds-assertion-token',
      // exchangeForBotToken omitted → real stub throws NOT_IMPLEMENTED.
    });

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
    const activity = JSON.stringify({ type: 'message', serviceUrl: 'https://smba.example/', conversation: { id: 'c1' }, id: 'incoming-1' });
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

    // 4. NCL replies; outbound sender runs, stops at the federation stub.
    await new Promise<void>((resolve) => {
      stream.write(
        {
          reply: {
            botId: 'botProd',
            inReplyTo: inbound!.inbound!.activityId,
            activityJson: new TextEncoder().encode(JSON.stringify({ type: 'message', text: 'hi back', conversation: { id: 'c1' }, replyToId: 'incoming-1' })),
            serviceUrl: 'https://smba.example/',
            clientMsgId: 'cm-1',
          },
        } as FromNcl,
        () => setTimeout(resolve, 80),
      );
    });

    // 5. OutboundAck: not ok (stub), but retryable=true — internal chain proven.
    const ack = frames.find((f) => f.outboundAck);
    expect(ack?.outboundAck?.clientMsgId).toBe('cm-1');
    expect(ack?.outboundAck?.ok).toBe(false);
    expect(ack?.outboundAck?.retryable).toBe(true);
    expect(ack?.outboundAck?.error).toContain('NOT_IMPLEMENTED');

    broker.stop();
  });
});
