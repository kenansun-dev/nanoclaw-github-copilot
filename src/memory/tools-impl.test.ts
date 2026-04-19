/**
 * Unit tests for the nanoclaw-memory MCP server's pure helpers.
 *
 * The MCP server itself is a binary (stdio transport), so we test the
 * tool implementations indirectly by importing from a tested helper
 * extraction. To keep tests dependency-free of the MCP transport, we
 * test the file IO + naming helpers via a minimal sibling module
 * (memory-tools-impl.ts) that the server delegates to.
 *
 * If we want richer tests later, we can spawn the server over stdio
 * and exercise the MCP protocol end-to-end. For now, unit-test the
 * critical pieces: filename safety, local-time date, search, and
 * append/promote behaviour.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  appendToday,
  promoteToMemory,
  searchMemory,
  todayLocal,
  isSafeMemoryFile,
} from './tools-impl.js';

describe('memory-tools-impl', () => {
  let tmp: string;
  let memDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mem-'));
    memDir = path.join(tmp, 'memory');
    fs.mkdirSync(memDir);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('isSafeMemoryFile', () => {
    it('accepts plain *.md filenames', () => {
      expect(isSafeMemoryFile('MEMORY.md')).toBe('MEMORY.md');
      expect(isSafeMemoryFile('2026-04-19.md')).toBe('2026-04-19.md');
      expect(isSafeMemoryFile('notes_2026.md')).toBe('notes_2026.md');
    });

    it('rejects path traversal', () => {
      expect(isSafeMemoryFile('../etc/passwd')).toBeNull();
      expect(isSafeMemoryFile('foo/bar.md')).toBeNull();
      expect(isSafeMemoryFile('./MEMORY.md')).toBeNull();
    });

    it('rejects hidden files', () => {
      expect(isSafeMemoryFile('.dreams.md')).toBeNull();
    });

    it('rejects non-md files', () => {
      expect(isSafeMemoryFile('MEMORY.txt')).toBeNull();
      expect(isSafeMemoryFile('script.sh')).toBeNull();
    });
  });

  describe('todayLocal', () => {
    it('returns YYYY-MM-DD format', () => {
      const date = todayLocal('UTC');
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('respects timezone (Asia/Shanghai is UTC+8 \u2014 may differ from UTC date)', () => {
      // Just verify we can call with different TZs without throwing.
      const utc = todayLocal('UTC');
      const sh = todayLocal('Asia/Shanghai');
      const la = todayLocal('America/Los_Angeles');
      expect(utc).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(sh).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(la).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('falls back gracefully on unknown timezone', () => {
      const result = todayLocal('Not/AReal/TZ');
      // Should still return a valid date (even if formatter throws,
      // implementation falls back to UTC).
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('appendToday', () => {
    it('creates a new daily file with header on first call', () => {
      const result = appendToday(memDir, 'first note', 'UTC');
      expect(result.created).toBe(true);
      const date = todayLocal('UTC');
      const filePath = path.join(memDir, `${date}.md`);
      expect(fs.existsSync(filePath)).toBe(true);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain(`# ${date}`);
      expect(content).toContain('first note');
    });

    it('appends without header on subsequent calls', () => {
      appendToday(memDir, 'first note', 'UTC');
      const result = appendToday(memDir, 'second note', 'UTC');
      expect(result.created).toBe(false);
      const date = todayLocal('UTC');
      const content = fs.readFileSync(path.join(memDir, `${date}.md`), 'utf-8');
      // Header appears exactly once
      const headerCount = (content.match(new RegExp(`# ${date}`, 'g')) || [])
        .length;
      expect(headerCount).toBe(1);
      expect(content).toContain('first note');
      expect(content).toContain('second note');
    });

    it('includes a local-time HH:MM prefix in each entry', () => {
      appendToday(memDir, 'time-prefixed', 'UTC');
      const date = todayLocal('UTC');
      const content = fs.readFileSync(path.join(memDir, `${date}.md`), 'utf-8');
      expect(content).toMatch(/\*\*\d{2}:\d{2}\*\*/);
    });
  });

  describe('promoteToMemory', () => {
    it('creates MEMORY.md when missing and adds the section', () => {
      const result = promoteToMemory(
        memDir,
        'User prefers Chinese over English in casual chat',
        'User preferences',
        'UTC',
      );
      expect(result.section).toBe('User preferences');
      const text = fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf-8');
      expect(text).toContain('## User preferences');
      expect(text).toContain('User prefers Chinese');
    });

    it('adds new section when MEMORY.md exists but section does not', () => {
      fs.writeFileSync(
        path.join(memDir, 'MEMORY.md'),
        '# MEMORY.md\n\n## Existing\n\n- Old fact\n',
      );
      promoteToMemory(memDir, 'New thing', 'Different', 'UTC');
      const text = fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf-8');
      expect(text).toContain('## Existing');
      expect(text).toContain('Old fact');
      expect(text).toContain('## Different');
      expect(text).toContain('New thing');
    });

    it('appends to existing section without disturbing later sections', () => {
      fs.writeFileSync(
        path.join(memDir, 'MEMORY.md'),
        '# MEMORY.md\n\n## Notes\n\n- First note\n\n## Later\n\n- Later content\n',
      );
      promoteToMemory(memDir, 'Second note', 'Notes', 'UTC');
      const text = fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf-8');
      // Order preserved: Notes section contains both bullets, Later section intact
      const notesIdx = text.indexOf('## Notes');
      const laterIdx = text.indexOf('## Later');
      expect(notesIdx).toBeLessThan(laterIdx);
      const between = text.slice(notesIdx, laterIdx);
      expect(between).toContain('First note');
      expect(between).toContain('Second note');
      expect(text.slice(laterIdx)).toContain('Later content');
    });

    it('defaults section to "Notes" when omitted', () => {
      promoteToMemory(memDir, 'Default-section fact', undefined, 'UTC');
      const text = fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf-8');
      expect(text).toContain('## Notes');
      expect(text).toContain('Default-section fact');
    });
  });

  describe('searchMemory', () => {
    beforeEach(() => {
      fs.writeFileSync(
        path.join(memDir, 'MEMORY.md'),
        '# MEMORY.md\n\nUser likes the colour green.\nDislikes verbose replies.\n',
      );
      fs.writeFileSync(
        path.join(memDir, '2026-04-18.md'),
        '# 2026-04-18\n\n- Made a decision about green widgets\n- Ate noodles for lunch\n',
      );
      fs.writeFileSync(
        path.join(memDir, '2026-04-19.md'),
        '# 2026-04-19\n\n- Shipped memory PR\n- Reviewed cache stats\n',
      );
    });

    it('finds substrings case-insensitively across all md files', () => {
      const hits = searchMemory(memDir, 'green', 20);
      expect(hits.length).toBe(2);
      const files = hits.map((h) => h.file).sort();
      expect(files).toEqual(['2026-04-18.md', 'MEMORY.md']);
    });

    it('returns ±3 lines of context', () => {
      const hits = searchMemory(memDir, 'noodles', 10);
      expect(hits[0].context).toContain('Made a decision');
      expect(hits[0].context).toContain('noodles');
    });

    it('respects max_hits cap', () => {
      const hits = searchMemory(memDir, 'a', 2);
      expect(hits.length).toBeLessThanOrEqual(2);
    });

    it('returns empty array on no match', () => {
      const hits = searchMemory(memDir, 'definitely-not-present-xyz', 20);
      expect(hits).toEqual([]);
    });

    it('skips hidden files', () => {
      fs.writeFileSync(
        path.join(memDir, '.hidden.md'),
        'green should not match here',
      );
      const hits = searchMemory(memDir, 'green', 20);
      // Still 2 (MEMORY.md + 2026-04-18.md), hidden file excluded
      expect(hits.length).toBe(2);
    });
  });
});
