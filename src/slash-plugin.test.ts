import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleSlashCommand, SlashCommandContext } from './slash-commands.js';

// Mock cli/plugin so handlePluginSlash dispatches without touching FS.
vi.mock('./cli/plugin.js', () => ({
  runPluginCommand: vi.fn(async (argv: string[]) => {
    if (argv[0] === 'list' || argv.length === 0) {
      console.log('No plugins installed.');
      return;
    }
    if (argv[0] === 'install' && !argv[1]) {
      console.log('Usage: nanoclaw plugin install <spec>');
      return;
    }
    if (argv[0] === 'install') {
      console.log(`installing ${argv[1]}`);
      return;
    }
    if (argv[0] === 'remove' && argv[1]) {
      console.log(`removed ${argv[1]}`);
      return;
    }
    if (argv[0] === 'info' && argv[1]) {
      console.log(`info: ${argv[1]}`);
      return;
    }
    if (argv[0] === 'marketplace') {
      console.log('marketplace ok');
      return;
    }
    console.log('default usage');
  }),
  ensureEnabledPluginsInstalled: vi.fn(async () => ({
    installed: ['workiq'],
    skipped: [],
    failed: [],
  })),
}));

describe('/plugin slash command', () => {
  let sent: string[];
  let ctx: SlashCommandContext;

  beforeEach(() => {
    sent = [];
    ctx = {
      chatJid: 'tg:1',
      groupFolder: 'group-tg-1',
      channel: {
        sendMessage: vi.fn(async (_jid: string, text: string) => {
          sent.push(text);
          return 'mid-1';
        }),
      } as any,
      clearSession: vi.fn(),
      killActiveRunner: vi.fn(() => true),
    };
  });

  it('routes /plugin (no args) to list', async () => {
    const r = await handleSlashCommand('/plugin', ctx);
    expect(r.handled).toBe(true);
    expect(sent[0]).toContain('No plugins installed');
  });

  it('routes /plugin list', async () => {
    const r = await handleSlashCommand('/plugin list', ctx);
    expect(r.handled).toBe(true);
    expect(sent[0]).toContain('No plugins installed');
  });

  it('routes /plugin install <spec>', async () => {
    const r = await handleSlashCommand('/plugin install workiq@cc', ctx);
    expect(r.handled).toBe(true);
    expect(sent[0]).toContain('installing workiq@cc');
  });

  it('routes /plugin install (no spec) to usage', async () => {
    const r = await handleSlashCommand('/plugin install', ctx);
    expect(r.handled).toBe(true);
    expect(sent[0]).toMatch(/Usage:/);
  });

  it('routes /plugin remove <name>', async () => {
    const r = await handleSlashCommand('/plugin remove workiq', ctx);
    expect(r.handled).toBe(true);
    expect(sent[0]).toContain('removed workiq');
  });

  it('routes /plugin info <name>', async () => {
    const r = await handleSlashCommand('/plugin info workiq', ctx);
    expect(r.handled).toBe(true);
    expect(sent[0]).toContain('info: workiq');
  });

  it('routes /plugin marketplace list', async () => {
    const r = await handleSlashCommand('/plugin marketplace list', ctx);
    expect(r.handled).toBe(true);
    expect(sent[0]).toContain('marketplace ok');
  });

  it('handles /plugin reload (kills runner + reports installed)', async () => {
    const r = await handleSlashCommand('/plugin reload', ctx);
    expect(r.handled).toBe(true);
    const text = sent.join('\n');
    expect(text).toContain('Plugin reload');
    expect(text).toContain('installed: workiq');
    expect(text).toContain('Active runner killed');
    expect(ctx.killActiveRunner).toHaveBeenCalledWith('tg:1');
  });

  it('wraps CLI output in code fence', async () => {
    await handleSlashCommand('/plugin list', ctx);
    expect(sent[0].startsWith('```')).toBe(true);
    expect(sent[0].endsWith('```')).toBe(true);
  });
});
