import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory backing store for the token cache file, so we can assert that the
// az-cli path actually persists a cache entry and that the second call serves
// it from cache (no second `az` spawn).
let cacheFileContent: string | null = null;

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const impl = {
    ...actual,
    existsSync: vi.fn(() => cacheFileContent !== null),
    readFileSync: vi.fn(() => cacheFileContent ?? ''),
    writeFileSync: vi.fn((_p: string, data: string) => {
      cacheFileContent = data;
    }),
    renameSync: vi.fn(),
    chmodSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
  return { ...impl, default: impl };
});

// Mock child_process so `az account get-access-token` returns a deterministic
// token + expiresOn, and we can count how many times it was executed.
const execSyncMock = vi.fn();
const spawnMock = vi.fn();
const httpsRequestMock = vi.fn();
const httpsResponses: Array<Record<string, unknown>> = [];

function enqueueHttpsResponse(body: Record<string, unknown>): void {
  httpsResponses.push(body);
}

vi.mock('https', () => {
  const request = (...args: unknown[]) => httpsRequestMock(...args);
  return { default: { request }, request };
});

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: (file: string, args: string[], options: unknown) =>
      execSyncMock(`${file} ${args.join(' ')}`, options),
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

import { azureTokenNeedsRefresh, getAzureToken } from './mcp-azure-auth.js';

const AUTH = { resource: 'https://prodicm.example.com' };

beforeEach(() => {
  cacheFileContent = null;
  execSyncMock.mockReset();
  spawnMock.mockReset();
  httpsResponses.length = 0;
  httpsRequestMock.mockReset();
  httpsRequestMock.mockImplementation((_options: unknown, callback: (response: EventEmitter) => void) => {
    const request = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    request.write = vi.fn();
    request.destroy = vi.fn();
    request.end = vi.fn(() => {
      const body = httpsResponses.shift();
      if (!body) throw new Error('No queued HTTPS response');
      const response = new EventEmitter();
      callback(response);
      queueMicrotask(() => {
        response.emit('data', JSON.stringify(body));
        response.emit('end');
      });
    });
    return request;
  });
});

describe('mcp-azure-auth az-cli token caching', () => {
  it('caches the az-cli token and reuses it on the next call (no second az spawn)', async () => {
    const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('get-access-token')) {
        return JSON.stringify({ token: 'az-token-abcdef123456', expiresOn: futureIso });
      }
      return '';
    });

    const first = await getAzureToken('prodicm', AUTH);
    expect(first.token).toBe('az-token-abcdef123456');
    expect(first.method).toBe('az-cli');

    const tokenCalls = execSyncMock.mock.calls.filter((c) => String(c[0]).includes('get-access-token'));
    expect(tokenCalls.length).toBe(1);
    expect(cacheFileContent).toContain('az-token-abcdef123456');

    // Second call must hit cache — az should NOT be spawned again.
    const second = await getAzureToken('prodicm', AUTH);
    expect(second.token).toBe('az-token-abcdef123456');
    expect(second.method).toBe('cache');

    const tokenCalls2 = execSyncMock.mock.calls.filter((c) => String(c[0]).includes('get-access-token'));
    expect(tokenCalls2.length).toBe(1); // still 1 — no new spawn
  });

  it('refreshes a cached token inside the same five-minute window used by idle-agent recycling', async () => {
    cacheFileContent = JSON.stringify({
      prodicm: {
        access_token: 'near-expiry-token',
        refresh_token: 'refresh-near-expiry',
        expires_at: Math.floor(Date.now() / 1000) + 4 * 60,
        resource: AUTH.resource,
        tenant_id: 'organizations',
        scope: `${AUTH.resource}/.default`,
      },
    });
    enqueueHttpsResponse({
      access_token: 'refreshed-token-abcdef',
      refresh_token: 'refreshed-refresh-token',
      expires_in: 3600,
    });

    expect(azureTokenNeedsRefresh('prodicm', AUTH)).toBe(true);
    const result = await getAzureToken('prodicm', AUTH);

    expect(result).toEqual({ token: 'refreshed-token-abcdef', method: 'refresh' });
    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it('falls back to a fixed TTL when az expiresOn is missing/unparseable, still caching', async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('get-access-token')) {
        return JSON.stringify({ token: 'az-token-noexpiry-7890', expiresOn: 'not-a-date' });
      }
      return '';
    });

    const res = await getAzureToken('prodicm', AUTH);
    expect(res.token).toBe('az-token-noexpiry-7890');
    expect(res.method).toBe('az-cli');
    expect(cacheFileContent).toContain('az-token-noexpiry-7890');

    // Cached entry has a positive future expiry (the 50-min fallback).
    const parsed = JSON.parse(cacheFileContent ?? '{}');
    expect(parsed.prodicm.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('uses az expiresOn for the cache TTL when present', async () => {
    const expMs = Date.now() + 75 * 60 * 1000;
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('get-access-token')) {
        return JSON.stringify({ token: 'az-token-realexp-555', expiresOn: new Date(expMs).toISOString() });
      }
      return '';
    });

    await getAzureToken('prodicm', AUTH);
    const parsed = JSON.parse(cacheFileContent ?? '{}');
    // Within a couple minutes of az's expiresOn minus the 60s safety skew.
    const expectedEpoch = Math.floor(expMs / 1000) - 60;
    expect(Math.abs(parsed.prodicm.expires_at - expectedEpoch)).toBeLessThan(120);
  });
});

