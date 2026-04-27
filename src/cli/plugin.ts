/**
 * nanoclaw plugin — install, remove, and manage plugins.
 *
 * Plugin format (compatible with GHC plugin.json + CC AgentSkills):
 *   ~/.nanoclaw/plugins/<name>/
 *     ├── plugin.json         ← manifest (name, version, skills, mcpServers, provider)
 *     │   (also accepts CC-style `.claude-plugin/plugin.json`)
 *     ├── skills/             ← SKILL.md files (AgentSkills format)
 *     │   └── <skill-name>/
 *     │       └── SKILL.md
 *     └── .mcp.json           ← MCP server config (optional)
 *
 * Install spec formats (mirrors `copilot plugin install`):
 *   ./local/path                  — local directory
 *   /abs/path                     — local directory
 *   https://github.com/o/r.git    — raw git URL
 *   git@github.com:o/r.git        — ssh git URL
 *   owner/repo                    — https://github.com/owner/repo
 *   owner/repo:path/to/sub        — subdirectory inside a repo
 *   plugin@marketplace            — fetch via a registered marketplace
 *
 * Commands:
 *   nanoclaw plugin list                       — list installed plugins
 *   nanoclaw plugin install <spec>             — install a plugin
 *   nanoclaw plugin remove <name>              — remove a plugin
 *   nanoclaw plugin info <name>                — show plugin details
 *   nanoclaw plugin marketplace add <spec>     — register a marketplace
 *   nanoclaw plugin marketplace list           — list registered marketplaces
 *   nanoclaw plugin marketplace browse <name>  — list plugins in a marketplace
 *   nanoclaw plugin marketplace remove <name>  — unregister a marketplace
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { resolveWorkspace } from '../workspace.js';
import {
  loadConfig,
  saveConfig,
  getEnabledPlugins,
  getExtraKnownMarketplaces,
  setExtraKnownMarketplaces,
} from '../config-loader.js';
import { logger } from '../logger.js';

/**
 * Shape of a single MCP server entry inside a plugin manifest. Mirrors the
 * CC plugin spec — keys are passed straight through to the agent runtime, so
 * any provider-specific fields (e.g. `command`, `args`, `env`, `url`,
 * `transport`) are preserved as-is.
 */
export type McpServerConfig = Record<string, unknown>;

export interface PluginManifest {
  name: string;
  description?: string;
  version?: string;
  author?: string | { name: string; email?: string };
  license?: string;
  keywords?: string[];
  /** Path to skills directory (relative to plugin root) */
  skills?: string | string[];
  /**
   * MCP server configuration. Two accepted shapes for compatibility with
   * both the CC/GHC plugin spec and nanoclaw's older path-based form:
   *  - **inline object** (CC/GHC standard): `{ "<name>": { command, args, ... } }`
   *  - **path string** (legacy nanoclaw): relative path to a JSON file inside
   *    the plugin root containing either `{ mcpServers: {...} }` or a bare
   *    server map.
   */
  mcpServers?: string | Record<string, McpServerConfig>;
  /** Path to agents directory (optional, GHC only) */
  agents?: string;
  /** Path to hooks file (optional, GHC only) */
  hooks?: string;
  /** Provider compatibility: 'both' | 'ghc' | 'cc' */
  provider?: 'both' | 'ghc' | 'cc';
}

function pluginsDir(): string {
  return path.join(resolveWorkspace(), 'plugins');
}

/**
 * Cached marketplaces directory — holds shallow git clones of registered
 * marketplace catalogs (`<workspace>/.cache/marketplaces/<name>/`).
 */
function marketplaceCacheDir(): string {
  return path.join(resolveWorkspace(), '.cache', 'marketplaces');
}

// ─── Install spec parser ────────────────────────────────────────

export type InstallSpec =
  | { kind: 'local'; path: string }
  | { kind: 'git'; url: string; subdir?: string; ref?: string }
  | { kind: 'marketplace'; plugin: string; marketplace: string };

/**
 * Parse a plugin install spec into a normalized form. Pure (no I/O) so it
 * can be unit-tested. Spec formats mirror `copilot plugin install`:
 *   ./foo, /abs/foo               → local
 *   https://..., git@..., *.git   → git URL
 *   owner/repo                    → https://github.com/owner/repo
 *   owner/repo:sub/dir            → git URL + subdir
 *   plugin@marketplace            → marketplace lookup
 */
