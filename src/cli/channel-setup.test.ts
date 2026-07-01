/**
 * Tests for `nanoclaw channel add teams --setup` multi-account routing.
 *
 * What we care about (and what regressed before this PR):
 *   1. `--account <id>` is honored end-to-end — appId/appPassword land in
 *      `accounts[<id>]`, NOT `accounts.default`.
 *   2. `botName` differs per account so two accounts that resolve to the
 *      same agent still get distinct Azure resource names.
 *   3. Webhook ports auto-allocate: default=3978, second account=3979,
 *      third=3980 — no collision with the first bot's HTTP server.
 *   4. `.env` writes are scoped to `accountId='default'`; non-default
 *      accounts must NOT touch MSTEAMS_APP_ID / MSTEAMS_APP_PASSWORD
 *      (otherwise they'd overwrite the first bot's single-account fallback).
 *
 * We stub Azure CLI / devtunnel / fs writes so the tests stay hermetic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execSync: vi.fn(),
  };
});

// In-memory config the CLI reads/writes — start fresh per test.
const memoryConfig: any = { channels: {}, agents: { defaults: { name: 'Andy' } } };

vi.mock('../config-loader.js', async () => {
  const actual = await vi.importActual<typeof import('../config-loader.js')>('../config-loader.js');
  return {
    ...actual,
    loadConfig: () => JSON.parse(JSON.stringify(memoryConfig)),
    saveConfig: (cfg: any) => {
      // Replace contents in-place so subsequent loadConfig() sees the write.
      for (const k of Object.keys(memoryConfig)) delete memoryConfig[k];
      Object.assign(memoryConfig, JSON.parse(JSON.stringify(cfg)));
    },
    resolveAgent: (cfg: any, agentId?: string) => {
      const list = cfg.agents?.list || [];
      const found = agentId ? list.find((a: any) => a.id === agentId) : null;
      if (found) return found;
      return { name: cfg.agents?.defaults?.name || 'Andy' };
    },
  };
});

// Skip .env disk writes / addon registry / manifest zip writes.
vi.mock('../workspace.js', () => ({
  paths: { env: '/tmp/test-nanoclaw.env', config: '/tmp/test-nanoclaw.json' },
  resolveWorkspace: () => '/tmp/test-nanoclaw',
}));
vi.mock('./addon.js', () => ({
  registerAddon: vi.fn(),
}));
vi.mock('./teams-manifest.js', () => ({
  setupManifest: vi.fn(async () => '/tmp/manifest.zip'),
}));

import { runChannelCommand } from './channel.js';

const exec = execSync as unknown as ReturnType<typeof vi.fn>;

// Drive execSync responses by command-substring match (order-independent —
// the CLI's own ordering of az/devtunnel calls is an implementation detail).
function setupExecStubs(): void {
  exec.mockImplementation((cmd: string) => {
    const c = String(cmd);
    // devtunnel
    if (c.startsWith('devtunnel --version')) return 'devtunnel 1.0\n';
    if (c.startsWith('devtunnel user show')) return 'user: test@example.com\n';
    if (c.startsWith('devtunnel list')) return 'nanoclaw-abc1 nanoclaw Active\n';
    if (c.startsWith('devtunnel create')) return 'Tunnel ID: nanoclaw-abc1\n';
    if (c.startsWith('devtunnel port create')) return 'created\n';
    if (c.startsWith('devtunnel access create')) return 'created\n';
    if (c.startsWith('devtunnel port show')) {
      // Per-port URL — embed the port number for assertion.
      const m = c.match(/-p (\d+)/);
      const port = m ? m[1] : '3978';
      return `https://nanoclaw-abc1-${port}.devtunnels.ms\n`;
    }
    if (c.startsWith('devtunnel show')) return 'https://nanoclaw-abc1.devtunnels.ms\n';
    // az
    if (c.startsWith('az account show')) return 'test-subscription\n';
    if (c.includes('az ad app list')) return ''; // no existing
    if (c.includes('az ad app create')) {
      // appId derived from the botName so different bots get different ids
      const m = c.match(/--display-name "([^"]+)"/);
      const name = m ? m[1] : 'nanoclaw';
      return `app-id-${name}\n`;
    }
    if (c.includes('az ad app credential reset')) return `secret-${Date.now()}\n`;
    if (c.includes('az group show')) return 'nanoclaw-rg\n';
    if (c.includes('az group create')) return '';
    if (c.includes('az bot show')) return '';
    if (c.includes('az bot create')) return '';
    if (c.includes('az bot msteams create')) return '';
    if (c.includes('az bot update')) return '';
    if (c.includes('az ad app federated-credential list')) return '';
    if (c.includes('az ad app federated-credential create')) return '';
    if (c.includes('az ad app federated-credential update')) return '';
    return '';
  });
}

let writeFileSyncSpy: any;
let readFileSyncSpy: any;
let logSpy: any;
let errSpy: any;

beforeEach(() => {
  // Reset in-memory config + agents list.
  for (const k of Object.keys(memoryConfig)) delete memoryConfig[k];
  memoryConfig.channels = {};
  memoryConfig.agents = {
    defaults: { name: 'Andy' },
    list: [
      { id: 'main', name: 'Andy' },
      { id: 'coder', name: 'Coder' },
    ],
  };
  exec.mockReset();
  setupExecStubs();
  writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
  readFileSyncSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((p: any) => {
    if (String(p).endsWith('.env')) return '';
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  writeFileSyncSpy.mockRestore();
  readFileSyncSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
});

describe('nanoclaw channel add teams --setup multi-account', () => {
  it('writes default account to accounts.default + .env on first setup', async () => {
    await runChannelCommand(['add', 'teams', '--setup', '--agent', 'main']);
    expect(memoryConfig.channels.teams).toBeDefined();
    expect(memoryConfig.channels.teams.enabled).toBe(true);
    expect(memoryConfig.channels.teams.accounts.default.appId).toMatch(/^app-id-nanoclaw-andy$/);
    expect(memoryConfig.channels.teams.accounts.default.webhookPort).toBe(3978);
    // .env got written (single-account fallback path)
    const envWrites = writeFileSyncSpy.mock.calls.filter((c: any[]) => String(c[0]).endsWith('.env'));
    expect(envWrites.length).toBeGreaterThan(0);
    const envBody = String(envWrites[envWrites.length - 1][1]);
    expect(envBody).toMatch(/MSTEAMS_APP_ID=app-id-nanoclaw-andy/);
    expect(envBody).toMatch(/MSTEAMS_APP_PASSWORD=secret-/);
  });

  it('non-default account lands in accounts.<id> without clobbering default or .env', async () => {
    // Seed: first bot already setup.
    memoryConfig.channels.teams = {
      enabled: true,
      accounts: {
        default: { appId: 'app-id-existing-default', appPassword: 'default-secret', webhookPort: 3978 },
      },
    };
    writeFileSyncSpy.mockClear();

    await runChannelCommand(['add', 'teams', '--setup', '--account', 'bot-b', '--agent', 'coder']);

    // Default account untouched
    expect(memoryConfig.channels.teams.accounts.default.appId).toBe('app-id-existing-default');
    expect(memoryConfig.channels.teams.accounts.default.appPassword).toBe('default-secret');
    expect(memoryConfig.channels.teams.accounts.default.webhookPort).toBe(3978);

    // New account written with distinct botName (suffixed with accountId)
    expect(memoryConfig.channels.teams.accounts['bot-b']).toBeDefined();
    expect(memoryConfig.channels.teams.accounts['bot-b'].appId).toBe('app-id-nanoclaw-coder-bot-b');
    expect(memoryConfig.channels.teams.accounts['bot-b'].appPassword).toMatch(/^secret-/);

    // Port auto-allocated to next free (3979)
    expect(memoryConfig.channels.teams.accounts['bot-b'].webhookPort).toBe(3979);

    // .env NOT touched for non-default account (would overwrite default bot's fallback)
    const envWrites = writeFileSyncSpy.mock.calls.filter((c: any[]) => String(c[0]).endsWith('.env'));
    expect(envWrites.length).toBe(0);
  });

  it('three-account chain allocates ports 3978/3979/3980', async () => {
    // Bot 1
    await runChannelCommand(['add', 'teams', '--setup', '--agent', 'main']);
    // Bot 2
    await runChannelCommand(['add', 'teams', '--setup', '--account', 'bot-b', '--agent', 'coder']);
    // Bot 3
    await runChannelCommand(['add', 'teams', '--setup', '--account', 'bot-c', '--agent', 'coder']);

    expect(memoryConfig.channels.teams.accounts.default.webhookPort).toBe(3978);
    expect(memoryConfig.channels.teams.accounts['bot-b'].webhookPort).toBe(3979);
    expect(memoryConfig.channels.teams.accounts['bot-c'].webhookPort).toBe(3980);

    // bot-b and bot-c both used the 'coder' agent — confirm their botNames
    // are nonetheless distinct (account suffix), so Azure resources don't collide.
    expect(memoryConfig.channels.teams.accounts['bot-b'].appId).toBe('app-id-nanoclaw-coder-bot-b');
    expect(memoryConfig.channels.teams.accounts['bot-c'].appId).toBe('app-id-nanoclaw-coder-bot-c');
  });

  it('--webhookPort flag overrides auto-allocation', async () => {
    // Seed: bot-b already exists on 3979
    memoryConfig.channels.teams = {
      enabled: true,
      accounts: {
        default: { appId: 'x', appPassword: 'y', webhookPort: 3978 },
        'bot-b': { appId: 'x', appPassword: 'y', webhookPort: 3979 },
      },
    };
    writeFileSyncSpy.mockClear();

    // Force bot-c onto port 4000 instead of the default 3980
    await runChannelCommand([
      'add',
      'teams',
      '--setup',
      '--account',
      'bot-c',
      '--agent',
      'coder',
      '--webhookPort',
      '4000',
    ]);

    expect(memoryConfig.channels.teams.accounts['bot-c'].webhookPort).toBe(4000);
  });

  it('--setup-tunnel --account <id> uses the allocated port', async () => {
    // Seed: default on 3978 — second account should request port 3979 on tunnel
    memoryConfig.channels.teams = {
      enabled: true,
      accounts: { default: { appId: 'x', appPassword: 'y', webhookPort: 3978 } },
    };
    exec.mockClear();
    setupExecStubs();

    await runChannelCommand(['add', 'teams', '--setup-tunnel', '--account', 'bot-b']);

    const portCreateCalls = exec.mock.calls
      .map((c: any[]) => String(c[0]))
      .filter((c: string) => c.startsWith('devtunnel port create'));
    expect(portCreateCalls.length).toBeGreaterThan(0);
    // At least one port create call should be for the new port (3979)
    expect(portCreateCalls.some((c: string) => c.includes('-p 3979'))).toBe(true);
    // And the account got its webhookPort persisted
    expect(memoryConfig.channels.teams.accounts['bot-b'].webhookPort).toBe(3979);
  });

  it('--setup-app --account <id> writes only that account, no .env clobber', async () => {
    memoryConfig.channels.teams = {
      enabled: true,
      accounts: { default: { appId: 'app-id-existing', appPassword: 'def-secret', webhookPort: 3978 } },
    };
    writeFileSyncSpy.mockClear();

    await runChannelCommand(['add', 'teams', '--setup-app', '--account', 'bot-b', '--agent', 'coder']);

    expect(memoryConfig.channels.teams.accounts.default.appId).toBe('app-id-existing');
    expect(memoryConfig.channels.teams.accounts['bot-b'].appId).toBe('app-id-nanoclaw-coder-bot-b');
    const envWrites = writeFileSyncSpy.mock.calls.filter((c: any[]) => String(c[0]).endsWith('.env'));
    expect(envWrites.length).toBe(0);
  });
});

describe('nanoclaw channel add teams --transport proxy (relay)', () => {
  it('--transport proxy (no setup verb) persists mode + endpoint + credEnv', async () => {
    memoryConfig.channels.teams = {
      enabled: true,
      accounts: { default: { appId: 'app-x', appPassword: 'y', webhookPort: 3978 } },
    };

    await runChannelCommand([
      'add',
      'teams',
      '--transport',
      'proxy',
      '--relay-endpoint',
      'relay-host:443',
      '--relay-cred-env',
      'NCL_RELAY_CRED',
    ]);

    const acct = memoryConfig.channels.teams.accounts.default;
    expect(acct.transport).toBe('proxy');
    expect(acct.proxy.southEndpoint).toBe('relay-host:443');
    expect(acct.proxy.auth.credentialEnv).toBe('NCL_RELAY_CRED');
    // appPassword left intact (federation not run in this path)
    expect(acct.appPassword).toBe('y');
  });

  it('credentialEnv defaults to NCL_RELAY_CRED when --relay-cred-env omitted', async () => {
    memoryConfig.channels.teams = { enabled: true, accounts: { default: { appId: 'app-x' } } };
    await runChannelCommand(['add', 'teams', '--transport', 'proxy', '--relay-endpoint', 'r:443']);
    expect(memoryConfig.channels.teams.accounts.default.proxy.auth.credentialEnv).toBe('NCL_RELAY_CRED');
  });

  it('`relay` is accepted as an alias for proxy', async () => {
    memoryConfig.channels.teams = { enabled: true, accounts: { default: { appId: 'app-x' } } };
    await runChannelCommand(['add', 'teams', '--transport', 'relay', '--relay-endpoint', 'r:443']);
    expect(memoryConfig.channels.teams.accounts.default.transport).toBe('proxy');
  });

  it('--transport tunnel persists tunnel mode without touching proxy', async () => {
    memoryConfig.channels.teams = { enabled: true, accounts: { default: { appId: 'app-x' } } };
    await runChannelCommand(['add', 'teams', '--transport', 'tunnel']);
    expect(memoryConfig.channels.teams.accounts.default.transport).toBe('tunnel');
    expect(memoryConfig.channels.teams.accounts.default.proxy).toBeUndefined();
  });

  it('--setup --transport proxy populates schema and skips devtunnel', async () => {
    exec.mockClear();
    setupExecStubs();
    await runChannelCommand([
      'add',
      'teams',
      '--setup',
      '--transport',
      'proxy',
      '--agent',
      'main',
      '--relay-endpoint',
      'relay-host:443',
      '--relay-cred-env',
      'NCL_RELAY_CRED',
      '--relay-issuer',
      'https://issuer.example/oidc',
    ]);

    const acct = memoryConfig.channels.teams.accounts.default;
    expect(acct.transport).toBe('proxy');
    expect(acct.proxy.southEndpoint).toBe('relay-host:443');
    expect(acct.appId).toMatch(/^app-id-nanoclaw-andy$/);

    // No devtunnel calls on the proxy path.
    const dtCalls = exec.mock.calls.map((c: any[]) => String(c[0])).filter((c: string) => c.startsWith('devtunnel'));
    expect(dtCalls.length).toBe(0);
  });

  it('--setup-federation without issuer does NOT create a credential', async () => {
    exec.mockClear();
    setupExecStubs();
    memoryConfig.channels.teams = { enabled: true, accounts: { default: { appId: 'app-x' } } };

    await runChannelCommand(['add', 'teams', '--setup-federation']);

    const fedCreate = exec.mock.calls
      .map((c: any[]) => String(c[0]))
      .filter((c: string) => c.includes('az ad app federated-credential create'));
    expect(fedCreate.length).toBe(0);
  });

  it('--setup-federation with issuer + subject creates the credential', async () => {
    exec.mockClear();
    setupExecStubs();
    memoryConfig.channels.teams = { enabled: true, accounts: { default: { appId: 'app-x' } } };
    // Provide subject via ARM output file read.
    readFileSyncSpy.mockImplementation((p: any) => {
      if (String(p).includes('arm') || String(p).includes('outputs')) {
        return JSON.stringify({ msiPrincipalId: { value: 'msi-principal-123' } });
      }
      if (String(p).endsWith('.env')) return '';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    await runChannelCommand([
      'add',
      'teams',
      '--setup-federation',
      '--relay-issuer',
      'https://issuer.example/oidc',
    ]);

    const fedCreate = exec.mock.calls
      .map((c: any[]) => String(c[0]))
      .filter((c: string) => c.includes('az ad app federated-credential create'));
    expect(fedCreate.length).toBe(1);
    expect(fedCreate[0]).toContain('msi-principal-123');
    expect(fedCreate[0]).toContain('https://issuer.example/oidc');
    expect(fedCreate[0]).toContain('api://AzureADTokenExchange');
  });
});

