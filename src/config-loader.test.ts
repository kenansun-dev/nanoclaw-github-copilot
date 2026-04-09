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
    expect(saved.channels.telegram.botToken).toBeUndefined();
    expect(saved.channels.teams.appPassword).toBeUndefined();
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