describe('mcp-azure-auth built-in device-code fallback', () => {
  it('never spawns Azure CLI on Windows and uses the built-in flow instead', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    enqueueHttpsResponse({
      device_code: 'device-code-win',
      user_code: 'WIN-CODE',
      verification_uri: 'https://microsoft.com/devicelogin',
      expires_in: 60,
      interval: 0.001,
    });
    enqueueHttpsResponse({
      access_token: 'windows-builtin-token',
      refresh_token: 'windows-refresh-token',
      expires_in: 3600,
    });

    try {
      const result = await getAzureToken('prodicm', AUTH, () => {});
      expect(result).toEqual({ token: 'windows-builtin-token', method: 'device-code' });
      expect(execSyncMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('self-acquires and caches a token when Azure CLI has no usable session', async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('not logged in');
    });
    enqueueHttpsResponse({
      device_code: 'device-code-1',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://microsoft.com/devicelogin',
      expires_in: 60,
      interval: 0.001,
    });
    enqueueHttpsResponse({
      access_token: 'builtin-token-abcdef123456',
      refresh_token: 'refresh-token-abcdef123456',
      expires_in: 3600,
    });
    const prompts: string[] = [];

    const result = await getAzureToken('prodicm', AUTH, (prompt) => prompts.push(prompt));

    expect(result).toEqual({ token: 'builtin-token-abcdef123456', method: 'device-code' });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('ABCD-EFGH');
    expect(prompts[0]).toContain('you do not need to run az login');
    expect(cacheFileContent).toContain('refresh-token-abcdef123456');
    expect(httpsRequestMock).toHaveBeenCalledTimes(2);

    const cached = await getAzureToken('prodicm', AUTH);
    expect(cached).toEqual({ token: 'builtin-token-abcdef123456', method: 'cache' });
    expect(azureTokenNeedsRefresh('prodicm', AUTH)).toBe(false);
    expect(azureTokenNeedsRefresh('prodicm', { ...AUTH, scope: 'api://different/.default' })).toBe(true);
    expect(httpsRequestMock).toHaveBeenCalledTimes(2);
  });

  it('handles authorization_pending and continues polling until the token arrives', async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('not logged in');
    });
    enqueueHttpsResponse({
      device_code: 'device-code-2',
      user_code: 'WAIT-1234',
      verification_uri: 'https://microsoft.com/devicelogin',
      expires_in: 60,
      interval: 0.001,
    });
    enqueueHttpsResponse({ error: 'authorization_pending' });
    enqueueHttpsResponse({
      access_token: 'builtin-token-after-pending',
      refresh_token: 'refresh-token-after-pending',
      expires_in: 3600,
    });

    const result = await getAzureToken('prodicm', AUTH, () => {});

    expect(result).toEqual({ token: 'builtin-token-after-pending', method: 'device-code' });
    expect(httpsRequestMock).toHaveBeenCalledTimes(3);
  });

  it('returns a non-fatal automatic-auth error instead of asking the user to run az login', async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('not logged in');
    });
    enqueueHttpsResponse({ error: 'invalid_request', error_description: 'device flow unavailable' });

    const result = await getAzureToken('prodicm', AUTH, () => {});

    expect(result.token).toBeNull();
    expect(result.loginPrompt).toContain('could not complete automatic Azure device-code authentication');
    expect(result.loginPrompt).not.toContain('Please install Azure CLI');
  });
});

describe('mcp-azure-auth coordination and prompt safety', () => {
  it('singleflights concurrent acquisition for the same server/config', async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('not logged in');
    });
    enqueueHttpsResponse({
      device_code: 'device-code-singleflight',
      user_code: 'ONE-CODE',
      verification_uri: 'https://microsoft.com/devicelogin',
      expires_in: 60,
      interval: 0.001,
    });
    enqueueHttpsResponse({
      access_token: 'builti…ight',
      refresh_token: 'refres…ight',
      expires_in: 3600,
    });
    const prompts: string[] = [];

    const [first, second] = await Promise.all([
      getAzureToken('prodicm', AUTH, (prompt) => prompts.push(prompt)),
      getAzureToken('prodicm', AUTH, (prompt) => prompts.push(`duplicate:${prompt}`)),
    ]);

    expect(first).toEqual(second);
    expect(first.token).toBeTruthy();
    expect(String(first.token).length).toBeGreaterThan(10);
    expect(prompts).toHaveLength(1);
    expect(httpsRequestMock).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the private prompt cannot be delivered', async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('not logged in');
    });
    enqueueHttpsResponse({
      device_code: 'device-code-undeliverable',
      user_code: 'NO-DM',
      verification_uri: 'https://microsoft.com/devicelogin',
      expires_in: 60,
      interval: 0.001,
    });

    const result = await getAzureToken('prodicm', AUTH, () => {
      throw new Error('private DM unavailable');
    });

    expect(result.token).toBeNull();
    expect(result.loginPrompt).toContain('private DM unavailable');
    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
  });

  it('does not start interactive auth when no private prompt handler exists', async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('not logged in');
    });

    const result = await getAzureToken('prodicm', AUTH);

    expect(result.token).toBeNull();
    expect(result.loginPrompt).toContain('Ask an owner in a private chat');
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });
});
