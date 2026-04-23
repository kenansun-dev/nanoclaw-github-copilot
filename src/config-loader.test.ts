import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { setWorkspace, ensureWorkspace } from './workspace.js';
import { loadConfig, saveConfig, readWorkspaceEnv } from './config-loader.js';

describe('config-loader', () => {
  const tmpDir = path.join(os.tmpdir(), `nanoclaw-test-cfg-${Date.now()}`);

  beforeEach(() => {
    setWorkspace(tmpDir);
    ensureWorkspace();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadConfig returns defaults when no config file', () => {
    const config = loadConfig();
    expect(config.agents.defaults.name).toBe('Andy');
    expect(config.sandbox.image).toBe('nanoclaw-agent:latest');
    expect(config.channels.telegram.enabled).toBe(false);
    expect(config.logLevel).toBe('info');
  });

  it('loadConfig merges user config with defaults', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'nanoclaw.json'),
      JSON.stringify({
        agents: { defaults: { name: 'Bob' } },
        channels: { telegram: { enabled: true } },
      }),
    );
    const config = loadConfig();
    expect(config.agents.defaults.name).toBe('Bob');
    expect(config.agents.defaults.triggerWord).toBe('@Andy'); // default preserved
    expect(config.channels.telegram.enabled).toBe(true);
  });

  it('loadConfig reads .env secrets', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      'TELEGRAM_BOT_TOKEN=test-token-123\n',
    );
    const config = loadConfig();
    expect(config.channels.telegram.botToken).toBe('test-token-123');
    expect(config.channels.telegram.enabled).toBe(true); // auto-enabled
  });

  it('loadConfig merges mcp.json servers', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mcp.json'),
      JSON.stringify({
        myserver: {
          type: 'local',
          command: 'node',
          args: ['test.js'],
          tools: ['*'],
        },
      }),
    );
    const config = loadConfig();
    expect(config.mcp.servers.myserver).toBeDefined();
    expect(config.mcp.servers.myserver.command).toBe('node');
  });

  it('saveConfig strips secrets', () => {
    const config = loadConfig();
    config.channels.telegram.botToken = 'secret-token';
    config.channels.teams.appPassword = 'secret-pass';
    saveConfig(config);

    const saved = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'nanoclaw.json'), 'utf-8'),
    );
    expect(saved.channels.telegram.botToken).toBe('${TELEGRAM_BOT_TOKEN}');
    expect(saved.channels.teams.appPassword).toBe('${MSTEAMS_APP_PASSWORD}');
  });

  it('readWorkspaceEnv parses .env correctly', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      '# comment\nKEY1=value1\nKEY2="quoted value"\nKEY3=\n',
    );
    const env = readWorkspaceEnv();
    expect(env.KEY1).toBe('value1');
    expect(env.KEY2).toBe('quoted value');
    expect(env.KEY3).toBeUndefined(); // empty value
  });
});

describe('config model passthrough', () => {
  const tmpDir = path.join(os.tmpdir(), `nanoclaw-test-model-${Date.now()}`);

  beforeEach(() => {
    setWorkspace(tmpDir);
    ensureWorkspace();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('model from config is accessible for container input', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'nanoclaw.json'),
      JSON.stringify({
        agents: {
          defaults: {
            model: 'github-copilot/claude-sonnet-4.6',
          },
        },
      }),
    );
    const config = loadConfig();
    // Config migration v1→v2 splits provider/model into separate fields
    expect(config.agents?.defaults?.model).toBe('claude-sonnet-4.6');
    expect(config.agents?.defaults?.provider).toBe('github-copilot');
  });

  it('model defaults to claude-sonnet-4 when not specified', () => {
    const config = loadConfig();
    expect(config.agents.defaults.model).toBe('claude-sonnet-4');
    expect(config.agents.defaults.provider).toBe('github-copilot');
  });
});

// --- Accounts normalization + bindings ---

