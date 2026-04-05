/**
 * Tests for config-extensions.ts — provider detection, agent resolution,
 * model parsing, and session directory helpers.
 *
 * These functions are the glue between config and runtime behavior.
 */
import { describe, it, expect } from 'vitest';
import {
  getProvider,
  getModelName,
  isGHCProvider,
  isAgentGHC,
  getAgentSessionDir,
  getAgentModelName,
  getAgentProvider,
} from './config-extensions.js';
import { AgentConfig } from './config-loader.js';

// ─── Helper ──────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    model: 'github-copilot/claude-sonnet-4.5',
    name: 'Test',
    triggerWord: '@test',
    hasOwnNumber: false,
    mode: 'host',
    ...overrides,
  };
}

// ─── getProvider ─────────────────────────────────────────────────────────────

describe('getProvider', () => {
  it('extracts provider from provider/model format', () => {
    expect(getProvider('github-copilot/claude-sonnet-4.5')).toBe(
      'github-copilot',
    );
    expect(getProvider('anthropic/claude-opus-4')).toBe('anthropic');
    expect(getProvider('openai/gpt-5.3')).toBe('openai');
  });

  it('defaults to anthropic when no slash in model string', () => {
    expect(getProvider('claude-sonnet-4.5')).toBe('anthropic');
  });

  it('handles undefined/empty', () => {
    expect(getProvider(undefined)).toBeTruthy(); // returns default
    expect(getProvider('')).toBeTruthy();
  });
});

// ─── getModelName ────────────────────────────────────────────────────────────

describe('getModelName', () => {
  it('extracts model name after slash', () => {
    expect(getModelName('github-copilot/claude-sonnet-4.5')).toBe(
      'claude-sonnet-4.5',
    );
    expect(getModelName('openai/gpt-5.3')).toBe('gpt-5.3');
  });

  it('returns full string when no slash', () => {
    expect(getModelName('claude-sonnet-4.5')).toBe('claude-sonnet-4.5');
  });
});

// ─── isGHCProvider ───────────────────────────────────────────────────────────

describe('isGHCProvider', () => {
  it('returns true for github-copilot provider', () => {
    expect(isGHCProvider('github-copilot/claude-sonnet-4.5')).toBe(true);
    expect(isGHCProvider('github-copilot/gpt-5.3')).toBe(true);
  });

  it('returns false for other providers', () => {
    expect(isGHCProvider('anthropic/claude-opus-4')).toBe(false);
    expect(isGHCProvider('openai/gpt-4')).toBe(false);
  });
});

// ─── isAgentGHC ──────────────────────────────────────────────────────────────

describe('isAgentGHC', () => {
  it('returns true for GHC agent', () => {
    expect(
      isAgentGHC(makeAgent({ model: 'github-copilot/claude-sonnet-4.5' })),
    ).toBe(true);
  });

  it('returns false for non-GHC agent', () => {
    expect(isAgentGHC(makeAgent({ model: 'anthropic/claude-opus-4' }))).toBe(
      false,
    );
  });
});

// ─── getAgentSessionDir ──────────────────────────────────────────────────────

describe('getAgentSessionDir', () => {
  it('returns .copilot for GHC agents', () => {
    expect(
      getAgentSessionDir(
        makeAgent({ model: 'github-copilot/claude-sonnet-4.5' }),
      ),
    ).toBe('.copilot');
  });

  it('returns .claude for CC agents', () => {
    expect(
      getAgentSessionDir(makeAgent({ model: 'anthropic/claude-opus-4' })),
    ).toBe('.claude');
  });
});

// ─── getAgentModelName / getAgentProvider ────────────────────────────────────

describe('getAgentModelName', () => {
  it('extracts model from agent config', () => {
    expect(
      getAgentModelName(makeAgent({ model: 'github-copilot/gpt-5.3' })),
    ).toBe('gpt-5.3');
  });
});

describe('getAgentProvider', () => {
  it('extracts provider from agent config', () => {
    expect(
      getAgentProvider(makeAgent({ model: 'github-copilot/gpt-5.3' })),
    ).toBe('github-copilot');
  });
});