export function parseInstallSpec(spec: string): InstallSpec {
  const trimmed = spec.trim();
  if (!trimmed) throw new Error('Empty install spec');

  // Local path: starts with ./, ../, /, ~, or letter+colon (Windows drive).
  if (
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('~') ||
    /^[a-zA-Z]:[\\/]/.test(trimmed)
  ) {
    return { kind: 'local', path: trimmed };
  }

  // Explicit git URL (http(s), git+, ssh, ends with .git).
  if (
    /^(https?|git|ssh):\/\//.test(trimmed) ||
    trimmed.startsWith('git@') ||
    trimmed.endsWith('.git')
  ) {
    return { kind: 'git', url: trimmed };
  }

  // plugin@marketplace — the @ must NOT be the first character (would be
  // a scoped-npm-package-style spec, which we don't support here) and the
  // marketplace side must look like a kebab-case name.
  const atIdx = trimmed.indexOf('@');
  if (atIdx > 0 && atIdx < trimmed.length - 1) {
    const plugin = trimmed.slice(0, atIdx);
    const marketplace = trimmed.slice(atIdx + 1);
    if (
      /^[a-z0-9][a-z0-9_-]*$/i.test(plugin) &&
      /^[a-z0-9][a-z0-9_-]*$/i.test(marketplace)
    ) {
      return { kind: 'marketplace', plugin, marketplace };
    }
    // Helpful error: user typed `plugin@owner/repo` (kenan repro 2026-04-27
    // — wrote `workiq@microsoft/work-iq` which silently fell through into
    // the owner/repo branch and produced `https://github.com/workiq@microsoft/work-iq.git`).
    // Detect the slash-in-marketplace case explicitly and surface the
    // suggested fix.
    if (
      /^[a-z0-9][a-z0-9_-]*$/i.test(plugin) &&
      marketplace.includes('/')
    ) {
      throw new Error(
        `Invalid install spec: ${spec}\n` +
          `Marketplace name '${marketplace}' looks like an owner/repo path. ` +
          `Marketplaces are referenced by their registered name, not their source.\n` +
          `Did you mean one of:\n` +
          `  1. nanoclaw plugin marketplace add <name> ${marketplace}\n` +
          `     nanoclaw plugin install ${plugin}@<name>\n` +
          `  2. nanoclaw plugin install ${marketplace}   # install repo directly`,
      );
    }
  }

  // owner/repo or owner/repo:subdir — GitHub shorthand.
  const slashCount = (trimmed.match(/\//g) || []).length;
  if (slashCount === 1 || (slashCount === 2 && trimmed.includes(':'))) {
    let url: string;
    let subdir: string | undefined;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      const repoPart = trimmed.slice(0, colonIdx);
      subdir = trimmed.slice(colonIdx + 1);
      url = `https://github.com/${repoPart}.git`;
    } else {
      url = `https://github.com/${trimmed}.git`;
    }
    return { kind: 'git', url, subdir };
  }

  throw new Error(
    `Unrecognized install spec: ${spec}\n` +
      `Expected: ./path, /abs/path, owner/repo, owner/repo:subdir, ` +
      `https://..., or plugin@marketplace`,
  );
}

// ─── Marketplace catalog (CC + GHC compatible) ──────────────────────

/**
 * Both CC and GHC use `.claude-plugin/marketplace.json` as the catalog
 * format. Top-level shape:
 *   { name, owner, plugins: [{ name, source, ... }] }
 * `source` for each plugin can itself be a string in any of our InstallSpec
 * formats, or an object: { source: 'github', repo: 'o/r', path?, ref? }.
 */
export interface MarketplaceCatalog {
  name: string;
  owner?: { name?: string; email?: string; url?: string };
  description?: string;
  plugins: MarketplaceCatalogEntry[];
}

export interface MarketplaceCatalogEntry {
  name: string;
  description?: string;
  /** Either a string spec (`owner/repo:path`) or a CC-style source object. */
  source: string | MarketplaceCatalogSource;
  version?: string;
}

export interface MarketplaceCatalogSource {
  source?: 'github' | 'git' | 'local';
  repo?: string;
  url?: string;
  path?: string;
  ref?: string;
}

/**
 * Normalize a marketplace catalog entry's `source` field into an InstallSpec.
 * String form is parsed via parseInstallSpec; object form is converted into
 * either git or local kind.
 */
export function catalogEntryToSpec(
  entry: MarketplaceCatalogEntry,
  marketplaceDir?: string,
): InstallSpec {
  // Local-path detection: if marketplaceDir is provided and the source string
  // looks like a relative path (./foo, ../foo), resolve it against the
  // marketplace's cloned dir rather than cwd. This matches CC/GHC marketplace
  // semantics where catalog entries reference plugins inside the same repo.
  if (typeof entry.source === 'string') {
    const s = entry.source.trim();
    const isRelLocal =
      s.startsWith('./') || s.startsWith('../') || s === '.' || s === '..';
    if (isRelLocal && marketplaceDir) {
      return { kind: 'local', path: path.resolve(marketplaceDir, s) };
    }
    return parseInstallSpec(s);
  }
  const src = entry.source;
  if (src.source === 'local' && src.path) {
    const p = src.path;
    const isAbs = path.isAbsolute(p) || p.startsWith('~');
    return {
      kind: 'local',
      path: isAbs || !marketplaceDir ? p : path.resolve(marketplaceDir, p),
    };
  }
  if (src.url) {
    return { kind: 'git', url: src.url, subdir: src.path, ref: src.ref };
  }
  if (src.repo) {
    return {
      kind: 'git',
      url: `https://github.com/${src.repo}.git`,
      subdir: src.path,
      ref: src.ref,
    };
  }
  throw new Error(
    `Marketplace entry '${entry.name}' has unrecognized source object`,
  );
}

/**
 * Ensure a marketplace catalog is cloned to the local cache, then read it.
 * Marketplace `source` itself is parsed as an InstallSpec (so `owner/repo`
 * shorthand works). For local sources, no cloning happens.
 */
function fetchMarketplaceCatalogWithDir(
  name: string,
  source: string,
): { catalog: MarketplaceCatalog; resolvedDir: string } {
  const cacheRoot = marketplaceCacheDir();
  fs.mkdirSync(cacheRoot, { recursive: true });
  const cacheDir = path.join(cacheRoot, name);

  let resolvedDir: string;
  const spec = parseInstallSpec(source);
  if (spec.kind === 'local') {
    resolvedDir = path.resolve(spec.path);
  } else if (spec.kind === 'git') {
    if (!fs.existsSync(cacheDir)) {
      execSync(`git clone --depth 1 "${spec.url}" "${cacheDir}"`, {
        stdio: 'pipe',
        timeout: 60000,
      });
    }
    resolvedDir = spec.subdir ? path.join(cacheDir, spec.subdir) : cacheDir;
  } else {
    throw new Error(
      `Marketplace source must be a git URL, owner/repo, or local path (got ${spec.kind})`,
    );
  }

  // Catalog lives at .claude-plugin/marketplace.json (CC + GHC convention)
  // OR at marketplace.json at repo root (legacy / minimal).
  const ccPath = path.join(resolvedDir, '.claude-plugin', 'marketplace.json');
  const rootPath = path.join(resolvedDir, 'marketplace.json');
  const catalogPath = fs.existsSync(ccPath)
    ? ccPath
    : fs.existsSync(rootPath)
      ? rootPath
      : null;
  if (!catalogPath) {
    throw new Error(
      `No marketplace.json found for '${name}' at ${resolvedDir}`,
    );
  }
  return {
    catalog: JSON.parse(fs.readFileSync(catalogPath, 'utf-8')),
    resolvedDir,
  };
}

function fetchMarketplaceCatalog(
  name: string,
  source: string,
): MarketplaceCatalog {
  return fetchMarketplaceCatalogWithDir(name, source).catalog;
}

/**
 * Look up a plugin by name in a registered marketplace and return its
 * normalized install spec. Throws if either marketplace or plugin is missing.
 */
function resolveMarketplacePlugin(
  pluginName: string,
  marketplaceName: string,
): { spec: InstallSpec; entry: MarketplaceCatalogEntry } {
  const config = loadConfig();
  const mp = getExtraKnownMarketplaces(config).find(
    (m) => m.name === marketplaceName,
  );
  if (!mp) {
    throw new Error(
      `Marketplace '${marketplaceName}' not registered. Run \`nanoclaw plugin marketplace list\`.`,
    );
  }
  const { catalog, resolvedDir } = fetchMarketplaceCatalogWithDir(
    mp.name,
    mp.source,
  );
  const entry = catalog.plugins?.find((p) => p.name === pluginName);
  if (!entry) {
    throw new Error(
      `Plugin '${pluginName}' not found in marketplace '${marketplaceName}'`,
    );
  }
  return { spec: catalogEntryToSpec(entry, resolvedDir), entry };
}

/**
 * Synthesize a `PluginManifest` from a marketplace catalog entry. CC
 * marketplaces frequently inline plugin metadata (name, version,
 * description, skills, mcpServers) directly into `marketplace.json`
 * entries rather than shipping a separate `plugin.json`. We treat the
 * catalog entry as authoritative when no on-disk manifest exists.
 */
export function synthesizeManifestFromCatalogEntry(
  entry: MarketplaceCatalogEntry,
): PluginManifest {
  const e = entry as MarketplaceCatalogEntry & {
    skills?: string | string[];
    mcpServers?: string | Record<string, McpServerConfig>;
    agents?: string;
    hooks?: string;
    provider?: 'both' | 'ghc' | 'cc';
    author?: PluginManifest['author'];
    license?: string;
  };
  const out: PluginManifest = {
    name: e.name,
    description: e.description,
    version: e.version,
    provider: e.provider ?? 'both',
  };
  if (e.skills !== undefined) out.skills = e.skills;
  if (e.mcpServers !== undefined) out.mcpServers = e.mcpServers;
  if (e.agents !== undefined) out.agents = e.agents;
  if (e.hooks !== undefined) out.hooks = e.hooks;
  if (e.author !== undefined) out.author = e.author;
  if (e.license !== undefined) out.license = e.license;
  return out;
}

function loadManifest(pluginDir: string): PluginManifest | null {
  // Try root plugin.json first (GHC convention), then CC's .claude-plugin/plugin.json.
  const candidates = [
    path.join(pluginDir, 'plugin.json'),
    path.join(pluginDir, '.claude-plugin', 'plugin.json'),
  ];
  for (const manifestPath of candidates) {
    if (!fs.existsSync(manifestPath)) continue;
    try {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch {
      // try next candidate
    }
  }
  return null;
}

// ─── Install ─────────────────────────────────────────────────────────────────

/**
 * Resolve a plugin's MCP server map regardless of which schema shape the
 * manifest uses. Returns `null` when nothing is configured or when a path
 * was set but the file is missing/unreadable.
 *
 * Accepted shapes:
 *  - **inline object** (CC/GHC standard): `mcpServers: { foo: {...}, bar: {...} }`
 *  - **path string** (legacy nanoclaw): `mcpServers: "mcp.json"` pointing to
 *    a JSON file with either `{ mcpServers: {...} }`, `{ servers: {...} }`,
 *    or a bare `{ foo: {...} }` server map.
 *
 * Plugins authored against the upstream CC/GHC plugin spec can be installed
 * directly into nanoclaw without rewriting the manifest. The legacy path
 * shape stays supported for backward compatibility with manifests written
 * before the CC plugin spec stabilized.
 */
export function resolvePluginMcpServers(
  pluginDir: string,
  manifest: PluginManifest,
): Record<string, McpServerConfig> | null {
  const raw = manifest.mcpServers;

  if (raw && typeof raw === 'object') {
    // Inline object form (CC/GHC standard) — pass through verbatim.
    return raw as Record<string, McpServerConfig>;
  }

  if (typeof raw === 'string') {
    // Path-string form (legacy nanoclaw) — load + unwrap the file.
    const mcpPath = path.join(pluginDir, raw);
    if (fs.existsSync(mcpPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
        const servers = parsed.mcpServers || parsed.servers || parsed;
        if (servers && typeof servers === 'object') {
          return servers as Record<string, McpServerConfig>;
        }
      } catch {
        logger.warn(
          { plugin: path.basename(pluginDir), mcpPath },
          'Failed to parse plugin MCP config file',
        );
      }
    }
  }

  // Fallback: CC convention places `.mcp.json` at the plugin root with no
  // explicit reference from plugin.json. Auto-detect it so plugins authored
  // for CC work without manifest edits.
  const conventionalPath = path.join(pluginDir, '.mcp.json');
  if (fs.existsSync(conventionalPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(conventionalPath, 'utf-8'));
      const servers = parsed.mcpServers || parsed.servers || parsed;
      if (servers && typeof servers === 'object') {
        return servers as Record<string, McpServerConfig>;
      }
    } catch {
      logger.warn(
        { plugin: path.basename(pluginDir), conventionalPath },
        'Failed to parse plugin .mcp.json',
      );
    }
  }

  return null;
}

function describeSpec(s: InstallSpec): string {
  if (s.kind === 'local') return `local:${s.path}`;
  if (s.kind === 'git') return `git:${s.url}${s.subdir ? `#${s.subdir}` : ''}`;
  return `marketplace:${s.plugin}@${s.marketplace}`;
}

async function installPlugin(source: string): Promise<void> {
  const pDir = pluginsDir();
  fs.mkdirSync(pDir, { recursive: true });

  // Resolve the spec. For marketplace specs we recurse with the resolved
  // git/local spec so we hit the same code path uniformly.
  let spec: InstallSpec;
  try {
    spec = parseInstallSpec(source);
  } catch (err: any) {
    console.error(`❌ ${err.message}`);
    return;
  }
  // Catalog entry kept around so we can synthesize a plugin.json from it
  // when the source directory has no manifest of its own. CC marketplaces
  // commonly inline `name`/`version`/`description`/`skills` in the catalog
  // entry rather than shipping a per-plugin manifest.
  let catalogEntry: MarketplaceCatalogEntry | undefined;
  if (spec.kind === 'marketplace') {
    try {
      const resolved = resolveMarketplacePlugin(spec.plugin, spec.marketplace);
      spec = resolved.spec;
      catalogEntry = resolved.entry;
      console.log(
        `Resolved \`${source}\` via marketplace → ${describeSpec(spec)}`,
      );
    } catch (err: any) {
      console.error(`❌ ${err.message}`);
      return;
    }
  }

  let srcDir: string;

  if (spec.kind === 'git') {
    const tmpDir = path.join(pDir, '.tmp-install');
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
    console.log(`Cloning ${spec.url}...`);
    try {
      execSync(`git clone --depth 1 "${spec.url}" "${tmpDir}"`, {
        stdio: 'pipe',
        timeout: 60000,
      });
      srcDir = spec.subdir ? path.join(tmpDir, spec.subdir) : tmpDir;
      if (!fs.existsSync(srcDir)) {
        console.error(
          `❌ Subdirectory '${spec.subdir}' not found in cloned repo.`,
        );
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
        return;
      }
    } catch (err: any) {
      console.error(`❌ Failed to clone: ${err.message}`);
      return;
    }
  } else if (spec.kind === 'local') {
    srcDir = path.resolve(spec.path.replace(/^~(?=\/|$)/, os.homedir()));
    if (!fs.existsSync(srcDir)) {
      console.error(`❌ Path not found: ${srcDir}`);
      return;
    }
  } else {
    // Should be unreachable: marketplace was resolved above.
    console.error(`❌ Unresolved marketplace spec: ${describeSpec(spec)}`);
    return;
  }

  // Read manifest. Order:
  //   1. plugin.json at root or .claude-plugin/plugin.json (CC + GHC standard)
  //   2. catalog entry inline metadata (CC marketplaces commonly inline
  //      name/version/description/skills in marketplace.json instead of
  //      shipping a per-plugin plugin.json)
  //   3. bare SKILL.md → auto-generated single-skill manifest
  let manifest = loadManifest(srcDir);
  if (!manifest && catalogEntry) {
    manifest = synthesizeManifestFromCatalogEntry(catalogEntry);
    console.log(
      `No plugin.json found. Using marketplace catalog metadata for: ${manifest.name}`,
    );
  }
  if (!manifest) {
    // Try to treat as a bare skill directory (has SKILL.md but no plugin.json)
    const skillMd = path.join(srcDir, 'SKILL.md');
    if (fs.existsSync(skillMd)) {
      const dirName = path.basename(srcDir);
      console.log(`No plugin.json found. Installing as bare skill: ${dirName}`);
      const destDir = path.join(pDir, dirName);
      copyDirSync(srcDir, destDir);
      // Auto-generate plugin.json
      const autoManifest: PluginManifest = {
        name: dirName,
        description: `Skill: ${dirName}`,
        version: '0.0.1',
        skills: './',
        provider: 'both',
      };
      fs.writeFileSync(
        path.join(destDir, 'plugin.json'),
        JSON.stringify(autoManifest, null, 2) + '\n',
      );
      console.log(`✅ Installed skill plugin: ${dirName}`);
      syncPluginsToConfig();
      return;
    }
    console.error('❌ No plugin.json or SKILL.md found.');
    // Clean up temp clone dir
    const tmpClone = path.join(pDir, '.tmp-install');
    if (fs.existsSync(tmpClone)) fs.rmSync(tmpClone, { recursive: true });
    return;
  }

  if (!manifest.name) {
    console.error('❌ plugin.json missing "name" field.');
    const tmpClone = path.join(pDir, '.tmp-install');
    if (fs.existsSync(tmpClone)) fs.rmSync(tmpClone, { recursive: true });
    return;
  }

  // Check provider compatibility
  const config = loadConfig();
  const currentProvider = config.agents?.defaults?.provider || 'github-copilot';
  if (manifest.provider && manifest.provider !== 'both') {
    const providerMap: Record<string, string> = {
      ghc: 'github-copilot',
      cc: 'anthropic',
    };
    if (
      providerMap[manifest.provider] &&
      providerMap[manifest.provider] !== currentProvider
    ) {
      console.warn(
        `⚠️  Plugin '${manifest.name}' is designed for ${manifest.provider}, but current provider is ${currentProvider}. Installing anyway.`,
      );
    }
  }

  // Copy to plugins directory
  const destDir = path.join(pDir, manifest.name);
  if (fs.existsSync(destDir)) {
    console.log(`Updating existing plugin: ${manifest.name}`);
    fs.rmSync(destDir, { recursive: true });
  }
  copyDirSync(srcDir, destDir);

  // Clean up tmp if git clone
  const tmpDir = path.join(pDir, '.tmp-install');
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true });
  }

  console.log(
    `✅ Installed plugin: ${manifest.name}${manifest.version ? ` v${manifest.version}` : ''}`,
  );
  if (manifest.description) {
    console.log(`   ${manifest.description}`);
  }

  ensureDualManifest(path.join(pDir, manifest.name), manifest);
  syncPluginsToConfig();
}