describe('channel accounts normalization', () => {
  const tmpDir2 = path.join(os.tmpdir(), `nanoclaw-test-accts-${Date.now()}`);

  beforeEach(() => {
    setWorkspace(tmpDir2);
    ensureWorkspace();
  });

  afterEach(() => {
    fs.rmSync(tmpDir2, { recursive: true, force: true });
  });

  it('auto-normalizes flat telegram credentials to accounts.default', () => {
    fs.writeFileSync(
      path.join(tmpDir2, 'nanoclaw.json'),
      JSON.stringify({
        channels: {
          telegram: { enabled: true, botToken: 'test-token-123' },
        },
      }),
    );
    const config = loadConfig();
    expect(config.channels.telegram.accounts).toBeDefined();
    expect(config.channels.telegram.accounts!.default).toBeDefined();
    expect(config.channels.telegram.accounts!.default.botToken).toBe(
      'test-token-123',
    );
  });

  it('auto-normalizes flat teams credentials to accounts.default', () => {
    fs.writeFileSync(
      path.join(tmpDir2, 'nanoclaw.json'),
      JSON.stringify({
        channels: {
          teams: {
            enabled: true,
            appId: 'app-123',
            appPassword: 'secret',
            tenantId: 'tenant-456',
            webhookPort: 3978,
          },
        },
      }),
    );
    const config = loadConfig();
    expect(config.channels.teams.accounts).toBeDefined();
    expect(config.channels.teams.accounts!.default.appId).toBe('app-123');
    expect(config.channels.teams.accounts!.default.appPassword).toBe('secret');
    expect(config.channels.teams.accounts!.default.tenantId).toBe('tenant-456');
    expect(config.channels.teams.accounts!.default.webhookPort).toBe(3978);
  });

  it('preserves explicit accounts without auto-normalization', () => {
    fs.writeFileSync(
      path.join(tmpDir2, 'nanoclaw.json'),
      JSON.stringify({
        channels: {
          telegram: {
            enabled: true,
            accounts: {
              default: { botToken: 'token-a' },
              daily: { botToken: 'token-b' },
            },
          },
        },
      }),
    );
    const config = loadConfig();
    expect(Object.keys(config.channels.telegram.accounts!)).toEqual([
      'default',
      'daily',
    ]);
    expect(config.channels.telegram.accounts!.default.botToken).toBe('token-a');
    expect(config.channels.telegram.accounts!.daily.botToken).toBe('token-b');
  });

  it('bindings config is loaded and accessible', () => {
    fs.writeFileSync(
      path.join(tmpDir2, 'nanoclaw.json'),
      JSON.stringify({
        bindings: [
          {
            agentId: 'main',
            match: { channel: 'telegram', accountId: 'default' },
          },
          {
            agentId: 'coder',
            match: { channel: 'telegram', accountId: 'daily' },
          },
        ],
      }),
    );
    const config = loadConfig();
    expect(config.bindings).toHaveLength(2);
    expect(config.bindings![0].agentId).toBe('main');
    expect(config.bindings![1].match.accountId).toBe('daily');
  });

  it('bindings defaults to undefined when not configured', () => {
    const config = loadConfig();
    expect(config.bindings).toBeUndefined();
  });
});

// --- tenantId dedup migration ---

describe('config migration v2→v3: tenantId dedup', () => {
  const tmpDir4 = path.join(os.tmpdir(), `nanoclaw-test-tenant-${Date.now()}`);

  beforeEach(() => {
    setWorkspace(tmpDir4);
    ensureWorkspace();
  });

  afterEach(() => {
    fs.rmSync(tmpDir4, { recursive: true, force: true });
  });

  it('migrates root-level teams.tenantId to accounts.default.tenantId', () => {
    fs.writeFileSync(
      path.join(tmpDir4, 'nanoclaw.json'),
      JSON.stringify({
        configVersion: 2,
        channels: {
          teams: {
            enabled: true,
            tenantId: 'my-tenant-123',
            appId: 'app-1',
            appPassword: 'pass-1',
          },
        },
      }),
    );
    const config = loadConfig();
    // Root tenantId should be gone after migration, account should have it
    expect(config.channels.teams.accounts?.default?.tenantId).toBe(
      'my-tenant-123',
    );
  });

  it('saveConfig strips root-level teams.tenantId', () => {
    const config = loadConfig();
    (config.channels.teams as any).tenantId = 'should-be-stripped';
    saveConfig(config);
    const saved = JSON.parse(
      fs.readFileSync(path.join(tmpDir4, 'nanoclaw.json'), 'utf-8'),
    );
    expect(saved.channels?.teams?.tenantId).toBeUndefined();
  });

  it('preserves existing accounts.default.tenantId over root during migration', () => {
    fs.writeFileSync(
      path.join(tmpDir4, 'nanoclaw.json'),
      JSON.stringify({
        configVersion: 2,
        channels: {
          teams: {
            enabled: true,
            tenantId: 'root-tenant',
            accounts: {
              default: {
                appId: 'app-1',
                tenantId: 'account-tenant',
              },
            },
          },
        },
      }),
    );
    const config = loadConfig();
    // The existing account-level tenantId should be preserved
    expect(config.channels.teams.accounts?.default?.tenantId).toBe(
      'account-tenant',
    );
  });
});

