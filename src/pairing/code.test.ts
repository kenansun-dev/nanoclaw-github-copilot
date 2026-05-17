/**
 * Tests for src/pairing/code.ts.
 *
 * Covers:
 *   1. format XXXX-XXXX matches the canonical regex
 *   2. 1000 generated codes are all unique (CSPRNG smoke + collision floor)
 *   3. only Crockford-style chars (no I/L/O/U/0/1)
 *   4. normalizePairingCode strips dash, uppercases, trims
 *   5. PAIRING_ALPHABET is exactly 30 chars (entropy guard)
 */
import { describe, expect, it } from 'vitest';

import { PAIRING_ALPHABET, PAIRING_CODE_REGEX, generatePairingCode, normalizePairingCode } from './code.js';

describe('generatePairingCode', () => {
  it('produces XXXX-XXXX matching the canonical regex', () => {
    for (let i = 0; i < 20; i++) {
      const code = generatePairingCode();
      expect(code).toMatch(PAIRING_CODE_REGEX);
      expect(code).toHaveLength(9); // 4 + dash + 4
      expect(code[4]).toBe('-');
    }
  });

  it('1000 codes are all unique (collision floor sanity)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const code = generatePairingCode();
      expect(seen.has(code)).toBe(false);
      seen.add(code);
    }
    expect(seen.size).toBe(1000);
  });

  it('only contains Crockford-safe chars (no I/L/O/U/0/1)', () => {
    const forbidden = /[ILOU01]/;
    for (let i = 0; i < 200; i++) {
      const code = generatePairingCode();
      expect(code).not.toMatch(forbidden);
    }
  });
});

describe('normalizePairingCode', () => {
  it('strips the dash + uppercases + trims', () => {
    expect(normalizePairingCode('  abcd-efgh  ')).toBe('ABCDEFGH');
    expect(normalizePairingCode('ABCD-EFGH')).toBe('ABCDEFGH');
    expect(normalizePairingCode('abcdefgh')).toBe('ABCDEFGH');
  });
});

describe('PAIRING_ALPHABET', () => {
  it('is exactly 30 chars (no I/L/O/U/0/1) — entropy guard', () => {
    expect(PAIRING_ALPHABET).toHaveLength(30);
    expect(PAIRING_ALPHABET).not.toMatch(/[ILOU01]/);
    // No duplicates.
    expect(new Set(PAIRING_ALPHABET).size).toBe(30);
  });
});
