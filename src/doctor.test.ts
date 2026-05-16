/**
 * Unit tests for src/doctor.ts pure helpers.
 *
 * Covers:
 *   1. `check` helper — status override + happy path + thrown error
 *   2. `formatDoctorResults` — icon mapping per status
 *
 * Chat-related severity tests (chatsCheck, chatDriftCheck,
 * mainChatSingletonCheck) were retired 2026-05-16 alongside the v1
 * cutover — those checks no longer exist in doctor.
 *
 * The runDoctor() integration is intentionally NOT covered here; it
 * shells out to docker / reads disk / inspects env. Pure-logic coverage
 * is enough to catch the regressions that this PR's prior bugs
 * (silent ESM swallow, hardcoded ❌ severity) demonstrated.
 */
import { describe, it, expect } from 'vitest';

import { check, formatDoctorResults } from './doctor.js';

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
