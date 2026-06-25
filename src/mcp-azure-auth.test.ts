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
    mkdirSync: vi.fn(),
  };
  return { ...impl, default: impl };
});

// Mock child_process so `az account get-access-token` returns a deterministic
// token + expiresOn, and we can count how many times it was spawned.
const execSyncMock = vi.fn();
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execSync: (...args: unknown[]) => execSyncMock(...args),
    spawn: actual.spawn,
  };
});

import { getAzureToken } from './mcp-azure-auth.js';

const AUTH = { resource: 'https://prodicm.example.com' };

beforeEach(() => {
  cacheFileContent = null;
  execSyncMock.mockReset();
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
