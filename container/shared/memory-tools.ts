/**
 * Memory tools — shared across all nanoclaw MCP server entry points.
 *
 * SOURCE OF TRUTH: container/shared/memory-tools.ts
 *
 * This file is **build-time copied** into:
 *   - container/agent-runner-ghc/src/memory-tools.ts
 *   - container/agent-runner/src/memory-tools.ts
 *
 * Do NOT edit the copies; edit this file and run `npm run build` (the
 * build script handles the copy via container/shared/sync.sh).
 *
 * Usage in each runner's ipc-mcp-stdio.ts:
 *
 *   import { registerMemoryTools } from './memory-tools.js';
 *   registerMemoryTools(server);
 *
 * The tools read $NANOCLAW_MEMORY_DIR (set by host) or fall back to
 * `<groupFolder>/memory`. Date/time formatting uses $NANOCLAW_TZ (set
 * by host from nanoclaw.json `timezone`) so daily filenames are local.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const MEMORY_SAFE_PATH_RE = /^[A-Za-z0-9._-]+\.md$/;

function memoryDir(): string {
  if (process.env.NANOCLAW_MEMORY_DIR) return process.env.NANOCLAW_MEMORY_DIR;
  const gf =
    process.env.NANOCLAW_GROUP_FOLDER ||
    process.env.NANOCLAW_WORK_DIR ||
    process.cwd();
  return path.join(gf, 'memory');
}

function memoryTz(): string {
  return (
    process.env.NANOCLAW_TZ ||
    process.env.TZ ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'UTC'
  );
}

function memoryTodayLocal(tz: string): string {
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

function memoryNowTime(tz: string): string {
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

function memorySafeName(name: string): string | null {
  if (!MEMORY_SAFE_PATH_RE.test(name)) return null;
  if (name.startsWith('.')) return null;
  return name;
}

function memoryReadSafe(abs: string, maxBytes = 256 * 1024): string {
  if (!fs.existsSync(abs)) return '';
  const stat = fs.statSync(abs);
  if (stat.size <= maxBytes) return fs.readFileSync(abs, 'utf-8');
  const fd = fs.openSync(abs, 'r');
  try {
    const head = Buffer.alloc(Math.floor(maxBytes / 2));
    fs.readSync(fd, head, 0, head.length, 0);
    const tail = Buffer.alloc(Math.floor(maxBytes / 2));
    fs.readSync(fd, tail, 0, tail.length, stat.size - tail.length);
    return (
      head.toString('utf-8') +
      `\n\n... [truncated ${stat.size - maxBytes} bytes] ...\n\n` +
      tail.toString('utf-8')
    );
  } finally {
    fs.closeSync(fd);
  }
}

export function registerMemoryTools(server: McpServer): void {
  server.tool(
    'memory_list',
    'List per-group memory files (MEMORY.md long-term + YYYY-MM-DD.md daily journals). Returns each file with size, mtime, and a one-line preview. Cheap; run before reading or appending if unsure what exists.',
    {},
    async () => {
      const dir = memoryDir();
      fs.mkdirSync(dir, { recursive: true });
      const tz = memoryTz();
      const entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => {
          const abs = path.join(dir, e.name);
          const stat = fs.statSync(abs);
          const head = memoryReadSafe(abs, 200).trim().split('\n')[0] ?? '';
          return {
            name: e.name,
            bytes: stat.size,
            mtime: stat.mtime.toISOString(),
            preview: head.slice(0, 120),
          };
        })
        .sort((a, b) => (a.name < b.name ? 1 : -1));
      const lines = [
        `# Memory directory: ${dir}`,
        `Local timezone: ${tz} | Today (local): ${memoryTodayLocal(tz)}`,
        `Total files: ${entries.length}`,
        '',
        ...entries.map(
          (e) =>
            `- **${e.name}** (${e.bytes} bytes, mtime ${e.mtime})\n  > ${e.preview}`,
        ),
      ];
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  server.tool(
    'memory_read',
    'Read a specific memory file (MEMORY.md for long-term, YYYY-MM-DD.md for a daily journal). Files larger than 256 KB are head/tail truncated.',
    {
      file: z
        .string()
        .describe('Filename within the memory dir, e.g. MEMORY.md or 2026-04-19.md'),
    },
    async (args) => {
      const dir = memoryDir();
      const safe = memorySafeName(args.file);
      if (!safe) {
        return {
          content: [
            { type: 'text' as const, text: `Error: invalid filename: ${args.file}` },
          ],
        };
      }
      const abs = path.join(dir, safe);
      if (!fs.existsSync(abs)) {
        return {
          content: [{ type: 'text' as const, text: `(no such file: ${safe})` }],
        };
      }
      return {
        content: [{ type: 'text' as const, text: memoryReadSafe(abs) }],
      };
    },
  );

  server.tool(
    'memory_search',
    'Substring-search across all per-group memory files (case-insensitive). Returns up to N hits with \u00b13 lines of context. Use this to recall past events or facts before answering.',
    {
      query: z.string().min(1).describe('Substring to search for'),
      max_hits: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Max hits to return (default 20)'),
    },
    async (args) => {
      const dir = memoryDir();
      if (!fs.existsSync(dir)) {
        return {
          content: [
            { type: 'text' as const, text: `No matches for "${args.query}".` },
          ],
        };
      }
      const max = args.max_hits ?? 20;
      const needle = args.query.toLowerCase();
      const hits: { file: string; lineno: number; context: string }[] = [];
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith('.md')) continue;
        if (entry.startsWith('.')) continue;
        const abs = path.join(dir, entry);
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
            if (hits.length >= max) break;
          }
        }
        if (hits.length >= max) break;
      }
      if (hits.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: `No matches for "${args.query}".` },
          ],
        };
      }
      const out = hits
        .map((h) => `--- ${h.file}:${h.lineno} ---\n${h.context}`)
        .join('\n\n');
      return { content: [{ type: 'text' as const, text: out }] };
    },
  );

  server.tool(
    'memory_append_today',
    "Append a note to TODAY's daily journal (YYYY-MM-DD.md, local time). Use for capturing events, decisions, or anything worth recalling tomorrow. NEVER store secrets, tokens, or PII. Each call adds ONE bullet with a local-time HH:MM prefix \u2014 call multiple times for multiple highlights so each gets its own timestamp.",
    {
      note: z.string().min(1).describe('The single note to append (markdown supported)'),
    },
    async (args) => {
      const dir = memoryDir();
      fs.mkdirSync(dir, { recursive: true });
      const tz = memoryTz();
      const date = memoryTodayLocal(tz);
      const filename = `${date}.md`;
      const abs = path.join(dir, filename);
      const time = memoryNowTime(tz);
      const created = !fs.existsSync(abs);
      const header = created ? `# ${date} (${tz})\n\n` : '';
      const entry = `- **${time}** \u2014 ${args.note.trim()}\n`;
      fs.appendFileSync(abs, header + entry, 'utf-8');
      return {
        content: [
          {
            type: 'text' as const,
            text: `Appended to ${filename} at ${time} ${tz}.`,
          },
        ],
      };
    },
  );

  server.tool(
    'memory_promote',
    'Promote a durable fact into MEMORY.md (curated long-term memory). Use sparingly: only for facts that should persist across many days/weeks (preferences, hard rules, important context). Daily/transient stuff belongs in memory_append_today. NEVER store secrets.',
    {
      fact: z.string().min(1).describe('The fact to remember long-term'),
      section: z
        .string()
        .optional()
        .describe(
          'Optional H2 section heading to file under (e.g. "User preferences"). Defaults to "Notes".',
        ),
    },
    async (args) => {
      const dir = memoryDir();
      fs.mkdirSync(dir, { recursive: true });
      const abs = path.join(dir, 'MEMORY.md');
      const sectionTitle = (args.section ?? 'Notes').trim() || 'Notes';
      const heading = `## ${sectionTitle}`;
      let text = fs.existsSync(abs)
        ? fs.readFileSync(abs, 'utf-8')
        : '# MEMORY.md\n\n';
      if (!text.endsWith('\n')) text += '\n';
      const dateStamp = memoryTodayLocal(memoryTz());
      const bullet = `- (${dateStamp}) ${args.fact.trim()}`;
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
      return {
        content: [
          {
            type: 'text' as const,
            text: `Promoted to MEMORY.md under "${sectionTitle}" (${dateStamp}).`,
          },
        ],
      };
    },
  );
}

// ─── Internals exported for unit tests only ─────────────────────────────────
export const __test = {
  memoryDir,
  memoryTz,
  memoryTodayLocal,
  memoryNowTime,
  memorySafeName,
  memoryReadSafe,
};
