/**
 * Config loader for nanoclaw.
 * Reads nanoclaw.json from workspace, merges with defaults, reads .env for secrets.
 */

import fs from 'fs';
import { logger } from './logger.js';
import { paths, workspacePath } from './workspace.js';
import { auditConfigDiff, type AuditSource } from './audit.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentConfig {
  id?: string;
  default?: boolean;
  provider?: string; // e.g. "github-copilot", "anthropic". If omitted, parsed from model string.
  model: string; // Short name (e.g. "claude-sonnet-4") or FQDN "provider/model" for backward compat
  name: string;
  triggerWord: string;
  hasOwnNumber: boolean;
  mode: 'host' | 'sandbox';
  thinkLevel?: 'low' | 'medium' | 'high' | 'xhigh'; // GHC: --effort flag; CC: --thinking flag
  showThinking?: boolean | 'on' | 'off' | 'flash'; // Show thinking/reasoning in channel messages. boolean kept for back-compat (true=on, false=off). 'flash' = stream thinking as transient placeholder, replaced by final answer (Discord-style edit-only). Default: off.
  timeoutSeconds?: number; // Max agent run duration in seconds (default: 600 = 10 min). 0 = no timeout.
  githubMcp?: boolean; // GHC: register GitHub MCP server (web_search, issues, PRs, etc.)
}

// Per-account credentials for multi-bot support
export interface TelegramAccountConfig {
  botToken?: string;
}

export interface TeamsAccountConfig {
  appId?: string;
  appPassword?: string;
  tenantId?: string;
  webhookPort?: number;
  authMode?: 'secret' | 'certificate';
  certThumbprint?: string;
  certPrivateKeyPath?: string;
}

// Binding: route (channel, accountId, peer) -> agentId
export interface Binding {
  agentId: string;
  match: {
    channel?: string;
    accountId?: string;
    peer?: { kind?: 'direct' | 'group'; id?: string };
  };
}

// New chats format: grouped by channel.
// `id` is a stable user-facing numeric handle assigned at chat-add time.
// It is the only thing users type at the CLI; jid is the platform-stable id
// kept as a detail field. See proposals/chat-ssot.md.
export interface ChatEntry {
  id?: number;
  jid: string;
  name: string;
  isMain?: boolean;
  requiresTrigger?: boolean;
  agentId?: string;
}

export interface ChannelChats {
  telegram?: ChatEntry[];
  teams?: ChatEntry[];
  discord?: ChatEntry[];
  [channel: string]: ChatEntry[] | undefined;
}

export interface NanoclawConfig {
  configVersion?: number;
  agents: {
    defaults: AgentConfig;
    list?: AgentConfig[];
  };
  channels: {
    discord: {
      enabled: boolean;
      botToken?: string;
    };
    telegram: {
      enabled: boolean;
      botToken?: string;
      accounts?: Record<string, TelegramAccountConfig>;
    };
    teams: {
      enabled: boolean;
      appId?: string;
      appPassword?: string;
      tenantId?: string;
      webhookPort: number;
      authMode: 'secret' | 'certificate';
      certThumbprint?: string;
      certPrivateKeyPath?: string;
      accounts?: Record<string, TeamsAccountConfig>;
    };
    [key: string]: { enabled: boolean; [k: string]: unknown };
  };
  mcp: {
    servers: Record<
      string,
      {
        type?: string;
        command?: string;
        args?: string[];
        url?: string;
        headers?: Record<string, string>;
        tools?: string[];
        env?: Record<string, string>;
      }
    >;
  };
  skills: {
    directories: string[];
    disabled: string[];
  };
  sandbox: {
    runtime: 'docker' | 'apple-container';
    image: string;
    timeout: number;
    maxOutputSize: number;
    maxConcurrent: number;
    idleTimeout: number;
    engine?: 'node' | 'tsx'; // node = compiled dist (default), tsx = self-modifying
  };
  chats: Record<
    string,
    {
      id?: number;
      name: string;
      isMain?: boolean;
      requiresTrigger?: boolean;
      agentId?: string;
    }
  >;
  addons?: Record<
    string,
    {
      type: string; // 'devtunnel' | 'azure-app' | 'azure-bot' | 'scheduled-task'
      channel?: string; // which channel this addon belongs to (e.g. 'teams')
      enabled: boolean;
      config: Record<string, unknown>;
      createdAt?: string;
    }
  >;
  bindings?: Binding[];
  pairing: {
    mode: 'open' | 'prompt' | 'allowlist' | 'disabled';
    notifyChat?: string;
  };
  security?: {
    allowedSenders?: {
      default?: { allow: '*' | string[]; mode?: 'trigger' | 'drop' };
      chats?: Record<
        string,
        { allow: '*' | string[]; mode?: 'trigger' | 'drop' }
      >;
    };
  };
  credentialProxy: {
    port: number;
  };
  logLevel: string;
  timezone: string;
  sendErrorToUser?: boolean; // Send error messages to user on agent failure (default: false)
  tui?: {
    mode?: 'host' | 'sandbox';
    model?: string;
    thinkLevel?: 'low' | 'medium' | 'high' | 'xhigh';
    name?: string;
  };
  /**
   * Plugin configuration. Plugins extend nanoclaw with skills, MCP servers,
   * agents, and hooks. Format is intentionally compatible with both Claude Code
   * (`.claude-plugin/plugin.json` + `marketplace.json`) and GitHub Copilot CLI
   * (`copilot plugin` semantics: `plugin@marketplace`, `owner/repo`, URLs).
   *
   * - `enabled[]`  — declarative list of plugins to ensure-installed at startup
   *                  (similar to CC's `enabledPlugins` + `autoInstallEnabledPlugins`).
   * - `marketplaces[]` — registered marketplaces (CC + GHC use the same
   *                  `marketplace.json` catalog format under `.claude-plugin/`).
   *                  Two defaults are seeded automatically:
   *                  `github/copilot-plugins` and `github/awesome-copilot`.
   * - `directories[]` — extra local directories scanned for plugin manifests
   *                  (in addition to `<workspace>/plugins/`).
   */
  plugins?: {
    /**
     * Declarative list of plugins to ensure-installed at startup.
     * Renamed from `enabled` in v8 to align with CC's `enabledPlugins`.
     */
    enabledPlugins?: PluginEnabledEntry[];
    /**
     * Registered marketplaces. Renamed from `marketplaces` in v8 to align
     * with CC's `extraKnownMarketplaces`.
     */
    extraKnownMarketplaces?: PluginMarketplaceEntry[];
    directories?: string[];
    /** @deprecated v8 — renamed to `enabledPlugins`. Read-only back-compat. */
    enabled?: PluginEnabledEntry[];
    /** @deprecated v8 — renamed to `extraKnownMarketplaces`. Read-only back-compat. */
    marketplaces?: PluginMarketplaceEntry[];
  };
}

