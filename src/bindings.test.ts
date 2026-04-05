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
    expect(
      resolveAgentIdFromBindings(config, 'tg:123', { agentId: 'coder' }),
    ).toBe('coder');
  });

  it('matches binding by channel', () => {
    const config = makeConfig([
      { agentId: 'main', match: { channel: 'telegram' } },
    ]);
    expect(resolveAgentIdFromBindings(config, 'tg:123')).toBe('main');
  });

  it('matches binding by channel — teams', () => {
    const config = makeConfig([
      { agentId: 'coder', match: { channel: 'teams' } },
    ]);
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
    const config = makeConfig([
      { agentId: 'coder', match: { channel: 'teams' } },
    ]);
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
    const config = makeConfig([
      { agentId: 'main', match: { channel: 'telegram' } },
    ]);
    expect(
      resolveAgentIdFromBindings(config, 'tg:123', { agentId: 'coder' }),
    ).toBe('main');
  });
});
