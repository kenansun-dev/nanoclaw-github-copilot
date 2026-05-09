import { describe, it, expect } from 'vitest';
import { resolveAgentIdFromBindings, NanoclawConfig } from './config-loader.js';

function makeConfig(bindings?: any[], chats?: any): NanoclawConfig {
  return {
    agents: {
      defaults: {
        model: 'test',
        name: 'Test',
        triggerWord: '@test',
        hasOwnNumber: false,
        mode: 'host',
      },
      list: [
        {
          id: 'main',
          default: true,
          model: 'test',
          name: 'Main',
          triggerWord: '@main',
          hasOwnNumber: false,
          mode: 'host' as const,
        },
        {
          id: 'coder',
          model: 'test',
          name: 'Coder',
          triggerWord: '@coder',
          hasOwnNumber: false,
          mode: 'sandbox' as const,
        },
      ],
    },
    channels: {
      discord: { enabled: false },
      telegram: { enabled: true },
      teams: { enabled: false, webhookPort: 3978, authMode: 'secret' as const },
    },
    mcp: { servers: {} },
    skills: { directories: [], disabled: [] },
    sandbox: {
      runtime: 'docker',
      image: 'test',
      timeout: 300000,
      maxOutputSize: 1048576,
      maxConcurrent: 1,
      idleTimeout: 0,
    },
    chats: chats || {},
    pairing: { mode: 'disabled' },
    credentialProxy: { port: 3001 },
    logLevel: 'info',
    timezone: 'UTC',
    bindings,
  } as NanoclawConfig;
}