// --- sandbox.engine config ---

describe('env var interpolation', () => {
  const tmpDir5 = path.join(os.tmpdir(), `nanoclaw-test-envvar-${Date.now()}`);

  beforeEach(() => {
    setWorkspace(tmpDir5);
    ensureWorkspace();
  });

  afterEach(() => {
    fs.rmSync(tmpDir5, { recursive: true, force: true });
  });

  it('resolves ${VAR} from .env file', () => {
    fs.writeFileSync(path.join(tmpDir5, '.env'), 'MY_APP_ID=resolved-app-id\n');
    fs.writeFileSync(
      path.join(tmpDir5, 'nanoclaw.json'),
      JSON.stringify({
        channels: {
          teams: {
            enabled: true,
            accounts: {
              default: { appId: '${MY_APP_ID}' },
            },
          },
        },
      }),
    );
    const config = loadConfig();
    expect(config.channels.teams.accounts?.default?.appId).toBe(
      'resolved-app-id',
    );
  });

  it('leaves ${VAR} as-is when env var not found', () => {
    fs.writeFileSync(
      path.join(tmpDir5, 'nanoclaw.json'),
      JSON.stringify({
        channels: {
          teams: {
            enabled: true,
            accounts: {
              default: { appId: '${NONEXISTENT_VAR_XYZ}' },
            },
          },
        },
      }),
    );
    const config = loadConfig();
    expect(config.channels.teams.accounts?.default?.appId).toBe(
      '${NONEXISTENT_VAR_XYZ}',
    );
  });

  it('workspace .env takes priority over process.env', () => {
    const origVal = process.env.NANOCLAW_TEST_PRIORITY;
    process.env.NANOCLAW_TEST_PRIORITY = 'from-process';
    fs.writeFileSync(
      path.join(tmpDir5, '.env'),
      'NANOCLAW_TEST_PRIORITY=from-dotenv\n',
    );
    fs.writeFileSync(
      path.join(tmpDir5, 'nanoclaw.json'),
      JSON.stringify({
        agents: { defaults: { name: '${NANOCLAW_TEST_PRIORITY}' } },
      }),
    );
    const config = loadConfig();
    expect(config.agents.defaults.name).toBe('from-dotenv');
    // Cleanup
    if (origVal === undefined) delete process.env.NANOCLAW_TEST_PRIORITY;
    else process.env.NANOCLAW_TEST_PRIORITY = origVal;
  });
});

// --- sandbox.engine config ---