// ─── Remove ──────────────────────────────────────────────────────────────────

function removePlugin(name: string): void {
  const dir = path.join(pluginsDir(), name);
  if (!fs.existsSync(dir)) {
    console.error(`Plugin '${name}' not found.`);
    return;
  }

  fs.rmSync(dir, { recursive: true });
  console.log(`✅ Removed plugin: ${name}`);
  syncPluginsToConfig();
}

// ─── List ────────────────────────────────────────────────────────────────────

function listPlugins(): void {
  const pDir = pluginsDir();
  if (!fs.existsSync(pDir)) {
    console.log('No plugins installed.');
    return;
  }

  const entries = fs
    .readdirSync(pDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'));

  if (entries.length === 0) {
    console.log('No plugins installed.');
    return;
  }

  console.log('\n🔌 Installed Plugins:\n');
  for (const entry of entries) {
    const manifest = loadManifest(path.join(pDir, entry.name));
    if (manifest) {
      const provider = manifest.provider || 'both';
      const ver = manifest.version ? ` v${manifest.version}` : '';
      console.log(`  📦 ${manifest.name}${ver} [${provider}]`);
      if (manifest.description) {
        console.log(`     ${manifest.description}`);
      }
      // Count skills
      const skillsDirs = Array.isArray(manifest.skills)
        ? manifest.skills
        : manifest.skills
          ? [manifest.skills]
          : [];
      let skillCount = 0;
      for (const sd of skillsDirs) {
        const fullPath = path.join(pDir, entry.name, sd);
        if (fs.existsSync(fullPath)) {
          // Count SKILL.md files
          skillCount += countSkills(fullPath);
        }
      }
      if (skillCount > 0) {
        console.log(`     Skills: ${skillCount}`);
      }
      // Check MCP — works for both inline-object and path-string shapes.
      const mcpServers = resolvePluginMcpServers(
        path.join(pDir, entry.name),
        manifest,
      );
      if (mcpServers && Object.keys(mcpServers).length > 0) {
        console.log(`     MCP: ✅ (${Object.keys(mcpServers).length})`);
      }
    } else {
      console.log(`  📦 ${entry.name} (no manifest)`);
    }
  }
  console.log('');
}

// ─── Info ────────────────────────────────────────────────────────────────────

function pluginInfo(name: string): void {
  const dir = path.join(pluginsDir(), name);
  if (!fs.existsSync(dir)) {
    console.error(`Plugin '${name}' not found.`);
    return;
  }

  const manifest = loadManifest(dir);
  if (!manifest) {
    console.log(`Plugin '${name}' has no manifest.`);
    return;
  }

  console.log(`\n📦 ${manifest.name}`);
  if (manifest.version) console.log(`   Version: ${manifest.version}`);
  if (manifest.description) console.log(`   ${manifest.description}`);
  if (manifest.author) {
    const author =
      typeof manifest.author === 'string'
        ? manifest.author
        : manifest.author.name;
    console.log(`   Author: ${author}`);
  }
  if (manifest.license) console.log(`   License: ${manifest.license}`);
  if (manifest.provider) console.log(`   Provider: ${manifest.provider}`);
  console.log(`   Path: ${dir}`);
  console.log('');
}

// ─── Sync to config ─────────────────────────────────────────────────────────

/**
 * Sync installed plugins to nanoclaw.json skills.directories and mcp.servers.
 * Called after install/remove.
 */
function syncPluginsToConfig(): void {
  const config = loadConfig();
  const pDir = pluginsDir();

  if (!fs.existsSync(pDir)) return;

  const entries = fs
    .readdirSync(pDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'));

  // Collect plugin skill directories
  const pluginSkillDirs: string[] = [];
  const pluginMcpServers: Record<string, any> = {};

  for (const entry of entries) {
    const manifest = loadManifest(path.join(pDir, entry.name));
    if (!manifest) continue;

    // Collect skills directories
    const skillsDirs = Array.isArray(manifest.skills)
      ? manifest.skills
      : manifest.skills
        ? [manifest.skills]
        : [];
    for (const sd of skillsDirs) {
      const fullPath = path.join(pDir, entry.name, sd);
      if (fs.existsSync(fullPath)) {
        // Use relative path from workspace so config is portable
        // Normalize: catalog entries often use `./skills/foo`, which produces
        // `./plugins/<n>/./skills/foo` if naively joined. posix.normalize
        // strips the redundant `./` segment so config paths stay clean.
        const rel = path.posix.normalize(`./plugins/${entry.name}/${sd}`);
        pluginSkillDirs.push(rel.startsWith('./') ? rel : `./${rel}`);
      }
    }

    // Collect MCP servers — resolver handles both inline object and path string.
    const servers = resolvePluginMcpServers(
      path.join(pDir, entry.name),
      manifest,
    );
    if (servers) {
      for (const [name, serverConfig] of Object.entries(servers)) {
        pluginMcpServers[`plugin:${entry.name}:${name}`] = serverConfig;
      }
    }
  }

  // Update skills.directories — ensure plugin dirs are included
  if (!config.skills)
    config.skills = { directories: ['./skills'], disabled: [] };
  const existingDirs = config.skills.directories || [];
  for (const dir of pluginSkillDirs) {
    if (!existingDirs.includes(dir)) {
      existingDirs.push(dir);
    }
  }
  // Remove stale plugin dirs
  config.skills.directories = existingDirs.filter((d: string) => {
    if (d.includes('/plugins/') || d.includes('./plugins/')) {
      // Resolve relative path against workspace to check existence
      const resolved = d.startsWith('./')
        ? path.join(resolveWorkspace(), d)
        : d;
      return fs.existsSync(resolved);
    }
    return true;
  });

  // Update MCP servers — add plugin servers, remove stale ones
  if (!config.mcp) config.mcp = { servers: {} };
  // Remove old plugin MCP servers
  for (const key of Object.keys(config.mcp.servers)) {
    if (key.startsWith('plugin:')) {
      delete config.mcp.servers[key];
    }
  }
  // Add current plugin MCP servers
  Object.assign(config.mcp.servers, pluginMcpServers);

  saveConfig(config);
}

// --- Dual manifest (GHC + CC compatibility) ---

/**
 * Ensure both GHC (plugin.json at root) and CC (.claude-plugin/plugin.json)
 * manifest formats exist so both providers can discover the plugin.
 */
function ensureDualManifest(pluginDir: string, manifest: PluginManifest): void {
  // GHC format: plugin.json at root (should already exist)
  const ghcManifest = path.join(pluginDir, 'plugin.json');
  if (!fs.existsSync(ghcManifest)) {
    fs.writeFileSync(ghcManifest, JSON.stringify(manifest, null, 2) + '\n');
  }

  // CC format: .claude-plugin/plugin.json
  const ccDir = path.join(pluginDir, '.claude-plugin');
  const ccManifest = path.join(ccDir, 'plugin.json');
  if (!fs.existsSync(ccManifest)) {
    fs.mkdirSync(ccDir, { recursive: true });
    const ccData: Record<string, unknown> = {
      name: manifest.name,
      description: manifest.description || `NanoClaw plugin: ${manifest.name}`,
      version: manifest.version || '0.0.1',
    };
    if (manifest.author) ccData.author = manifest.author;
    if (manifest.license) ccData.license = manifest.license;
    fs.writeFileSync(ccManifest, JSON.stringify(ccData, null, 2) + '\n');
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function countSkills(dir: string): number {
  let count = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (fs.existsSync(path.join(dir, entry.name, 'SKILL.md'))) {
        count++;
      }
    } else if (entry.name === 'SKILL.md') {
      count++;
    }
  }
  return count;
}

// ─── CLI entry point ─────────────────────────────────────────────────────────

export async function runPluginCommand(args: string[]): Promise<void> {
  const sub = args[0] || 'list';

  switch (sub) {
    case 'list':
    case 'ls':
      listPlugins();
      break;
    case 'install':
    case 'add':
      if (!args[1]) {
        console.log('Usage: nanoclaw plugin install <spec>');
        console.log('');
        console.log('Examples:');
        console.log('  nanoclaw plugin install ./my-plugin');
        console.log('  nanoclaw plugin install owner/repo');
        console.log('  nanoclaw plugin install owner/repo:path/to/plugin');
        console.log(
          '  nanoclaw plugin install https://github.com/user/repo.git',
        );
        console.log('  nanoclaw plugin install workiq@copilot-plugins');
        return;
      }
      await installPlugin(args[1]);
      break;
    case 'remove':
    case 'rm':
    case 'uninstall':
      if (!args[1]) {
        console.log('Usage: nanoclaw plugin remove <name>');
        return;
      }
      removePlugin(args[1]);
      break;
    case 'info':
      if (!args[1]) {
        console.log('Usage: nanoclaw plugin info <name>');
        return;
      }
      pluginInfo(args[1]);
      break;
    case 'marketplace':
    case 'mp':
      await runMarketplaceCommand(args.slice(1));
      break;
    default:
      console.log(
        'Usage: nanoclaw plugin <list|install|remove|info|marketplace> [args]',
      );
      console.log('');
      console.log('Commands:');
      console.log('  list                       List installed plugins');
      console.log(
        '  install <spec>             Install a plugin from path, URL,',
      );
      console.log(
        '                             owner/repo, or plugin@marketplace',
      );
      console.log('  remove <name>              Remove a plugin');
      console.log('  info <name>                Show plugin details');
      console.log('  marketplace add <spec>     Register a plugin marketplace');
      console.log('  marketplace list           List registered marketplaces');
      console.log('  marketplace browse <name>  List plugins in a marketplace');
      console.log('  marketplace remove <name>  Unregister a marketplace');
  }
}

// ─── Marketplace CLI ─────────────────────────────────────────────────

async function runMarketplaceCommand(args: string[]): Promise<void> {
  const sub = args[0] || 'list';
  switch (sub) {
    case 'list':
    case 'ls':
      marketplaceList();
      break;
    case 'add': {
      if (!args[1]) {
        console.log('Usage: nanoclaw plugin marketplace add <spec>');
        console.log('');
        console.log('Examples:');
        console.log('  nanoclaw plugin marketplace add github/copilot-plugins');
        console.log(
          '  nanoclaw plugin marketplace add https://github.com/anthropics/claude-code.git',
        );
        console.log('  nanoclaw plugin marketplace add ./my-marketplace');
        return;
      }
      // Optional explicit name override: --name <foo>
      let name: string | undefined;
      const nameIdx = args.indexOf('--name');
      if (nameIdx > 0 && args[nameIdx + 1]) name = args[nameIdx + 1];
      marketplaceAdd(args[1], name);
      break;
    }
    case 'browse':
      if (!args[1]) {
        console.log('Usage: nanoclaw plugin marketplace browse <name>');
        return;
      }
      marketplaceBrowse(args[1]);
      break;
    case 'remove':
    case 'rm':
      if (!args[1]) {
        console.log('Usage: nanoclaw plugin marketplace remove <name>');
        return;
      }
      marketplaceRemove(args[1]);
      break;
    default:
      console.log(
        'Usage: nanoclaw plugin marketplace <list|add|browse|remove> [args]',
      );
  }
}

function marketplaceList(): void {
  const config = loadConfig();
  const list = getExtraKnownMarketplaces(config);
  if (list.length === 0) {
    console.log('No marketplaces registered.');
    return;
  }
  console.log('\n✨ Registered Marketplaces:\n');
  for (const mp of list) {
    console.log(`  ◆ ${mp.name}  →  ${mp.source}`);
  }
  console.log('');
}

function marketplaceAdd(source: string, explicitName?: string): void {
  const config = loadConfig();
  const existingList = getExtraKnownMarketplaces(config);

  // Derive a default name from source if not provided.
  let name = explicitName;
  if (!name) {
    if (/^[\w.-]+\/[\w.-]+$/.test(source)) {
      // owner/repo → use repo part
      name = source.split('/')[1];
    } else if (/\/([\w.-]+?)(?:\.git)?\/?$/.test(source)) {
      const m = source.match(/\/([\w.-]+?)(?:\.git)?\/?$/);
      name = m?.[1];
    } else {
      name = path.basename(source.replace(/\.git$/, ''));
    }
  }
  if (!name) {
    console.error(
      '❌ Could not derive marketplace name from source. Pass --name <name>.',
    );
    return;
  }

  const existing = existingList.find((m) => m.name === name);
  if (existing) {
    console.error(
      `❌ Marketplace '${name}' already registered (source: ${existing.source}).`,
    );
    return;
  }

  // Verify the catalog actually exists by fetching it once.
  try {
    const catalog = fetchMarketplaceCatalog(name, source);
    setExtraKnownMarketplaces(config, [...existingList, { name, source }]);
    saveConfig(config);
    console.log(
      `✅ Registered marketplace '${name}' (${catalog.plugins?.length ?? 0} plugins available)`,
    );
  } catch (err: any) {
    console.error(`❌ Failed to register marketplace: ${err.message}`);
  }
}

function marketplaceBrowse(name: string): void {
  const config = loadConfig();
  const mp = getExtraKnownMarketplaces(config).find((m) => m.name === name);
  if (!mp) {
    console.error(`❌ Marketplace '${name}' not registered.`);
    return;
  }
  let catalog: MarketplaceCatalog;
  try {
    catalog = fetchMarketplaceCatalog(mp.name, mp.source);
  } catch (err: any) {
    console.error(`❌ ${err.message}`);
    return;
  }
  console.log(`\n✨ Marketplace: ${catalog.name || mp.name}`);
  if (catalog.description) console.log(`   ${catalog.description}`);
  console.log('');
  if (!catalog.plugins || catalog.plugins.length === 0) {
    console.log('  (no plugins in this marketplace)');
    return;
  }
  for (const p of catalog.plugins) {
    const ver = p.version ? ` v${p.version}` : '';
    console.log(`  📦 ${p.name}${ver}`);
    if (p.description) console.log(`     ${p.description}`);
    console.log(
      `     install: \`nanoclaw plugin install ${p.name}@${mp.name}\``,
    );
  }
  console.log('');
}

function marketplaceRemove(name: string): void {
  const config = loadConfig();
  const list = getExtraKnownMarketplaces(config);
  const before = list.length;
  const filtered = list.filter((m) => m.name !== name);
  if (filtered.length === before) {
    console.error(`❌ Marketplace '${name}' not found.`);
    return;
  }
  setExtraKnownMarketplaces(config, filtered);
  saveConfig(config);
  // Also wipe the cached clone so a re-add re-fetches.
  const cached = path.join(marketplaceCacheDir(), name);
  if (fs.existsSync(cached)) fs.rmSync(cached, { recursive: true });
  console.log(`✅ Unregistered marketplace: ${name}`);
}

// ─── Startup auto-install ────────────────────────────────────────────

/**
 * Walk `plugins.enabled[]` from the loaded config and install any plugin
 * whose target directory does not yet exist under `<workspace>/plugins/`.
 *
 * Mirrors CC's proposed `autoInstallEnabledPlugins` behaviour. Idempotent:
 * already-installed plugins are skipped silently. Errors per-entry are
 * logged but do not abort startup — we want a single broken plugin to be
 * surfaced, not to block the whole daemon.
 *
 * Returns a summary of what happened so callers can log/announce.
 */
export async function ensureEnabledPluginsInstalled(): Promise<{
  installed: string[];
  skipped: string[];
  failed: { name: string; error: string }[];
}> {
  const config = loadConfig();
  const enabled = getEnabledPlugins(config);
  const result = {
    installed: [] as string[],
    skipped: [] as string[],
    failed: [] as { name: string; error: string }[],
  };
  if (enabled.length === 0) return result;

  const pDir = pluginsDir();
  for (const entry of enabled) {
    if (entry.autoInstall === false) {
      result.skipped.push(entry.name);
      continue;
    }
    const target = path.join(pDir, entry.name);
    if (fs.existsSync(target)) {
      result.skipped.push(entry.name);
      continue;
    }
    try {
      await installPlugin(entry.source);
      // installPlugin logs to stdout; we just record the outcome.
      if (fs.existsSync(target)) {
        result.installed.push(entry.name);
      } else {
        // installPlugin printed an error and returned without creating the dir.
        result.failed.push({
          name: entry.name,
          error: `installPlugin returned without creating ${target}`,
        });
      }
    } catch (err: any) {
      result.failed.push({
        name: entry.name,
        error: err.message ?? String(err),
      });
    }
  }
  return result;
}
