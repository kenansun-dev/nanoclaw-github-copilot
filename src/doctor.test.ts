/**
 * Unit tests for src/doctor.ts pure helpers.
 *
 * Covers:
 *   1. `check` helper — status override + happy path + thrown error
 *   2. `chatsCheck` — full chats × channels severity matrix
 *   3. `formatDoctorResults` — icon mapping per status
 *
 * The runDoctor() integration is intentionally NOT covered here; it
 * shells out to docker / reads disk / inspects env. Pure-logic coverage
 * is enough to catch the regressions that this PR's prior bugs
 * (silent ESM swallow, hardcoded ❌ severity) demonstrated.
 */
import { describe, it, expect } from 'vitest';

import { check, chatsCheck, formatDoctorResults } from './doctor.js';

describe('check helper', () => {
  it('returns ok when fn returns ok=true and no status override', () => {
    const r = check('x', () => ({ ok: true, msg: 'fine' }));
    expect(r).toEqual({ name: 'x', status: 'ok', message: 'fine' });
  });

  it('returns error when fn returns ok=false and no status override', () => {
    const r = check('x', () => ({ ok: false, msg: 'broken' }));
    expect(r).toEqual({ name: 'x', status: 'error', message: 'broken' });
  });

  it('honours explicit status=warn override even with ok=false', () => {
    // This is the exact regression PR #14 fixes for "Registered chats":
    // ok=false but severity should be ⚠️ not ❌.
    const r = check('x', () => ({
      ok: false,
      status: 'warn',
      msg: 'caveat',
    }));
    expect(r.status).toBe('warn');
  });

  it('honours explicit status=ok override even with ok=false', () => {
    const r = check('x', () => ({ ok: false, status: 'ok', msg: 'lol' }));
    expect(r.status).toBe('ok');
  });

  it('catches thrown errors and reports them as error status', () => {
    const r = check('boom', () => {
      throw new Error('kaboom');
    });
    expect(r.status).toBe('error');
    expect(r.message).toBe('kaboom');
  });

  it('stringifies non-Error throws', () => {
    const r = check('boom', () => {
      throw 'plain string thrown'; // eslint-disable-line @typescript-eslint/only-throw-error
    });
    expect(r.status).toBe('error');
    expect(r.message).toBe('plain string thrown');
  });
});

describe('chatsCheck severity matrix', () => {
  it('chats > 0 → ok regardless of channels', () => {
    expect(chatsCheck(1, [])).toMatchObject({ ok: true });
    expect(chatsCheck(1, ['telegram'])).toMatchObject({ ok: true });
    expect(chatsCheck(5, ['telegram', 'teams'])).toMatchObject({
      ok: true,
      msg: '5 chat(s)',
    });
  });

  it('chats=0 + at least one channel enabled → warn (not error)', () => {
    const r = chatsCheck(0, ['telegram']);
    expect(r.ok).toBe(false);
    expect(r.status).toBe('warn');
    expect(r.msg).toContain('telegram');
    expect(r.msg).toContain('accept incoming without registration');
  });

  it('chats=0 + multiple channels lists them all', () => {
    const r = chatsCheck(0, ['telegram', 'teams']);
    expect(r.status).toBe('warn');
    expect(r.msg).toContain('telegram, teams');
  });

  it('chats=0 + no channels enabled → error (truly unconfigured)', () => {
    const r = chatsCheck(0, []);
    expect(r.ok).toBe(false);
    // No status override → check() will compute 'error' from ok=false.
    expect(r.status).toBeUndefined();
    expect(r.msg).toContain('none and no channels enabled');
  });
});

describe('formatDoctorResults', () => {
  it('maps ok → ✅, warn → ⚠️, error → ❌', () => {
    const out = formatDoctorResults([
      { name: 'a', status: 'ok', message: 'fine' },
      { name: 'b', status: 'warn', message: 'caveat' },
      { name: 'c', status: 'error', message: 'broken' },
    ]);
    expect(out).toBe('✅ a: fine\n⚠️ b: caveat\n❌ c: broken');
  });

  it('handles empty result set', () => {
    expect(formatDoctorResults([])).toBe('');
  });
});
