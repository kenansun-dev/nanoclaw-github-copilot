import { describe, it, expect, afterEach } from 'vitest';
import {
  Server,
  ServerCredentials,
  credentials,
  Metadata,
  makeGenericClientConstructor,
  type ClientDuplexStream,
} from '@grpc/grpc-js';
import { type GrpcServerDeps } from './grpc-server.js';
import { TeamsRelayService, type FromNcl, type ToNcl } from './gen/teams_relay.js';
import { makeBroker, type Broker } from './broker.js';
import type { OutboundSender, OutboundResult } from './contract.js';

/**
 * gRPC server tests (Rpi5 #3). Exercises the real wire over a loopback bind:
 * AAD reject, Hello accept/partial-reject, outbound reply → OutboundSender, and
 * broker inbound push reaching the client.
 */

const ClientCtor = makeGenericClientConstructor(TeamsRelayService, 'TeamsRelay');

let servers: Server[] = [];
let openStreams: ClientDuplexStream<FromNcl, ToNcl>[] = [];
afterEach(() => {
  // Swallow the expected 'Call cancelled' from streams torn down by shutdown.
  for (const s of openStreams) {
    s.on('error', () => {});
    try {
      s.cancel();
    } catch {
      /* already closed */
    }
  }
  openStreams = [];
  for (const s of servers) s.forceShutdown();
  servers = [];
});

function okSender(results: OutboundResult[] = []): OutboundSender {
  return {
    async deliverOutbound(reply) {
      const r: OutboundResult = { clientMsgId: reply.clientMsgId, ok: true, connectorStatus: 200, retryable: false };
      results.push(r);
      return r;
    },
  };
}

// startGrpcServer binds port 0 (ephemeral) but doesn't surface the chosen port;
// for tests bind an explicit free port instead.
import { createServer } from 'node:net';
function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

async function startOn(port: number, deps: Partial<GrpcServerDeps> & { broker: Broker }): Promise<Server> {
  const full: GrpcServerDeps = {
    broker: deps.broker,
    sender: deps.sender ?? okSender(),
    validateSouthToken: deps.validateSouthToken ?? (async () => ({ objectId: 'oid1', principal: 'owner@t' })),
    authorizeBots: deps.authorizeBots ?? ((_c, ids) => ids),
    genSessionId: deps.genSessionId ?? (() => 'sessFixed'),
  };
  const server = new Server();
  const { makeAttachHandler } = await import('./grpc-server.js');
  server.addService(TeamsRelayService, { attach: makeAttachHandler(full) });
  await new Promise<void>((resolve, reject) =>
    server.bindAsync(`127.0.0.1:${port}`, ServerCredentials.createInsecure(), (e) => (e ? reject(e) : resolve())),
  );
  servers.push(server);
  return server;
}

function dial(port: number): { client: any; stream: ClientDuplexStream<FromNcl, ToNcl> } {
  const client = new ClientCtor(`127.0.0.1:${port}`, credentials.createInsecure());
  const stream = (client as any).attach(new Metadata()) as ClientDuplexStream<FromNcl, ToNcl>;
  openStreams.push(stream);
  return { client, stream };
}

describe('grpc-server: south auth', () => {
  it('rejects when validateSouthToken returns null', async () => {
    const broker = makeBroker();
    const port = await freePort();
    await startOn(port, { broker, validateSouthToken: async () => null });
    const { stream } = dial(port);
    const err = await new Promise<any>((resolve) => {
      stream.on('error', resolve);
      stream.write({ hello: { botIds: ['botA'], nclInstance: 'x', protocolVersion: 1, replayBuffered: false } } as FromNcl);
    });
    expect(err).toBeTruthy();
    broker.stop();
  });
});

describe('grpc-server: hello + attach', () => {
  it('accepts permitted bots, rejects others in AttachAck', async () => {
    const broker = makeBroker();
    const port = await freePort();
    await startOn(port, { broker, authorizeBots: (_c, ids) => ids.filter((b) => b === 'botA') });
    const { stream } = dial(port);
    const ack = await new Promise<ToNcl>((resolve) => {
      stream.on('data', resolve);
      stream.write({ hello: { botIds: ['botA', 'botB'], nclInstance: 'x', protocolVersion: 1, replayBuffered: false } } as FromNcl);
    });
    expect(ack.attachAck?.acceptedBotIds).toEqual(['botA']);
    expect(ack.attachAck?.rejected.map((r) => r.botId)).toEqual(['botB']);
    expect(ack.attachAck?.sessionId).toBe('sessFixed');
    broker.stop();
  });

  it('broker inbound reaches the client after attach', async () => {
    const broker = makeBroker();
    const port = await freePort();
    await startOn(port, { broker });
    const { stream } = dial(port);
    const frames: ToNcl[] = [];
    stream.on('data', (m: ToNcl) => frames.push(m));
    await new Promise<void>((resolve) => {
      stream.write(
        { hello: { botIds: ['botA'], nclInstance: 'x', protocolVersion: 1, replayBuffered: false } } as FromNcl,
        () => setTimeout(resolve, 50),
      );
    });
    await broker.enqueueInbound({ botId: 'botA', activityJson: new TextEncoder().encode('hi'), serviceUrl: 'https://s/', receivedUnixMs: 1 });
    await new Promise((r) => setTimeout(r, 50));
    const inbound = frames.find((f) => f.inbound);
    expect(inbound?.inbound?.botId).toBe('botA');
    expect(new TextDecoder().decode(inbound!.inbound!.activityJson)).toBe('hi');
    broker.stop();
  });
});

describe('grpc-server: outbound reply', () => {
  it('routes OutboundReply to sender and acks ok', async () => {
    const broker = makeBroker();
    const results: OutboundResult[] = [];
    const port = await freePort();
    await startOn(port, { broker, sender: okSender(results) });
    const { stream } = dial(port);
    const acks: ToNcl[] = [];
    stream.on('data', (m: ToNcl) => acks.push(m));
    await new Promise<void>((resolve) => {
      stream.write(
        { hello: { botIds: ['botA'], nclInstance: 'x', protocolVersion: 1, replayBuffered: false } } as FromNcl,
        () => setTimeout(resolve, 50),
      );
    });
    await new Promise<void>((resolve) => {
      stream.write(
        {
          reply: { botId: 'botA', inReplyTo: '', activityJson: new TextEncoder().encode('reply'), serviceUrl: 'https://s/', clientMsgId: 'm1' },
        } as FromNcl,
        () => setTimeout(resolve, 50),
      );
    });
    const ack = acks.find((a) => a.outboundAck);
    expect(ack?.outboundAck?.ok).toBe(true);
    expect(ack?.outboundAck?.clientMsgId).toBe('m1');
    expect(results).toHaveLength(1);
    broker.stop();
  });
});