/**
 * Declarative plugin entry — "this plugin should be installed".
 * On nanoclaw startup the host-runner ensures each entry is present under
 * `<workspace>/plugins/<name>/`, installing it if missing.
 *
 * Source formats (parsed in this order, mirroring `copilot plugin install`):
 *   - `name@marketplace`            — pull from a registered marketplace
 *   - `owner/repo`                  — `https://github.com/owner/repo`
 *   - `owner/repo:path/to/sub`      — subdirectory inside a repo
 *   - `https://...` / `git@...`     — raw git URL
 *   - `./local/path` / `/abs/path`  — local directory
 */
export interface PluginEnabledEntry {
  /** Plugin name as installed under `<workspace>/plugins/<name>/`. */
  name: string;
  /** Where to install from. See spec formats above. */
  source: string;
  /** Optional git ref (branch / tag / sha). Default: marketplace's pinned version, or `HEAD`. */
  version?: string;
  /** Whether to auto-install if missing. Default: true. */
  autoInstall?: boolean;
  /** Whether the plugin is enabled (loaded at runtime). Default: true. */
  enabled?: boolean;
}

/**
 * Registered marketplace entry. A marketplace is a git repo (or local path)
 * containing `.claude-plugin/marketplace.json` (CC + GHC compatible).
 */
export interface PluginMarketplaceEntry {
  /** Marketplace name (used as `plugin@<name>` install spec). */
  name: string;
  /** Source URL or `owner/repo` short form, or local path. */
  source: string;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULTS: NanoclawConfig = {
  agents: {
    defaults: {
      provider: 'github-copilot',
      model: 'claude-sonnet-4',
      name: 'Andy',
      triggerWord: '@Andy',
      hasOwnNumber: false,
      mode: process.platform === 'win32' ? 'host' : 'sandbox',
      timeoutSeconds: 600, // 10 minutes default
    },
  },
  channels: {
    discord: { enabled: false },
    telegram: { enabled: false },
    teams: {
      enabled: false,
      webhookPort: 3978,
      authMode: 'secret',
    },
  },
  mcp: { servers: {} },
  skills: {
    directories: ['./skills'],
    disabled: [],
  },
  sandbox: {
    runtime: 'docker',
    image: 'nanoclaw-agent:latest',
    timeout: 1800000,
    maxOutputSize: 10485760,
    maxConcurrent: 5,
    idleTimeout: 0,
    engine: 'node' as const,
  },
  chats: {},
  addons: {},
  plugins: {
    enabledPlugins: [],
    // Default marketplaces mirror GHC's built-ins so the experience matches
    // `copilot plugin install plugin@copilot-plugins` out-of-the-box.
    extraKnownMarketplaces: [
      { name: 'copilot-plugins', source: 'github/copilot-plugins' },
      { name: 'awesome-copilot', source: 'github/awesome-copilot' },
    ],
    directories: [],
  },
  pairing: { mode: 'disabled' },
  credentialProxy: { port: 3001 },
  logLevel: 'info',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
};

// ─── Loader ──────────────────────────────────────────────────────────────────

/**
 * Deep merge: target values overridden by source values.
 */
function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Read .env file from workspace and return key-value pairs.
 */
export function readWorkspaceEnv(): Record<string, string> {
  const envPath = paths.env;
  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    const result: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (value) result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Load nanoclaw.json from workspace, merge with defaults.
 * Secrets from .env are merged into the appropriate config sections.
 */
/**
 * Derive channel name from a chat jid prefix.
 */
function channelFromJid(jid: string): string {
  if (jid.startsWith('tg:')) return 'telegram';
  if (jid.startsWith('teams:')) return 'teams';
  if (jid.startsWith('dc:')) return 'discord';
  if (jid.startsWith('wa:')) return 'whatsapp';
  if (jid.startsWith('slack:')) return 'slack';
  return 'other';
}

/**
 * Convert channel-grouped chats format to flat Record<jid, config> format.
 * Supports:
 * - Old top-level flat format: { "teams:xxx": { name: "..." } }
 * - Grouped format (top-level chats): { telegram: [...], teams: [...] }
 * - Channel-embedded format: read from channels.<name>.chats arrays
 */
function normalizeChats(
  raw: any,
  channels?: any,
): Record<
  string,
  {
    id?: number;
    name: string;
    isMain?: boolean;
    requiresTrigger?: boolean;
    agentId?: string;
  }
> {
  const result: Record<string, any> = {};

  // 1. Read from channels.<name>.chats (new canonical format)
  if (channels && typeof channels === 'object') {
    for (const [, chDef] of Object.entries(channels) as any[]) {
      if (!chDef || !Array.isArray(chDef.chats)) continue;
      for (const entry of chDef.chats) {
        if (entry.jid) {
          result[entry.jid] = {
            id: typeof entry.id === 'number' ? entry.id : undefined,
            name: entry.name || entry.jid,
            isMain: entry.isMain,
            requiresTrigger: entry.requiresTrigger,
            agentId: entry.agentId,
          };
        }
      }
    }
  }

  // 2. Also read from top-level chats (migration support)
  if (raw && typeof raw === 'object') {
    const channelKeys = [
      'telegram',
      'teams',
      'discord',
      'slack',
      'whatsapp',
      'other',
    ];
    const isGrouped = Object.keys(raw).some(
      (k) => channelKeys.includes(k) && Array.isArray(raw[k]),
    );

    if (isGrouped) {
      for (const [, entries] of Object.entries(raw)) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          if (entry.jid && !result[entry.jid]) {
            result[entry.jid] = {
              id: typeof entry.id === 'number' ? entry.id : undefined,
              name: entry.name || entry.jid,
              isMain: entry.isMain,
              requiresTrigger: entry.requiresTrigger,
              agentId: entry.agentId,
            };
          }
        }
      }
    } else {
      // Old flat format (jid-keyed map). No `id` field — assigned by v3→v4 migration.
      for (const [jid, cfg] of Object.entries(raw) as any[]) {
        if (!result[jid]) {
          result[jid] = cfg;
        }
      }
    }
  }

  return result;
}

