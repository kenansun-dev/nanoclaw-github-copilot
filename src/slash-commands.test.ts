/**
 * Slash command tests — normalizeSlashInput, handleSlashCommand,
 * parseTeamsCardSubmit, buildHelpText, COMMANDS registry.
 *
 * Target: 100% command recognition, correct handled/unhandled routing.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { setWorkspace, ensureWorkspace } from './workspace.js';
import {
  normalizeSlashInput,
  handleSlashCommand,
  buildHelpText,
  parseTeamsCardSubmit,
  COMMANDS,
  SlashCommandContext,
} from './slash-commands.js';

// Isolate workspace BEFORE any test runs handleSlashCommand. /think writes
// to nanoclaw.json via saveConfig; without this, every CI run pollutes the
// real ~/.nanoclaw/nanoclaw.json on the developer machine. (Caught
// 2026-04-23 when kenan reported thinkLevel kept becoming 'high' after
// running npm test — this test was the culprit.)
const tmpWs = path.join(os.tmpdir(), `nanoclaw-test-slash-${Date.now()}`);
beforeAll(() => {
  setWorkspace(tmpWs);
  ensureWorkspace();
});
afterAll(() => {
  try {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// Mock DB to avoid needing real SQLite for /new and /reset
vi.mock('./db.js', () => ({
  deleteSession: vi.fn(),
}));

// ─── Mock context factory ────────────────────────────────────────────────────

function makeCtx(
  overrides: Partial<SlashCommandContext> = {},
): SlashCommandContext {
  return {
    chatJid: 'tg:123',
    groupFolder: 'test-group',
    channel: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendCard: vi.fn().mockResolvedValue(undefined),
    } as any,
    clearSession: vi.fn(),
    ...overrides,
  };
}

// ─── normalizeSlashInput ─────────────────────────────────────────────────────

describe('normalizeSlashInput', () => {
  it('passes through plain slash commands', () => {
    expect(normalizeSlashInput('/help')).toBe('/help');
    expect(normalizeSlashInput('/new')).toBe('/new');
    expect(normalizeSlashInput('/status')).toBe('/status');
  });

  it('trims whitespace', () => {
    expect(normalizeSlashInput('  /help  ')).toBe('/help');
    expect(normalizeSlashInput('\n/new\n')).toBe('/new');
  });

  it('lowercases input', () => {
    expect(normalizeSlashInput('/HELP')).toBe('/help');
    expect(normalizeSlashInput('/New')).toBe('/new');
  });

  it('strips leading @mention', () => {
    expect(normalizeSlashInput('@botname /help')).toBe('/help');
    expect(normalizeSlashInput('@MyBot /status')).toBe('/status');
  });

  it('strips trailing @botname (Telegram format)', () => {
    expect(normalizeSlashInput('/help@mybot')).toBe('/help');
    expect(normalizeSlashInput('/new@nanoclaw_bot')).toBe('/new');
  });

  it('handles combined mention + trailing bot', () => {
    expect(normalizeSlashInput('@mention /help@bot')).toBe('/help');
  });

  it('returns empty for non-slash text after normalization', () => {
    expect(normalizeSlashInput('hello')).toBe('hello');
  });
});

// ─── handleSlashCommand ──────────────────────────────────────────────────────

describe('handleSlashCommand', () => {
  it('/new clears session and returns handled', async () => {
    const ctx = makeCtx();
    const result = await handleSlashCommand('/new', ctx);
    expect(result.handled).toBe(true);
    expect(ctx.clearSession).toHaveBeenCalledWith('test-group');
    expect(ctx.channel!.sendMessage).toHaveBeenCalledWith(
      'tg:123',
      expect.stringContaining('Session reset'),
    );
  });

  it('/reset is an alias for /new', async () => {
    const ctx = makeCtx();
    const result = await handleSlashCommand('/reset', ctx);
    expect(result.handled).toBe(true);
    expect(ctx.clearSession).toHaveBeenCalledWith('test-group');
  });

  it('/help sends help text and returns handled', async () => {
    const ctx = makeCtx();
    const result = await handleSlashCommand('/help', ctx);
    expect(result.handled).toBe(true);
    expect(ctx.channel!.sendMessage).toHaveBeenCalledWith(
      'tg:123',
      expect.stringContaining('Available commands'),
    );
  });

  it('/think with level returns handled and sends confirmation', async () => {
    const ctx = makeCtx();
    const result = await handleSlashCommand('/think high', ctx);
    expect(result.handled).toBe(true);
    // Should send confirmation via sendMessage or sendCard
    const sendMsg = ctx.channel!.sendMessage as ReturnType<typeof vi.fn>;
    const sendCard = ctx.channel!.sendCard as ReturnType<typeof vi.fn>;
    expect(
      sendMsg.mock.calls.length + sendCard.mock.calls.length,
    ).toBeGreaterThan(0);
  });

  it('/think without level returns handled (shows selector)', async () => {
    const ctx = makeCtx();
    const result = await handleSlashCommand('/think', ctx);
    expect(result.handled).toBe(true);
  });

  it('/reasoning flash returns handled and writes "flash" to config', async () => {
    const ctx = makeCtx();
    const result = await handleSlashCommand('/reasoning flash', ctx);
    expect(result.handled).toBe(true);
    const { loadConfig } = await import('./config-loader.js');
    expect(loadConfig().agents?.defaults?.showThinking).toBe('flash');
  });

  it('/reasoning on writes "on" (string enum, not boolean) to config', async () => {
    const ctx = makeCtx();
    await handleSlashCommand('/reasoning on', ctx);
    const { loadConfig } = await import('./config-loader.js');
    expect(loadConfig().agents?.defaults?.showThinking).toBe('on');
  });

  it('/reasoning off writes "off" to config', async () => {
    const ctx = makeCtx();
    await handleSlashCommand('/reasoning off', ctx);
    const { loadConfig } = await import('./config-loader.js');
    expect(loadConfig().agents?.defaults?.showThinking).toBe('off');
  });

  it('/reasoning rejects bogus values (returns not handled, leaves config alone)', async () => {
    // Set a known good value first
    await handleSlashCommand('/reasoning flash', makeCtx());
    const result = await handleSlashCommand('/reasoning bogus', makeCtx());
    // Match regex fails, so it's not handled by the reasoning handler
    // (and should not stomp on the prior value).
    expect(result.handled).toBe(false);
    const { loadConfig } = await import('./config-loader.js');
    expect(loadConfig().agents?.defaults?.showThinking).toBe('flash');
  });

  // Bumped timeout to 30s: collectStatus() does ~10 dynamic imports
  // (workspace, config-loader, config-extensions, etc) which on a cold
  // CI runner can exceed the default 5s. Locally it's ~4s; CI saw it
  // tip over 5s on 2026-04-23 (run 24813239156). The work itself is
  // file-only reads, no network/LLM, so a generous bound is fine.
  it(
    '/status returns handled: true and sends nanoclaw status text directly (no LLM round-trip)',
    { timeout: 30_000 },
    async () => {
      // Regression for kenan request 2026-04-23: /status was previously
      // passed to the agent which made it ~5-10s per invocation. We now
      // render `nanoclaw status` directly in the slash handler.
      const ctx = makeCtx();
      const result = await handleSlashCommand('/status', ctx);
      expect(result.handled).toBe(true);
      expect(ctx.channel!.sendMessage).toHaveBeenCalledTimes(1);
      const sentText = (ctx.channel!.sendMessage as any).mock
        .calls[0][1] as string;
      // Status text always starts with the version line and contains the
      // hard-coded section labels formatStatusText emits.
      expect(sentText).toContain('NanoClaw');
      expect(sentText).toMatch(/Status:/);
      expect(sentText).toMatch(/Workspace:/);
      // And it's wrapped in a code fence so emoji-aligned columns render.
      expect(sentText.startsWith('```')).toBe(true);
      expect(sentText.endsWith('```')).toBe(true);
    },
  );

  it('/tasks returns handled: false (passthrough to agent)', async () => {
    const ctx = makeCtx();
    const result = await handleSlashCommand('/tasks', ctx);
    expect(result.handled).toBe(false);
    expect(ctx.channel!.sendMessage).not.toHaveBeenCalled();
  });

  it('/capabilities returns handled: false (passthrough to agent)', async () => {
    const ctx = makeCtx();
    const result = await handleSlashCommand('/capabilities', ctx);
    expect(result.handled).toBe(false);
    expect(ctx.channel!.sendMessage).not.toHaveBeenCalled();
  });

  it('unknown command returns handled: false', async () => {
    const ctx = makeCtx();
    const result = await handleSlashCommand('/unknown', ctx);
    expect(result.handled).toBe(false);
  });

  it('non-slash text returns handled: false', async () => {
    const ctx = makeCtx();
    const result = await handleSlashCommand('hello world', ctx);
    expect(result.handled).toBe(false);
  });

  it('/new works without channel (no sendMessage call)', async () => {
    const ctx = makeCtx({ channel: undefined });
    const result = await handleSlashCommand('/new', ctx);
    expect(result.handled).toBe(true);
    expect(ctx.clearSession).toHaveBeenCalled();
    // No crash despite no channel
  });
});

// ─── parseTeamsCardSubmit ────────────────────────────────────────────────────

describe('parseTeamsCardSubmit', () => {
  it('parses think command with value', () => {
    const activity = {
      type: 'message',
      value: { command: 'think', think_value: 'high' },
    };
    expect(parseTeamsCardSubmit(activity)).toBe('/think high');
  });

  it('parses command without value', () => {
    const activity = {
      type: 'message',
      value: { command: 'new' },
    };
    expect(parseTeamsCardSubmit(activity)).toBe('/new');
  });

  it('returns null for non-message activity', () => {
    expect(
      parseTeamsCardSubmit({ type: 'event', value: { command: 'new' } }),
    ).toBeNull();
  });

  it('returns null for missing value', () => {
    expect(parseTeamsCardSubmit({ type: 'message' })).toBeNull();
    expect(parseTeamsCardSubmit({ type: 'message', value: null })).toBeNull();
  });

  it('returns null for missing command in value', () => {
    expect(
      parseTeamsCardSubmit({ type: 'message', value: { foo: 'bar' } }),
    ).toBeNull();
  });

  it('returns null for unknown command', () => {
    expect(
      parseTeamsCardSubmit({ type: 'message', value: { command: 'nope' } }),
    ).toBeNull();
  });
});

// ─── buildHelpText ───────────────────────────────────────────────────────────

describe('buildHelpText', () => {
  it('includes all registered commands', () => {
    const text = buildHelpText();
    for (const cmd of COMMANDS) {
      expect(text).toContain(`/${cmd.name}`);
    }
  });

  it('includes Available commands header', () => {
    expect(buildHelpText()).toContain('Available commands');
  });

  it('includes description for each command', () => {
    const text = buildHelpText();
    for (const cmd of COMMANDS) {
      expect(text).toContain(cmd.description);
    }
  });
});

// ─── COMMANDS registry ───────────────────────────────────────────────────────

describe('COMMANDS registry', () => {
  it('has at least 5 commands', () => {
    expect(COMMANDS.length).toBeGreaterThanOrEqual(5);
  });

  it('all commands have name and description', () => {
    for (const cmd of COMMANDS) {
      expect(cmd.name).toBeTruthy();
      expect(cmd.description).toBeTruthy();
    }
  });

  it('command names are unique', () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('includes essential commands: new, help, think, status, tasks', () => {
    const names = COMMANDS.map((c) => c.name);
    expect(names).toContain('new');
    expect(names).toContain('help');
    expect(names).toContain('think');
    expect(names).toContain('status');
    expect(names).toContain('tasks');
  });

  it('includes /model and /models', () => {
    const names = COMMANDS.map((c) => c.name);
    expect(names).toContain('model');
    expect(names).toContain('models');
  });
});

// ─── /model + /models ─────────────────────────────────────────────────

describe('/model + /models', () => {
  // The catalog calls into @github/copilot-sdk and would hit the live API
  // (slow + flaky in CI). Mock the SDK module so tests run hermetically.
  // Keep mocks scoped to this describe block via beforeAll/afterAll.
  const fakeCatalog = [
    {
      id: 'claude-opus-4.6',
      name: 'Claude Opus 4.6',
      billing: { is_premium: true },
      policy: { state: 'enabled' },
    },
    {
      id: 'claude-sonnet-4.6',
      name: 'Claude Sonnet 4.6',
      billing: { is_premium: true },
      policy: { state: 'enabled' },
    },
    {
      id: 'gpt-4.1',
      name: 'GPT-4.1',
      billing: { is_premium: false },
      policy: { state: 'enabled' },
    },
    {
      id: 'gpt-5.4-mini',
      name: 'GPT-5.4 mini',
      billing: { is_premium: true },
      policy: { state: 'disabled' },
    },
  ];

  beforeAll(async () => {
    vi.doMock('@github/copilot-sdk', () => ({
      CopilotClient: class FakeClient {
        async start() {}
        async stop() {}
        async listModels() {
          return fakeCatalog;
        }
      },
    }));
    const mod = await import('./slash-commands.js');
    mod._resetModelCatalogCache();
  });

  afterAll(async () => {
    vi.doUnmock('@github/copilot-sdk');
    const mod = await import('./slash-commands.js');
    mod._resetModelCatalogCache();
  });

  it('/models lists catalog with current marker', async () => {
    const ctx = makeCtx();
    const res = await handleSlashCommand('/models', ctx);
    expect(res.handled).toBe(true);
    expect(ctx.channel!.sendMessage).toHaveBeenCalledOnce();
    const msg = (ctx.channel!.sendMessage as any).mock.calls[0][1] as string;
    expect(msg).toContain('claude-opus-4.6');
    expect(msg).toContain('gpt-4.1');
    // disabled models still listed (with state column)
    expect(msg).toContain('gpt-5.4-mini');
  });

  it('/model with no args shows current model', async () => {
    const ctx = makeCtx();
    const res = await handleSlashCommand('/model', ctx);
    expect(res.handled).toBe(true);
    // Either sendCard or sendMessage will fire depending on channel caps.
    const calls =
      (ctx.channel!.sendCard as any).mock.calls.length +
      (ctx.channel!.sendMessage as any).mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it('/model <valid-id> updates config', async () => {
    const ctx = makeCtx();
    const res = await handleSlashCommand('/model claude-opus-4.6', ctx);
    expect(res.handled).toBe(true);
    expect(ctx.channel!.sendMessage).toHaveBeenCalledOnce();
    const msg = (ctx.channel!.sendMessage as any).mock.calls[0][1] as string;
    expect(msg).toContain('claude-opus-4.6');
    expect(msg).toMatch(/set to/i);

    // Verify config was actually persisted.
    const { loadConfig } = await import('./config-loader.js');
    const cfg = loadConfig();
    expect(cfg.agents?.defaults?.model).toBe('claude-opus-4.6');
  });

  it('/model <invalid-id> rejects with suggestion when family matches', async () => {
    const ctx = makeCtx();
    const res = await handleSlashCommand('/model claude-opus-9.9', ctx);
    expect(res.handled).toBe(true);
    expect(ctx.channel!.sendMessage).toHaveBeenCalledOnce();
    const msg = (ctx.channel!.sendMessage as any).mock.calls[0][1] as string;
    expect(msg).toMatch(/not available/i);
    expect(msg).toContain('claude-opus-4.6'); // family-prefix suggestion
  });

  it('/model <disabled-id> refuses to switch', async () => {
    const ctx = makeCtx();
    const res = await handleSlashCommand('/model gpt-5.4-mini', ctx);
    expect(res.handled).toBe(true);
    expect(ctx.channel!.sendMessage).toHaveBeenCalledOnce();
    const msg = (ctx.channel!.sendMessage as any).mock.calls[0][1] as string;
    expect(msg).toMatch(/disabled/i);
  });

  it('/model accepts <provider>/<id> form and strips prefix on write', async () => {
    const ctx = makeCtx();
    const res = await handleSlashCommand('/model github-copilot/gpt-4.1', ctx);
    expect(res.handled).toBe(true);
    const { loadConfig } = await import('./config-loader.js');
    const cfg = loadConfig();
    expect(cfg.agents?.defaults?.model).toBe('gpt-4.1');
    expect(cfg.agents?.defaults?.provider).toBe('github-copilot');
  });
});

// ─── registerTelegramCommands ─────────────────────────────────────────────────

describe('registerTelegramCommands', () => {
  it('calls Telegram setMyCommands API', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', mockFetch);

    const { registerTelegramCommands } = await import('./slash-commands.js');
    await registerTelegramCommands('fake-token-123');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('api.telegram.org/botfake-token-123/setMyCommands');
    expect(opts.method).toBe('POST');

    // Body should contain command definitions
    const body = JSON.parse(opts.body);
    expect(body.commands).toBeDefined();
    expect(body.commands.length).toBeGreaterThanOrEqual(3);

    vi.unstubAllGlobals();
  });
});
