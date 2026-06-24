import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./log-extensions.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { treeKillAgent } from './host-runner.js';

describe('treeKillAgent (POSIX process-group reap)', () => {
  const origPlatform = process.platform;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Force POSIX branch regardless of host OS running the test.
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as never);
  });

  afterEach(() => {
    killSpy.mockRestore();
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    vi.clearAllMocks();
  });

  it('SIGKILLs the negative pid (whole process group) so MCP grandchildren go too', async () => {
    await treeKillAgent(44208, 'unit');
    expect(killSpy).toHaveBeenCalledWith(-44208, 'SIGKILL');
  });

  it('falls back to single-pid SIGKILL when the process group is gone (ESRCH)', async () => {
    killSpy.mockImplementationOnce(() => {
      throw new Error('ESRCH'); // no such process group
    });
    await treeKillAgent(44208, 'unit');
    // first attempt: pgroup; fallback: single pid
    expect(killSpy).toHaveBeenNthCalledWith(1, -44208, 'SIGKILL');
    expect(killSpy).toHaveBeenNthCalledWith(2, 44208, 'SIGKILL');
  });

  it('is a no-op for an invalid pid (already-reaped / 0 / negative)', async () => {
    await treeKillAgent(0, 'unit');
    await treeKillAgent(-1, 'unit');
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('swallows the case where both pgroup and single-pid kill throw (already dead)', async () => {
    killSpy.mockImplementation(() => {
      throw new Error('ESRCH');
    });
    // Must not reject — best-effort + idempotent.
    await expect(treeKillAgent(44208, 'unit')).resolves.toBeUndefined();
  });
});
