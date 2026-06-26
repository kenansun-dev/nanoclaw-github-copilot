import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Run a binary directly (no shell) with the OS console window suppressed.
 *
 * Why this exists (kenan's Windows console-flicker report, 2026-06-26):
 * Node's string-form `execSync('taskkill /F /PID 123')` / `execAsync(...)` on
 * win32 ALWAYS routes through `cmd.exe /d /s /c "<string>"`, and Node spawns
 * that helper with `windowsHide: false` by default. Result: every lifecycle
 * shell-out (`ncl stop` / `update` → taskkill, plus the schtasks/reg
 * service-detection that runs on EVERY invocation) flashes a console window.
 * The window often shows `error 2147942632 (0x800700e8)` (ERROR_NO_DATA — the
 * parent's stdio pipe is tearing down during shutdown); it is harmless (the
 * target pid is being force-killed anyway and the error is already swallowed)
 * but the flicker is real user-visible noise.
 *
 * Calling the real executable via `execFile`/`execFileSync` with an args ARRAY:
 *   1. bypasses `cmd.exe` entirely (no shell wrapper → no window to hide/flash),
 *   2. sets `windowsHide: true` as belt-and-braces for any console the child
 *      itself would create,
 *   3. removes the shell-injection surface (args are passed verbatim, no quoting
 *      games, no interpolation into a command string).
 *
 * Cross-platform safe: `windowsHide` is a no-op on POSIX, and `execFile` works
 * the same way everywhere. POSIX callers that previously relied on shell
 * features (globbing, `;`, redirection) must NOT use these helpers.
 */

export interface WinExecOptions {
  /** Capture stdout as this encoding (default 'utf-8'). */
  encoding?: BufferEncoding;
  /** Per-call timeout in ms. */
  timeout?: number;
}

/** Synchronous hidden exec. Returns trimmed stdout. Throws on non-zero exit. */
export function winExecSync(file: string, args: string[], opts: WinExecOptions = {}): string {
  const out = execFileSync(file, args, {
    encoding: opts.encoding ?? 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    ...(opts.timeout ? { timeout: opts.timeout } : {}),
  });
  // `encoding` is always set, so execFileSync returns a string here.
  return String(out).trim();
}

/** Async hidden exec. Resolves with trimmed stdout. Rejects on non-zero exit. */
export async function winExecAsync(file: string, args: string[], opts: WinExecOptions = {}): Promise<string> {
  const { stdout } = await execFileAsync(file, args, {
    encoding: opts.encoding ?? 'utf-8',
    windowsHide: true,
    ...(opts.timeout ? { timeout: opts.timeout } : {}),
  });
  // `encoding` is always set, so stdout is a string here.
  return String(stdout).trim();
}

/**
 * True when a Windows `taskkill` failure means "the target pid/image is already
 * gone" rather than a real error. Matches the localized "process not found"
 * strings taskkill emits (EN + common zh-CN: 不存在 / 找不到 / 没有). Centralized
 * so every kill site classifies identically.
 */
export function isProcessAlreadyGone(err: unknown): boolean {
  const e = err as { stderr?: unknown; message?: unknown } | undefined;
  const msg =
    (typeof e?.stderr === 'object' && e?.stderr && typeof (e.stderr as Buffer).toString === 'function'
      ? (e.stderr as Buffer).toString()
      : String(e?.stderr ?? '')) +
    ' ' +
    String(e?.message ?? '');
  return /not found|no running instance|没有运行|不存在|找不到/i.test(msg);
}
