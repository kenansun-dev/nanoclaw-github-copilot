/**
 * Regression tests for `nanoclaw status` Logs path reporting.
 *
 * v2-merge B.5 (`55b4fe6`) restored daily-rotated log files
 * (`nanoclaw-YYYY-MM-DD.log`), but `cli/status-text.ts`,
 * `workspace.ts paths.logFile`, and `cli.ts runStart`/`runLogs` kept
 * reporting the legacy `nanoclaw.log` path. Result: `/status` showed
 * a stale path, `nanoclaw logs` failed to find anything.
 *
 * 2026-05-09 followup: route all callers through `paths.logFile`
 * which now returns today's daily file.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

import { paths } from '../workspace.js';

describe('paths.logFile (workspace.ts)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns today's daily-rotated file under <ws>/logs/", () => {
    const lf = paths.logFile;
    const base = path.basename(lf);
    expect(base).toMatch(/^nanoclaw-\d{4}-\d{2}-\d{2}\.log$/);
    expect(path.dirname(lf).endsWith(path.join('logs'))).toBe(true);
  });

  it('embeds the current local date', () => {
    // Freeze clock at 2026-07-04 noon local time.
    const fixed = new Date(2026, 6, 4, 12, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(fixed);
    expect(path.basename(paths.logFile)).toBe('nanoclaw-2026-07-04.log');
  });

  it('does NOT report the legacy single-file path', () => {
    expect(path.basename(paths.logFile)).not.toBe('nanoclaw.log');
  });
});
