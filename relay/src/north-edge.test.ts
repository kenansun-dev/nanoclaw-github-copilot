import { describe, it, expect, afterEach } from 'vitest';
import { startNorthEdge, type NorthEdgeDeps, type InboundAuthResult } from './north-edge.js';
import type { InboundActivityInput } from './contract.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

function start(deps: Partial<NorthEdgeDeps> & { sink: NorthEdgeDeps['sink'] }): Promise<string> {
  const full: NorthEdgeDeps = {
    sink: deps.sink,
    validateInboundJwt:
      deps.validateInboundJwt ??
      (async (): Promise<InboundAuthResult | null> => ({ appId: 'app-1' })),
  };
  return new Promise((resolve) => {
    server = startNorthEdge(0, full);
    server.on('listening', () => {
      const { port } = server!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

describe('north edge', () => {
  it('serves /healthz', async () => {
    const base = await start({ sink: { async enqueueInbound() {} } });
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('ok');
  });

  it('rejects an unauthenticated POST with 401 (fail-closed)', async () => {
    const base = await start({
      sink: { async enqueueInbound() {} },
      validateInboundJwt: async () => null,
    });
    const res = await fetch(`${base}/api/messages/prod`, {
      method: 'POST',
      body: JSON.stringify({ serviceUrl: 'https://smba.example/' }),
    });
    expect(res.status).toBe(401);
  });

  it('forwards a validated activity to the sink and acks 202', async () => {
    const seen: InboundActivityInput[] = [];
    const base = await start({
      sink: {
        async enqueueInbound(a) {
          seen.push(a);
        },
      },
    });
    const res = await fetch(`${base}/api/messages/prod`, {
      method: 'POST',
      body: JSON.stringify({ serviceUrl: 'https://smba.example/v3/' }),
    });
    expect(res.status).toBe(202);
    expect(seen).toHaveLength(1);
    expect(seen[0].botId).toBe('prod');
    expect(seen[0].serviceUrl).toBe('https://smba.example/v3/');
    expect(seen[0].activityJson.byteLength).toBeGreaterThan(0);
  });

  it('does NOT 500 when sink reports no-NCL by returning normally', async () => {
    // "no NCL attached" is a normal buffer/drop path in the broker, surfaced as
    // a normal resolve — north edge should still 202, not 500.
    const base = await start({ sink: { async enqueueInbound() {} } });
    const res = await fetch(`${base}/api/messages/prod`, {
      method: 'POST',
      body: JSON.stringify({ serviceUrl: '' }),
    });
    expect(res.status).toBe(202);
  });

  it('500s when the sink throws (internal failure)', async () => {
    const base = await start({
      sink: {
        async enqueueInbound() {
          throw new Error('boom');
        },
      },
    });
    const res = await fetch(`${base}/api/messages/prod`, {
      method: 'POST',
      body: JSON.stringify({ serviceUrl: '' }),
    });
    expect(res.status).toBe(500);
  });

  it('404s an unknown path and 405s a non-POST to messages', async () => {
    const base = await start({ sink: { async enqueueInbound() {} } });
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/api/messages/prod`)).status).toBe(405);
  });
});
