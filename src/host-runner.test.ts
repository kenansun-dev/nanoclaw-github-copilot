import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('./log-extensions.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { treeKillAgent, reapDeadAgentPids } from './host-runner.js';
import { setWorkspace } from './workspace.js';

const origPlatform = process.platform;

describe('treeKillAgent (POSIX process-group reap)', () => {
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

describe('reapDeadAgentPids (liveness-checked record pruning)', () => {
  let tmpWs: string;

  beforeEach(() => {
    // POSIX liveness path uses process.kill(pid, 0); force that branch.
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-pids-'));
    setWorkspace(tmpWs);
    fs.mkdirSync(path.join(tmpWs, 'state'), { recursive: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    try {
      fs.rmSync(tmpWs, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  const pidsFile = () => path.join(tmpWs, 'state', 'agent-pids.json');

  it('prunes records whose process is gone, keeps the live one', async () => {
    // process.pid is definitely alive; a huge pid is definitely dead.
    const deadPid = 2_000_000_000;
    fs.writeFileSync(pidsFile(), JSON.stringify([process.pid, deadPid]));
    const pruned = await reapDeadAgentPids();
    expect(pruned).toBe(1);
    const remaining = JSON.parse(fs.readFileSync(pidsFile(), 'utf-8'));
    expect(remaining).toEqual([process.pid]);
  });

  it('is a no-op when the file is missing', async () => {
    expect(fs.existsSync(pidsFile())).toBe(false);
    await expect(reapDeadAgentPids()).resolves.toBe(0);
  });

  it('never kills a live process (pruning is record-only)', async () => {
    const killSpy = vi.spyOn(process, 'kill');
    fs.writeFileSync(pidsFile(), JSON.stringify([process.pid]));
    await reapDeadAgentPids();
    // Only signal 0 (liveness probe) is allowed; never a real kill signal.
    for (const call of killSpy.mock.calls) {
      expect(call[1]).toBe(0);
    }
    killSpy.mockRestore();
  });
});