describe('resolveAgentIdFromBindings', () => {
  it('returns undefined when no bindings and no chatConfig', () => {
    const config = makeConfig();
    expect(resolveAgentIdFromBindings(config, 'tg:123')).toBeUndefined();
  });

  it('returns chatConfig.agentId as legacy fallback', () => {
    const config = makeConfig();
    expect(resolveAgentIdFromBindings(config, 'tg:123', { agentId: 'coder' })).toBe('coder');
  });

  it('matches binding by channel', () => {
    const config = makeConfig([{ agentId: 'main', match: { channel: 'telegram' } }]);
    expect(resolveAgentIdFromBindings(config, 'tg:123')).toBe('main');
  });

  it('matches binding by channel — teams', () => {
    const config = makeConfig([{ agentId: 'coder', match: { channel: 'teams' } }]);
    expect(resolveAgentIdFromBindings(config, 'teams:conv-abc')).toBe('coder');
  });

  it('first match wins', () => {
    const config = makeConfig([
      { agentId: 'coder', match: { channel: 'telegram' } },
      { agentId: 'main', match: { channel: 'telegram' } },
    ]);
    expect(resolveAgentIdFromBindings(config, 'tg:123')).toBe('coder');
  });

  it('skips non-matching channel', () => {
    const config = makeConfig([{ agentId: 'coder', match: { channel: 'teams' } }]);
    expect(resolveAgentIdFromBindings(config, 'tg:123')).toBeUndefined();
  });

  it('matches binding by peer id', () => {
    const config = makeConfig([
      { agentId: 'coder', match: { channel: 'telegram', peer: { id: '999' } } },
      { agentId: 'main', match: { channel: 'telegram' } },
    ]);
    expect(resolveAgentIdFromBindings(config, 'tg:999')).toBe('coder');
    expect(resolveAgentIdFromBindings(config, 'tg:123')).toBe('main');
  });

  it('bindings take precedence over chatConfig.agentId', () => {
    const config = makeConfig([{ agentId: 'main', match: { channel: 'telegram' } }]);
    expect(resolveAgentIdFromBindings(config, 'tg:123', { agentId: 'coder' })).toBe('main');
  });

  // Multi-account routing tests (PR #166 bug fixes)

  it('matches binding by accountId — non-default account', () => {
    const config = makeConfig([
      { agentId: 'main', match: { channel: 'telegram', accountId: 'default' } },
      { agentId: 'coder', match: { channel: 'telegram', accountId: 'daily' } },
    ]);
    // tg:daily:123 should match accountId=daily → coder
    expect(resolveAgentIdFromBindings(config, 'tg:daily:123')).toBe('coder');
    // tg:123 should match accountId=default → main
    expect(resolveAgentIdFromBindings(config, 'tg:123')).toBe('main');
  });

  it('accountId "default" matches 2-segment JIDs', () => {
    const config = makeConfig([{ agentId: 'main', match: { channel: 'telegram', accountId: 'default' } }]);
    expect(resolveAgentIdFromBindings(config, 'tg:123')).toBe('main');
    // 3-segment JID should NOT match default
    expect(resolveAgentIdFromBindings(config, 'tg:daily:123')).toBeUndefined();
  });

  it('accountId in binding prevents cross-account routing', () => {
    const config = makeConfig([{ agentId: 'coder', match: { channel: 'telegram', accountId: 'daily' } }]);
    // Default account JID should NOT match daily binding
    expect(resolveAgentIdFromBindings(config, 'tg:123')).toBeUndefined();
    // Daily account JID should match
    expect(resolveAgentIdFromBindings(config, 'tg:daily:123')).toBe('coder');
  });

  it('binding without accountId matches all accounts', () => {
    const config = makeConfig([{ agentId: 'main', match: { channel: 'telegram' } }]);
    // Both default and non-default JIDs should match
    expect(resolveAgentIdFromBindings(config, 'tg:123')).toBe('main');
    expect(resolveAgentIdFromBindings(config, 'tg:daily:123')).toBe('main');
  });

  it('multiple accounts routed to different agents', () => {
    const config = makeConfig([
      { agentId: 'main', match: { channel: 'telegram', accountId: 'default' } },
      { agentId: 'coder', match: { channel: 'telegram', accountId: 'daily' } },
      { agentId: 'main', match: { channel: 'teams' } },
    ]);
    expect(resolveAgentIdFromBindings(config, 'tg:555')).toBe('main');
    expect(resolveAgentIdFromBindings(config, 'tg:daily:555')).toBe('coder');
    expect(resolveAgentIdFromBindings(config, 'teams:conv-1')).toBe('main');
    // Unknown account falls through all
    expect(resolveAgentIdFromBindings(config, 'tg:other:555')).toBeUndefined();
  });

  it('specific accountId binding wins over wildcard (no accountId)', () => {
    const config = makeConfig([
      { agentId: 'coder', match: { channel: 'telegram', accountId: 'daily' } },
      { agentId: 'main', match: { channel: 'telegram' } }, // wildcard
    ]);
    // daily account hits specific binding first
    expect(resolveAgentIdFromBindings(config, 'tg:daily:123')).toBe('coder');
    // default account skips daily binding, hits wildcard
    expect(resolveAgentIdFromBindings(config, 'tg:123')).toBe('main');
  });

  // Edge case: tg:default:123 would never be generated by chatJid()
  // because accountId='default' is treated as no prefix.
  // But if it somehow appears, it should match accountId=default binding
  // since the JID extraction sees accountId='default' from parts[1].
  it('tg:default:123 matches accountId default (edge case)', () => {
    const config = makeConfig([{ agentId: 'main', match: { channel: 'telegram', accountId: 'default' } }]);
    expect(resolveAgentIdFromBindings(config, 'tg:default:123')).toBe('main');
  });

  // ⚠️ Order matters: bindings use first-match-wins.
  // If a wildcard (no accountId) is listed before a specific accountId binding,
  // the wildcard catches everything and the specific binding is unreachable.
  it('wildcard BEFORE specific — wildcard wins (order matters gotcha)', () => {
    const config = makeConfig([
      { agentId: 'main', match: { channel: 'telegram' } }, // wildcard FIRST
      { agentId: 'coder', match: { channel: 'telegram', accountId: 'daily' } },
    ]);
    // wildcard eats everything — daily never reached
    expect(resolveAgentIdFromBindings(config, 'tg:daily:123')).toBe('main');
    expect(resolveAgentIdFromBindings(config, 'tg:123')).toBe('main');
  });
});
