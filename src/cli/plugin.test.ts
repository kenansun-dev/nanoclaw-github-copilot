/**
 * Unit tests for the plugin install spec parser. Pure-function — no I/O.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { setWorkspace, ensureWorkspace } from '../workspace.js';
import {
  parseInstallSpec,
  catalogEntryToSpec,
  ensureEnabledPluginsInstalled,
  resolvePluginMcpServers,
  type MarketplaceCatalogEntry,
  type PluginManifest,
} from './plugin.js';
import { saveConfig, loadConfig } from '../config-loader.js';

describe('parseInstallSpec', () => {
  describe('local paths', () => {
    it('parses ./relative paths', () => {
      expect(parseInstallSpec('./my-plugin')).toEqual({
        kind: 'local',
        path: './my-plugin',
      });
    });
    it('parses ../parent paths', () => {
      expect(parseInstallSpec('../sibling')).toEqual({
        kind: 'local',
        path: '../sibling',
      });
    });
    it('parses /absolute paths', () => {
      expect(parseInstallSpec('/opt/plugins/foo')).toEqual({
        kind: 'local',
        path: '/opt/plugins/foo',
      });
    });
    it('parses ~/home paths', () => {
      expect(parseInstallSpec('~/.plugins/foo')).toEqual({
        kind: 'local',
        path: '~/.plugins/foo',
      });
    });
    it('parses Windows drive paths', () => {
      expect(parseInstallSpec('C:\\plugins\\foo')).toEqual({
        kind: 'local',
        path: 'C:\\plugins\\foo',
      });
      expect(parseInstallSpec('D:/plugins/foo')).toEqual({
        kind: 'local',
        path: 'D:/plugins/foo',
      });
    });
  });

  describe('git URLs', () => {
    it('parses https URLs', () => {
      expect(parseInstallSpec('https://github.com/o/r.git')).toEqual({
        kind: 'git',
        url: 'https://github.com/o/r.git',
      });
    });
    it('parses http URLs', () => {
      expect(parseInstallSpec('http://gitea.local/o/r.git')).toEqual({
        kind: 'git',
        url: 'http://gitea.local/o/r.git',
      });
    });
    it('parses ssh URLs', () => {
      expect(parseInstallSpec('git@github.com:o/r.git')).toEqual({
        kind: 'git',
        url: 'git@github.com:o/r.git',
      });
    });
    it('parses URLs without .git extension if scheme present', () => {
      expect(parseInstallSpec('https://gitlab.com/o/r')).toEqual({
        kind: 'git',
        url: 'https://gitlab.com/o/r',
      });
    });
  });

  describe('owner/repo shorthand', () => {
    it('expands to https://github.com/owner/repo.git', () => {
      expect(parseInstallSpec('microsoft/work-iq')).toEqual({
        kind: 'git',
        url: 'https://github.com/microsoft/work-iq.git',
      });
    });
    it('parses owner/repo:subdir form', () => {
      expect(parseInstallSpec('microsoft/work-iq:plugins/workiq')).toEqual({
        kind: 'git',
        url: 'https://github.com/microsoft/work-iq.git',
        subdir: 'plugins/workiq',
      });
    });
    it('handles dashes and dots in owner/repo names', () => {
      expect(parseInstallSpec('my-org/my.repo-name')).toEqual({
        kind: 'git',
        url: 'https://github.com/my-org/my.repo-name.git',
      });
    });
  });

  describe('marketplace specs', () => {
    it('parses plugin@marketplace', () => {
      expect(parseInstallSpec('workiq@copilot-plugins')).toEqual({
        kind: 'marketplace',
        plugin: 'workiq',
        marketplace: 'copilot-plugins',
      });
    });
    it('does NOT match owner/repo:subdir as marketplace (no @)', () => {
      const res = parseInstallSpec('owner/repo:sub');
      expect(res.kind).toBe('git');
    });
    it('does NOT match git@host:path/to.git as marketplace', () => {
      const res = parseInstallSpec('git@github.com:o/r.git');
      expect(res.kind).toBe('git');
    });
  });

  describe('rejection', () => {
    it('throws on empty input', () => {
      expect(() => parseInstallSpec('   ')).toThrow();
    });
    it('throws on garbage', () => {
      expect(() => parseInstallSpec('not a real spec')).toThrow();
    });
    it('throws on bare names without owner', () => {
      expect(() => parseInstallSpec('justaname')).toThrow();
    });
  });
});

describe('catalogEntryToSpec', () => {
  it('passes string source through parseInstallSpec', () => {
    const entry: MarketplaceCatalogEntry = {
      name: 'workiq',
      source: 'microsoft/work-iq',
    };
    expect(catalogEntryToSpec(entry)).toEqual({
      kind: 'git',
      url: 'https://github.com/microsoft/work-iq.git',
    });
  });

  it('handles CC-style source object with repo', () => {
    const entry: MarketplaceCatalogEntry = {
      name: 'foo',
      source: { source: 'github', repo: 'owner/repo', path: 'plugins/foo' },
    };
    expect(catalogEntryToSpec(entry)).toEqual({
      kind: 'git',
      url: 'https://github.com/owner/repo.git',
      subdir: 'plugins/foo',
      ref: undefined,
    });
  });

  it('handles raw url object', () => {
    const entry: MarketplaceCatalogEntry = {
      name: 'foo',
      source: { url: 'https://gitlab.com/o/r.git', ref: 'v1' },
    };
    expect(catalogEntryToSpec(entry)).toEqual({
      kind: 'git',
      url: 'https://gitlab.com/o/r.git',
      subdir: undefined,
      ref: 'v1',
    });
  });

  it('handles local source object', () => {
    const entry: MarketplaceCatalogEntry = {
      name: 'foo',
      source: { source: 'local', path: '/opt/plugins/foo' },
    };
    expect(catalogEntryToSpec(entry)).toEqual({
      kind: 'local',
      path: '/opt/plugins/foo',
    });
  });

  it('throws on empty source object', () => {
    const entry: MarketplaceCatalogEntry = {
      name: 'foo',
      source: {},
    };
    expect(() => catalogEntryToSpec(entry)).toThrow();
  });

  it('resolves relative string source vs marketplace dir (work-iq style)', () => {
    const entry: MarketplaceCatalogEntry = {
      name: 'workiq',
      source: './plugins/workiq',
    };
    expect(catalogEntryToSpec(entry, '/cache/marketplaces/work-iq')).toEqual({
      kind: 'local',
      path: '/cache/marketplaces/work-iq/plugins/workiq',
    });
  });

  it('does not rebase absolute string source', () => {
    const entry: MarketplaceCatalogEntry = {
      name: 'foo',
      source: 'microsoft/work-iq',
    };
    expect(catalogEntryToSpec(entry, '/cache/x')).toEqual({
      kind: 'git',
      url: 'https://github.com/microsoft/work-iq.git',
    });
  });

  it('resolves relative local-object path vs marketplace dir', () => {
    const entry: MarketplaceCatalogEntry = {
      name: 'foo',
      source: { source: 'local', path: './plugins/foo' },
    };
    expect(catalogEntryToSpec(entry, '/cache/m')).toEqual({
      kind: 'local',
      path: '/cache/m/plugins/foo',
    });
  });
});

describe('ensureEnabledPluginsInstalled', () => {
  const tmpDir = path.join(
    os.tmpdir(),
    `nanoclaw-test-pluginauto-${Date.now()}`,
  );

  beforeEach(() => {
    setWorkspace(tmpDir);
    ensureWorkspace();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty result when no plugins.enabled[]', async () => {
    const config = loadConfig();
    config.plugins = { enabled: [], marketplaces: [], directories: [] };
    saveConfig(config);
    const result = await ensureEnabledPluginsInstalled();
    expect(result).toEqual({ installed: [], skipped: [], failed: [] });
  });

  it('skips plugins whose target directory already exists', async () => {
    // Pre-create the target dir so install is treated as already-done.
    fs.mkdirSync(path.join(tmpDir, 'plugins', 'workiq'), { recursive: true });
    const config = loadConfig();
    config.plugins = {
      enabled: [{ name: 'workiq', source: 'microsoft/work-iq' }],
      marketplaces: [],
      directories: [],
    };
    saveConfig(config);
    const result = await ensureEnabledPluginsInstalled();
    expect(result.skipped).toEqual(['workiq']);
    expect(result.installed).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it('skips plugins explicitly marked autoInstall:false', async () => {
    const config = loadConfig();
    config.plugins = {
      enabled: [
        { name: 'workiq', source: 'microsoft/work-iq', autoInstall: false },
      ],
      marketplaces: [],
      directories: [],
    };
    saveConfig(config);
    const result = await ensureEnabledPluginsInstalled();
    expect(result.skipped).toEqual(['workiq']);
    expect(result.installed).toEqual([]);
  });

  it('reports failures from invalid specs without throwing', async () => {
    const config = loadConfig();
    config.plugins = {
      enabled: [{ name: 'broken', source: 'this is not a valid spec' }],
      marketplaces: [],
      directories: [],
    };
    saveConfig(config);
    const result = await ensureEnabledPluginsInstalled();
    // installPlugin catches parse errors and prints; target dir is never
    // created, so we record a `failed` entry.
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].name).toBe('broken');
  });

  it('installs from a local directory source', async () => {
    // Create a tiny local plugin source on disk.
    const srcRoot = path.join(tmpDir, 'src-plugin');
    fs.mkdirSync(srcRoot, { recursive: true });
    fs.writeFileSync(
      path.join(srcRoot, 'plugin.json'),
      JSON.stringify({
        name: 'localfoo',
        version: '0.0.1',
        description: 'local test plugin',
      }),
    );
    const config = loadConfig();
    config.plugins = {
      enabled: [{ name: 'localfoo', source: srcRoot }],
      marketplaces: [],
      directories: [],
    };
    saveConfig(config);
    const result = await ensureEnabledPluginsInstalled();
    expect(result.installed).toEqual(['localfoo']);
    expect(result.failed).toEqual([]);
    expect(
      fs.existsSync(path.join(tmpDir, 'plugins', 'localfoo', 'plugin.json')),
    ).toBe(true);
  });
});

describe('resolvePluginMcpServers', () => {
  const tmpDir = path.join(
    os.tmpdir(),
    `nanoclaw-test-mcpresolver-${Date.now()}`,
  );

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when manifest has no mcpServers field', () => {
    const manifest: PluginManifest = { name: 'p1' };
    expect(resolvePluginMcpServers(tmpDir, manifest)).toBeNull();
  });

  it('passes through inline-object form (CC/GHC standard)', () => {
    const manifest: PluginManifest = {
      name: 'p2',
      mcpServers: {
        foo: { command: 'node', args: ['foo.js'] },
        bar: { url: 'https://example.com/mcp' },
      },
    };
    const result = resolvePluginMcpServers(tmpDir, manifest);
    expect(result).toEqual({
      foo: { command: 'node', args: ['foo.js'] },
      bar: { url: 'https://example.com/mcp' },
    });
  });

  it('reads path-string form pointing to bare server map', () => {
    const mcpFile = path.join(tmpDir, 'mcp.json');
    fs.writeFileSync(
      mcpFile,
      JSON.stringify({
        foo: { command: 'python', args: ['-m', 'foo'] },
      }),
    );
    const manifest: PluginManifest = { name: 'p3', mcpServers: 'mcp.json' };
    const result = resolvePluginMcpServers(tmpDir, manifest);
    expect(result).toEqual({
      foo: { command: 'python', args: ['-m', 'foo'] },
    });
  });

  it('reads path-string form with `mcpServers` wrapper', () => {
    const mcpFile = path.join(tmpDir, 'wrapped.json');
    fs.writeFileSync(
      mcpFile,
      JSON.stringify({
        mcpServers: { foo: { command: 'cat' } },
      }),
    );
    const manifest: PluginManifest = {
      name: 'p4',
      mcpServers: 'wrapped.json',
    };
    expect(resolvePluginMcpServers(tmpDir, manifest)).toEqual({
      foo: { command: 'cat' },
    });
  });

  it('reads path-string form with `servers` wrapper', () => {
    const mcpFile = path.join(tmpDir, 'servers.json');
    fs.writeFileSync(
      mcpFile,
      JSON.stringify({ servers: { bar: { command: 'echo' } } }),
    );
    const manifest: PluginManifest = {
      name: 'p5',
      mcpServers: 'servers.json',
    };
    expect(resolvePluginMcpServers(tmpDir, manifest)).toEqual({
      bar: { command: 'echo' },
    });
  });

  it('returns null when path-string points to missing file', () => {
    const manifest: PluginManifest = {
      name: 'p6',
      mcpServers: 'nope.json',
    };
    expect(resolvePluginMcpServers(tmpDir, manifest)).toBeNull();
  });

  it('returns null when path-string points to malformed JSON', () => {
    const mcpFile = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(mcpFile, '{not json');
    const manifest: PluginManifest = { name: 'p7', mcpServers: 'bad.json' };
    expect(resolvePluginMcpServers(tmpDir, manifest)).toBeNull();
  });

  it('preserves provider-specific server fields verbatim', () => {
    // Round-trips arbitrary MCP server config keys (env, transport, headers,
    // cwd, etc.) so we never silently drop fields.
    const manifest: PluginManifest = {
      name: 'p8',
      mcpServers: {
        complex: {
          command: 'node',
          args: ['srv.js'],
          env: { TOKEN: 'x' },
          transport: 'stdio',
          cwd: '/tmp',
          headers: { authorization: 'bearer y' },
        },
      },
    };
    expect(resolvePluginMcpServers(tmpDir, manifest)).toEqual(
      manifest.mcpServers,
    );
  });
});
