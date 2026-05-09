/**
 * Tests for the access-gate registry skeleton (B.5-prep #4).
 *
 * Covers the gate iteration contract:
 * - empty registry is permissive (returns 'allow')
 * - first non-'allow' wins, later gates not consulted
 * - 'deny' and 'drop' both short-circuit
 * - registration order is preserved
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerAccessGate,
  runAccessGates,
  getAccessGates,
  __resetAccessGatesForTests,
  type AccessGate,
} from './access-gate-registry.js';

describe('access-gate-registry', () => {
  beforeEach(() => {
    __resetAccessGatesForTests();
  });

  it('returns "allow" when no gates are registered', () => {
    expect(runAccessGates('jid@x', 'sender', 'hello')).toBe('allow');
    expect(getAccessGates()).toHaveLength(0);
  });

  it('runs a single allow-gate and returns "allow"', () => {
    registerAccessGate(() => 'allow');
    expect(runAccessGates('jid@x', 'sender', 'hello')).toBe('allow');
  });

  it('returns the first non-"allow" decision and stops iterating', () => {
    const calls: string[] = [];
    const a: AccessGate = () => {
      calls.push('a');
      return 'allow';
    };
    const b: AccessGate = () => {
      calls.push('b');
      return 'drop';
    };
    const c: AccessGate = () => {
      calls.push('c');
      return 'deny';
    };
    registerAccessGate(a);
    registerAccessGate(b);
    registerAccessGate(c);

    expect(runAccessGates('jid@x', 'sender', 'hello')).toBe('drop');
    expect(calls).toEqual(['a', 'b']); // c never ran
  });

  it('passes chatJid / sender / content to each gate', () => {
    const seen: Array<[string, string, string]> = [];
    registerAccessGate((jid, sender, content) => {
      seen.push([jid, sender, content]);
      return 'allow';
    });
    runAccessGates('jid@x', 'alice', '/foo bar');
    expect(seen).toEqual([['jid@x', 'alice', '/foo bar']]);
  });

  it('preserves registration order in getAccessGates snapshot', () => {
    const a: AccessGate = () => 'allow';
    const b: AccessGate = () => 'allow';
    const c: AccessGate = () => 'allow';
    registerAccessGate(a);
    registerAccessGate(b);
    registerAccessGate(c);
    expect(getAccessGates()).toEqual([a, b, c]);
  });

  it('"deny" short-circuits just like "drop"', () => {
    let ran = false;
    registerAccessGate(() => 'deny');
    registerAccessGate(() => {
      ran = true;
      return 'allow';
    });
    expect(runAccessGates('jid', 'who', 'msg')).toBe('deny');
    expect(ran).toBe(false);
  });
});