describe('sandbox.engine config', () => {
  const tmpDir3 = path.join(os.tmpdir(), `nanoclaw-test-engine-${Date.now()}`);

  beforeEach(() => {
    setWorkspace(tmpDir3);
    ensureWorkspace();
  });

  afterEach(() => {
    fs.rmSync(tmpDir3, { recursive: true, force: true });
  });

  it('defaults to node when not specified', () => {
    fs.writeFileSync(path.join(tmpDir3, 'nanoclaw.json'), JSON.stringify({}));
    const config = loadConfig();
    expect(config.sandbox.engine).toBe('node');
  });

  it('respects explicit engine: tsx', () => {
    fs.writeFileSync(
      path.join(tmpDir3, 'nanoclaw.json'),
      JSON.stringify({ sandbox: { engine: 'tsx' } }),
    );
    const config = loadConfig();
    expect(config.sandbox.engine).toBe('tsx');
  });

  it('respects explicit engine: node', () => {
    fs.writeFileSync(
      path.join(tmpDir3, 'nanoclaw.json'),
      JSON.stringify({ sandbox: { engine: 'node' } }),
    );
    const config = loadConfig();
    expect(config.sandbox.engine).toBe('node');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// chat numeric-id surface (kenan model: numeric id is user-facing handle,
// jid is detail field, isMain singleton enforced at load).
// ──────────────────────────────────────────────────────────────────────────
import {
  resolveChatHandle,
  nextChatId,
  findExtraMainChats,
} from './config-loader.js';

describe('config-loader / chat numeric ids', () => {
  const tmpDir = path.join(os.tmpdir(), `nanoclaw-test-chatid-${Date.now()}`);

  beforeEach(() => {
    setWorkspace(tmpDir);
    ensureWorkspace();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('v3 → v4 migration assigns sequential ids in jid sort order (top-level format)', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'nanoclaw.json'),
      JSON.stringify({
        configVersion: 3,
        chats: {
          'tg:222': { name: 'b' },
          'tg:111': { name: 'a' },
          'tg:333': { name: 'c' },
        },
      }),
    );
    const config = loadConfig();
    expect(config.chats['tg:111'].id).toBe(1);
    expect(config.chats['tg:222'].id).toBe(2);
    expect(config.chats['tg:333'].id).toBe(3);
  });

  it('v3 → v4 migration honours pre-existing ids and only fills gaps', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'nanoclaw.json'),
      JSON.stringify({
        configVersion: 3,
        channels: {
          telegram: {
            chats: [
              { jid: 'tg:111', name: 'a', id: 5 },
              { jid: 'tg:222', name: 'b' },
              { jid: 'tg:333', name: 'c' },
            ],
          },
        },
      }),
    );
    const config = loadConfig();
    expect(config.chats['tg:111'].id).toBe(5);
    expect(config.chats['tg:222'].id).toBe(1);
    expect(config.chats['tg:333'].id).toBe(2);
  });

  it('nextChatId returns max+1 when ids exist', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'nanoclaw.json'),
      JSON.stringify({
        configVersion: 4,
        channels: {
          telegram: {
            chats: [
              { jid: 'tg:111', name: 'a', id: 3 },
              { jid: 'tg:222', name: 'b', id: 7 },
            ],
          },
        },
      }),
    );
    const config = loadConfig();
    expect(nextChatId(config)).toBe(8);
  });

  it('nextChatId returns 1 when chats are empty', () => {
    const config = loadConfig();
    expect(nextChatId(config)).toBe(1);
  });

  it('resolveChatHandle accepts numeric id', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'nanoclaw.json'),
      JSON.stringify({
        configVersion: 4,
        channels: {
          telegram: { chats: [{ jid: 'tg:111', name: 'a', id: 7 }] },
        },
      }),
    );
    const config = loadConfig();
    expect(resolveChatHandle(config, '7')).toBe('tg:111');
  });

  it('resolveChatHandle accepts jid', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'nanoclaw.json'),
      JSON.stringify({
        configVersion: 4,
        channels: {
          telegram: { chats: [{ jid: 'tg:111', name: 'a', id: 7 }] },
        },
      }),
    );
    const config = loadConfig();
    expect(resolveChatHandle(config, 'tg:111')).toBe('tg:111');
  });

  it('resolveChatHandle returns null on miss', () => {
    const config = loadConfig();
    expect(resolveChatHandle(config, '99')).toBeNull();
    expect(resolveChatHandle(config, 'tg:nope')).toBeNull();
    expect(resolveChatHandle(config, '')).toBeNull();
  });

  it('loadConfig allows multiple isMain chats (DM share-main feature)', () => {
    // After the share-main feature: multi-isMain is intentional for DMs.
    // loadConfig should NOT throw on it; the doctor check enforces the
    // group-aware view at runtime once chats.is_group is populated.
    fs.writeFileSync(
      path.join(tmpDir, 'nanoclaw.json'),
      JSON.stringify({
        configVersion: 4,
        channels: {
          telegram: {
            chats: [
              { jid: 'tg:111', name: 'a', id: 1, isMain: true },
              { jid: 'tg:222', name: 'b', id: 2, isMain: true },
            ],
          },
        },
      }),
    );
    expect(() => loadConfig()).not.toThrow();
  });

  it('findExtraMainChats flags multi-isMain *groups* when isGroup info is given', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'nanoclaw.json'),
      JSON.stringify({
        configVersion: 4,
        channels: {
          telegram: {
            chats: [
              { jid: 'tg:g1', name: 'group1', id: 1, isMain: true },
              { jid: 'tg:g2', name: 'group2', id: 2, isMain: true },
            ],
          },
        },
      }),
    );
    const config = loadConfig();
    const isGroupByJid = { 'tg:g1': true, 'tg:g2': true };
    expect(findExtraMainChats(config, isGroupByJid)).toEqual([
      'tg:g1',
      'tg:g2',
    ]);
  });

  it('findExtraMainChats does NOT flag multi-isMain DMs', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'nanoclaw.json'),
      JSON.stringify({
        configVersion: 4,
        channels: {
          telegram: {
            chats: [
              { jid: 'tg:111', name: 'a', id: 1, isMain: true },
              { jid: 'tg:222', name: 'b', id: 2, isMain: true },
            ],
          },
        },
      }),
    );
    const config = loadConfig();
    const isGroupByJid = { 'tg:111': false, 'tg:222': false };
    expect(findExtraMainChats(config, isGroupByJid)).toEqual([]);
  });

  it('loadConfig succeeds with exactly one isMain', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'nanoclaw.json'),
      JSON.stringify({
        configVersion: 4,
        channels: {
          telegram: {
            chats: [
              { jid: 'tg:111', name: 'a', id: 1, isMain: true },
              { jid: 'tg:222', name: 'b', id: 2 },
            ],
          },
        },
      }),
    );
    expect(() => loadConfig()).not.toThrow();
  });

  it('v3 → v4 dedupes isMain when v0→1 set it on multiple chats (regression: rpi5 review)', () => {
    // Simulate post-v0→1 state: every chat has isMain:true (the v0→1 default).
    // Without dedupe in v3→4, loadConfig() would throw "2 chats marked isMain"
    // and break every multi-chat user on upgrade.
    fs.writeFileSync(
      path.join(tmpDir, 'nanoclaw.json'),
      JSON.stringify({
        configVersion: 3,
        channels: {
          telegram: {
            chats: [
              { jid: 'tg:111', name: 'a', isMain: true },
              { jid: 'tg:222', name: 'b', isMain: true },
              { jid: 'tg:333', name: 'c', isMain: true },
            ],
          },
        },
      }),
    );
    // Should NOT throw.
    const config = loadConfig();
    // Lowest-id (first assigned) kept as main; rest cleared.
    expect(config.chats['tg:111'].isMain).toBe(true);
    expect(config.chats['tg:222'].isMain).toBeUndefined();
    expect(config.chats['tg:333'].isMain).toBeUndefined();
    expect(findExtraMainChats(config)).toEqual([]);
  });

  it('findExtraMainChats returns empty when at most one isMain', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'nanoclaw.json'),
      JSON.stringify({
        configVersion: 4,
        channels: {
          telegram: {
            chats: [{ jid: 'tg:111', name: 'a', id: 1, isMain: true }],
          },
        },
      }),
    );
    const config = loadConfig();
    expect(findExtraMainChats(config)).toEqual([]);
  });

  // rpi5 caught this on 2026-04-20 live deploy of PR #15: reconcile
  // imports DB chats whose channel isn't in `channels.<name>` config
  // → channelFromJid('signal:abc') === 'signal' (or 'other')
  // → distributeChatsToChannels skips because no `channels.signal` exists
  // → chats vanish on saveConfig → next boot reconcile re-adds them
  // → forever-drift loop. Fix: stash unknown-channel chats back at
  // top-level `chats` so normalizeChats picks them up next load.
  //
  // 2026-04-21: switched the example jid from 'tui:1' to 'signal:abc'
  // because PR #16's v4→v5 TUI migration consolidates tui:N →
  // tui:default. The orphan-preservation behavior we test here is
  // channel-agnostic, so any unconfigured channel works as the example.
  it('saveConfig preserves chats whose channel has no config (e.g. signal:*)', () => {
    const cfgPath = path.join(tmpDir, 'nanoclaw.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        configVersion: 5,
        chats: {
          'signal:abc': { id: 1, name: 'signal-friend' },
          'tg:42': { id: 2, name: 'kenan-tg' },
        },
        channels: { telegram: { enabled: true } },
      }),
    );
    const config = loadConfig();
    expect(config.chats['signal:abc']).toBeDefined();
    expect(config.chats['tg:42']).toBeDefined();

    saveConfig(config);

    const config2 = loadConfig();
    expect(config2.chats['signal:abc']).toBeDefined();
    expect(config2.chats['signal:abc'].name).toBe('signal-friend');
    expect(config2.chats['tg:42']).toBeDefined();

    // And the on-disk shape: signal:abc lives under top-level `chats`,
    // tg:42 under channels.telegram.chats.
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(onDisk.chats).toBeDefined();
    expect(onDisk.chats['signal:abc']).toBeDefined();
    expect(onDisk.channels.telegram.chats).toEqual([
      expect.objectContaining({ jid: 'tg:42', name: 'kenan-tg' }),
    ]);
  });
});

