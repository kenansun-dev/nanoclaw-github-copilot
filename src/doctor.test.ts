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

import { check, chatsCheck, chatDriftCheck, mainChatSingletonCheck, formatDoctorResults } from './doctor.js';

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

describe('mainChatSingletonCheck severity matrix', () => {
  it('0 mains + 0 chats → ok (clean install)', () => {
    const r = mainChatSingletonCheck([], 0);
    expect(r).toMatchObject({ ok: true, msg: 'no chats registered' });
  });

  it('0 mains + N chats → warn (forgot to pick one)', () => {
    const r = mainChatSingletonCheck([], 3);
    expect(r.ok).toBe(false);
    expect(r.status).toBe('warn');
    expect(r.msg).toContain('no main chat picked');
    expect(r.msg).toContain('chat set-main');
  });

  it('exactly 1 main → ok', () => {
    const r = mainChatSingletonCheck(['tg:8731187021'], 5, {
      'tg:8731187021': false,
    });
    expect(r.ok).toBe(true);
    expect(r.msg).toContain('1 main chat');
  });

  it('multiple isMain DMs → ok with shared-session note', () => {
    const r = mainChatSingletonCheck(['tg:1', 'dc:2', 'tui:3'], 10, {
      'tg:1': false,
      'dc:2': false,
      'tui:3': false,
    });
    expect(r.ok).toBe(true);
    expect(r.msg).toContain('3 main chats');
    expect(r.msg).toContain('share session');
  });

  it('multiple isMain DMs + 1 isMain group → ok', () => {
    const r = mainChatSingletonCheck(['tg:1', 'dc:2', 'tg:group'], 10, {
      'tg:1': false,
      'dc:2': false,
      'tg:group': true,
    });
    expect(r.ok).toBe(true);
  });

  it('>1 isMain groups → error (group sessions must stay isolated)', () => {
    const r = mainChatSingletonCheck(['tg:g1', 'tg:g2', 'tg:g3'], 10, {
      'tg:g1': true,
      'tg:g2': true,
      'tg:g3': true,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('error');
    expect(r.msg).toContain('3 group chats marked isMain');
    expect(r.msg).toContain('chat set-main');
  });

  it('unknown isGroup defaults to DM-style behavior (no error)', () => {
    const r = mainChatSingletonCheck(['tg:1', 'dc:2'], 5);
    // Without isGroup info, we treat them as not-known-groups → ok.
    expect(r.ok).toBe(true);
  });
});

describe('chatDriftCheck severity matrix', () => {
  it('clean state → ok', () => {
    const r = chatDriftCheck({ added: [], dedupedMains: [], mirroredToDb: [] });
    expect(r.ok).toBe(true);
    expect(r.msg).toContain('in sync');
  });

  it('only added → warn (DB-only chats, non-destructive)', () => {
    const r = chatDriftCheck({
      added: ['tg:1', 'tg:2'],
      dedupedMains: [],
      mirroredToDb: [],
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('warn');
    expect(r.msg).toContain('2 chat(s) only in DB');
    expect(r.msg).toContain('chat reconcile');
  });

  it('dedupedMains > 0 → error (mount collision)', () => {
    const r = chatDriftCheck({
      added: [],
      dedupedMains: ['tg:2', 'tg:3', 'tui:1'],
      mirroredToDb: [],
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('error');
    expect(r.msg).toContain('3 duplicate main(s)');
    expect(r.msg).toContain('main/ mount');
  });

  it('mirroredToDb > 0 → error (config↔DB isMain mismatch)', () => {
    const r = chatDriftCheck({
      added: [],
      dedupedMains: [],
      mirroredToDb: ['tg:1'],
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('error');
    expect(r.msg).toContain('1 isMain mismatch(es)');
  });

  it('combined drift → error wins (worst signal surfaces)', () => {
    const r = chatDriftCheck({
      added: ['tg:5'],
      dedupedMains: ['tg:2'],
      mirroredToDb: ['tg:1'],
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('error');
    expect(r.msg).not.toContain('only in DB'); // doesn't downgrade to warn
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
