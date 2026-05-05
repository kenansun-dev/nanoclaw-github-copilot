import { describe, it, expect, beforeEach, vi } from 'vitest';

// Test the resolution helpers in isolation by mocking the db + config layers.
// This keeps the test sqlite-free and fast — the actual db.ts column work
// is exercised indirectly through slash-commands.test.ts and via runtime use.

const overridesByKey: Record<string, any> = {};
const groupsByJid: Record<string, { jid: string; folder: string; name: string; trigger_pattern: string }> = {};
let configMock: any = { agents: { defaults: {} } };

vi.mock('./db.js', () => ({
  getSessionOverrides: vi.fn((folder: string, provider: string) => {
    return overridesByKey[`${folder}:${provider}`] ?? {};
  }),
  setSessionOverride: vi.fn(),
  getRegisteredGroup: vi.fn((jid: string) => groupsByJid[jid]),
}));

vi.mock('./config.js', () => ({
  getConfig: () => configMock,
}));

vi.mock('./config-extensions.js', () => ({
  resolveAgentForChat: vi.fn(() => ({
    name: 'test-agent',
    provider: 'github-copilot',
    model: 'claude-sonnet-4',
  })),
  getAgentModelName: vi.fn((a: any) => a?.model),
  isAgentGHC: vi.fn((a: any) => a?.provider === 'github-copilot'),
}));

import {
  getEffectiveThinkLevel,
  getEffectiveModel,
  getEffectiveShowThinking,
  providerForChat,
  resolveSessionScope,
} from './session-overrides.js';

describe('session-overrides resolution', () => {
  beforeEach(() => {
    for (const k of Object.keys(overridesByKey)) delete overridesByKey[k];
    for (const k of Object.keys(groupsByJid)) delete groupsByJid[k];
    configMock = { agents: { defaults: {} } };
    groupsByJid['tg:123'] = {
      jid: 'tg:123',
      folder: 'g1',
      name: 'g1',
      trigger_pattern: '@a',
    };
  });

  it('providerForChat returns github-copilot for GHC agent', () => {
    expect(providerForChat('tg:123')).toBe('github-copilot');
  });

  it('resolveSessionScope returns undefined for unregistered chats', () => {
    expect(resolveSessionScope('tg:nope')).toBeUndefined();
  });

  it('resolveSessionScope returns folder+provider for registered chats', () => {
    expect(resolveSessionScope('tg:123')).toEqual({
      groupFolder: 'g1',
      provider: 'github-copilot',
    });
  });

  describe('getEffectiveThinkLevel', () => {
    it('returns global default when no session override', () => {
      configMock.agents.defaults.thinkLevel = 'medium';
      expect(getEffectiveThinkLevel('tg:123')).toBe('medium');
    });

    it('session override beats global default', () => {
      configMock.agents.defaults.thinkLevel = 'medium';
      overridesByKey['g1:github-copilot'] = { thinkLevel: 'high' };
      expect(getEffectiveThinkLevel('tg:123')).toBe('high');
    });

    it('returns undefined when neither set', () => {
      expect(getEffectiveThinkLevel('tg:123')).toBeUndefined();
    });

    it('falls back to global default for unregistered chats', () => {
      configMock.agents.defaults.thinkLevel = 'low';
      expect(getEffectiveThinkLevel('tg:nope')).toBe('low');
    });
  });

  describe('getEffectiveModel', () => {
    it('returns agent default when no session override', () => {
      expect(getEffectiveModel('tg:123')).toBe('claude-sonnet-4');
    });

    it('session override beats agent default', () => {
      overridesByKey['g1:github-copilot'] = { model: 'claude-opus-4.6' };
      expect(getEffectiveModel('tg:123')).toBe('claude-opus-4.6');
    });
  });

  describe('getEffectiveShowThinking', () => {
    it('normalizes legacy boolean true → on', () => {
      configMock.agents.defaults.showThinking = true;
      expect(getEffectiveShowThinking('tg:123')).toBe('on');
    });

    it('preserves "flash" enum', () => {
      configMock.agents.defaults.showThinking = 'flash';
      expect(getEffectiveShowThinking('tg:123')).toBe('flash');
    });

    it('session override "off" beats global "on"', () => {
      configMock.agents.defaults.showThinking = 'on';
      overridesByKey['g1:github-copilot'] = { showThinking: 'off' };
      expect(getEffectiveShowThinking('tg:123')).toBe('off');
    });

    it('returns undefined when neither set', () => {
      expect(getEffectiveShowThinking('tg:123')).toBeUndefined();
    });
  });
});