/**
 * Resolve a user-supplied chat handle (numeric id or jid) to its jid.
 * Returns null if no chat matches. Used by CLI commands like `chat set-main <id-or-jid>`.
 */
export function resolveChatHandle(
  config: NanoclawConfig,
  handle: string,
): string | null {
  if (!handle) return null;
  // jid path: contains a colon and matches an existing key
  if (handle.includes(':') && config.chats[handle]) return handle;
  // numeric id path
  const id = Number(handle);
  if (Number.isInteger(id) && id > 0) {
    for (const [jid, entry] of Object.entries(config.chats)) {
      if (entry.id === id) return jid;
    }
  }
  return null;
}

/**
 * Assign a fresh sequential numeric id, larger than any currently-used id.
 */
export function nextChatId(config: NanoclawConfig): number {
  let max = 0;
  for (const entry of Object.values(config.chats)) {
    if (typeof entry.id === 'number' && entry.id > max) max = entry.id;
  }
  return max + 1;
}

/**
 * Validate the isMain invariant.
 *
 * After the share-main feature: multiple isMain *DMs* are allowed and
 * intentionally collapse onto a shared session per agent (see
 * src/session-routing.ts). Multiple isMain *groups* still violate the
 * invariant — group sessions must stay isolated.
 *
 * Without authoritative is-group info we conservatively treat ALL chats
 * as DMs (the share-main case), so config loading never blocks the user
 * just because we can't resolve isGroup yet. The doctor check
 * (`mainChatSingletonCheck`) provides the stricter group-aware view
 * once chats.is_group is populated.
 *
 * @param config         The loaded config.
 * @param isGroupByJid   Optional authoritative is-group map. When
 *                       provided, only multi-isMain *groups* are flagged.
 * @returns The offending jids when there are too many; empty array when fine.
 */
export function findExtraMainChats(
  config: NanoclawConfig,
  isGroupByJid?: Record<string, boolean | undefined>,
): string[] {
  const mains: string[] = [];
  for (const [jid, entry] of Object.entries(config.chats)) {
    if (entry.isMain) mains.push(jid);
  }
  if (mains.length <= 1) return [];

  // No isGroup info → assume all are DMs (allowed). Be conservative
  // here: false-negatives at this layer are caught by the doctor check.
  if (!isGroupByJid) return [];

  const mainGroups = mains.filter((jid) => isGroupByJid[jid] === true);
  return mainGroups.length > 1 ? mainGroups : [];
}

/**
 * Write chats into channels.<name>.chats arrays for saving.
 * Removes top-level "chats" key.
 */
function distributeChatsToChannels(
  toSave: any,
  flat: Record<string, any>,
): void {
  // Remove top-level chats
  delete toSave.chats;

  // Group by channel
  const byChannel: Record<string, any[]> = {};
  for (const [jid, config] of Object.entries(flat)) {
    const ch = channelFromJid(jid);
    if (!byChannel[ch]) byChannel[ch] = [];
    byChannel[ch].push({
      ...(typeof config.id === 'number' ? { id: config.id } : {}),
      jid,
      name: config.name,
      isMain: config.isMain,
      requiresTrigger: config.requiresTrigger,
      agentId: config.agentId,
    });
  }
  // Stable sort by id within each channel for readable diffs.
  for (const entries of Object.values(byChannel)) {
    entries.sort((a, b) => (a.id ?? 1e9) - (b.id ?? 1e9));
  }

  // Write into channels.<name>.chats — but only for channels that already exist.
  // Don't create stub entries for unknown channel names (e.g. 'other' from unrecognized jids).
  if (!toSave.channels) toSave.channels = {};
  const orphans: Record<string, any> = {};
  for (const [ch, entries] of Object.entries(byChannel)) {
    if (!toSave.channels[ch]) {
      // Channel not registered — stash these chats back at the top-level
      // `chats` key so we don't silently drop them. This matters most for
      // tui:N (channelFromJid → 'other'), which has no channel config but
      // is real, persistent state. Without this fallback, reconcile keeps
      // re-importing them from DB on every boot, only to lose them again
      // at saveConfig time — a forever-drift loop (rpi5 caught this on
      // 2026-04-20 live test of PR #15).
      for (const e of entries) {
        const { jid, ...rest } = e;
        orphans[jid] = rest;
      }
      continue;
    }
    toSave.channels[ch].chats = entries;
  }
  // Clean up channels that no longer have chats
  for (const [ch, chDef] of Object.entries(toSave.channels) as any[]) {
    if (chDef && typeof chDef === 'object' && chDef.chats && !byChannel[ch]) {
      delete chDef.chats;
    }
  }

  // Re-attach orphans (chats whose channel isn't registered) at top level
  // so normalizeChats() picks them up again on next load.
  if (Object.keys(orphans).length > 0) {
    toSave.chats = orphans;
  }
}

// ─── Config Migration ────────────────────────────────────────────────────────

const CURRENT_CONFIG_VERSION = 8;

/**
 * Migrate config from older versions. Returns true if migration occurred.
 */
