import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { loadMemory, formatLocalDate } from './loader.js';

describe('memory loader', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mem-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns empty when memory dir does not exist', () => {
    const result = loadMemory({ groupFolder: tmp });
    expect(result.additionalContext).toBe('');
    expect(result.sections).toEqual([]);
  });

  it('returns empty when memory dir exists but has no files', () => {
    fs.mkdirSync(path.join(tmp, 'memory'));
    const result = loadMemory({ groupFolder: tmp });
    expect(result.additionalContext).toBe('');
    expect(result.sections).toEqual([]);
  });

  it('loads MEMORY.md when present', () => {
    const memDir = path.join(tmp, 'memory');
    fs.mkdirSync(memDir);
    fs.writeFileSync(
      path.join(memDir, 'MEMORY.md'),
      '# Long-term\nUser likes tea.',
    );
    const result = loadMemory({ groupFolder: tmp, today: '2026-04-19' });
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].label).toContain('MEMORY.md');
    expect(result.additionalContext).toContain('User likes tea.');
    expect(result.additionalContext).toContain('# NanoClaw Memory');
  });

  it('loads today and yesterday journal files when present', () => {
    const memDir = path.join(tmp, 'memory');
    fs.mkdirSync(memDir);
    fs.writeFileSync(
      path.join(memDir, '2026-04-19.md'),
      'Today: shipped Phase 1',
    );
    fs.writeFileSync(
      path.join(memDir, '2026-04-18.md'),
      'Yesterday: spike done',
    );
    const result = loadMemory({ groupFolder: tmp, today: '2026-04-19' });
    expect(result.sections).toHaveLength(2);
    expect(result.additionalContext).toContain('shipped Phase 1');
    expect(result.additionalContext).toContain('spike done');
  });

  it('loads all three (MEMORY + today + yesterday) and orders correctly', () => {
    const memDir = path.join(tmp, 'memory');
    fs.mkdirSync(memDir);
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), 'LONG');
    fs.writeFileSync(path.join(memDir, '2026-04-19.md'), 'TODAY');
    fs.writeFileSync(path.join(memDir, '2026-04-18.md'), 'YESTERDAY');
    const result = loadMemory({ groupFolder: tmp, today: '2026-04-19' });
    expect(result.sections.map((s) => s.label[0])).toEqual(['L', 'T', 'Y']);
    const ctx = result.additionalContext;
    // Long-term comes first, today next, yesterday last.
    expect(ctx.indexOf('LONG')).toBeLessThan(ctx.indexOf('TODAY'));
    expect(ctx.indexOf('TODAY')).toBeLessThan(ctx.indexOf('YESTERDAY'));
  });

  it('truncates files that exceed maxBytesPerFile', () => {
    const memDir = path.join(tmp, 'memory');
    fs.mkdirSync(memDir);
    const big = 'x'.repeat(2000);
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), big);
    const result = loadMemory({
      groupFolder: tmp,
      today: '2026-04-19',
      maxBytesPerFile: 100,
    });
    expect(result.sections[0].truncated).toBe(true);
    expect(result.additionalContext).toContain('truncated: file is 2000 bytes');
    // Body should contain ~100 bytes of x's, not the full 2000.
    expect(result.sections[0].content.length).toBeLessThan(300);
  });

  it('handles dates that cross month/year boundaries', () => {
    const memDir = path.join(tmp, 'memory');
    fs.mkdirSync(memDir);
    fs.writeFileSync(path.join(memDir, '2026-01-01.md'), 'NewYear');
    fs.writeFileSync(path.join(memDir, '2025-12-31.md'), 'NYE');
    const result = loadMemory({ groupFolder: tmp, today: '2026-01-01' });
    expect(result.additionalContext).toContain('NewYear');
    expect(result.additionalContext).toContain('NYE');
  });

  it('formatLocalDate produces YYYY-MM-DD', () => {
    expect(formatLocalDate(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(formatLocalDate(new Date(2026, 11, 31))).toBe('2026-12-31');
  });

  it('skips non-file entries with the same name', () => {
    const memDir = path.join(tmp, 'memory');
    fs.mkdirSync(memDir);
    fs.mkdirSync(path.join(memDir, 'MEMORY.md')); // dir, not file
    fs.writeFileSync(path.join(memDir, '2026-04-19.md'), 'OK');
    const result = loadMemory({ groupFolder: tmp, today: '2026-04-19' });
    expect(
      result.sections.find((s) => s.label.includes('MEMORY.md')),
    ).toBeUndefined();
    expect(result.additionalContext).toContain('OK');
  });
});