describe('config migration v4→v5: TUI chat consolidation', () => {
  const tmpDir = path.join(os.tmpdir(), `nanoclaw-test-tuiv5-${Date.now()}`);

  beforeEach(() => {
    setWorkspace(tmpDir);
    ensureWorkspace();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('consolidates legacy tui:N entries into a single tui:default', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'nanoclaw.json'),
      JSON.stringify({
        configVersion: 4,
        chats: {
          'tui:1': { id: 10, name: 'tui-1', isMain: true },
          'tui:2': { id: 11, name: 'tui-2', isMain: true },
          'tui:3': { id: 12, name: 'tui-3', isMain: true },
          'tg:999': { id: 1, name: 'kenan', isMain: true },
        },
      }),
    );
    const config = loadConfig();
    expect(config.configVersion).toBe(8);
    expect(config.chats['tui:1']).toBeUndefined();
    expect(config.chats['tui:2']).toBeUndefined();
    expect(config.chats['tui:3']).toBeUndefined();
    // v5 creates tui:default but v7 then purges all tui:* entries
    // (tui channel auto-registers on connect, no config entry needed).
    expect(config.chats['tui:default']).toBeUndefined();
    // Non-TUI chats are untouched.
    expect(config.chats['tg:999']).toBeDefined();
  });

  it('is a no-op when no legacy tui:N entries exist', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'nanoclaw.json'),
      JSON.stringify({
        configVersion: 4,
        chats: { 'tg:999': { id: 1, name: 'kenan', isMain: true } },
      }),
    );
    const config = loadConfig();
    expect(config.configVersion).toBe(8);
    expect(config.chats['tui:default']).toBeUndefined();
    expect(config.chats['tg:999']).toBeDefined();
  });

  it('v7 supersedes v5 preservation: tui:default is purged (auto-registered by tui channel)', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'nanoclaw.json'),
      JSON.stringify({
        configVersion: 4,
        chats: {
          'tui:default': { id: 5, name: 'tui', isMain: true, custom: 'kept' },
          'tui:1': { id: 10, name: 'tui-1', isMain: true },
        },
      }),
    );
    const config = loadConfig();
    expect(config.chats['tui:1']).toBeUndefined();
    expect(config.chats['tui:default']).toBeUndefined();
  });

  it('v7 purges all tui:* entries including non-numeric subkeys', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'nanoclaw.json'),
      JSON.stringify({
        configVersion: 4,
        chats: {
          'tui:custom-name': { id: 5, name: 'tui-custom', isMain: true },
        },
      }),
    );
    const config = loadConfig();
    expect(config.chats['tui:custom-name']).toBeUndefined();
  });
});