function migrateConfig(config: Record<string, any>): boolean {
  const version = config.configVersion || 0;
  if (version >= CURRENT_CONFIG_VERSION) return false;

  let migrated = false;

  // v0 → v1: normalize structure
  if (version < 1) {
    // Ensure chats registered without isMain get isMain: true (personal use default)
    if (config.chats) {
      const chats =
        typeof config.chats === 'object' && !Array.isArray(config.chats)
          ? config.chats
          : {};
      for (const [channel, chatList] of Object.entries(chats)) {
        if (Array.isArray(chatList)) {
          for (const chat of chatList as any[]) {
            if (chat.isMain === undefined) {
              chat.isMain = true;
              migrated = true;
            }
          }
        }
      }
    }

    // Ensure sandbox.engine defaults to 'node'
    if (config.sandbox && !config.sandbox.engine) {
      config.sandbox.engine = 'node';
      migrated = true;
    }

    config.configVersion = 1;
    migrated = true;
  }

  // v1 → v2: split "provider/model" into separate provider + model fields
  if (version < 2) {
    const splitProviderModel = (agent: any) => {
      if (agent && agent.model && !agent.provider) {
        const slash = agent.model.indexOf('/');
        if (slash > 0) {
          agent.provider = agent.model.substring(0, slash);
          agent.model = agent.model.substring(slash + 1);
          migrated = true;
        }
      }
    };

    if (config.agents?.defaults) {
      splitProviderModel(config.agents.defaults);
    }
    if (Array.isArray(config.agents?.list)) {
      for (const agent of config.agents.list) {
        splitProviderModel(agent);
      }
    }
    // Also migrate tui.model if present
    if (config.tui?.model) {
      const slash = config.tui.model.indexOf('/');
      if (slash > 0) {
        config.tui.model = config.tui.model.substring(slash + 1);
        migrated = true;
      }
    }

    config.configVersion = 2;
    migrated = true;
  }

  // v2 → v3: move root-level teams.tenantId into accounts.default.tenantId
  if (version < 3) {
    const teams = config.channels?.teams;
    if (teams && teams.tenantId) {
      if (!teams.accounts) teams.accounts = {};
      if (!teams.accounts.default) teams.accounts.default = {};
      if (!teams.accounts.default.tenantId) {
        teams.accounts.default.tenantId = teams.tenantId;
      }
      delete teams.tenantId;
      migrated = true;
    }
    config.configVersion = 3;
    migrated = true;
  }

  // v3 → v4: assign sequential numeric `id` to every chat entry.
  // Ids are stable user-facing handles for CLI commands (set-main, etc.).
  // Walks chats in deterministic load order and assigns 1..N.
  if (version < 4) {
    // Collect all chat entries from every supported on-disk shape:
    //   - channels.<name>.chats: ChatEntry[] (canonical)
    //   - chats: { <channel>: ChatEntry[] }   (older grouped)
    //   - chats: { <jid>: {...} }              (oldest flat)
    type Walked = { entry: any };
    const grouped: Walked[] = [];
    const flat: Array<{ jid: string; entry: any }> = [];

    if (config.channels && typeof config.channels === 'object') {
      const chOrder = Object.keys(config.channels).sort();
      for (const ch of chOrder) {
        const arr = config.channels[ch]?.chats;
        if (Array.isArray(arr)) {
          for (const entry of arr) grouped.push({ entry });
        }
      }
    }

    if (config.chats && typeof config.chats === 'object') {
      const channelKeys = [
        'telegram',
        'teams',
        'discord',
        'slack',
        'whatsapp',
        'other',
      ];
      const isGrouped = Object.keys(config.chats).some(
        (k) => channelKeys.includes(k) && Array.isArray(config.chats[k]),
      );
      if (isGrouped) {
        const chOrder = Object.keys(config.chats).sort();
        for (const ch of chOrder) {
          const arr = config.chats[ch];
          if (Array.isArray(arr)) {
            for (const entry of arr) grouped.push({ entry });
          }
        }
      } else {
        const jids = Object.keys(config.chats).sort();
        for (const jid of jids) flat.push({ jid, entry: config.chats[jid] });
      }
    }

    const used = new Set<number>();
    for (const { entry } of grouped) {
      if (entry && typeof entry.id === 'number' && entry.id > 0)
        used.add(entry.id);
    }
    for (const { entry } of flat) {
      if (entry && typeof entry.id === 'number' && entry.id > 0)
        used.add(entry.id);
    }
    let next = 1;
    const nextFree = (): number => {
      while (used.has(next)) next++;
      used.add(next);
      return next;
    };
    for (const { entry } of grouped) {
      if (entry && typeof entry.id !== 'number') {
        entry.id = nextFree();
        migrated = true;
      }
    }
    for (const { entry } of flat) {
      if (entry && typeof entry.id !== 'number') {
        entry.id = nextFree();
        migrated = true;
      }
    }

    // Dedupe isMain: v0→1 migration set isMain:true on every grouped chat
    // that lacked the field. With the v4 "at most one isMain" invariant, that
    // would brick any pre-v1 multi-chat config on first launch. Keep the
    // lowest-id main, clear the rest, and warn so the user can re-pick.
    const allMains = [...grouped, ...flat]
      .map(({ entry }) => entry)
      .filter((e) => e && e.isMain);
    if (allMains.length > 1) {
      allMains.sort((a, b) => (a.id ?? 1e9) - (b.id ?? 1e9));
      const kept = allMains[0];
      const cleared: number[] = [];
      for (let i = 1; i < allMains.length; i++) {
        delete allMains[i].isMain;
        if (typeof allMains[i].id === 'number') cleared.push(allMains[i].id);
        migrated = true;
      }
      logger.warn(
        { kept: kept.id, cleared, total: allMains.length },
        `v3→4 migration: ${allMains.length} chats had isMain:true (likely from v0→1 default). ` +
          `Kept #${kept.id} as main; cleared #${cleared.join(', #')}. ` +
          `Run \`nanoclaw chat set-main <id>\` to choose a different main.`,
      );
    }

    config.configVersion = 4;
    migrated = true;
  }

  if (version < 5) {
    // v5: consolidate legacy per-connection TUI chats (`tui:1`, `tui:2`, ...)
    // into a single canonical `tui:default` entry. Pre-v5 the TUI channel
    // auto-registered a new chat per socket connection, polluting
    // nanoclaw.json + status/doctor with N entries that all collapsed onto
    // the same `main/` folder anyway. v5+ uses one stable jid for all TUI
    // sessions; this migration removes the legacy entries and ensures a
    // single `tui:default` row exists if any TUI chat existed before.
    if (config.chats && typeof config.chats === 'object') {
      const tuiKeys = Object.keys(config.chats).filter(
        (k) =>
          k.startsWith('tui:') && k !== 'tui:default' && /^tui:\d+$/.test(k),
      );
      if (tuiKeys.length > 0) {
        // Pick a representative entry to seed tui:default if it doesn't exist
        const firstKey = tuiKeys[0];
        const firstEntry = config.chats[firstKey];
        if (!config.chats['tui:default']) {
          config.chats['tui:default'] = {
            ...firstEntry,
            name: 'tui',
            isMain: true,
          };
        }
        for (const k of tuiKeys) {
          delete config.chats[k];
        }
        logger.info(
          { removed: tuiKeys.length, kept: 'tui:default' },
          'v5 migration: consolidated legacy TUI chats into tui:default',
        );
        migrated = true;
      }
    }

    config.configVersion = 5;
    migrated = true;
  }

  if (version < 6) {
    // v6: introduce `plugins` config block. Seeds default marketplaces so
    // `nanoclaw plugin install <name>@copilot-plugins` works out-of-the-box,
    // and creates an empty `enabled[]` so users can declaratively pin
    // plugins in nanoclaw.json (akin to CC's `enabledPlugins` /
    // `autoInstallEnabledPlugins`). Existing user-defined `plugins` blocks
    // are preserved — we only seed missing keys.
    if (!config.plugins || typeof config.plugins !== 'object') {
      config.plugins = {};
    }
    if (
      !Array.isArray(config.plugins.enabledPlugins) &&
      !Array.isArray(config.plugins.enabled)
    ) {
      config.plugins.enabledPlugins = [];
    }
    if (
      !Array.isArray(config.plugins.extraKnownMarketplaces) &&
      !Array.isArray(config.plugins.marketplaces)
    ) {
      config.plugins.extraKnownMarketplaces = [
        { name: 'copilot-plugins', source: 'github/copilot-plugins' },
        { name: 'awesome-copilot', source: 'github/awesome-copilot' },
      ];
    }
    if (!Array.isArray(config.plugins.directories)) {
      config.plugins.directories = [];
    }
    config.configVersion = 6;
    migrated = true;
  }

  if (version < 7) {
    // v7: purge legacy tui:* and 'other' placeholders from root `chats`.
    //
    // Reason: the TUI channel auto-registers `tui:default` on connect
    // (see channels/tui.ts), so config entries for it are pure noise.
    // Pre-v5 left tui:1, tui:2, ... behind; v5 consolidated to
    // tui:default but kept it in root `chats`. v7 finishes the cleanup
    // by removing all tui:* (auto-registered on next TUI connect) plus
    // the deprecated `other` placeholder.
    //
    // Real-jid entries (telegram:*, discord:*, etc.) are LEFT IN PLACE
    // — callers (loadConfig:684+) preserve them as orphans when their
    // channel has no config block, and reconciliation in cli.ts owns
    // the migration to channels.<name>.chats[].
    if (config.chats && typeof config.chats === 'object') {
      const keys = Object.keys(config.chats);
      let removed = 0;
      for (const jid of keys) {
        // tui:* (any subkey) — tui channel auto-registers tui:default
        if (jid.startsWith('tui:')) {
          delete config.chats[jid];
          removed++;
          continue;
        }
        // 'other' placeholder — deprecated, never wired up
        if (jid === 'other') {
          delete config.chats[jid];
          removed++;
          continue;
        }
      }
      if (removed > 0) {
        logger.info(
          { removed },
          'v7 migration: purged legacy tui:* and other entries from root chats',
        );
      }
    }
    config.configVersion = 7;
    migrated = true;
  }

  if (version < 8) {
    // v8: rename plugin config fields to match CC's nomenclature.
    //   enabled        → enabledPlugins
    //   marketplaces   → extraKnownMarketplaces
    // Field semantics unchanged. Reads are tolerant of either name in
    // loadConfig (we re-write to canonical names on first save).
    if (config.plugins && typeof config.plugins === 'object') {
      const p = config.plugins as Record<string, any>;
      if (Array.isArray(p.enabled) && !Array.isArray(p.enabledPlugins)) {
        p.enabledPlugins = p.enabled;
        delete p.enabled;
        migrated = true;
      }
      if (
        Array.isArray(p.marketplaces) &&
        !Array.isArray(p.extraKnownMarketplaces)
      ) {
        p.extraKnownMarketplaces = p.marketplaces;
        delete p.marketplaces;
        migrated = true;
      }
    }
    config.configVersion = 8;
    migrated = true;
  }

  return migrated;
}

