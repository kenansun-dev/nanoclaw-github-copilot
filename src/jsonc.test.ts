/**
 * Tests for src/jsonc.ts — minimal JSONC stripper used to parse the
 * GitHub Copilot CLI's `~/.copilot/config.json` (which has a `//` banner
 * the CLI itself writes; bare `JSON.parse` rejects it).
 *
 * Regression context: see PR #46 follow-up, 2026-05-12. Before this fix
 * `nanoclaw status` showed `🔑 Auth: ❌ not configured` even when the
 * Copilot CLI was fully logged in, because the parse threw and the
 * catch silently set `hasAuth = false`.
 */
import { describe, it, expect } from 'vitest';
import { stripJsonComments, parseJsonc } from './jsonc.js';

describe('stripJsonComments', () => {
  it('strips leading // line comments (the Copilot CLI banner case)', () => {
    const input = '// User settings belong in settings.json.\n// This file is managed automatically.\n{"a":1}';
    expect(stripJsonComments(input).trim()).toBe('{"a":1}');
  });

  it('strips trailing // line comments', () => {
    expect(stripJsonComments('{"a":1} // tail').trim()).toBe('{"a":1}');
  });

  it('strips /* block comments */', () => {
    expect(stripJsonComments('/* hi */{"a":1}').trim()).toBe('{"a":1}');
  });

  it('preserves "//" inside string values', () => {
    const input = '{"url":"https://example.com//x"}';
    expect(stripJsonComments(input)).toBe(input);
  });

  it('preserves "/*" inside string values', () => {
    const input = '{"path":"/*a/b"}';
    expect(stripJsonComments(input)).toBe(input);
  });

  it('handles escaped quotes in strings', () => {
    const input = '{"a":"he said \\"hi //\\""}';
    expect(stripJsonComments(input)).toBe(input);
  });

  it('returns plain JSON unchanged', () => {
    const input = '{"a":1,"b":[2,3]}';
    expect(stripJsonComments(input)).toBe(input);
  });
});

describe('parseJsonc', () => {
  it('parses strict JSON via fast path', () => {
    expect(parseJsonc<{ a: number }>('{"a":1}').a).toBe(1);
  });

  it('parses JSONC with leading // banner (Copilot CLI shape)', () => {
    const input =
      '// User settings belong in settings.json.\n' +
      '// This file is managed automatically.\n' +
      '{\n  "lastLoggedInUser": { "login": "kenansun0" },\n' +
      '  "copilotTokens": { "https://github.com:kenansun0": "gho_xxx" }\n}';
    const parsed = parseJsonc<any>(input);
    expect(parsed.lastLoggedInUser.login).toBe('kenansun0');
    expect(parsed.copilotTokens['https://github.com:kenansun0']).toBe('gho_xxx');
  });

  it('throws the original strict error when both passes fail', () => {
    expect(() => parseJsonc('{not json at all')).toThrow();
  });
});
