/**
 * Pure-function implementation of the nanoclaw-memory MCP tools.
 *
 * This module is the *canonical* implementation tested by
 * `tools-impl.test.ts`. The two MCP server entry points
 * (`container/agent-runner{,-ghc}/mcp-servers/memory/index.ts`) inline
 * the same logic for runtime independence (each MCP server is a
 * self-contained npm-publishable artifact). If you change behaviour
 * here, mirror the change in both server index.ts files.
 *
 * Local-time discipline: all date/time formatting uses the supplied
 * `tz` (IANA timezone). The MCP servers pass NANOCLAW_TZ (set by host
 * from `nanoclaw.json` `timezone`).
 */
import fs from 'fs';
import path from 'path';

const SAFE_PATH_RE = /^[A-Za-z0-9._-]+\.md$/;

export function isSafeMemoryFile(name: string): string | null {
  if (!SAFE_PATH_RE.test(name)) return null;
  if (name.startsWith('.')) return null;
  return name;
}

/**
 * Today's date in the supplied IANA timezone, formatted YYYY-MM-DD.
 * Falls back to UTC if the formatter throws (unknown TZ).
 */
export function todayLocal(tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }
}

function nowLocalTime(tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date());
  }
}

export interface AppendResult {
  filename: string;
  created: boolean;
  time: string;
}

export function appendToday(
  memDir: string,
  note: string,
  tz: string,
): AppendResult {
  fs.mkdirSync(memDir, { recursive: true });
  const date = todayLocal(tz);
  const filename = `${date}.md`;
  const abs = path.join(memDir, filename);
  const time = nowLocalTime(tz);
  const created = !fs.existsSync(abs);
  const header = created ? `# ${date} (${tz})\n\n` : '';
  const entry = `- **${time}** \u2014 ${note.trim()}\n`;
  fs.appendFileSync(abs, header + entry, 'utf-8');
  return { filename, created, time };
}

export interface PromoteResult {
  section: string;
}

export function promoteToMemory(
  memDir: string,
  fact: string,
  section: string | undefined,
  tz: string,
): PromoteResult {
  fs.mkdirSync(memDir, { recursive: true });
  const abs = path.join(memDir, 'MEMORY.md');
  const sectionTitle = (section ?? 'Notes').trim() || 'Notes';
  const heading = `## ${sectionTitle}`;

  let text = fs.existsSync(abs)
    ? fs.readFileSync(abs, 'utf-8')
    : '# MEMORY.md\n\n';
  if (!text.endsWith('\n')) text += '\n';

  const dateStamp = todayLocal(tz);
  const bullet = `- (${dateStamp}) ${fact.trim()}`;

  if (text.includes(heading)) {
    const lines = text.split('\n');
    const startIdx = lines.findIndex((l) => l.trim() === heading);
    let insertIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) {
        insertIdx = i;
        break;
      }
    }
    while (insertIdx > startIdx + 1 && lines[insertIdx - 1].trim() === '') {
      insertIdx--;
    }
    lines.splice(insertIdx, 0, bullet);
    text = lines.join('\n');
    if (!text.endsWith('\n')) text += '\n';
  } else {
    text += `\n${heading}\n\n${bullet}\n`;
  }
  fs.writeFileSync(abs, text, 'utf-8');
  return { section: sectionTitle };
}

export interface SearchHit {
  file: string;
  lineno: number;
  context: string;
}

export function searchMemory(
  memDir: string,
  query: string,
  maxHits: number,
): SearchHit[] {
  if (!fs.existsSync(memDir)) return [];
  const needle = query.toLowerCase();
  const hits: SearchHit[] = [];
  for (const entry of fs.readdirSync(memDir)) {
    if (!entry.endsWith('.md')) continue;
    if (entry.startsWith('.')) continue;
    const abs = path.join(memDir, entry);
    let text: string;
    try {
      text = fs.readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        const start = Math.max(0, i - 3);
        const end = Math.min(lines.length, i + 4);
        hits.push({
          file: entry,
          lineno: i + 1,
          context: lines.slice(start, end).join('\n'),
        });
        if (hits.length >= maxHits) return hits;
      }
    }
  }
  return hits;
}
