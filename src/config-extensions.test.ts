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

// ─── buildProviderMounts ───────────────────────────────────────────────────────────────────────────
//
// Plugin mounts must be emitted for both CC and GHC providers (regression
// guard for the bug where `if (!agentIsGHC) return []` silently skipped CC
// sandbox plugin mounts, leaving NANOCLAW_PLUGIN_DIRS pointing at non-existent
// container paths).

describe('buildProviderMounts', () => {
  // Defer import + fs + path so we can isolate env per test
  it('mounts plugins for both CC and GHC providers', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const pathMod = await import('node:path');
    const { buildProviderMounts } = await import('./config-extensions.js');
    const { setWorkspace } = await import('./workspace.js');

    const tmpRoot = fs.mkdtempSync(
      pathMod.join(os.tmpdir(), 'nanoclaw-mounts-'),
    );
    const wsDir = pathMod.join(tmpRoot, 'ws');
    const homeDir = pathMod.join(tmpRoot, 'home');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });

    // Set up plugin in workspace plugins/ so it has a plugin.json
    const wsPluginDir = pathMod.join(wsDir, 'plugins', 'ws-plugin');
    fs.mkdirSync(wsPluginDir, { recursive: true });
    fs.writeFileSync(
      pathMod.join(wsPluginDir, 'plugin.json'),
      JSON.stringify({ name: 'ws-plugin', version: '1.0.0' }),
    );

    // Set up plugin in ~/.copilot/plugins/ (.claude-plugin layout)
    const cpPluginDir = pathMod.join(homeDir, '.copilot', 'plugins', 'cp-plugin');
    fs.mkdirSync(pathMod.join(cpPluginDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      pathMod.join(cpPluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'cp-plugin', version: '1.0.0' }),
    );

    // Set up an empty dir without manifest — must be skipped
    fs.mkdirSync(pathMod.join(wsDir, 'plugins', 'no-manifest'), { recursive: true });

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
      expect(pluginPaths).toEqual([
        '/workspace/plugins/cp-plugin',
        '/workspace/plugins/ws-plugin',
      ]);

      // Empty manifest dir must be excluded
      expect(
        mounts.some((m) => m.containerPath === '/workspace/plugins/no-manifest'),
      ).toBe(false);
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

    const tmpRoot = fs.mkdtempSync(
      pathMod.join(os.tmpdir(), 'nanoclaw-mounts-dedup-'),
    );
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
      fs.writeFileSync(
        pathMod.join(dir, 'plugin.json'),
        JSON.stringify({ name: 'shared', version: '1.0.0' }),
      );
    }

    const origHome = process.env.HOME;
    const origWs = process.env.NANOCLAW_WORKSPACE;
    process.env.HOME = homeDir;
    process.env.NANOCLAW_WORKSPACE = wsDir;
    setWorkspace(wsDir);

    try {
      const mounts = buildProviderMounts(undefined);
      const sharedMounts = mounts.filter(
        (m) => m.containerPath === '/workspace/plugins/shared',
      );
      expect(sharedMounts).toHaveLength(1);
      // Workspace source wins
      expect(sharedMounts[0].hostPath).toBe(
        pathMod.join(wsDir, 'plugins', 'shared'),
      );
    } finally {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      if (origWs === undefined) delete process.env.NANOCLAW_WORKSPACE;
      else process.env.NANOCLAW_WORKSPACE = origWs;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
