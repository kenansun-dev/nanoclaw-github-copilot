/**
 * Pairing code generation — fixup #49 step 7.
 *
 * Uses a Crockford-style base32 *encoding* alphabet (no I/L/O/U) with the
 * additional digits 0 and 1 removed (visually similar to O and I). That
 * leaves 30 unambiguous characters. 8 random chars → 30^8 ≈ 6.6 × 10^11
 * possibilities, well outside brute-force range for a code with a 24h TTL.
 *
 * Format: 4-4 grouping with a single dash separator, e.g. `ABCD-EFGH`.
 * The dash is purely cosmetic — `normalizePairingCode` strips it and
 * uppercases input before lookup.
 *
 * The previously-considered 6-digit numeric option was rejected: 10^6 = 1M
 * brute-force space is too small for a code that auto-expires only at 24h.
 */
import { randomInt } from 'node:crypto';

/**
 * Crockford-base32 *encoding* alphabet minus 0 and 1 — 30 characters,
 * no I/L/O/U/0/1.
 */
export const PAIRING_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
// Sanity: must stay 30 chars (asserted in tests).

/**
 * Generate a random 8-char pairing code formatted as `XXXX-XXXX`.
 *
 * Uses `crypto.randomInt` for each character so the CSPRNG handles
 * rejection sampling and the output is uniform across the alphabet.
 */
export function generatePairingCode(): string {
  const chars: string[] = [];
  for (let i = 0; i < 8; i++) {
    chars.push(PAIRING_ALPHABET[randomInt(0, PAIRING_ALPHABET.length)]);
  }
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

/**
 * Normalize a user-typed pairing code for lookup: uppercase, strip the
 * dash, strip surrounding whitespace. Does NOT validate the alphabet —
 * lookup misses (no row) handle that path.
 */
export function normalizePairingCode(input: string): string {
  return input.trim().toUpperCase().replace(/-/g, '');
}

/** Regex matching the canonical XXXX-XXXX shape (post-format). */
export const PAIRING_CODE_REGEX = /^[2-9A-HJKMNP-TVWXYZ]{4}-[2-9A-HJKMNP-TVWXYZ]{4}$/;
