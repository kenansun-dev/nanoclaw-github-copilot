/**
 * nanoclaw plugin — install, remove, and manage plugins.
 *
 * Plugin format (compatible with GHC plugin.json + CC AgentSkills):
 *   ~/.nanoclaw/plugins/<name>/
 *     ├── plugin.json         ← manifest (name, version, skills, mcpServers, provider)
 *     ├── skills/             ← SKILL.md files (AgentSkills format)
 *     │   └── <skill-name>/
 *     │       └── SKILL.md
 *     └── .mcp.json           ← MCP server config (optional)
 *
 * Commands:
 *   nanoclaw plugin list                  — list installed plugins
 *   nanoclaw plugin install <path|url>    — install a plugin
 *   nanoclaw plugin remove <name>         — remove a plugin
 *   nanoclaw plugin info <name>           — show plugin details
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { resolveWorkspace } from '../workspace.js';
import { loadConfig, saveConfig } from '../config-loader.js';
import { logger } from '../logger.js';

export interface PluginManifest {
  name: string;
  description?: string;
  version?: string;
  author?: string | { name: string; email?: string };
  license?: string;
  keywords?: string[];
  /** Path to skills directory (relative to plugin root) */
  skills?: string | string[];
  /** Path to MCP config file (relative to plugin root) */
  mcpServers?: string;
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

function loadManifest(pluginDir: string): PluginManifest | null {
  const manifestPath = path.join(pluginDir, 'plugin.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return null;
  }
}

// ─── Install ─────────────────────────────────────────────────────────────────

async function installPlugin(source: string): Promise<void> {
  const pDir = pluginsDir();
  fs.mkdirSync(pDir, { recursive: true });

  let srcDir: string;

  if (source.startsWith('http://') || source.startsWith('https://')) {
    // Git clone
    const tmpDir = path.join(pDir, '.tmp-install');
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
    console.log(`Cloning ${source}...`);
    try {
      execSync(`git clone --depth 1 "${source}" "${tmpDir}"`, {
        stdio: 'pipe',
        timeout: 60000,
      });
      srcDir = tmpDir;
    } catch (err: any) {
      console.error(`❌ Failed to clone: ${err.message}`);
      return;
    }
  } else {
    // Local path
    srcDir = path.resolve(source);
    if (!fs.existsSync(srcDir)) {
      console.error(`❌ Path not found: ${srcDir}`);
      return;
    }
  }

  // Read manifest
  const manifest = loadManifest(srcDir);
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
      // Check MCP
      if (
        manifest.mcpServers &&
        fs.existsSync(path.join(pDir, entry.name, manifest.mcpServers))
      ) {
        console.log(`     MCP: ✅`);
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
        pluginSkillDirs.push(`./plugins/${entry.name}/${sd}`);
      }
    }

    // Collect MCP servers
    if (manifest.mcpServers) {
      const mcpPath = path.join(pDir, entry.name, manifest.mcpServers);
      if (fs.existsSync(mcpPath)) {
        try {
          const mcpConfig = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
          const servers =
            mcpConfig.mcpServers || mcpConfig.servers || mcpConfig;
          for (const [name, serverConfig] of Object.entries(servers)) {
            pluginMcpServers[`plugin:${entry.name}:${name}`] = serverConfig;
          }
        } catch {
          logger.warn({ plugin: entry.name }, 'Failed to parse MCP config');
        }
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
      const resolved = d.startsWith('./') ? path.join(resolveWorkspace(), d) : d;
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
        console.log('Usage: nanoclaw plugin install <path|url>');
        console.log('');
        console.log('Examples:');
        console.log('  nanoclaw plugin install ./my-plugin');
        console.log(
          '  nanoclaw plugin install https://github.com/user/nanoclaw-wiki-plugin',
        );
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
    default:
      console.log('Usage: nanoclaw plugin <list|install|remove|info> [args]');
      console.log('');
      console.log('Commands:');
      console.log('  list                    List installed plugins');
      console.log(
        '  install <path|url>      Install a plugin from local path or git URL',
      );
      console.log('  remove <name>           Remove a plugin');
      console.log('  info <name>             Show plugin details');
  }
}