/**
 * Recursively resolve ${VAR_NAME} placeholders in string values.
 * envMap is the merged .env + process.env (workspace .env takes priority).
 */
function resolveEnvVars(
  obj: any,
  envMap: Record<string, string | undefined>,
): any {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      const value = envMap[varName];
      if (value !== undefined) return value;
      logger.warn(
        { var: varName },
        `Env var \${${varName}} not found, leaving as-is`,
      );
      return match;
    });
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => resolveEnvVars(item, envMap));
  }
  if (obj && typeof obj === 'object') {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvVars(value, envMap);
    }
    return result;
  }
  return obj;
}

// ─── Load / Save ─────────────────────────────────────────────────────────────

export function loadConfig(): NanoclawConfig {
  let userConfig: Partial<NanoclawConfig> = {};
  let recoveredFromBackup = false;

  // Read nanoclaw.json
  try {
    if (fs.existsSync(paths.config)) {
      const raw = fs.readFileSync(paths.config, 'utf-8');
      userConfig = JSON.parse(raw);
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to parse nanoclaw.json — attempting recovery from backup',
    );
    // Try to recover from .bak files
    const recovered = recoverFromBackup(paths.config);
    if (recovered) {
      userConfig = recovered;
      recoveredFromBackup = true;
      console.error(
        '\n  ⚠️  nanoclaw.json was corrupt — recovered from backup.\n' +
          `  File: ${paths.config}\n`,
      );
    } else {
      console.error(
        '\n  ❌ nanoclaw.json is invalid JSON and no backup found.\n' +
          '  Fix the file manually before starting.\n' +
          `  File: ${paths.config}\n`,
      );
      process.exit(1);
    }
  }

  // Migrate secrets from nanoclaw.json to .env (one-time)
  // Skip if we just recovered from backup to avoid circular corruption
  if (!recoveredFromBackup) {
    migrateSecretsToEnv(userConfig);
  }

  // Run config migrations
  const migrated = migrateConfig(userConfig);
  if (migrated && !recoveredFromBackup) {
    try {
      fs.writeFileSync(
        paths.config,
        JSON.stringify(userConfig, null, 2) + '\n',
      );
      logger.debug(
        { version: userConfig.configVersion },
        'Config migrated and saved',
      );
    } catch {
      /* best effort */
    }
  }

  // Resolve ${VAR_NAME} env var placeholders in config values
  const wsEnv = readWorkspaceEnv();
  const envMap: Record<string, string | undefined> = {
    ...process.env,
    ...wsEnv,
  };
  userConfig = resolveEnvVars(userConfig, envMap);

  // Merge with defaults
  const config = deepMerge(DEFAULTS, userConfig) as NanoclawConfig;

  // Normalize chats: convert grouped format to flat Record<jid, config>
  config.chats = normalizeChats(config.chats, config.channels) as any;

  // Singleton invariant: at most one *group* may be isMain. Multiple
  // isMain DMs are allowed and intentionally share a session per agent
  // (see src/session-routing.ts and features/dm-session-sharing.md).
  // Without isGroup info here we skip the strict check; the doctor
  // check enforces the group-aware view at runtime.
  const extraMains = findExtraMainChats(config);
  if (extraMains.length > 0) {
    const lines = extraMains
      .map((j) => {
        const e = config.chats[j];
        return `    • #${e.id ?? '?'}  ${j}  (${e.name || '?'})`;
      })
      .join('\n');
    throw new Error(
      `nanoclaw config: ${extraMains.length} group chats marked isMain:\n${lines}\n` +
        `Group chats must keep isolated sessions — at most one may be the main group. ` +
        `Edit ~/.nanoclaw/nanoclaw.json or run \`nanoclaw chat set-main <id>\` ` +
        `to choose one and clear the rest. (Multiple DM chats may share a main session.)`,
    );
  }

  // Merge MCP servers from mcp.json if it exists
  if (fs.existsSync(paths.mcpConfig)) {
    try {
      const mcpJson = JSON.parse(fs.readFileSync(paths.mcpConfig, 'utf-8'));
      const mcpServers = mcpJson.mcpServers || mcpJson;
      // mcp.json servers are base, nanoclaw.json servers override
      config.mcp.servers = { ...mcpServers, ...config.mcp.servers };
    } catch {
      // ignore
    }
  }

  // Read .env and fill in secrets where config doesn't have them
  const env = readWorkspaceEnv();

  // Telegram
  if (!config.channels.telegram.botToken) {
    config.channels.telegram.botToken =
      process.env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
  }

  // Teams
  const teams = config.channels.teams;
  if (!teams.appId) {
    teams.appId = process.env.MSTEAMS_APP_ID || env.MSTEAMS_APP_ID;
  }
  if (!teams.appPassword) {
    teams.appPassword =
      process.env.MSTEAMS_APP_PASSWORD ||
      env.MSTEAMS_APP_PASSWORD ||
      process.env.MSTEAMS_APP_KEY ||
      env.MSTEAMS_APP_KEY;
  }
  if (!teams.tenantId) {
    teams.tenantId = process.env.MSTEAMS_TENANT_ID || env.MSTEAMS_TENANT_ID;
  }
  if (!teams.certThumbprint) {
    teams.certThumbprint =
      process.env.MSTEAMS_CERT_THUMBPRINT || env.MSTEAMS_CERT_THUMBPRINT;
  }
  if (!teams.certPrivateKeyPath) {
    teams.certPrivateKeyPath =
      process.env.MSTEAMS_CERT_PRIVATE_KEY_PATH ||
      env.MSTEAMS_CERT_PRIVATE_KEY_PATH;
  }

  // Auto-enable channels if credentials are present
  if (
    config.channels.telegram.botToken &&
    !userConfig.channels?.telegram?.enabled
  ) {
    config.channels.telegram.enabled = true;
  }
  if (teams.appId && (teams.appPassword || teams.certThumbprint)) {
    if (!userConfig.channels?.teams?.enabled) {
      config.channels.teams.enabled = true;
    }
  }

  // Normalize channel credentials: old flat format → accounts.default
  // This ensures channel factories always read from accounts{}
  const tg = config.channels.telegram;
  if (tg.botToken && !tg.accounts) {
    tg.accounts = { default: { botToken: tg.botToken } };
  }
  const tm = config.channels.teams;
  if (tm.appId) {
    if (!tm.accounts) tm.accounts = {};
    const acct = tm.accounts.default || ({} as TeamsAccountConfig);
    tm.accounts.default = {
      appId: acct.appId || tm.appId,
      appPassword: acct.appPassword || tm.appPassword,
      tenantId: acct.tenantId || tm.tenantId,
      webhookPort: acct.webhookPort || tm.webhookPort,
      authMode: acct.authMode || tm.authMode,
      certThumbprint: acct.certThumbprint || tm.certThumbprint,
      certPrivateKeyPath: acct.certPrivateKeyPath || tm.certPrivateKeyPath,
    };
  }

  return config;
}

