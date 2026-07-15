/**
 * Tests for the shared devtunnel lifecycle helpers (cli/tunnel-lifecycle.ts).
 *
 * Regression context: the "start the nanoclaw devtunnel when Teams is enabled"
 * logic used to be inlined inside `case 'start'` AFTER the Windows
 * scheduled-task early-return, so `nanoclaw start` via scheduled task and
 * `nanoclaw update` (which shells to `nanoclaw start`) never hosted the tunnel.
 * These tests pin the extracted helper's behavior: no-op when Teams is off /
 * transport is proxy, host when a tunnel exists and isn't hosting, skip when
 * already hosting, and fail-soft when devtunnel is missing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync, spawn } from 'child_process';
import fs from 'fs';

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execSync: vi.fn(), spawn: vi.fn() };
});

const memoryConfig: any = { channels: {} };
vi.mock('../config-loader.js', async () => {
  const actual = await vi.importActual<typeof import('../config-loader.js')>('../config-loader.js');
  return { ...actual, loadConfig: () => JSON.parse(JSON.stringify(memoryConfig)) };
});

import { ensureTunnelHosting, stopTrackedTunnel } from './tunnel-lifecycle.js';

const execMock = execSync as unknown as ReturnType<typeof vi.fn>;
const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;

function setConfig(cfg: any) {
  for (const k of Object.keys(memoryConfig)) delete memoryConfig[k];
  Object.assign(memoryConfig, cfg);
}

beforeEach(() => {
  execMock.mockReset();
  spawnMock.mockReset();
  spawnMock.mockReturnValue({ pid: 4242, unref: () => {} } as any);
});

afterEach(() => vi.restoreAllMocks());

describe('ensureTunnelHosting', () => {
  it('no-ops when Teams is disabled', async () => {
    setConfig({ channels: {} });
    await ensureTunnelHosting('/tmp/ws');
    expect(execMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('no-ops when channel transport is proxy (relay, no local tunnel)', async () => {
    setConfig({ channels: { teams: { enabled: true, transport: 'proxy' } } });
    await ensureTunnelHosting('/tmp/ws');
    expect(execMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('no-ops when every account is proxy transport', async () => {
    setConfig({
      channels: { teams: { enabled: true, accounts: { default: { transport: 'proxy' }, b: { transport: 'proxy' } } } },
    });
    await ensureTunnelHosting('/tmp/ws');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('hosts the tunnel when one exists and is not already hosting', async () => {
    setConfig({ channels: { teams: { enabled: true } } });
    execMock.mockImplementation((cmd: string) => {
      if (cmd === 'devtunnel list') return 'nanoclaw-abc1 nanoclaw Active\n';
      if (cmd.startsWith('devtunnel show')) return 'Host connections : 0\n';
      return '';
    });
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined as any);
    await ensureTunnelHosting('/tmp/ws');
    expect(spawnMock).toHaveBeenCalledWith(
      'devtunnel',
      ['host', 'nanoclaw-abc1', '--allow-anonymous'],
      expect.any(Object),
    );
    expect(writeSpy).toHaveBeenCalled();
  });

  it('skips hosting when the tunnel is already hosting', async () => {
    setConfig({ channels: { teams: { enabled: true } } });
    execMock.mockImplementation((cmd: string) => {
      if (cmd === 'devtunnel list') return 'nanoclaw-abc1 nanoclaw Active\n';
      if (cmd.startsWith('devtunnel show')) return 'Host connections : 1\n';
      return '';
    });
    await ensureTunnelHosting('/tmp/ws');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('fail-soft when devtunnel is not installed', async () => {
    setConfig({ channels: { teams: { enabled: true } } });
    execMock.mockImplementation(() => {
      throw new Error('devtunnel: command not found');
    });
    await expect(ensureTunnelHosting('/tmp/ws')).resolves.toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('stopTrackedTunnel', () => {
  it('returns null when no pid file exists', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const killed: number[] = [];
    expect(stopTrackedTunnel('/tmp/ws', (p) => killed.push(p))).toBeNull();
    expect(killed).toEqual([]);
  });

  it('kills tracked pid and removes the pid file', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('9987' as any);
    const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined as any);
    const killed: number[] = [];
    const ret = stopTrackedTunnel('/tmp/ws', (p) => killed.push(p));
    expect(ret).toBe(9987);
    expect(killed).toEqual([9987]);
    expect(unlink).toHaveBeenCalled();
  });
});
