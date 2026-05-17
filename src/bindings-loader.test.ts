/**
 * Tests for src/bindings-loader.ts.
 *
 * Covers all three Rpi5 review focus items:
 *   1. 3-layer precedence (peer > accountId > wildcard '*')
 *   2. no-match returns undefined (explicit)
 *   3. rebuild helper for cache-invalidation pattern
 */
import { describe, expect, it } from 'vitest';

import type { Binding, NanoclawConfig } from './config-loader.js';
import { loadBindings, rebuildBindings, resolveBinding } from './bindings-loader.js';

/** Minimal NanoclawConfig stub — only `bindings` matters for these tests. */
function mkConfig(bindings?: Binding[]): NanoclawConfig {
  return { bindings } as unknown as NanoclawConfig;
}

describe('bindings-loader', () => {
  it('empty bindings → resolve returns undefined', () => {
    const t = loadBindings(mkConfig([]));
    expect(resolveBinding(t, { channel: 'telegram' })).toBeUndefined();
  });

  it('empty config (no bindings field at all) → resolve returns undefined', () => {
    const t = loadBindings(mkConfig(undefined));
    expect(resolveBinding(t, { channel: 'telegram', accountId: 'a', peerId: 'p' })).toBeUndefined();
  });

  it('channel-only binding matches by channel alone', () => {
    const t = loadBindings(mkConfig([{ agentId: 'agent-tg', match: { channel: 'telegram' } }]));
    expect(resolveBinding(t, { channel: 'telegram' })).toBe('agent-tg');
    expect(resolveBinding(t, { channel: 'telegram', accountId: 'whatever' })).toBe('agent-tg');
    expect(resolveBinding(t, { channel: 'telegram', accountId: 'x', peerId: 'y' })).toBe('agent-tg');
    expect(resolveBinding(t, { channel: 'discord' })).toBeUndefined();
  });

  it('accountId-specific binding overrides wildcard accountId (focus #1: account > wildcard)', () => {
    const t = loadBindings(
      mkConfig([
        { agentId: 'agent-acct', match: { channel: 'telegram', accountId: 'acct-1' } },
        { agentId: 'agent-default', match: { channel: 'telegram' } },
      ]),
    );
    expect(resolveBinding(t, { channel: 'telegram', accountId: 'acct-1' })).toBe('agent-acct');
    expect(resolveBinding(t, { channel: 'telegram', accountId: 'acct-2' })).toBe('agent-default');
    expect(resolveBinding(t, { channel: 'telegram' })).toBe('agent-default');
  });

  it('multiple agents same channel, different accounts', () => {
    const t = loadBindings(
      mkConfig([
        { agentId: 'agent-A', match: { channel: 'telegram', accountId: 'acct-A' } },
        { agentId: 'agent-B', match: { channel: 'telegram', accountId: 'acct-B' } },
      ]),
    );
    expect(resolveBinding(t, { channel: 'telegram', accountId: 'acct-A' })).toBe('agent-A');
    expect(resolveBinding(t, { channel: 'telegram', accountId: 'acct-B' })).toBe('agent-B');
    expect(resolveBinding(t, { channel: 'telegram', accountId: 'acct-C' })).toBeUndefined();
  });

  it('wildcard match when accountId not in bindings', () => {
    const t = loadBindings(
      mkConfig([
        { agentId: 'agent-acct', match: { channel: 'telegram', accountId: 'acct-1' } },
        { agentId: 'agent-fallback', match: { channel: 'telegram' } },
      ]),
    );
    expect(resolveBinding(t, { channel: 'telegram', accountId: 'unknown' })).toBe('agent-fallback');
  });

  it('peerId precedence beats accountId-only binding (focus #1: peer > account)', () => {
    const t = loadBindings(
      mkConfig([
        // Listed in reverse-precedence order on purpose — table indexing must
        // give peer-level the win regardless of array order.
        { agentId: 'agent-acct', match: { channel: 'telegram', accountId: 'acct-1' } },
        {
          agentId: 'agent-peer',
          match: { channel: 'telegram', accountId: 'acct-1', peer: { kind: 'group', id: 'group-7' } },
        },
      ]),
    );
    expect(resolveBinding(t, { channel: 'telegram', accountId: 'acct-1', peerId: 'group-7' })).toBe('agent-peer');
    // Same account, different peer → falls back to account-level binding.
    expect(resolveBinding(t, { channel: 'telegram', accountId: 'acct-1', peerId: 'group-other' })).toBe('agent-acct');
  });

  it('no match returns undefined (explicit — caller must fall back to mainAgentId)', () => {
    const t = loadBindings(mkConfig([{ agentId: 'agent-tg', match: { channel: 'telegram' } }]));
    expect(resolveBinding(t, { channel: 'discord', accountId: 'a', peerId: 'p' })).toBeUndefined();
  });

  it('first-write-wins on duplicate cells (legacy "first match wins" parity)', () => {
    const t = loadBindings(
      mkConfig([
        { agentId: 'agent-first', match: { channel: 'telegram', accountId: 'acct-1' } },
        { agentId: 'agent-second', match: { channel: 'telegram', accountId: 'acct-1' } },
      ]),
    );
    expect(resolveBinding(t, { channel: 'telegram', accountId: 'acct-1' })).toBe('agent-first');
  });

  it('rebuildBindings returns a fresh table (focus #3: cache invalidation pattern)', () => {
    const cfgA = mkConfig([{ agentId: 'agent-A', match: { channel: 'telegram' } }]);
    const cfgB = mkConfig([{ agentId: 'agent-B', match: { channel: 'telegram' } }]);
    const t1 = loadBindings(cfgA);
    const t2 = rebuildBindings(cfgB);
    expect(resolveBinding(t1, { channel: 'telegram' })).toBe('agent-A');
    expect(resolveBinding(t2, { channel: 'telegram' })).toBe('agent-B');
    // Independent objects, not shared references.
    expect(t1).not.toBe(t2);
  });
});
