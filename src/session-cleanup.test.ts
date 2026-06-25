import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks must be declared before importing the module under test.
const execFileMock = vi.fn();
const accessSyncMock = vi.fn();
const loggerInfo = vi.fn();
const loggerError = vi.fn();

vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

vi.mock('fs', () => ({
  default: {
    accessSync: (...args: unknown[]) => accessSyncMock(...args),
    constants: { X_OK: 1 },
  },
}));

vi.mock('./log-extensions.js', () => ({
  logger: {
    info: (...args: unknown[]) => loggerInfo(...args),
    error: (...args: unknown[]) => loggerError(...args),
  },
}));

import { startSessionCleanup } from './session-cleanup.js';

describe('startSessionCleanup', () => {
  const realPlatform = process.platform;

  function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    execFileMock.mockReset();
    accessSyncMock.mockReset();
    loggerInfo.mockReset();
    loggerError.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    setPlatform(realPlatform);
  });

  it('skips on win32 without spawning bash (no ENOENT spam)', () => {
    setPlatform('win32');
    startSessionCleanup();
    // Even after the would-be 30s startup delay, bash must never be spawned.
    vi.advanceTimersByTime(31_000);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(loggerError).not.toHaveBeenCalled();
    expect(loggerInfo).toHaveBeenCalledTimes(1);
  });

  it('skips when /bin/bash is not executable on a posix host', () => {
    setPlatform('linux');
    accessSyncMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    startSessionCleanup();
    vi.advanceTimersByTime(31_000);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('runs the cleanup script when bash is available', () => {
    setPlatform('linux');
    accessSyncMock.mockReturnValue(undefined);
    startSessionCleanup();
    expect(execFileMock).not.toHaveBeenCalled(); // delayed 30s
    vi.advanceTimersByTime(30_000);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [bin, args] = execFileMock.mock.calls[0];
    expect(bin).toBe('/bin/bash');
    expect(String(args[0])).toContain('cleanup-sessions.sh');
  });
});
