import { describe, it, expect, vi } from 'vitest';
import { sendWithRetry } from './send-with-retry.js';

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as any;

describe('sendWithRetry', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await sendWithRetry(fn, {
      opName: 'test.send',
      log: silentLog,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on transient failure and eventually succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue('ok');

    const result = await sendWithRetry(fn, {
      opName: 'test.send',
      backoffMs: [1, 1, 1], // fast for test
      log: silentLog,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting all retries', async () => {
    const err = new Error('still broken');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      sendWithRetry(fn, {
        opName: 'test.send',
        backoffMs: [1, 1, 1],
        log: silentLog,
      }),
    ).rejects.toThrow('still broken');
    // 3 backoff intervals = 4 total attempts (initial + 3 retries)
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('does NOT retry permanent errors (401)', async () => {
    const err: any = new Error('Unauthorized');
    err.status = 401;
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      sendWithRetry(fn, {
        opName: 'test.send',
        backoffMs: [1, 1, 1],
        log: silentLog,
      }),
    ).rejects.toThrow('Unauthorized');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry permanent errors (403 forbidden)', async () => {
    const err = new Error('Missing Access (forbidden)');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      sendWithRetry(fn, {
        opName: 'test.send',
        backoffMs: [1, 1, 1],
        log: silentLog,
      }),
    ).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry "chat not found" Telegram errors', async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(new Error('Bad Request: chat not found'));
    await expect(
      sendWithRetry(fn, {
        opName: 'tg.send',
        backoffMs: [1, 1, 1],
        log: silentLog,
      }),
    ).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('DOES retry 429 rate-limit', async () => {
    const err: any = new Error('Too Many Requests');
    err.status = 429;
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    const result = await sendWithRetry(fn, {
      opName: 'test.send',
      backoffMs: [1, 1, 1],
      log: silentLog,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('DOES retry 500 server errors', async () => {
    const err: any = new Error('Internal Server Error');
    err.status = 500;
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    const result = await sendWithRetry(fn, {
      opName: 'test.send',
      backoffMs: [1, 1, 1],
      log: silentLog,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('uses default backoff when none provided (smoke test, exits fast on success)', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await sendWithRetry(fn, {
      opName: 'test.send',
      log: silentLog,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
