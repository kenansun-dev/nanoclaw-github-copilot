/**
 * Memory loader — reads the long-term `MEMORY.md` plus today's and
 * yesterday's daily memory files for a given group folder, and composes
 * them into a single `additionalContext`-style string suitable for
 * appending to either CC's `systemPrompt.append` or GHC's
 * `systemMessage.content`.
 *
 * Design (Phase 1):
 *   - Pure file reads. No mutation, no daemon, no cron.
 *   - Layout under <groupFolder>/memory/:
 *       MEMORY.md            — long-term curated memories
 *       YYYY-MM-DD.md        — daily journal (today + yesterday loaded)
 *   - Missing files are silently skipped (returns the empty string when
 *     no memory exists at all — caller can use that as a "do not append"
 *     signal).
 *   - All reads bounded by `maxBytesPerFile` (default 64 KiB) to protect
 *     the model's context window. Truncation is marked inline.
 *
 * Phase 2 will add the daily-summary cron that distils the previous
 * day's notes into MEMORY.md. Phase 3 will expose `memory_search` /
 * `memory_write` MCP tools so the agent can curate memory directly.
 */
import fs from 'fs';
import path from 'path';

const DEFAULT_MAX_BYTES = 64 * 1024;

export interface LoadMemoryOptions {
  /** Absolute path to the group folder (e.g. ~/.nanoclaw/groups/{group}). */
  groupFolder: string;
  /** Override "today" for deterministic tests. ISO date (YYYY-MM-DD). */
  today?: string;
  /** Per-file truncation cap. Defaults to 64 KiB. */
  maxBytesPerFile?: number;
}

export interface LoadedMemorySection {
  label: string;
  path: string;
  content: string;
  truncated: boolean;
}

export interface LoadedMemory {
  /** Composed string to inject. Empty when no memory files exist. */
  additionalContext: string;
  /** Sections that were actually found and read (for logging / tests). */
  sections: LoadedMemorySection[];
  /** Memory dir path (created lazily by loader; useful for skill hint). */
  memoryDir: string;
}

/**
 * Format a Date into a `YYYY-MM-DD` local-date string.
 *
 * We use local time (not UTC) so "today" matches what the user sees
 * when they open the daily file. Off-by-one across midnight is
 * acceptable; both today and yesterday are loaded anyway.
 */
export function formatLocalDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateMinusDays(iso: string, days: number): string {
  // iso is YYYY-MM-DD — parse as local midnight to avoid TZ surprises.
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - days);
  return formatLocalDate(dt);
}

function readBounded(
  filePath: string,
  maxBytes: number,
): { content: string; truncated: boolean } | null {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return null;
  if (stat.size <= maxBytes) {
    return { content: fs.readFileSync(filePath, 'utf-8'), truncated: false };
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, 0);
    return {
      content:
        buf.toString('utf-8') +
        `\n\n[... truncated: file is ${stat.size} bytes, showing first ${maxBytes}]`,
      truncated: true,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Load memory files for a group and compose them into a single
 * additionalContext string. Safe to call when nothing exists yet —
 * returns an empty `additionalContext` and an empty `sections` list.
 */
export function loadMemory(opts: LoadMemoryOptions): LoadedMemory {
  const memoryDir = path.join(opts.groupFolder, 'memory');
  const maxBytes = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES;
  const today = opts.today ?? formatLocalDate(new Date());
  const yesterday = dateMinusDays(today, 1);

  const candidates: { label: string; path: string }[] = [
    { label: 'Long-term memory (MEMORY.md)', path: path.join(memoryDir, 'MEMORY.md') },
    { label: `Today's journal (${today}.md)`, path: path.join(memoryDir, `${today}.md`) },
    {
      label: `Yesterday's journal (${yesterday}.md)`,
      path: path.join(memoryDir, `${yesterday}.md`),
    },
  ];

  const sections: LoadedMemorySection[] = [];
  for (const c of candidates) {
    const result = readBounded(c.path, maxBytes);
    if (result === null) continue;
    sections.push({
      label: c.label,
      path: c.path,
      content: result.content,
      truncated: result.truncated,
    });
  }

  if (sections.length === 0) {
    return { additionalContext: '', sections, memoryDir };
  }

  // Compose. Frame with a clear header so the model knows this is
  // injected memory and not part of the user's prompt.
  const header = [
    '# NanoClaw Memory',
    '',
    `The following content was loaded from \`${memoryDir}\` and is your`,
    'long-term + recent memory for this group. Treat it as authoritative',
    'context but do not echo it back unless the user asks. When you learn',
    'something worth remembering, append to today\'s journal file or',
    '`MEMORY.md` directly using the Write/Edit tools.',
    '',
    '---',
    '',
  ].join('\n');

  const body = sections
    .map((s) => `## ${s.label}\n\n${s.content.trim()}\n`)
    .join('\n---\n\n');

  return {
    additionalContext: header + body,
    sections,
    memoryDir,
  };
}

/**
 * Convenience wrapper for runner code: derive the memory dir from
 * `NANOCLAW_MEMORY_DIR` (set by host-runner) or fall back to the
 * conventional `<NANOCLAW_WORK_DIR>/memory` path used inside the
 * container.
 */
export function loadMemoryFromEnv(): LoadedMemory {
  const explicit = process.env.NANOCLAW_MEMORY_DIR;
  const workDir = process.env.NANOCLAW_WORK_DIR || '/workspace/group';
  const memoryDir = explicit ?? path.join(workDir, 'memory');
  return loadMemory({ groupFolder: path.dirname(memoryDir) });
}