// ─── Config Backup ───────────────────────────────────────────────────────────

const MAX_BACKUP_RING = 4;

/** Rotate .bak ring: .bak → .bak.1, .bak.1 → .bak.2, ... up to .bak.4 */
function rotateConfigBackups(configPath: string): void {
  const bakBase = `${configPath}.bak`;
  // Remove oldest
  try {
    fs.unlinkSync(`${bakBase}.${MAX_BACKUP_RING}`);
  } catch {}
  // Shift ring
  for (let i = MAX_BACKUP_RING - 1; i >= 1; i--) {
    try {
      fs.renameSync(`${bakBase}.${i}`, `${bakBase}.${i + 1}`);
    } catch {}
  }
  // Current .bak → .bak.1
  try {
    fs.renameSync(bakBase, `${bakBase}.1`);
  } catch {}
}

/** Create a backup of the config file before writing. */
function backupConfig(configPath: string): void {
  if (!fs.existsSync(configPath)) return;
  rotateConfigBackups(configPath);
  try {
    fs.copyFileSync(configPath, `${configPath}.bak`);
    // Harden permissions (owner-only)
    fs.chmodSync(`${configPath}.bak`, 0o600);
  } catch {
    /* best effort */
  }
}

/** Try to recover config from .bak files when nanoclaw.json is corrupt. */
function recoverFromBackup(configPath: string): Partial<NanoclawConfig> | null {
  const candidates = [
    `${configPath}.bak`,
    ...Array.from(
      { length: MAX_BACKUP_RING },
      (_, i) => `${configPath}.bak.${i + 1}`,
    ),
  ];
  for (const bakPath of candidates) {
    try {
      if (!fs.existsSync(bakPath)) continue;
      const raw = fs.readFileSync(bakPath, 'utf-8');
      const parsed = JSON.parse(raw);
      logger.info({ bakPath }, 'Recovered config from backup');
      // Restore the main config file from backup
      fs.copyFileSync(bakPath, configPath);
      return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Save config back to nanoclaw.json (for CLI commands like chat add).
 *
 * @param source Optional caller hint for audit logs. Defaults to 'unknown' so
 *               existing call sites keep compiling; pass a specific value
 *               (e.g. 'slash-command', 'tui') from new call sites so audit
 *               output identifies the trigger.
 * @param context Optional structured context (chatJid, userId, etc.) attached
 *                to any audit events emitted from this save.
 */
export function saveConfig(
  config: NanoclawConfig,
  source: AuditSource = 'unknown',
  context?: Record<string, unknown>,
): void {
  // Read prior on-disk snapshot so audit can diff watched fields.
  // Best-effort: if read fails (first save, fs error), prior = undefined and
  // any newly-set watched field is reported as <unset> → <new>.
  let priorOnDisk: unknown = undefined;
  try {
    if (fs.existsSync(paths.config)) {
      priorOnDisk = JSON.parse(fs.readFileSync(paths.config, 'utf-8'));
    }
  } catch {
    /* ignore — audit will record undefined → new */
  }
  // Strip secrets before saving — they stay in .env
  const toSave = JSON.parse(JSON.stringify(config));
  // Strip top-level channel secrets
  // Replace secrets with ${ENV_VAR} references (explicit, visible in json)
  if (
    toSave.channels?.telegram?.botToken &&
    !toSave.channels.telegram.botToken.startsWith('${')
  ) {
    toSave.channels.telegram.botToken = '${TELEGRAM_BOT_TOKEN}';
  }
  if (toSave.channels?.teams) {
    if (
      toSave.channels.teams.appPassword &&
      !toSave.channels.teams.appPassword.startsWith('${')
    ) {
      toSave.channels.teams.appPassword = '${MSTEAMS_APP_PASSWORD}';
    }
    delete toSave.channels.teams.certThumbprint;
    delete toSave.channels.teams.certPrivateKeyPath;
    // tenantId lives in accounts.default, not root level (v2→v3 migration)
    delete toSave.channels.teams.tenantId;
  }
  // Per-account secrets → ${ENV_VAR} references
  for (const ch of ['telegram', 'teams'] as const) {
    const accounts = toSave.channels?.[ch]?.accounts;
    if (accounts && typeof accounts === 'object') {
      for (const [accId, acc] of Object.entries(accounts) as any[]) {
        if (
          ch === 'telegram' &&
          acc.botToken &&
          !acc.botToken.startsWith('${')
        ) {
          const envKey =
            accId === 'default'
              ? 'TELEGRAM_BOT_TOKEN'
              : `TELEGRAM_BOT_TOKEN_${accId.toUpperCase()}`;
          acc.botToken = `\${${envKey}}`;
        }
        if (
          ch === 'teams' &&
          acc.appPassword &&
          !acc.appPassword.startsWith('${')
        ) {
          const envKey =
            accId === 'default'
              ? 'MSTEAMS_APP_PASSWORD'
              : `MSTEAMS_APP_PASSWORD_${accId.toUpperCase()}`;
          acc.appPassword = `\${${envKey}}`;
        }
        delete acc.certThumbprint;
        delete acc.certPrivateKeyPath;
      }
    }
  }

  // Distribute chats into channels.<name>.chats
  distributeChatsToChannels(toSave, toSave.chats || {});
  // Backup before writing
  backupConfig(paths.config);
  fs.writeFileSync(paths.config, JSON.stringify(toSave, null, 2) + '\n');

  // Emit audit events for watched-field diffs. After writeFileSync so we
  // only audit changes that actually landed on disk.
  try {
    auditConfigDiff(priorOnDisk, toSave, source, context);
  } catch (err) {
    // Audit must never break saveConfig. Log to standard logger as a fallback.
    logger.error({ err }, 'Audit emit failed (saveConfig still succeeded)');
  }
}

// ─── Agent Resolution ────────────────────────────────────────────────────────

/**
 * Resolve agent config for a given agentId.
 * If agentId is provided, looks in agents.list[]. Falls back to agents.defaults.
 * List entries inherit missing fields from defaults.
 */
export function resolveAgent(
  config: NanoclawConfig,
  agentId?: string,
): AgentConfig {
  const defaults = config.agents.defaults;
  if (!agentId || !config.agents.list?.length) {
    return defaults;
  }
  const found = config.agents.list.find((a) => a.id === agentId);
  if (!found) {
    return defaults;
  }
  // Merge: agent-specific overrides defaults
  return { ...defaults, ...found };
}

/**
 * Resolve agentId from bindings for a given chat.
 * Checks bindings[] in order; first match wins.
 * Falls back to chatConfig.agentId (legacy) or undefined (use default agent).
 */
export function resolveAgentIdFromBindings(
  config: NanoclawConfig,
  chatJid: string,
  chatConfig?: { agentId?: string },
): string | undefined {
  if (config.bindings?.length) {
    // Derive channel and accountId from JID
    // Format: tg:<chatId> (default account) or tg:<accountId>:<chatId>
    let channel: string | undefined;
    let jidAccountId: string | undefined;
    if (chatJid.startsWith('tg:')) {
      channel = 'telegram';
      const parts = chatJid.split(':');
      if (parts.length >= 3) jidAccountId = parts[1]; // tg:accountId:chatId
    } else if (chatJid.startsWith('teams:')) {
      channel = 'teams';
    } else if (chatJid.startsWith('dc:')) {
      channel = 'discord';
    } else if (chatJid.startsWith('wa:')) {
      channel = 'whatsapp';
    }

    for (const binding of config.bindings) {
      const m = binding.match;
      if (m.channel && m.channel !== channel) continue;
      if (m.accountId) {
        // Match accountId: 'default' matches JIDs without accountId prefix
        const effective = jidAccountId || 'default';
        if (m.accountId !== effective) continue;
      }
      if (m.peer?.id && !chatJid.includes(m.peer.id)) continue;
      return binding.agentId;
    }
  }

  // Legacy: chatConfig.agentId
  return chatConfig?.agentId;
}

/**
 * Get the default agent (first with default: true, or first in list, or defaults).
 */
export function getDefaultAgent(config: NanoclawConfig): AgentConfig {
  const list = config.agents.list;
  if (!list?.length) return config.agents.defaults;
  const defaultAgent = list.find((a) => a.default);
  return defaultAgent
    ? { ...config.agents.defaults, ...defaultAgent }
    : { ...config.agents.defaults, ...list[0] };
}

// ─── Secret Migration ────────────────────────────────────────────────────────

/**
 * One-time migration: move plaintext secrets from nanoclaw.json to .env.
 * After moving, saves a clean nanoclaw.json without secrets.
 */
function migrateSecretsToEnv(config: any): void {
  const secrets: Record<string, string> = {};
  let found = false;

  // Check top-level channel secrets (skip ${ENV_VAR} references)
  if (
    config.channels?.telegram?.botToken &&
    !config.channels.telegram.botToken.startsWith('${')
  ) {
    secrets.TELEGRAM_BOT_TOKEN = config.channels.telegram.botToken;
    found = true;
  }
  if (
    config.channels?.teams?.appPassword &&
    !config.channels.teams.appPassword.startsWith('${')
  ) {
    secrets.MSTEAMS_APP_PASSWORD = config.channels.teams.appPassword;
    found = true;
  }
  // Note: appId is NOT a secret — it's a public Azure App Registration ID.
  // It stays in nanoclaw.json, not in .env.
  if (
    config.channels?.teams?.tenantId &&
    !config.channels.teams.tenantId.startsWith('${')
  ) {
    secrets.MSTEAMS_TENANT_ID = config.channels.teams.tenantId;
    found = true;
  }

  // Check per-account secrets (skip ${ENV_VAR} references)
  for (const [accId, acc] of Object.entries(
    config.channels?.telegram?.accounts || {},
  ) as any[]) {
    if (acc.botToken && !acc.botToken.startsWith('${')) {
      const key =
        accId === 'default'
          ? 'TELEGRAM_BOT_TOKEN'
          : `TELEGRAM_BOT_TOKEN_${accId.toUpperCase()}`;
      secrets[key] = acc.botToken;
      found = true;
    }
  }
  for (const [accId, acc] of Object.entries(
    config.channels?.teams?.accounts || {},
  ) as any[]) {
    if (acc.appPassword && !acc.appPassword.startsWith('${')) {
      const key =
        accId === 'default'
          ? 'MSTEAMS_APP_PASSWORD'
          : `MSTEAMS_APP_PASSWORD_${accId.toUpperCase()}`;
      secrets[key] = acc.appPassword;
      found = true;
    }
  }

  if (!found) return;

  // Append to .env
  const envPath = paths.config.replace(/nanoclaw.json$/, '.env');
  let envContent = '';
  try {
    envContent = fs.readFileSync(envPath, 'utf-8');
  } catch {
    /* no .env yet */
  }

  const lines: string[] = [];
  for (const [k, v] of Object.entries(secrets)) {
    // Only add if not already in .env
    if (!envContent.includes(`${k}=`)) {
      lines.push(`${k}=${v}`);
    }
  }

  if (lines.length > 0) {
    const append =
      '\n# Migrated from nanoclaw.json\n' + lines.join('\n') + '\n';
    fs.appendFileSync(envPath, append, { mode: 0o600 });
    logger.info(
      `Migrated ${lines.length} secret(s) from nanoclaw.json to .env`,
    );

    // Save clean config (saveConfig strips secrets)
    saveConfig(config, 'secret-migration', { migratedKeys: lines.length });
    logger.info('Stripped secrets from nanoclaw.json');
  }
}

// ─── Plugin config field accessors (CC-aligned naming) ──────────────────────
// v8 renamed `enabled` → `enabledPlugins` and `marketplaces` →
// `extraKnownMarketplaces` to match CCs nomenclature. These helpers tolerate
// either field name on read so old configs that have not yet been re-saved
// still work.

export function getEnabledPlugins(
  config: Pick<NanoclawConfig, 'plugins'>,
): PluginEnabledEntry[] {
  const p = config.plugins as
    | (NonNullable<NanoclawConfig['plugins']> & {
        enabled?: PluginEnabledEntry[];
      })
    | undefined;
  if (!p) return [];
  const raw =
    (Array.isArray(p.enabledPlugins) && p.enabledPlugins) ||
    (Array.isArray(p.enabled) && p.enabled) ||
    [];
  // Normalize: tolerate bare-string entries like `"workiq@work-iq"` that
  // users naturally write when copying a CC config or following docs that
  // pre-date the v8 schema split. Without this, the entry's `.name` and
  // `.source` are both undefined and ensureEnabledPluginsInstalled() does
  // a no-op while logging nothing user-visible (kenan repro 2026-04-27
  // workiq case). String form parsed identically to InstallSpec's
  // marketplace branch: `<plugin>@<marketplace>` → { name: plugin, source: full }.
  // Other shapes (owner/repo, urls, paths) are passed through as the source
  // and the name is inferred from the last useful path segment.
  return raw
    .map((entry: any): PluginEnabledEntry | null => {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof entry.name === 'string'
      ) {
        return entry as PluginEnabledEntry;
      }
      if (typeof entry === 'string') {
        const name = inferPluginNameFromSource(entry);
        if (!name) return null;
        return { name, source: entry };
      }
      return null;
    })
    .filter((e): e is PluginEnabledEntry => e !== null);
}

/**
 * Best-effort plugin-name inference for bare-string `enabledPlugins` entries.
 * Returns null when the string isn't recognizable as any of the documented
 * install spec shapes (caller drops the entry rather than guessing).
 */
function inferPluginNameFromSource(spec: string): string | null {
  const trimmed = spec.trim();
  if (!trimmed) return null;
  // marketplace form: name@marketplace → left side is the plugin name.
  const atIdx = trimmed.indexOf('@');
  if (atIdx > 0 && atIdx < trimmed.length - 1) {
    const left = trimmed.slice(0, atIdx);
    if (/^[a-z0-9][a-z0-9_-]*$/i.test(left)) return left;
  }
  // owner/repo[:subdir] → last path segment of the repo or subdir.
  const colonIdx = trimmed.indexOf(':');
  const headBeforeColon = colonIdx > 0 ? trimmed.slice(0, colonIdx) : trimmed;
  const tail = (colonIdx > 0 ? trimmed.slice(colonIdx + 1) : headBeforeColon)
    .split('/')
    .filter(Boolean)
    .pop();
  if (tail && /^[a-z0-9][a-z0-9._-]*$/i.test(tail)) {
    // Strip a trailing .git on git URLs.
    return tail.replace(/\.git$/i, '');
  }
  return null;
}

export function getExtraKnownMarketplaces(
  config: Pick<NanoclawConfig, 'plugins'>,
): PluginMarketplaceEntry[] {
  const p = config.plugins as
    | (NonNullable<NanoclawConfig['plugins']> & {
        marketplaces?: PluginMarketplaceEntry[];
      })
    | undefined;
  if (!p) return [];
  if (Array.isArray(p.extraKnownMarketplaces)) return p.extraKnownMarketplaces;
  if (Array.isArray(p.marketplaces)) return p.marketplaces;
  return [];
}

export function setEnabledPlugins(
  config: NanoclawConfig,
  list: PluginEnabledEntry[],
): void {
  if (!config.plugins) config.plugins = {};
  const p = config.plugins as Record<string, any>;
  p.enabledPlugins = list;
  delete p.enabled; // canonicalize
}

export function setExtraKnownMarketplaces(
  config: NanoclawConfig,
  list: PluginMarketplaceEntry[],
): void {
  if (!config.plugins) config.plugins = {};
  const p = config.plugins as Record<string, any>;
  p.extraKnownMarketplaces = list;
  delete p.marketplaces; // canonicalize
}
