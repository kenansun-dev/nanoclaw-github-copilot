import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

/**
 * Source guard for the Windows console-flicker regression (kenan, 2026-06-26).
 *
 * The win32 daemon lifecycle paths must NOT shell out to `taskkill`/`tasklist`/
 * `schtasks`/`reg` via string-form `execSync('… cmd string …')` /
 * `execAsync('… cmd string …')` — that routes through `cmd.exe` and flashes a
 * console window. They must use the `winExec*` helpers (execFile + windowsHide).
 *
 * This test reads the actual source files and fails if a banned string-form
 * invocation reappears, so a future edit can't silently reintroduce the flicker.
 */

const here = dirname(fileURLToPath(import.meta.url));

function read(rel: string): string {
  return readFileSync(join(here, rel), 'utf-8');
}

// Match execSync/execAsync called with a STRING (template or quote) that starts
// a banned win32 console command. We only flag the string-form; array-form
// execFile via winExec* is fine.
const BANNED = /\bexec(?:Sync|Async)\s*\(\s*[`'"][^`'"]*\b(taskkill|tasklist|schtasks|reg query)\b/;

// Files that must never reintroduce a string-form win32 console shell-out.
// win-process.ts is excluded here because it *documents* the banned pattern in
// comments (and contains no real shell-out); it is covered by the export check.
const GUARDED_FILES = ['cli.ts', 'cli/update.ts', 'host-runner.ts', 'group-queue.ts'];

describe('win console-flicker source guard', () => {
  for (const f of GUARDED_FILES) {
    it(`${f} has no string-form execSync/execAsync taskkill/tasklist/schtasks/reg`, () => {
      const src = read(f);
      const match = src.match(BANNED);
      expect(match, match ? `Found banned string-form win32 shell-out: "${match[0]}"` : '').toBeNull();
    });
  }

  it('win-process.ts exports the hidden-exec helpers', () => {
    const src = read('win-process.ts');
    expect(src).toContain('export function winExecSync');
    expect(src).toContain('export async function winExecAsync');
    expect(src).toContain('windowsHide: true');
  });
});