describe('config migration v5→v6: plugins block seed', () => {
  const tmpDir = path.join(os.tmpdir(), `nanoclaw-test-pluginv6-${Date.now()}`);

  beforeEach(() => {
    setWorkspace(tmpDir);
    ensureWorkspace();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('seeds default marketplaces and empty enabledPlugins[] when missing', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'nanoclaw.json'),
      JSON.stringify({ configVersion: 5 }),
    );
    const config = loadConfig();
    expect(config.configVersion).toBe(8);
    expect(config.plugins).toBeDefined();
    expect(config.plugins?.enabledPlugins).toEqual([]);
    expect(config.plugins?.extraKnownMarketplaces).toEqual([
      { name: 'copilot-plugins', source: 'github/copilot-plugins' },
      { name: 'awesome-copilot', source: 'github/awesome-copilot' },
    ]);
    expect(config.plugins?.directories).toEqual([]);
    // Old field names removed by v8 canonicalization.
    expect(config.plugins?.enabled).toBeUndefined();
    expect(config.plugins?.marketplaces).toBeUndefined();
  });

  it('preserves user-defined plugins block (only seeds missing keys)', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'nanoclaw.json'),
      JSON.stringify({
        configVersion: 5,
        plugins: {
          enabled: [
            {
              name: 'workiq',
              source: 'microsoft/work-iq',
            },
          ],
        },
      }),
    );
    const config = loadConfig();
    expect(config.configVersion).toBe(8);
    // v8 renamed enabled → enabledPlugins
    expect(config.plugins?.enabledPlugins).toHaveLength(1);
    expect(config.plugins?.enabledPlugins?.[0].name).toBe('workiq');
    // marketplaces still seeded with defaults because user didn't define them
    expect(config.plugins?.extraKnownMarketplaces?.length).toBe(2);
  });

  it('does not touch user-defined marketplaces array', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'nanoclaw.json'),
      JSON.stringify({
        configVersion: 5,
        plugins: {
          marketplaces: [{ name: 'custom-mp', source: 'kenan/my-marketplace' }],
        },
      }),
    );
    const config = loadConfig();
    // v8 renamed marketplaces → extraKnownMarketplaces; entries preserved.
    expect(config.plugins?.extraKnownMarketplaces).toEqual([
      { name: 'custom-mp', source: 'kenan/my-marketplace' },
    ]);
    expect(config.plugins?.marketplaces).toBeUndefined();
  });

  it('v7 migration: purges legacy tui:N + other root chats', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'nanoclaw.json'),
      JSON.stringify({
        configVersion: 6,
        chats: {
          'tui:1': {
            id: 1,
            name: 'tui-1',
            isMain: true,
            requiresTrigger: true,
          },
          'tui:2': { id: 2, name: 'tui-2', requiresTrigger: true },
          'tui:3': {
            id: 4,
            name: 'tui-3',
            isMain: true,
            requiresTrigger: true,
          },
          other: { id: 5, name: 'other' },
          'tui:default': {
            id: 6,
            name: 'tui',
            isMain: true,
            requiresTrigger: true,
          },
        },
      }),
    );
    const config = loadConfig();
    expect(config.configVersion).toBe(8);
    expect(Object.keys(config.chats)).toHaveLength(0);
  });

  it('v7 migration: leaves real-jid entries in root chats untouched', () => {
    // Real channel jids (telegram:*, signal:*, discord:*) stay in root
    // chats; existing reconciliation owns moving them. v7 only purges
    // tui:* and 'other'.
    fs.writeFileSync(
      path.join(tmpDir, 'nanoclaw.json'),
      JSON.stringify({
        configVersion: 6,
        chats: {
          'tui:default': { id: 1, name: 'tui', isMain: true },
          'telegram:12345': { id: 10, name: 'Alice' },
          'discord:67890': { id: 11, name: 'Bob' },
        },
      }),
    );
    const config = loadConfig();
    expect(config.configVersion).toBe(8);
    expect(config.chats['tui:default']).toBeUndefined();
    expect(config.chats['telegram:12345']).toBeDefined();
    expect(config.chats['discord:67890']).toBeDefined();
  });
});
