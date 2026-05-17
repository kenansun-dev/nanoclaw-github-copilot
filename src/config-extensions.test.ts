/**
 * Tests for config-extensions.ts — provider detection, agent resolution,
 * model parsing, and session directory helpers.
 *
 * These functions are the glue between config and runtime behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process so isCopilotAuthenticated never shells out during tests.
// Real snap/npm host behavior is exercised by smoke runs (VM + rpi5) — unit
// suite must stay hermetic + fast (no 5s timeouts under parallel load).
const execSyncMock = vi.fn();
vi.mock('child_process', async () => {
  const real = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...real, execSync: (...args: unknown[]) => execSyncMock(...args) };
});
import {
  getProvider,
  getModelName,
  isGHCProvider,
  isAgentGHC,
  getAgentSessionDir,
  getAgentModelName,
  getAgentProvider,
  resolveAgentForChat,
  isCopilotAuthenticated,
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
    expect(getProvider('github-copilot/claude-sonnet-4.5')).toBe('github-copilot');
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
    expect(getModelName('github-copilot/claude-sonnet-4.5')).toBe('claude-sonnet-4.5');
    expect(getModelName('openai/gpt-5.3')).toBe('gpt-5.3');
  });

  it('returns full string when no slash (maps via default provider)', () => {
    // Default provider is anthropic (CC), so GHC-style name maps to CC form
    expect(getModelName('claude-sonnet-4.5')).toBe('claude-sonnet-4-5');
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
    expect(isAgentGHC(makeAgent({ model: 'github-copilot/claude-sonnet-4.5' }))).toBe(true);
  });

  it('returns false for non-GHC agent', () => {
    expect(isAgentGHC(makeAgent({ model: 'anthropic/claude-opus-4' }))).toBe(false);
  });
});

// ─── getAgentSessionDir ──────────────────────────────────────────────────────

describe('getAgentSessionDir', () => {
  it('returns .copilot for GHC agents', () => {
    expect(getAgentSessionDir(makeAgent({ model: 'github-copilot/claude-sonnet-4.5' }))).toBe('.copilot');
  });

  it('returns .claude for CC agents', () => {
    expect(getAgentSessionDir(makeAgent({ model: 'anthropic/claude-opus-4' }))).toBe('.claude');
  });
});

// ─── getAgentModelName / getAgentProvider ────────────────────────────────────

describe('getAgentModelName', () => {
  it('normalizes GHC-format model name when agent provider is anthropic', () => {
    // The bug: kenan switched provider from github-copilot to anthropic but
    // model stayed 'claude-opus-4.6' (GHC format). CC SDK errors on this.
    expect(getAgentModelName(makeAgent({ model: 'anthropic/claude-opus-4.6' }))).toBe('claude-opus-4-6');
  });

  it('normalizes CC-format model name when agent provider is github-copilot', () => {
    expect(getAgentModelName(makeAgent({ model: 'github-copilot/claude-opus-4-6' }))).toBe('claude-opus-4');
  });

  it('uses agent.provider field over model prefix when both present', () => {
    expect(
      getAgentModelName(
        makeAgent({
          provider: 'anthropic',
          model: 'github-copilot/claude-opus-4.6',
        }),
      ),
    ).toBe('claude-opus-4-6');
  });

  it('passes through unknown model names unchanged', () => {
    expect(getAgentModelName(makeAgent({ model: 'anthropic/some-future-model' }))).toBe('some-future-model');
  });

  it('extracts model from agent config', () => {
    expect(getAgentModelName(makeAgent({ model: 'github-copilot/gpt-5.3' }))).toBe('gpt-5.3');
  });
});

describe('getAgentProvider', () => {
  it('extracts provider from agent config', () => {
    expect(getAgentProvider(makeAgent({ model: 'github-copilot/gpt-5.3' }))).toBe('github-copilot');
  });
});

// ─── buildProviderMounts ───────────────────────────────────────────────────────────────────────────
//
// Plugin mounts must be emitted for both CC and GHC providers (regression
// guard for the bug where `if (!agentIsGHC) return []` silently skipped CC
// sandbox plugin mounts, leaving NANOCLAW_PLUGIN_DIRS pointing at non-existent
// container paths).

describe('buildProviderMounts', () => {
  // Defer import + fs + path so we can isolate env per test
  it('mounts mcp.json for both CC and GHC sandbox', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const pathMod = await import('node:path');
    const { buildProviderMounts } = await import('./config-extensions.js');
    const { setWorkspace } = await import('./workspace.js');

    const tmpRoot = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'nc-mcp-mount-'));
    const wsDir = pathMod.join(tmpRoot, 'workspace');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(
      pathMod.join(wsDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { remote1: { url: 'https://x' } } }),
    );

    const origWs = process.env.NANOCLAW_WORKSPACE;
    process.env.NANOCLAW_WORKSPACE = wsDir;
    setWorkspace(wsDir);

    try {
      const mounts = buildProviderMounts(undefined);
      const mcpMount = mounts.find((m) => m.containerPath === '/workspace/mcp.json');
      expect(mcpMount).toBeDefined();
      expect(mcpMount?.readonly).toBe(true);
    } finally {
      if (origWs === undefined) delete process.env.NANOCLAW_WORKSPACE;
      else process.env.NANOCLAW_WORKSPACE = origWs;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('mounts plugins for both CC and GHC providers', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const pathMod = await import('node:path');
    const { buildProviderMounts } = await import('./config-extensions.js');
    const { setWorkspace } = await import('./workspace.js');

    const tmpRoot = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'nanoclaw-mounts-'));
    const wsDir = pathMod.join(tmpRoot, 'ws');
    const homeDir = pathMod.join(tmpRoot, 'home');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });

    // Set up plugin in workspace plugins/ so it has a plugin.json
    const wsPluginDir = pathMod.join(wsDir, 'plugins', 'ws-plugin');
    fs.mkdirSync(wsPluginDir, { recursive: true });
    fs.writeFileSync(pathMod.join(wsPluginDir, 'plugin.json'), JSON.stringify({ name: 'ws-plugin', version: '1.0.0' }));

    // Set up plugin in ~/.copilot/plugins/ (.claude-plugin layout)
    const cpPluginDir = pathMod.join(homeDir, '.copilot', 'plugins', 'cp-plugin');
    fs.mkdirSync(pathMod.join(cpPluginDir, '.claude-plugin'), {
      recursive: true,
    });
    fs.writeFileSync(
      pathMod.join(cpPluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'cp-plugin', version: '1.0.0' }),
    );

    // Set up an empty dir without manifest — must be skipped
    fs.mkdirSync(pathMod.join(wsDir, 'plugins', 'no-manifest'), {
      recursive: true,
    });

    const origHome = process.env.HOME;
    const origWs = process.env.NANOCLAW_WORKSPACE;
    process.env.HOME = homeDir;
    process.env.NANOCLAW_WORKSPACE = wsDir;
    setWorkspace(wsDir);

    try {
      // Plugin mounts must always appear regardless of provider — the gate
      // (`if (!agentIsGHC) return [];`) was removed for plugin discovery.
      const mounts = buildProviderMounts(undefined);
      const pluginPaths = mounts
        .filter((m) => m.containerPath.startsWith('/workspace/plugins/'))
        .map((m) => m.containerPath)
        .sort();
      expect(pluginPaths).toEqual(['/workspace/plugins/cp-plugin', '/workspace/plugins/ws-plugin']);

      // Empty manifest dir must be excluded
      expect(mounts.some((m) => m.containerPath === '/workspace/plugins/no-manifest')).toBe(false);
    } finally {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      if (origWs === undefined) delete process.env.NANOCLAW_WORKSPACE;
      else process.env.NANOCLAW_WORKSPACE = origWs;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('deduplicates plugins by name across sources (workspace wins)', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const pathMod = await import('node:path');
    const { buildProviderMounts } = await import('./config-extensions.js');
    const { setWorkspace } = await import('./workspace.js');

    const tmpRoot = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'nanoclaw-mounts-dedup-'));
    const wsDir = pathMod.join(tmpRoot, 'ws');
    const homeDir = pathMod.join(tmpRoot, 'home');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });

    // Same plugin name in workspace and in ~/.claude/plugins
    for (const dir of [
      pathMod.join(wsDir, 'plugins', 'shared'),
      pathMod.join(homeDir, '.claude', 'plugins', 'shared'),
    ]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(pathMod.join(dir, 'plugin.json'), JSON.stringify({ name: 'shared', version: '1.0.0' }));
    }

    const origHome = process.env.HOME;
    const origWs = process.env.NANOCLAW_WORKSPACE;
    process.env.HOME = homeDir;
    process.env.NANOCLAW_WORKSPACE = wsDir;
    setWorkspace(wsDir);

    try {
      const mounts = buildProviderMounts(undefined);
      const sharedMounts = mounts.filter((m) => m.containerPath === '/workspace/plugins/shared');
      expect(sharedMounts).toHaveLength(1);
      // Workspace source wins
      expect(sharedMounts[0].hostPath).toBe(pathMod.join(wsDir, 'plugins', 'shared'));
    } finally {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      if (origWs === undefined) delete process.env.NANOCLAW_WORKSPACE;
      else process.env.NANOCLAW_WORKSPACE = origWs;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

// ─── resolveAgentForChat: Teams jid parsing regression ──────────────────────
//
// Teams user/thread ids contain ':' (e.g. '29:abc-def', '19:xxx@thread.v2').
// A previous implementation split chatJid on ':' and treated a 3+ segment
// jid as `<channel>:<accountKey>:<peerId>`, which mis-attributed the Teams
// id's leading prefix (e.g. '29') to `accountId`. Bindings keyed on the
// real peer id (e.g. '29:abc-def') therefore never matched, and every
// inbound Teams message fell through to the default agent.
//
// Fix: always treat first segment as channel, rest as peerId. accountId is
// undefined until v2-multi-account routing lands (see TODO in src/router.ts).

describe('resolveAgentForChat — Teams jid parse regression', () => {
  it('binds to a Teams peer whose raw id contains a colon (29:abc-def)', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const pathMod = await import('node:path');
    const { setWorkspace } = await import('./workspace.js');

    const tmpRoot = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'nc-teams-jid-'));
    const wsDir = pathMod.join(tmpRoot, 'workspace');
    fs.mkdirSync(wsDir, { recursive: true });

    const cfg = {
      agents: {
        defaults: { name: 'Default', model: 'anthropic/x', triggerWord: '@d', hasOwnNumber: false, mode: 'host' },
        list: [
          {
            id: 'default-agent',
            name: 'Default',
            model: 'anthropic/x',
            triggerWord: '@d',
            hasOwnNumber: false,
            mode: 'host',
          },
          {
            id: 'teams-agent',
            name: 'Teams',
            model: 'anthropic/x',
            triggerWord: '@t',
            hasOwnNumber: false,
            mode: 'host',
          },
        ],
      },
      bindings: [
        // Binding keyed on the *full* Teams peer id (with embedded colon).
        { agentId: 'teams-agent', match: { channel: 'teams', peer: { id: '29:abc-def' } } },
      ],
    };
    fs.writeFileSync(pathMod.join(wsDir, 'nanoclaw.json'), JSON.stringify(cfg));

    const origWs = process.env.NANOCLAW_WORKSPACE;
    process.env.NANOCLAW_WORKSPACE = wsDir;
    setWorkspace(wsDir);
    try {
      const agent = resolveAgentForChat('teams:29:abc-def');
      // Pre-fix this would return 'default-agent' because accountId='29',
      // peerId='abc-def' fails to match the binding keyed on '29:abc-def'.
      expect(agent.name).toBe('Teams');
    } finally {
      if (origWs === undefined) delete process.env.NANOCLAW_WORKSPACE;
      else process.env.NANOCLAW_WORKSPACE = origWs;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

// ─── isCopilotAuthenticated snap-awareness (2026-05-17 fix) ─────────────────
describe('isCopilotAuthenticated snap detection', () => {
  beforeEach(() => execSyncMock.mockReset());
  afterEach(() => execSyncMock.mockReset());

  it('returns true when `command -v copilot` resolves under /snap/', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('command -v copilot')) return '/snap/bin/copilot\n';
      throw new Error('should not reach subcommand probe');
    });
    expect(isCopilotAuthenticated()).toBe(true);
  });

  it('falls back to subcommand probe for non-snap installs', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('command -v copilot')) return '/home/x/.npm-global/bin/copilot\n';
      if (cmd === 'copilot auth whoami') return 'Logged in as user@example.com\n';
      throw new Error('not reached');
    });
    expect(isCopilotAuthenticated()).toBe(true);
  });

  it('returns false when binary present but all subcommands fail', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('command -v copilot')) return '/home/x/.npm-global/bin/copilot\n';
      throw new Error('command failed');
    });
    expect(isCopilotAuthenticated()).toBe(false);
  });

  it('returns false when `command -v copilot` itself throws and probes fail', () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('command unavailable');
    });
    expect(isCopilotAuthenticated()).toBe(false);
  });
});
