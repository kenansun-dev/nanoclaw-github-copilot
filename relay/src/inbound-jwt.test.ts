import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage } from 'node:http';

// Mock the connector's JwtTokenValidation so we test the relay's wiring/
// fail-closed logic without a live JWKS / real Bot Connector token.
const authenticateRequest = vi.fn();
vi.mock('botframework-connector', () => ({
  JwtTokenValidation: {
    authenticateRequest: (...args: unknown[]) => authenticateRequest(...args),
  },
  SimpleCredentialProvider: class {
    constructor(
      public appId: string,
      public password: string,
    ) {}
  },
}));

const { makeJwtValidator } = await import('./inbound-jwt.js');

function req(authHeader?: string): IncomingMessage {
  return { headers: authHeader ? { authorization: authHeader } : {} } as IncomingMessage;
}

const body = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8');
const APPIDS = new Map([['prod', 'app-prod']]);

beforeEach(() => authenticateRequest.mockReset());

describe('inbound JWT validator (#2)', () => {
  it('rejects an unknown bot id (no appId) before touching the token', async () => {
    const v = makeJwtValidator({ resolveAppId: (b) => APPIDS.get(b) });
    expect(await v(req('Bearer x'), 'unknown', body({ serviceUrl: 's' }))).toBeNull();
    expect(authenticateRequest).not.toHaveBeenCalled();
  });

  it('rejects a missing authorization header', async () => {
    const v = makeJwtValidator({ resolveAppId: (b) => APPIDS.get(b) });
    expect(await v(req(), 'prod', body({ serviceUrl: 's' }))).toBeNull();
    expect(authenticateRequest).not.toHaveBeenCalled();
  });

  it('rejects a non-JSON body', async () => {
    const v = makeJwtValidator({ resolveAppId: (b) => APPIDS.get(b) });
    expect(await v(req('Bearer x'), 'prod', Buffer.from('not json'))).toBeNull();
    expect(authenticateRequest).not.toHaveBeenCalled();
  });

  it('rejects when the token validates but identity is not authenticated', async () => {
    authenticateRequest.mockResolvedValue({ isAuthenticated: false });
    const v = makeJwtValidator({ resolveAppId: (b) => APPIDS.get(b) });
    expect(await v(req('Bearer x'), 'prod', body({ serviceUrl: 's' }))).toBeNull();
  });

  it('rejects (fail-closed) when authenticateRequest rejects', async () => {
    authenticateRequest.mockRejectedValueOnce(new Error('jwks down'));
    const v = makeJwtValidator({ resolveAppId: (b) => APPIDS.get(b) });
    await expect(v(req('Bearer x'), 'prod', body({ serviceUrl: 's' }))).resolves.toBeNull();
  });

  it('accepts a valid token and returns the resolved appId', async () => {
    authenticateRequest.mockResolvedValue({ isAuthenticated: true });
    const v = makeJwtValidator({ resolveAppId: (b) => APPIDS.get(b) });
    const r = await v(req('Bearer good'), 'prod', body({ serviceUrl: 's' }));
    expect(r).toEqual({ appId: 'app-prod' });
    // appId must be the audience credential passed to validation.
    const [, header, creds] = authenticateRequest.mock.calls[0];
    expect(header).toBe('Bearer good');
    expect((creds as { appId: string }).appId).toBe('app-prod');
  });
});
