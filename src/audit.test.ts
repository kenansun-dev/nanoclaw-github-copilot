/**
 * Audit log tests.
 *
 * Validates:
 *   1. auditConfigDiff fires only when a watched field actually changed.
 *   2. before/after values + source label appear in the emitted line.
 *   3. Non-watched fields don't emit (no spam from chat-manager etc.).
 *   4. saveConfig integration: changing thinkLevel via saveConfig() emits
 *      one audit line tagged with the source the caller passed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Capture logger.warn calls so we can assert on emitted audit lines.
const warnSpy = vi.fn();
vi.mock('./log.js', () => ({
  logger: {
    warn: (...args: unknown[]) => warnSpy(...args),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

const { auditLog, auditConfigDiff } = await import('./audit.js');

beforeEach(() => {
  warnSpy.mockReset();
});

describe('auditLog', () => {
  it('emits warn-level line with structured payload', () => {
    auditLog({
      event: 'config.changed',
      subject: 'agents.defaults.thinkLevel',
      before: 'medium',
      after: 'high',
      source: 'slash-command',
      context: { chatJid: 'tg:123' },
    });
    expect(warnSpy).toHaveBeenCalledOnce();
    const [data, msg] = warnSpy.mock.calls[0];
    expect(data).toMatchObject({
      audit: true,
      event: 'config.changed',
      subject: 'agents.defaults.thinkLevel',
      before: 'medium',
      after: 'high',
      source: 'slash-command',
      ctx: { chatJid: 'tg:123' },
    });
    expect(msg).toContain('AUDIT');
    expect(msg).toContain('agents.defaults.thinkLevel');
    expect(msg).toContain('medium → high');
    expect(msg).toContain('source=slash-command');
  });

  it('renders <unset> for undefined and <null> for null', () => {
    auditLog({
      event: 'config.changed',
      subject: 'agents.defaults.thinkLevel',
      before: undefined,
      after: 'high',
      source: 'slash-command',
    });
    auditLog({
      event: 'config.changed',
      subject: 'agents.defaults.model',
      before: 'x',
      after: null,
      source: 'cli',
    });
    expect(warnSpy.mock.calls[0][1]).toContain('<unset> → high');
    expect(warnSpy.mock.calls[1][1]).toContain('x → <null>');
  });
});

describe('auditConfigDiff', () => {
  it('fires for each changed watched field', () => {
    auditConfigDiff(
      {
        agents: {
          defaults: { thinkLevel: 'medium', model: 'claude-sonnet-4' },
        },
      },
      {
        agents: { defaults: { thinkLevel: 'high', model: 'claude-opus-4.7' } },
      },
      'slash-command',
    );
    expect(warnSpy).toHaveBeenCalledTimes(2);
    const subjects = warnSpy.mock.calls.map((c) => c[0].subject);
    expect(subjects).toContain('agents.defaults.thinkLevel');
    expect(subjects).toContain('agents.defaults.model');
  });

  it('does not fire when nothing watched changed', () => {
    auditConfigDiff(
      { agents: { defaults: { thinkLevel: 'high' } }, chats: { foo: {} } },
      { agents: { defaults: { thinkLevel: 'high' } }, chats: { bar: {} } },
      'chat-manager',
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('passes through context to emitted events', () => {
    auditConfigDiff(
      { agents: { defaults: { thinkLevel: 'medium' } } },
      { agents: { defaults: { thinkLevel: 'high' } } },
      'slash-command',
      { chatJid: 'tg:42', userId: 'u1' },
    );
    expect(warnSpy.mock.calls[0][0].ctx).toEqual({
      chatJid: 'tg:42',
      userId: 'u1',
    });
  });

  it('handles undefined before-snapshot (first save) gracefully', () => {
    auditConfigDiff(
      undefined,
      { agents: { defaults: { thinkLevel: 'high' } } },
      'unknown',
    );
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toMatchObject({
      before: '<unset>',
      after: 'high',
    });
  });
});

describe('saveConfig integration', () => {
  it('emits audit event when thinkLevel changes on disk', async () => {
    // Use the same isolation pattern as config-loader.test.ts:
    // setWorkspace() updates the cached `paths` so saveConfig writes to
    // the temp dir, NOT the real ~/.nanoclaw. Critical: process.env
    // alone is insufficient because workspace.ts caches paths at first call.
    const { setWorkspace, ensureWorkspace } = await import('./workspace.js');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-audit-'));
    setWorkspace(tmp);
    ensureWorkspace();

    const { saveConfig, loadConfig } = await import('./config-loader.js');

    // First save establishes baseline
    const cfg = loadConfig();
    cfg.agents.defaults.thinkLevel = 'medium';
    saveConfig(cfg, 'cli');
    warnSpy.mockReset();

    // Second save flips medium → high, should emit one audit line tagged tui
    const cfg2 = loadConfig();
    cfg2.agents.defaults.thinkLevel = 'high';
    saveConfig(cfg2, 'tui', { command: '/think', level: 'high' });

    const auditCalls = warnSpy.mock.calls.filter(
      (c) => c[0]?.subject === 'agents.defaults.thinkLevel',
    );
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0][0]).toMatchObject({
      before: 'medium',
      after: 'high',
      source: 'tui',
      ctx: { command: '/think', level: 'high' },
    });

    // Cleanup
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
