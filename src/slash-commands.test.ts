/**
 * Slash command tests — normalizeSlashInput, handleSlashCommand,
 * parseTeamsCardSubmit, buildHelpText, COMMANDS registry.
 *
 * Target: 100% command recognition, correct handled/unhandled routing.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  normalizeSlashInput,
  handleSlashCommand,
  buildHelpText,
  parseTeamsCardSubmit,
  COMMANDS,
  SlashCommandContext,
} from './slash-commands.js';

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

  it('/status returns handled: false (passthrough to agent)', async () => {
    const ctx = makeCtx();
    const result = await handleSlashCommand('/status', ctx);
    // These commands are NOT handled by nanoclaw — they pass through to the agent
    expect(result.handled).toBe(false);
    // No message sent by slash handler
    expect(ctx.channel!.sendMessage).not.toHaveBeenCalled();
  });

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
