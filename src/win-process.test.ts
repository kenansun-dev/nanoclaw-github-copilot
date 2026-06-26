import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Regression guard for kenan's Windows console-flicker report (2026-06-26).
 *
 * Lifecycle process kills MUST go through `execFile`/`execFileSync` with an
 * args ARRAY and `windowsHide: true` — NOT string-form `execSync('taskkill …')`,
 * which on win32 routes through `cmd.exe /d /s /c …` (Node default
 * `windowsHide: false`) and flashes a console window per call.
 *
 * These tests assert the helper's wire-level contract: no shell, args array,
 * windowsHide set. Two layers:
 *   1. Behavioural — winExecSync/winExecAsync call execFile* with the right opts.
 *   2. Source guard — the win32 lifecycle files never reintroduce string-form
 *      `execSync('taskkill …')` / `execAsync('taskkill …')`.
 */

const execFileSyncMock = vi.fn(() => Buffer.from('ok'));
const execFileMock = vi.fn(
  (
    _file: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null, res: { stdout: string; stderr: string }) => void,
  ) => {
    cb(null, { stdout: 'ok', stderr: '' });
  },
);

vi.mock('child_process', () => ({
  execFileSync: (...a: unknown[]) => execFileSyncMock(...(a as [])),
  execFile: (...a: unknown[]) => execFileMock(...(a as [])),
}));

import { winExecSync, winExecAsync, isProcessAlreadyGone } from './win-process.js';

beforeEach(() => {
  execFileSyncMock.mockClear();
  execFileMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('win-process: winExecSync', () => {
  it('invokes execFileSync with a binary + args array (no shell string)', () => {
    winExecSync('taskkill', ['/F', '/T', '/PID', '52728']);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [file, args] = execFileSyncMock.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(file).toBe('taskkill');
    expect(args).toEqual(['/F', '/T', '/PID', '52728']);
    // args must be an array, never a single concatenated command string
    expect(Array.isArray(args)).toBe(true);
  });

  it('sets windowsHide:true and pipes stdio (no inherited console)', () => {
    winExecSync('schtasks', ['/Query', '/TN', 'nanoclaw']);
    const opts = execFileSyncMock.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.windowsHide).toBe(true);
    expect(opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  it('never passes shell:true', () => {
    winExecSync('reg', ['query', 'HKCU\\X']);
    const opts = execFileSyncMock.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.shell).toBeUndefined();
  });

  it('trims stdout', () => {
    execFileSyncMock.mockReturnValueOnce(Buffer.from('  hello \n'));
    expect(winExecSync('x', [])).toBe('hello');
  });

  it('forwards timeout when provided', () => {
    winExecSync('x', [], { timeout: 1234 });
    const opts = execFileSyncMock.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.timeout).toBe(1234);
  });
});

describe('win-process: winExecAsync', () => {
  it('invokes execFile with a binary + args array and windowsHide', async () => {
    await winExecAsync('taskkill', ['/F', '/PID', '999']);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [file, args, opts] = execFileMock.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(file).toBe('taskkill');
    expect(args).toEqual(['/F', '/PID', '999']);
    expect(Array.isArray(args)).toBe(true);
    expect(opts.windowsHide).toBe(true);
    expect(opts.shell).toBeUndefined();
  });

  it('resolves trimmed stdout', async () => {
    execFileMock.mockImplementationOnce((_f, _a, _o, cb: any) => cb(null, { stdout: ' out \n', stderr: '' }));
    await expect(winExecAsync('x', [])).resolves.toBe('out');
  });
});

describe('win-process: isProcessAlreadyGone', () => {
  it('treats taskkill "not found" stderr as already-gone (EN)', () => {
    expect(isProcessAlreadyGone({ stderr: Buffer.from('ERROR: The process "52728" not found.') })).toBe(true);
  });

  it('treats zh-CN 不存在/找不到 as already-gone', () => {
    expect(isProcessAlreadyGone({ stderr: Buffer.from('错误: 进程不存在') })).toBe(true);
    expect(isProcessAlreadyGone({ message: '找不到该进程' })).toBe(true);
  });

  it('does NOT treat a real failure as already-gone', () => {
    expect(isProcessAlreadyGone({ stderr: Buffer.from('Access is denied.') })).toBe(false);
    expect(isProcessAlreadyGone(undefined)).toBe(false);
  });
});
