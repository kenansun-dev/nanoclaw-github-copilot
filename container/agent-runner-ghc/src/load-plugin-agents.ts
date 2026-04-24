/**
 * load-plugin-agents.ts
 *
 * Workaround for upstream GHC SDK gap (verified 2026-04-23 with @github/copilot-sdk 0.2.2):
 * the CLI accepts `--plugin-dir` and parses it, but in `--server --headless` mode
 * (the path the SDK uses) the parsed `pluginDir` value is dropped — only ACP and
 * interactive modes propagate it into `SessionManager.additionalPlugins`. Empirical
 * probe: a session created via `CopilotClient` with `cliArgs: ['--plugin-dir', X]`
 * returns `agent.list -> { agents: [] }` and `plugins.list -> { plugins: [] }`
 * even when X contains a valid plugin manifest with an `agents/` subdirectory.
 *
 * As a workaround, we read each plugin's `agents/*.md` files ourselves and build
 * `CustomAgentConfig[]` to pass through `SessionConfig.customAgents`. The SDK
 * supports this field directly.
 *
 * When upstream fixes the gap (additionalPlugins propagation in startServerMode),
 * this module can be removed.
 */

import fs from 'fs';
import path from 'path';

export interface PluginCustomAgent {
  /** Stable agent name; preferred from frontmatter `name`, else filename stem. */
  name: string;
  /** Display name from frontmatter; optional. */
  displayName?: string;
  /** Description from frontmatter; optional. */
  description?: string;
  /** Markdown body without the frontmatter block. */
  prompt: string;
  /** Optional tool list from frontmatter. */
  tools?: string[];
  /** Where this agent came from (for debug/logging). */
  sourcePath: string;
  /** Plugin directory that contained this agent. */
  pluginDir: string;
}

/**
 * Load custom agents from one or more plugin directories.
 *
 * For each plugin dir, looks at `agents/*.md` (one level deep). Each `.md` file
 * may have a YAML frontmatter block; the body is used as the agent prompt.
 *
 * Returns an empty array when no agents are found. Never throws on a single bad
 * file — bad files are skipped and reported via `onWarn`.
 */
export function loadPluginAgents(
  pluginDirs: readonly string[],
  opts: { onWarn?: (msg: string) => void } = {},
): PluginCustomAgent[] {
  const warn = opts.onWarn ?? (() => {});
  const out: PluginCustomAgent[] = [];
  const seen = new Set<string>(); // dedupe by agent name

  for (const dir of pluginDirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    const agentsDir = path.join(dir, 'agents');
    if (!fs.existsSync(agentsDir) || !fs.statSync(agentsDir).isDirectory())
      continue;

    let entries: string[];
    try {
      entries = fs.readdirSync(agentsDir);
    } catch (err) {
      warn(`load-plugin-agents: cannot read ${agentsDir}: ${(err as Error).message}`);
      continue;
    }

    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith('.md')) continue;
      const filePath = path.join(agentsDir, entry);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;

      let raw: string;
      try {
        raw = fs.readFileSync(filePath, 'utf8');
      } catch (err) {
        warn(`load-plugin-agents: cannot read ${filePath}: ${(err as Error).message}`);
        continue;
      }

      const parsed = parseAgentFile(raw, entry);
      if (!parsed) {
        warn(`load-plugin-agents: skipping ${filePath} (empty body or unparseable)`);
        continue;
      }

      // Stable name selection: frontmatter.name → filename stem.
      const stem = path.basename(entry, path.extname(entry));
      const name = sanitizeName(parsed.name || stem);
      if (!name) {
        warn(`load-plugin-agents: skipping ${filePath} (could not derive agent name)`);
        continue;
      }

      if (seen.has(name)) {
        warn(
          `load-plugin-agents: duplicate agent name "${name}" — keeping first, skipping ${filePath}`,
        );
        continue;
      }
      seen.add(name);

      out.push({
        name,
        displayName: parsed.displayName,
        description: parsed.description,
        prompt: parsed.body,
        tools: parsed.tools,
        sourcePath: filePath,
        pluginDir: dir,
      });
    }
  }

  return out;
}

interface ParsedAgent {
  name?: string;
  displayName?: string;
  description?: string;
  tools?: string[];
  body: string;
}

/**
 * Parse a markdown agent file with optional YAML-ish frontmatter.
 * We don't take a yaml dep — we only support flat scalar fields and
 * comma-or-bracket lists. That's enough for `name/description/displayName/tools`.
 */
export function parseAgentFile(raw: string, _filename = ''): ParsedAgent | null {
  const text = raw.replace(/^\uFEFF/, '');
  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);

  let frontmatter = '';
  let body: string;
  if (fmMatch) {
    frontmatter = fmMatch[1];
    body = fmMatch[2];
  } else {
    body = text;
  }

  body = body.trim();
  if (!body) return null;

  const fm: Record<string, string> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    fm[m[1].toLowerCase()] = m[2].trim();
  }

  const name = unquote(fm['name']);
  const displayName = unquote(fm['displayname'] || fm['display_name']);
  const description = unquote(fm['description']);
  const tools = parseToolsList(fm['tools']);

  return {
    ...(name ? { name } : {}),
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    ...(tools ? { tools } : {}),
    body,
  };
}

function unquote(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

function parseToolsList(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  let s = v.trim();
  if (!s) return undefined;
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const items = s
    .split(',')
    .map((t) => unquote(t.trim()) ?? '')
    .filter((t) => t.length > 0);
  return items.length > 0 ? items : undefined;
}

/**
 * Custom agent names are user-visible identifiers. Match the GHC SDK's loose
 * convention: alnum, dash, underscore. Strip everything else; if empty, return ''.
 */
export function sanitizeName(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
