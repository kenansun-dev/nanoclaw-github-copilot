/**
 * Memory MCP Server for NanoClaw
 *
 * Provides per-group memory tools so the agent can read & write its own
 * long-term and daily memory on demand:
 *
 *   - memory_list           : list available memory files (sizes + dates)
 *   - memory_read           : read MEMORY.md or a specific daily journal
 *   - memory_search         : naive substring search across all memory files
 *   - memory_append_today   : append a line/paragraph to today's daily journal
 *   - memory_promote        : promote a fact into MEMORY.md (long-term)
 *
 * Storage layout (resolved from $NANOCLAW_MEMORY_DIR, falls back to
 * $NANOCLAW_GROUP_FOLDER/memory):
 *
 *   <memoryDir>/
 *     MEMORY.md              <- long-term curated memory
 *     YYYY-MM-DD.md          <- per-day journal (local time)
 *     .dreams/               <- reserved for cron summarizer state
 *
 * Local-time dates: we use the runtime's resolved timezone (NANOCLAW_TZ
 * env, falls back to system TZ, falls back to UTC). The host sets
 * NANOCLAW_TZ to the configured `timezone` value before spawning.
 *
 * This server is intentionally simple and dependency-free beyond the
 * MCP SDK + zod \u2014 no embeddings, no vector store. Phase 2 can layer
 * smarter retrieval on top via the dreaming pipeline.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveMemoryDir(): string {
  if (process.env.NANOCLAW_MEMORY_DIR) {
    return process.env.NANOCLAW_MEMORY_DIR;
  }
  const groupFolder =
    process.env.NANOCLAW_GROUP_FOLDER ||
    process.env.NANOCLAW_WORK_DIR ||
    process.cwd();
  return path.join(groupFolder, 'memory');
}

function ensureMemoryDir(): string {
  const dir = resolveMemoryDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function resolveTz(): string {
  return (
    process.env.NANOCLAW_TZ ||
    process.env.TZ ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'UTC'
  );
}

/**
 * Today's date in the configured local timezone, formatted YYYY-MM-DD.
 */
function todayLocal(): string {
  const tz = resolveTz();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date());
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_PATH_RE = /^[A-Za-z0-9._-]+\.md$/;

/**
 * Validate a user-supplied filename is a flat *.md file inside the memory
 * directory (no directory traversal, no subdirs).
 */
function safeMemoryFile(name: string): string | null {
  if (!SAFE_PATH_RE.test(name)) return null;
  if (name.startsWith('.')) return null; // no hidden files (.dreams etc.)
  return name;
}

function readFileSafe(absPath: string, maxBytes = 256 * 1024): string {
  if (!fs.existsSync(absPath)) return '';
  const stat = fs.statSync(absPath);
  if (stat.size <= maxBytes) {
    return fs.readFileSync(absPath, 'utf-8');
  }
  // Truncate large files: read head + tail.
  const fd = fs.openSync(absPath, 'r');
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

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'nanoclaw-memory',
  version: '1.0.0',
});

server.tool(
  'memory_list',
  'List memory files in the current group: MEMORY.md (long-term) plus all per-day journal files (YYYY-MM-DD.md). Returns each file with size, mtime, and a one-line preview. Use this before reading or appending to know what exists.',
  {},
  async () => {
    const dir = ensureMemoryDir();
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => {
        const abs = path.join(dir, e.name);
        const stat = fs.statSync(abs);
        const head = readFileSafe(abs, 200).trim().split('\n')[0] ?? '';
        return {
          name: e.name,
          bytes: stat.size,
          mtime: stat.mtime.toISOString(),
          preview: head.slice(0, 120),
        };
      })
      .sort((a, b) => (a.name < b.name ? 1 : -1)); // newest first by name

    const lines = [
      `# Memory directory: ${dir}`,
      `Local timezone: ${resolveTz()} | Today (local): ${todayLocal()}`,
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
  'Read a specific memory file. Pass `file: "MEMORY.md"` for long-term memory, or `file: "YYYY-MM-DD.md"` for a daily journal. Files larger than 256 KB are head/tail truncated.',
  {
    file: z
      .string()
      .describe('Filename within the memory directory, e.g. MEMORY.md or 2026-04-19.md'),
  },
  async (args) => {
    const dir = ensureMemoryDir();
    const safe = safeMemoryFile(args.file);
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
        content: [
          { type: 'text' as const, text: `(no such file: ${safe})` },
        ],
      };
    }
    return {
      content: [{ type: 'text' as const, text: readFileSafe(abs) }],
    };
  },
);

server.tool(
  'memory_search',
  'Search across all memory files for a substring (case-insensitive). Returns up to 20 hits with surrounding context (\u00b13 lines). Use this to find specific past events or facts before answering questions about history.',
  {
    query: z.string().min(1).describe('Substring to search for'),
    max_hits: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of hits to return (default 20)'),
  },
  async (args) => {
    const dir = ensureMemoryDir();
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
      .map(
        (h) =>
          `--- ${h.file}:${h.lineno} ---\n${h.context}`,
      )
      .join('\n\n');
    return { content: [{ type: 'text' as const, text: out }] };
  },
);

server.tool(
  'memory_append_today',
  "Append a note to TODAY's daily journal (YYYY-MM-DD.md, local time). Use for capturing events, decisions, conversations, or anything worth remembering for the next day or two. NEVER store secrets, API keys, or passwords. Each call adds a new bullet with a local-time HH:MM prefix.",
  {
    note: z.string().min(1).describe('The note to append (markdown supported)'),
  },
  async (args) => {
    const dir = ensureMemoryDir();
    const filename = `${todayLocal()}.md`;
    const abs = path.join(dir, filename);
    const tz = resolveTz();
    const time = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date());

    const isNew = !fs.existsSync(abs);
    const header = isNew ? `# ${todayLocal()} (${tz})\n\n` : '';
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
  'Promote a durable fact into MEMORY.md (the curated long-term memory). Use sparingly: only for facts that should persist across many days/weeks (user preferences, hard rules, important context). Daily/transient stuff belongs in memory_append_today instead. NEVER store secrets.',
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
    const dir = ensureMemoryDir();
    const abs = path.join(dir, 'MEMORY.md');
    const sectionTitle = (args.section ?? 'Notes').trim() || 'Notes';
    const heading = `## ${sectionTitle}`;

    let text = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : '# MEMORY.md\n\n';
    if (!text.endsWith('\n')) text += '\n';

    const dateStamp = todayLocal();
    const bullet = `- (${dateStamp}) ${args.fact.trim()}\n`;

    if (text.includes(heading)) {
      // Append after the existing heading block: insert before the next H2 (or EOF).
      const lines = text.split('\n');
      const startIdx = lines.findIndex((l) => l.trim() === heading);
      let insertIdx = lines.length;
      for (let i = startIdx + 1; i < lines.length; i++) {
        if (lines[i].startsWith('## ')) {
          insertIdx = i;
          break;
        }
      }
      // Trim trailing blank lines in the section.
      while (insertIdx > startIdx + 1 && lines[insertIdx - 1].trim() === '') {
        insertIdx--;
      }
      lines.splice(insertIdx, 0, bullet.trimEnd());
      text = lines.join('\n');
      if (!text.endsWith('\n')) text += '\n';
    } else {
      text += `\n${heading}\n\n${bullet}`;
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

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
